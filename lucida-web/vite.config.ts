/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { precompress } from './precompress'

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
  plugins: [react(), precompress()],
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['lucida-core'],
  },
  test: {
    // Node 25 turned on a built-in `localStorage` global, and without
    // `--localstorage-file` it reads as undefined. It shadows happy-dom's
    // Storage, so every test that touches storage fails on Node 25 and later,
    // which includes CI since `lts/*` became Node 26. Turn Node's off in the
    // test workers.
    execArgv: ['--no-experimental-webstorage'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/**/*.perf.test.ts'],
          // The Windows runner takes several seconds to render and click
          // through one component test, so vitest's 5 s default fails tests
          // that are only slow. A hung test still fails, just later.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        // After the rest, one file at a time. On a CI runner's few shared
        // cores, other test files slow the measured code and the timing
        // reference by different amounts, which no reference can cancel.
        extends: true,
        test: {
          name: 'perf',
          include: ['src/**/*.perf.test.ts'],
          sequence: { groupOrder: 1 },
          // A perf test times dozens of samples and judges them against its own
          // budget, so vitest's 5 s wall clock measures only how slow the
          // runner is. A hung test still fails, after 60 s.
          testTimeout: 60_000,
          fileParallelism: false,
        },
      },
    ],
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
