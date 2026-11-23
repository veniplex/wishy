// Minimal, deliberately strict tar reader/writer (ustar + pax), without dependencies.
// Shared by the launcher (release archives) and the server (backups).
// ONLY regular files and directories are allowed. Symlinks, hardlinks, devices, GNU extensions,
// absolute paths, "..", backslashes, drive letters and duplicate entries are rejected.
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

const BLOCK = 512
const ZERO = Buffer.alloc(BLOCK)
const MAX_OCTAL_SIZE = 0o77777777777 // 11 Oktalziffern

export class TarError extends Error {
  constructor(message, code = 'tar_invalid') {
    super(message)
    this.code = code
  }
}

/** Normalizes and checks an archive path; returns a POSIX path without a leading "./" or trailing "/". */
export function safeName(raw) {
  let n = String(raw)
  if (!n || n.includes('\0') || n.includes('\\') || /[\x00-\x1f:]/.test(n)) throw new TarError(`Illegal path in archive: ${JSON.stringify(n)}`, 'tar_unsafe_path')
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) throw new TarError(`Absolute path in archive: ${n}`, 'tar_unsafe_path')
  while (n.startsWith('./')) n = n.slice(2)
  n = n.replace(/\/+$/, '')
  if (!n) throw new TarError('Empty path in archive', 'tar_unsafe_path')
  for (const seg of n.split('/')) {
    if (!seg || seg === '.' || seg === '..') throw new TarError(`Illegal path in archive: ${n}`, 'tar_unsafe_path')
  }
  if (n.length > 1024) throw new TarError('Path in archive too long', 'tar_unsafe_path')
  return n
}

// ---------------------------------------------------------------- Schreiben

function writeStr(buf, off, len, s) {
  const b = Buffer.from(s, 'utf8')
  b.copy(buf, off, 0, Math.min(len, b.length))
}
const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0'

function header(name, size, type, mtime, mode) {
  const h = Buffer.alloc(BLOCK)
  writeStr(h, 0, 100, name)
  writeStr(h, 100, 8, octal(mode, 8))
  writeStr(h, 108, 8, octal(0, 8))
  writeStr(h, 116, 8, octal(0, 8))
  writeStr(h, 124, 12, octal(size > MAX_OCTAL_SIZE ? 0 : size, 12))
  writeStr(h, 136, 12, octal(Math.max(0, Math.floor(mtime)), 12))
  h.fill(0x20, 148, 156)
  writeStr(h, 156, 1, type)
  writeStr(h, 257, 6, 'ustar\0')
  writeStr(h, 263, 2, '00')
  let sum = 0
  for (const b of h) sum += b
  writeStr(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ')
  return h
}

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`
  const len = Buffer.byteLength(body)
  let n = len + String(len).length
  while (len + String(n).length !== n) n = len + String(n).length
  return `${n}${body}`
}

const pad = (size) => (size % BLOCK ? Buffer.alloc(BLOCK - (size % BLOCK)) : null)

function* headerBlocks(name, size, type, mtime, mode) {
  const nameBytes = Buffer.byteLength(name)
  // eslint-disable-next-line no-control-regex
  const needPax = nameBytes > 99 || /[^\x20-\x7e]/.test(name) || size > MAX_OCTAL_SIZE
  if (needPax) {
    let recs = paxRecord('path', name)
    if (size > MAX_OCTAL_SIZE) recs += paxRecord('size', String(size))
    const body = Buffer.from(recs, 'utf8')
    yield header('PaxHeader', body.length, 'x', mtime, 0o644)
    yield body
    const p = pad(body.length)
    if (p) yield p
    yield header(name.slice(0, 99).replace(/[^\x20-\x7e]/g, '_'), size, type, mtime, mode)
  } else {
    yield header(name, size, type, mtime, mode)
  }
}

/**
 * Creates a tar stream. entries: (async) iterable of
 *   { name, type: 'file'|'dir', size, mtime?, mode?, body: Buffer | AsyncIterable<Buffer> }
 * The body must yield exactly `size` bytes.
 */
export async function* tarStream(entries) {
  // Bundle many small blocks into larger chunks (much faster with streams/gzip)
  let parts = []
  let size = 0
  for await (const b of tarBlocks(entries)) {
    parts.push(b)
    size += b.length
    if (size >= 256 * 1024) {
      yield parts.length === 1 ? parts[0] : Buffer.concat(parts, size)
      parts = []
      size = 0
    }
  }
  if (size) yield Buffer.concat(parts, size)
}

async function* tarBlocks(entries) {
  for await (const e of entries) {
    const name = safeName(e.name)
    const mtime = (e.mtime ?? Date.now()) / 1000
    if (e.type === 'dir') {
      yield* headerBlocks(name + '/', 0, '5', mtime, e.mode ?? 0o755)
      continue
    }
    const size = e.size ?? (Buffer.isBuffer(e.body) ? e.body.length : undefined)
    if (!Number.isSafeInteger(size) || size < 0) throw new TarError(`Unknown size for ${name}`)
    yield* headerBlocks(name, size, '0', mtime, e.mode ?? 0o644)
    let n = 0
    if (Buffer.isBuffer(e.body)) {
      n = e.body.length
      if (n) yield e.body
    } else {
      for await (const chunk of e.body) {
        n += chunk.length
        if (n > size) throw new TarError(`${name} changed while being read`, 'tar_changed')
        yield chunk
      }
    }
    if (n !== size) throw new TarError(`${name} changed while being read`, 'tar_changed')
    const p = pad(size)
    if (p) yield p
  }
  yield ZERO
  yield ZERO
}

// ---------------------------------------------------------------- Lesen

function readStr(buf, off, len) {
  const end = buf.indexOf(0, off)
  return buf.toString('utf8', off, end >= 0 && end < off + len ? end : off + len)
}
function readOctal(buf, off, len) {
  const s = readStr(buf, off, len).trim()
  if (!s) return 0
  if (!/^[0-7]+$/.test(s)) throw new TarError('Corrupted tar header')
  return parseInt(s, 8)
}

/**
 * Streaming parser. onEntry({ name, type: 'file'|'dir', size, mode, mtime }) returns either
 * null (discard the content) or a sink { write(buf), end() } (synchronous).
 */
export class TarParser {
  constructor({ onEntry, maxEntries = 100_000, maxTotal = 1024 ** 3, maxEntrySize = 1024 ** 3 } = {}) {
    Object.assign(this, { onEntry, maxEntries, maxTotal, maxEntrySize })
    this.buf = Buffer.alloc(0)
    this.remaining = 0 // Bytes des aktuellen Eintrags
    this.padding = 0
    this.sink = null
    this.collect = null // for pax headers
    this.pax = null
    this.entries = 0
    this.total = 0
    this.zeros = 0
    this.ended = false
    this.trailing = 0
    this.seen = new Set()
  }

  push(chunk) {
    if (this.ended) {
      this.trailing += chunk.length
      if (this.trailing > 1024 * 1024) throw new TarError('Unexpected data after the end of the archive')
      return
    }
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    let off = 0
    while (off < this.buf.length && !this.ended) {
      if (this.remaining > 0) {
        const n = Math.min(this.remaining, this.buf.length - off)
        const part = this.buf.subarray(off, off + n)
        if (this.sink) this.sink.write(part)
        else if (this.collect) this.collect.push(Buffer.from(part))
        this.remaining -= n
        off += n
        if (this.remaining === 0) this.finishEntry()
        continue
      }
      if (this.padding > 0) {
        const n = Math.min(this.padding, this.buf.length - off)
        this.padding -= n
        off += n
        continue
      }
      if (this.buf.length - off < BLOCK) break
      const h = this.buf.subarray(off, off + BLOCK)
      off += BLOCK
      this.header(h)
    }
    this.buf = off >= this.buf.length ? Buffer.alloc(0) : Buffer.from(this.buf.subarray(off))
    if (this.ended && this.buf.length) {
      this.trailing += this.buf.length
      this.buf = Buffer.alloc(0)
    }
  }

  header(h) {
    if (h.equals(ZERO)) {
      if (++this.zeros >= 2) this.ended = true
      return
    }
    if (this.zeros) throw new TarError('Corrupted tar archive')
    let sum = 0
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i]
    if (sum !== readOctal(h, 148, 8)) throw new TarError('tar checksum mismatch')
    const type = String.fromCharCode(h[156] || 0x30)
    let size = readOctal(h, 124, 12)
    if (type === 'x' || type === 'g') {
      if (size > 1024 * 1024) throw new TarError('pax header too large')
      this.collect = []
      this.collectType = type
      this.startBody(size)
      return
    }
    let name = readStr(h, 0, 100)
    if (readStr(h, 257, 6) === 'ustar') {
      const prefix = readStr(h, 345, 155)
      if (prefix) name = `${prefix}/${name}`
    }
    if (this.pax) {
      if (this.pax.path !== undefined) name = this.pax.path
      if (this.pax.size !== undefined) size = Number(this.pax.size)
      this.pax = null
    }
    let kind
    if (type === '0' || type === '\0' || type === '7') kind = 'file'
    else if (type === '5') kind = 'dir'
    else throw new TarError(`Entry type not allowed "${type}" (${name})`, 'tar_unsafe_entry')
    name = safeName(name)
    if (this.seen.has(name)) throw new TarError(`Duplicate entry in archive: ${name}`, 'tar_unsafe_entry')
    this.seen.add(name)
    if (++this.entries > this.maxEntries) throw new TarError('Too many entries in archive', 'tar_too_large')
    if (!Number.isSafeInteger(size) || size < 0) throw new TarError('Invalid size in archive')
    if (kind === 'dir') size = 0
    if (size > this.maxEntrySize) throw new TarError(`Entry too large: ${name}`, 'tar_too_large')
    this.total += size
    if (this.total > this.maxTotal) throw new TarError('Archive too large', 'tar_too_large')
    const mode = readOctal(h, 100, 8)
    const mtime = readOctal(h, 136, 12)
    this.sink = this.onEntry?.({ name, type: kind, size, mode, mtime }) || null
    this.startBody(size)
  }

  startBody(size) {
    this.remaining = size
    this.padding = size % BLOCK ? BLOCK - (size % BLOCK) : 0
    if (size === 0) this.finishEntry()
  }

  finishEntry() {
    if (this.collect) {
      const text = Buffer.concat(this.collect).toString('utf8')
      const isGlobal = this.collectType === 'g'
      this.collect = null
      if (isGlobal) return
      const rec = {}
      let i = 0
      while (i < text.length) {
        const sp = text.indexOf(' ', i)
        const len = parseInt(text.slice(i, sp), 10)
        if (!(len > 0) || sp < 0) throw new TarError('Corrupted pax header')
        const line = text.slice(sp + 1, i + len - 1)
        const eq = line.indexOf('=')
        if (eq > 0) rec[line.slice(0, eq)] = line.slice(eq + 1)
        i += len
      }
      this.pax = rec
      return
    }
    if (this.sink) this.sink.end()
    this.sink = null
  }

  finish() {
    if (this.remaining > 0 || this.collect) throw new TarError('Archive is incomplete (truncated)', 'tar_truncated')
    if (!this.ended) throw new TarError('Archive is incomplete (end marker missing)', 'tar_truncated')
  }
}

/** Determine a safe target file inside root. */
export function targetPath(root, name) {
  const rootAbs = path.resolve(root)
  const p = path.resolve(rootAbs, ...name.split('/'))
  if (p !== rootAbs && !p.startsWith(rootAbs + path.sep)) throw new TarError(`Path leaves the target directory: ${name}`, 'tar_unsafe_path')
  return p
}

/**
 * Safely unpacks a (gzip) tar stream into destDir (must be empty/new).
 * Returns { files: Map<name, { size }> }. Optional onFile(name, size) -> additional sink (e.g. hash).
 */
export async function extractTar(source, destDir, { gzip = true, onFile, ...limits } = {}) {
  fs.mkdirSync(destDir, { recursive: true })
  if (fs.readdirSync(destDir).length) throw new TarError('Target directory is not empty')
  const files = new Map()
  let openFd = null
  const parser = new TarParser({
    ...limits,
    onEntry(e) {
      const p = targetPath(destDir, e.name)
      if (e.type === 'dir') {
        fs.mkdirSync(p, { recursive: true })
        return null
      }
      fs.mkdirSync(path.dirname(p), { recursive: true })
      // Parent directories must not be symlinks (we never create any; check anyway)
      if (fs.lstatSync(path.dirname(p)).isSymbolicLink()) throw new TarError('Symlink in the target path', 'tar_unsafe_entry')
      const fd = fs.openSync(p, 'wx', e.mode & 0o111 ? 0o755 : 0o644)
      openFd = fd
      const extra = onFile?.(e.name, e.size)
      files.set(e.name, { size: e.size })
      return {
        write(b) {
          fs.writeSync(fd, b)
          extra?.write(b)
        },
        end() {
          fs.closeSync(fd)
          openFd = null
          extra?.end()
        },
      }
    },
  })
  const stages = [source]
  if (gzip) stages.push(createGunzip())
  try {
    await pipeline(...stages, async (src) => {
      for await (const chunk of src) parser.push(chunk)
    })
    parser.finish()
  } catch (e) {
    if (openFd !== null) fs.closeSync(openFd)
    if (e instanceof TarError) throw e
    throw new TarError(`Archive is corrupted: ${e.message}`, 'tar_corrupt')
  }
  return { files }
}
