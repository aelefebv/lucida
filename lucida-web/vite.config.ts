import path from 'node:path'
import { defineConfig, normalizePath, searchForWorkspaceRoot } from 'vite'
import react from '@vitejs/plugin-react'

const configDir = import.meta.dirname
const checkoutRoot = path.resolve(configDir, '..')

function isInside(parent: string, candidate: string): boolean {
  const rel = path.relative(parent, candidate)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

// Vite's default `server.fs.deny` includes `**/.git/**`, so a server started
// from this config never hands repository internals to a client. That default
// assumes the project is not itself inside a `.git` directory. A linked git
// worktree created under `.git/` breaks the assumption: the project's own files
// match the pattern too, so Vitest can't load any test file that runs in a
// browser-like environment — they all fail with `Cannot find module '/src/…'`.
//
// When running tests from such a checkout, swap the blanket `.git` rule for one
// anchored at the checkout root. Test files load again, and any real `.git`
// directory *inside* the checkout stays denied — that's where remote URLs with
// embedded credentials live.
//
// What this deliberately does not claim:
//
//   * It does not protect the `.git` directory the checkout sits *inside*. That
//     one is a parent, so no glob can deny it without denying the checkout with
//     it. Whether it is reachable is decided by `server.fs.allow` — and Vitest
//     unions its own entries (`dirname(configFile)`, `searchForWorkspaceRoot(root)`,
//     its own dist dir) into the `allow` below rather than replacing it. A union
//     is never narrower, so those entries can only widen what tests can serve.
//     Today they all land inside the checkout, but only because no workspace
//     marker (`pnpm-workspace.yaml`, `lerna.json`, a `workspaces` package.json, …)
//     exists above it. Adding one is an ordinary thing to do and would silently
//     widen serving to include the surrounding `.git`, so fail loudly if that
//     day comes.
//   * A test run is not serverless. `vitest --api` / `--ui` expose this same
//     transform pipeline over HTTP on localhost, and every file under the
//     checkout — not just source and tests — is reachable through it. A plain
//     `vitest run`, which is what `pnpm test` does, opens no listener.
//   * The switch keys off the `VITEST` environment variable and `--mode test`,
//     not off the command. A dev server started with both of those would get
//     the relaxed list; nothing in this repo does that. The flip side is that
//     running Vitest with a non-test `--mode` from such a checkout brings the
//     original load failure back.
const underVitest = Boolean(process.env.VITEST)
const insideGitDir = configDir.split(path.sep).includes('.git')

// Vite's `server.fs.deny` default with `**/.git/**` re-anchored to this
// checkout. Vite doesn't export its defaults, so the first three entries are
// transcribed from vite 8.0.16 — `vite` is pinned `^8.0.0`, so re-check them
// when that major moves.
const fsDenyAnchoredToCheckout = [
  '.env',
  '.env.*',
  '*.{crt,pem}',
  `${normalizePath(checkoutRoot)}/**/.git/**`,
]

function testFsDenyOverride(mode: string) {
  if (!underVitest || mode !== 'test' || !insideGitDir) return {}
  const workspaceRoot = searchForWorkspaceRoot(configDir)
  if (!isInside(checkoutRoot, workspaceRoot)) {
    throw new Error(
      `This checkout sits inside a .git directory (${checkoutRoot}), so vite.config.ts has to ` +
        `relax server.fs.deny for tests to load at all. Vitest resolves its file-serving root to ` +
        `${workspaceRoot}, outside the checkout, which would let the test server read the ` +
        `surrounding .git directory. Nothing is wrong with your changes — this is about where ` +
        `this checkout lives. Any one of these fixes it: run the suite from a checkout outside ` +
        `.git (\`git worktree add <path-outside-.git> <branch>\`, then \`pnpm test\` there) — do ` +
        `this if the location isn't yours to choose, e.g. a worktree some tool placed here; or ` +
        `move this checkout out of .git; or remove the workspace marker at ${workspaceRoot}. ` +
        `See wiki/gotchas/vitest-checkout-inside-git-dir.md.`,
    )
  }
  return { deny: fsDenyAnchoredToCheckout }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
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
      ...testFsDenyOverride(mode),
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
}))
