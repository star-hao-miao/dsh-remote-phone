/**
 * Self-contained token primitives: HMAC-SHA256 signed JWTs and random
 * credentials. No third-party crypto dependency — the host Node runtime
 * provides everything.
 */

import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'

const B64URL = 'base64url'

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString(B64URL)
}

/** URL-safe base64 without padding. */
function encode(input: Buffer | string): string {
  return Buffer.from(input).toString(B64URL)
}

function decode(input: string): Buffer {
  return Buffer.from(input, B64URL)
}

/** Pairing code alphabet: unambiguous uppercase alphanumerics. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

/**
 * One-time pairing code: 8 chars from the unambiguous alphabet, grouped for
 * readability as `XXXX-XXXX`. Comparison normalizes separators/case.
 */
export function generatePairingCode(): string {
  const chars: string[] = []
  for (let i = 0; i < 8; i++) {
    chars.push(CODE_ALPHABET[randomInt(CODE_ALPHABET.length)])
  }
  return chars.join('')
}

/** Canonical (ungrouped, uppercased) form of a code for comparison. */
export function normalizePairingCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export interface JwtClaims {
  /** Subject — device id for device tokens, `desktop` for control caps. */
  sub: string
  /** Audience — `device` or `desktop`. */
  aud?: string
  /** Free-form issuer tag. */
  iss?: string
  [claim: string]: unknown
}

export interface JwtHeader {
  alg: 'HS256'
  typ: 'JWT'
}

function b64urlJson(value: unknown): string {
  return encode(JSON.stringify(value))
}

/** Sign a JWT (HS256) with the given secret. */
export function signJwt(secret: string, claims: JwtClaims, ttlMs: number, now: number = Date.now()): string {
  const header: JwtHeader = { alg: 'HS256', typ: 'JWT' }
  const payload = { ...claims, iat: Math.floor(now / 1000), exp: Math.floor((now + ttlMs) / 1000) }
  const head = b64urlJson(header)
  const body = b64urlJson(payload)
  const signature = createHmac('sha256', secret).update(`${head}.${body}`).digest(B64URL)
  return `${head}.${body}.${signature}`
}

/** Verify + decode a JWT. Returns claims when valid and unexpired. */
export function verifyJwt(
  secret: string,
  token: string,
  now: number = Date.now(),
  opts: { aud?: string } = {},
): JwtClaims | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  const [head, body, signature] = parts as [string, string, string]
  const expected = createHmac('sha256', secret).update(`${head}.${body}`).digest(B64URL)
  if (!safeEqual(signature, expected)) return undefined
  let payload: JwtClaims
  try {
    payload = JSON.parse(decode(body).toString('utf8')) as JwtClaims
  } catch {
    return undefined
  }
  const exp = typeof payload.exp === 'number' ? payload.exp : undefined
  if (exp === undefined || exp <= Math.floor(now / 1000)) return undefined
  if (opts.aud !== undefined && payload.aud !== opts.aud) return undefined
  return payload
}

/** A fresh random HMAC secret for signing gateway tokens. */
export function newSecret(): string {
  return randomBytes(48).toString('hex')
}
