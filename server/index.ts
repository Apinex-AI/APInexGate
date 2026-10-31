import 'dotenv/config'
import Fastify from 'fastify'
import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import { registerRoutes } from './routes.js'
import { registerSecurityHeaders } from './securityHeaders.js'
import { startReservationExpiryJob } from './tokenReservations.js'
import { startOpsMonitor } from './opsMonitor.js'
import { startModelStatusPoller } from './modelStatusPoller.js'

import { startProviderBalanceSyncJob } from './providerKeys.js'
import { startPaymentInvoiceExpiryJob } from './paymentExpiry.js'
import './seed.js'
import { importCatalogFiles } from './catalogImport.js'
import { sanitizeErrorMessage } from './upstreamFallback.js'

importCatalogFiles()

const app = Fastify({
  logger: {
    serializers: {
      req(request) {
        return {
          method: request.method,
          url: request.url,
        }
      },
    },
  },
  bodyLimit: 5 * 1024 * 1024,
})

export function sanitizeJsonControlCharacters(str: string): string {
  if (str.length > 512 * 1024) {
    throw new SyntaxError('JSON string too large for control character sanitization')
  }

  // Fast path: if there are no raw control characters at all, return str as-is.
  if (!/[\u0000-\u001f]/.test(str)) {
    return str
  }

  const chunks: string[] = []
  let lastSlice = 0
  let inString = false
  let escaped = false

  const len = str.length
  for (let i = 0; i < len; i += 1) {
    const code = str.charCodeAt(i)

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (code === 0x5c /* \ */) {
        escaped = true
      } else if (code === 0x22 /* " */) {
        inString = false
      } else if (code < 0x20) {
        if (i > lastSlice) {
          chunks.push(str.slice(lastSlice, i))
        }
        if (code === 0x0a /* \n */) {
          chunks.push('\\n')
        } else if (code === 0x0d /* \r */) {
          chunks.push('\\r')
        } else if (code === 0x09 /* \t */) {
          chunks.push('\\t')
        } else {
          chunks.push(`\\u${code.toString(16).padStart(4, '0')}`)
        }
        lastSlice = i + 1
      }
    } else {
      if (code === 0x22 /* " */) {
        inString = true
      }
    }
  }

  if (lastSlice === 0) {
    return str
  }
  if (lastSlice < len) {
    chunks.push(str.slice(lastSlice))
  }
  return chunks.join('')
}

app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
  const raw = !body ? '' : (body as string)
  if (!raw) {
    done(null, {})
    return
  }
  try {
    done(null, JSON.parse(raw))
  } catch (initialError) {
    // Lenient recovery for literal unescaped newlines/tabs pasted into curl -d.
    if (raw.length > 512 * 1024) {
      done(initialError as Error, undefined)
      return
    }
    try {
      done(null, JSON.parse(sanitizeJsonControlCharacters(raw)))
    } catch {
      done(initialError as Error, undefined)
    }
  }
})

app.setErrorHandler((error: unknown, request, reply) => {
  const err = error as { name?: string; message?: string; statusCode?: number }
  const isSyntax =
    error instanceof SyntaxError ||
    err.name === 'SyntaxError' ||
    err.statusCode === 400
  const isJsonError =
    isSyntax &&
    (/JSON|position|character/i.test(err.message || '') || err.statusCode === 400)

  if (isJsonError) {
    if (request.url.startsWith('/v1/')) {
      return reply.code(400).send({
        error: {
          message: err.message || 'Invalid JSON in request body',
          type: 'invalid_request_error',
          param: null,
          code: 400,
        },
      })
    }
    return reply.code(400).send({
      statusCode: 400,
      error: 'Bad Request',
      message: err.message,
    })
  }

  const statusCode =
    typeof err.statusCode === 'number' && err.statusCode >= 400 && err.statusCode < 600
      ? err.statusCode
      : 500

  if (statusCode >= 500) {
    request.log.error(error)
  }

  const message =
    statusCode >= 500
      ? 'Internal Server Error'
      : sanitizeErrorMessage(err.message || 'An error occurred')

  if (request.url.startsWith('/v1/')) {
    return reply.code(statusCode).send({
      error: {
        message,
        type: statusCode >= 500 ? 'api_error' : 'invalid_request_error',
        param: null,
        code: statusCode,
      },
    })
  }

  return reply.code(statusCode).send({
    statusCode,
    error: err.name || 'Internal Server Error',
    message,
  })
})

// Raw audio / binary bodies for Voice STT uploads (and passthrough). Kept as Buffer.
const binaryAudioTypes = [
  'application/octet-stream',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/m4a',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/ogg',
  'audio/ogg; codecs=opus',
  'application/ogg',
  'audio/opus',
  'audio/vorbis',
  'audio/flac',
  'audio/aac',
  'video/mp4',
  'video/webm',
  'video/ogg',
]
for (const type of binaryAudioTypes) {
  app.addContentTypeParser(type, { parseAs: 'buffer' }, (_request, body, done) => {
    done(null, body)
  })
}

// Multipart form uploads (image editing, image variations, binary files)
app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_request, body, done) => {
  done(null, body)
})

const defaultLocalOrigins = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:8787',
  'http://127.0.0.1:8787',
]

const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean)

const trustedApiOrigins = corsOrigins.length > 0 ? corsOrigins : defaultLocalOrigins

await app.register(cors, {
  delegator: (req, cb) => {
    const url = req.url || ''
    const isV1 = url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?')
    if (isV1) {
      // Public LLM gateway endpoints (/v1/*): allow any origin without credentials (OpenAI/OpenRouter/Groq standard)
      cb(null, {
        origin: true,
        credentials: false,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Authorization',
          'Content-Type',
          'Accept',
          'X-API-Key',
          'x-api-key',
          'User-Agent',
          'X-Requested-With',
          'openai-organization',
          'openai-project',
          'anthropic-version',
        ],
      })
    } else {
      // Internal dashboard & session endpoints (/api/*): strict trusted origin list with credentials
      cb(null, {
        origin: trustedApiOrigins,
        credentials: true,
        methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: [
          'Authorization',
          'Content-Type',
          'Accept',
          'X-API-Key',
          'X-Session-Id',
          'X-Session-Id',
        ],
      })
    }
  },
})
await app.register(cookie)
registerSecurityHeaders(app)
await registerRoutes(app)

const port = Number(process.env.PORT ?? 8787)
const host = process.env.HOST ?? '0.0.0.0'

await app.listen({ port, host })
console.log(`API listening on http://${host}:${port}`)
startReservationExpiryJob()
startOpsMonitor()
startModelStatusPoller()
startProviderBalanceSyncJob()

startPaymentInvoiceExpiryJob()

try {
  const { startActivityLogMaintenance } = await import('./userActivityLog.js')
  startActivityLogMaintenance()
} catch (error) {
  console.error('[activity-log] failed to start maintenance', error)
}

try {
  const { startSubscriptionNotificationJob } = await import('./subscriptions.js')
  startSubscriptionNotificationJob()
  console.log('Subscription expiry reminder job started')
} catch (reason) {
  console.warn('Subscription expiry reminder job skipped', reason)
}


