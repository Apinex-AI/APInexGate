import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Baseline browser hardening. Nginx/Cloudflare may add more; these are safe defaults
 * if a request hits the Node process directly.
 */
export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const rawPath = request.url.split('?')[0] || ''
    let decodedPath = rawPath
    try {
      decodedPath = decodeURIComponent(rawPath)
    } catch {
      return reply.code(400).send({ statusCode: 400, error: 'Bad Request', message: 'Invalid URL encoding' })
    }

    // Strictly block directory traversal and access to sensitive files (.env, sqlite databases, git, package.json, configs)
    if (
      decodedPath.includes('..') ||
      /(?:^|\/)\.(env|git|oxlintrc|vscode|idea)/i.test(decodedPath) ||
      /(?:^|\/)(?:data\/|package\.json|package-lock\.json|tsconfig)/i.test(decodedPath) ||
      /\.(sqlite|sqlite-shm|sqlite-wal|sqlite-journal)$/i.test(decodedPath)
    ) {
      return reply.code(404).send({ statusCode: 404, error: 'Not Found', message: 'Not Found' })
    }
  })

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    reply.header('Cross-Origin-Resource-Policy', 'same-origin')
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: https: blob:; connect-src 'self' https: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self';",
    )
    // Only force HSTS on HTTPS terminations (prod behind TLS proxy still benefits when forwarded).
    const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
    if (proto === 'https' || process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })
}
