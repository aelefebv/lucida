import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The release version, read from the manifest release-please maintains. It
// goes in every trace run's header: two runs from different builds are not
// comparable, and a header that omits the build only stops you noticing.
const releaseVersion: string =
  JSON.parse(readFileSync(new URL('../.release-please-manifest.json', import.meta.url), 'utf8'))['.'] ?? 'unknown'

// https://vite.dev/config/
export default defineConfig({
  define: {
    __LUCIDA_VERSION__: JSON.stringify(releaseVersion),
  },
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
      '/auth': 'http://localhost:9876',
      '/api': 'http://localhost:9876',
      '/admin': 'http://localhost:9876',
      '/ws': {
        target: 'ws://localhost:9876',
        ws: true,
      },
    },
  },
})
