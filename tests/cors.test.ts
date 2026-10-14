import assert from 'node:assert/strict'
import test from 'node:test'
import Fastify from 'fastify'
import cors from '@fastify/cors'

test('CORS: /v1/* routes allow any origin without credentials', async () => {
  const app = Fastify()
  const corsOrigins = ['https://apinex.bond', 'https://admin.apinex.bond']

  await app.register(cors, {
    delegator: (req, cb) => {
      const url = req.url || ''
      const isV1 = url === '/v1' || url.startsWith('/v1/') || url.startsWith('/v1?')
      if (isV1) {
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
        cb(null, {
          origin: corsOrigins.length > 0 ? corsOrigins : true,
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

  app.post('/v1/chat/completions', async () => ({ ok: true }))
  app.get('/api/admin/overview', async () => ({ ok: true }))

  // 1. Preflight OPTIONS to /v1/chat/completions from JanitorAI
  const resJanitorOptions = await app.inject({
    method: 'OPTIONS',
    url: '/v1/chat/completions',
    headers: {
      origin: 'https://janitorai.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  })
  assert.equal(resJanitorOptions.statusCode, 204)
  assert.equal(resJanitorOptions.headers['access-control-allow-origin'], 'https://janitorai.com')
  assert.equal(resJanitorOptions.headers['access-control-allow-credentials'], undefined)

  // 2. Preflight OPTIONS to /v1/chat/completions from LibreChat
  const resLibreOptions = await app.inject({
    method: 'OPTIONS',
    url: '/v1/chat/completions',
    headers: {
      origin: 'https://librechat.ai',
      'access-control-request-method': 'POST',
    },
  })
  assert.equal(resLibreOptions.statusCode, 204)
  assert.equal(resLibreOptions.headers['access-control-allow-origin'], 'https://librechat.ai')

  // 3. Direct POST to /v1/chat/completions from Chatbox Web
  const resChatboxPost = await app.inject({
    method: 'POST',
    url: '/v1/chat/completions',
    headers: {
      origin: 'https://chatboxai.app',
      'content-type': 'application/json',
    },
    payload: '{}',
  })
  assert.equal(resChatboxPost.statusCode, 200)
  assert.equal(resChatboxPost.headers['access-control-allow-origin'], 'https://chatboxai.app')

  // 4. Preflight OPTIONS to /api/admin/overview from untrusted origin -> should NOT allow
  const resUntrustedApi = await app.inject({
    method: 'OPTIONS',
    url: '/api/admin/overview',
    headers: {
      origin: 'https://untrusted-site.com',
      'access-control-request-method': 'GET',
    },
  })
  assert.equal(resUntrustedApi.headers['access-control-allow-origin'], undefined)

  // 5. Preflight OPTIONS to /api/admin/overview from trusted origin -> should allow with credentials
  const resTrustedApi = await app.inject({
    method: 'OPTIONS',
    url: '/api/admin/overview',
    headers: {
      origin: 'https://admin.apinex.bond',
      'access-control-request-method': 'GET',
    },
  })
  assert.equal(resTrustedApi.headers['access-control-allow-origin'], 'https://admin.apinex.bond')
  assert.equal(resTrustedApi.headers['access-control-allow-credentials'], 'true')
})
