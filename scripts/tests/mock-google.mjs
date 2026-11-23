// Test preload (node --import): replaces globalThis.fetch for Google's token endpoint and JWKS so Google login can be tested without a network.
// The "code" in the token request is base64url(JSON of the desired id_token claims).
import { createRequire } from 'node:module'
// Resolve packages from the project (two levels above scripts/tests/), independent of the working directory
const require = createRequire(new URL('../../package.json', import.meta.url))
const jose = require('jose')
const { publicKey, privateKey } = await jose.generateKeyPair('RS256')
const jwk = { ...(await jose.exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  const u = String(url?.url || url)
  if (u.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return Response.json({ keys: [jwk] })
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const code = new URLSearchParams(String(init?.body)).get('code')
    const claims = JSON.parse(Buffer.from(code, 'base64url').toString())
    const id_token = await new jose.SignJWT({ ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://accounts.google.com')
      .setAudience(process.env.GOOGLE_CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey)
    return Response.json({ id_token, access_token: 'x' })
  }
  return realFetch(url, init)
}
