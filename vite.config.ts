import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
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

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000', '/manifest.webmanifest': 'http://localhost:3000', '/healthz': 'http://localhost:3000' },
  },
})
