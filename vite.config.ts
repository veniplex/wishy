import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { brotliCompressSync, constants as zc, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Writes /sw.js: src/offline/sw.js with the list of built files and a version that changes with their content. */
function serviceWorker(): Plugin {
  let publicDir = ''
  const walk = (dir: string): string[] => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(dir, f.name)) : [path.join(dir, f.name)])) : [])
  return {
    name: 'wishy-service-worker',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { publicDir = config.publicDir },
    generateBundle(_, bundle) {
      const template = fs.readFileSync(new URL('./src/offline/sw.js', import.meta.url), 'utf8')
      const hash = createHash('sha256').update(template)
      const files: string[] = []
      for (const name of Object.keys(bundle).sort()) {
        const f = bundle[name]
        hash.update(name).update(f.type === 'chunk' ? f.code : f.source)
        if (name.startsWith('assets/') && !name.endsWith('.map')) files.push(`/${name}`)
      }
      for (const file of walk(publicDir).sort()) {
        const name = path.relative(publicDir, file).split(path.sep).join('/')
        hash.update(name).update(fs.readFileSync(file))
        if (/^(assets|icons)\//.test(name)) files.push(`/${name}`)
      }
      // A function as replacement: `$` in the text has no special meaning
      const source = template.replace('__VERSION__', () => hash.digest('hex').slice(0, 16)).replace('__FILES__', () => JSON.stringify(files))
      this.emitFile({ type: 'asset', fileName: 'sw.js', source })
    },
  }
}

/** Precompresses text files of the build as <file>.br / <file>.gz (served by server/index.js); only when > 1 KB and smaller. */
function precompress(): Plugin {
  let outDir = ''
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((f) => (f.isDirectory() ? walk(path.join(dir, f.name)) : [path.join(dir, f.name)]))
  return {
    name: 'wishy-precompress',
    apply: 'build',
    enforce: 'post',
    configResolved(config) { outDir = path.resolve(config.root, config.build.outDir) },
    closeBundle() {
      if (!fs.existsSync(outDir)) return
      for (const file of walk(outDir)) {
        if (!/\.(js|mjs|css|svg|json|html|txt|webmanifest)$/.test(file)) continue
        const buf = fs.readFileSync(file)
        if (buf.length <= 1024) continue
        const br = brotliCompressSync(buf, { params: { [zc.BROTLI_PARAM_QUALITY]: 11, [zc.BROTLI_PARAM_SIZE_HINT]: buf.length } })
        const gz = gzipSync(buf, { level: 9 })
        if (br.length < buf.length) fs.writeFileSync(file + '.br', br)
        if (gz.length < buf.length) fs.writeFileSync(file + '.gz', gz)
      }
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker(), precompress()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/manifest.webmanifest': 'http://localhost:3000', '/healthz': 'http://localhost:3000' },
  },
})
