import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const DEFAULT_DEV_PROXY_TARGET = 'http://127.0.0.1:9876'

/** Resolve the one backend origin used by every dev proxy lane. Keeping this
 * pure makes multi-instance configuration testable without starting Vite. */
export function resolveDevProxyTarget(
  env: Record<string, string | undefined> = process.env,
): string {
  const raw = env.LUCIDA_VITE_PROXY_TARGET?.trim() || DEFAULT_DEV_PROXY_TARGET
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(`LUCIDA_VITE_PROXY_TARGET must be an absolute HTTP(S) URL; got ${JSON.stringify(raw)}`)
  }
  let target: URL
  try {
    target = new URL(raw)
  } catch {
    throw new Error(`LUCIDA_VITE_PROXY_TARGET must be an absolute HTTP(S) URL; got ${JSON.stringify(raw)}`)
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`LUCIDA_VITE_PROXY_TARGET must use http or https; got ${JSON.stringify(raw)}`)
  }
  if (target.username || target.password || target.pathname !== '/' || target.search || target.hash) {
    throw new Error('LUCIDA_VITE_PROXY_TARGET must be a credential-free origin without a path, query, or fragment')
  }
  return target.origin
}

const devProxyTarget = resolveDevProxyTarget()

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['lucida-core'],
  },
  server: {
    fs: {
      allow: ['..'],
    },
    // Proxy backend routes to lucida-server so the browser sees one
    // origin. Required for cookie-based auth — SameSite=Lax cookies
    // aren't sent on cross-origin XHR/WS even with credentials:include.
    proxy: {
      '/auth': { target: devProxyTarget },
      '/api': { target: devProxyTarget },
      '/admin': { target: devProxyTarget },
      '/ws/workspaces': {
        target: devProxyTarget,
        ws: true,
      },
    },
  },
})
