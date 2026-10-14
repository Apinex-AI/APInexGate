import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

/**
 * Baseline browser hardening. Nginx/Cloudflare may add more; these are safe defaults
 * if a request hits the Node process directly.
 */
export function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    reply.header('Cross-Origin-Opener-Policy', 'same-origin')
    // Only force HSTS on HTTPS terminations (prod behind TLS proxy still benefits when forwarded).
    const proto = String(request.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
    if (proto === 'https' || process.env.NODE_ENV === 'production') {
      reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    }
    return payload
  })
}
