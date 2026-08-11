import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The release version, read from the manifest release-please maintains. It
// goes in every trace run's header: two runs from different builds are not
// comparable, and a header that omits the build only stops you noticing.
// Deliberately not tolerant of a missing manifest — a build that quietly
// stamps a placeholder produces traces that look comparable and are not.
// The Dockerfile copies this file into the web build stage for that reason.
const manifestPath = new URL('../.release-please-manifest.json', import.meta.url)
const releaseVersion: string = JSON.parse(readFileSync(manifestPath, 'utf8'))['.']

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
