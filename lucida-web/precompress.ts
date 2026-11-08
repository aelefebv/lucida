import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import type { Plugin } from 'vite'

const brotli = promisify(brotliCompress)
const gzipped = promisify(gzip)

const COMPRESSIBLE = /\.(?:css|html|js|json|svg|txt|wasm)$/

/**
 * Writes a brotli (`.br`) and a gzip (`.gz`) copy beside each compressible
 * file in the build output. lucida-server answers with the copy the browser
 * accepts, so compression costs once per build instead of once per request.
 */
export function precompress(): Plugin {
  let outDir = ''
  return {
    name: 'lucida-precompress',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      const files = await readdir(outDir, { recursive: true })
      await Promise.all(
        files
          .filter((file) => COMPRESSIBLE.test(file))
          .map(async (file) => {
            const path = join(outDir, file)
            const data = await readFile(path)
            const [br, gz] = await Promise.all([
              brotli(data, {
                params: {
                  [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
                  [constants.BROTLI_PARAM_SIZE_HINT]: data.length,
                },
              }),
              gzipped(data, { level: constants.Z_BEST_COMPRESSION }),
            ])
            // The server falls back to the plain file, so a copy that saves
            // nothing is better left unwritten.
            if (br.length < data.length) await writeFile(`${path}.br`, br)
            if (gz.length < data.length) await writeFile(`${path}.gz`, gz)
          }),
      )
    },
  }
}
