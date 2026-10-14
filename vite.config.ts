import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function brandHtml(env: Record<string, string>): Plugin {
  const name = env.SITE_NAME || 'Gateway'
  const site = (env.SITE_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '')
  return {
    name: 'brand-html',
    transformIndexHtml(html) {
      return html.replaceAll('%SITE_NAME%', name).replaceAll('%SITE_URL%', site)
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
  plugins: [react(), brandHtml(env)],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/v1': 'http://127.0.0.1:8787',
      '/i': 'http://127.0.0.1:8787',
    },
  },
  }
})
