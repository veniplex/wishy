// Software WebAuthn authenticator for tests (no browser): ES256 key from node:crypto, attestation "none", hand-written CBOR/COSE.
// Every field a negative test wants to break is a parameter (flags, origin, rpId, counter, userHandle, challenge).
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'

// ---- Minimal CBOR encoder (uint, negative int, bytes, text, array, map) ----
const head = (major, n) => {
  if (n < 24) return Buffer.from([(major << 5) | n])
  if (n < 256) return Buffer.from([(major << 5) | 24, n])
  if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 255])
  const b = Buffer.alloc(5)
  b[0] = (major << 5) | 26
  b.writeUInt32BE(n, 1)
  return b
}
export function cbor(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v])
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]) }
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v)
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(cbor)])
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])])
  throw new Error('cbor: unsupported ' + typeof v)
}

const sha256 = (b) => createHash('sha256').update(b).digest()
export const b64u = (b) => Buffer.from(b).toString('base64url')
export const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 }

export class SoftAuthenticator {
  constructor() {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this.privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' })
    this.cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))
    this.credId = randomBytes(32)
    this.id = b64u(this.credId)
    this.counter = 0
  }

  /** Registration response (JSON as the browser sends it). o.options = options from the server. */
  attest(options, { origin, uv = true, rpId = options.rp.id, rk = true, challenge = options.challenge } = {}) {
    const flags = FLAG.UP | (uv ? FLAG.UV : 0) | FLAG.AT
    const idLen = Buffer.alloc(2)
    idLen.writeUInt16BE(this.credId.length)
    const cnt = Buffer.alloc(4)
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), cnt, Buffer.alloc(16), idLen, this.credId, this.cose])
    const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(attestationObject), transports: ['internal'] },
      clientExtensionResults: { credProps: { rk } },
      authenticatorAttachment: 'platform',
    }
  }

  /** Assertion response. userHandle: string (UTF-8) or null (omitted). counter: true = increment, number = fixed. */
  assert(options, { origin, uv = true, up = true, rpId = options.rpId, counter = true, userHandle, challenge = options.challenge, id = this.id } = {}) {
    if (counter === true) this.counter++
    const cnt = Buffer.alloc(4)
    cnt.writeUInt32BE(typeof counter === 'number' ? counter : this.counter) // a fixed number is not remembered (used for regression tests)
    const authData = Buffer.concat([sha256(rpId), Buffer.from([(up ? FLAG.UP : 0) | (uv ? FLAG.UV : 0)]), cnt])
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }))
    const signature = sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey)
    return {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(userHandle ? { userHandle: b64u(Buffer.from(userHandle)) } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }
}
