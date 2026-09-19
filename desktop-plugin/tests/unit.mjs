/**
 * Unit tests for the pure gateway logic (JWT + pairing manager).
 * Run after build: node tests/unit.mjs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const load = async (rel) => await import(pathToFileURL(join(lib, rel)).href)
const cryptoUtil = await load('util/crypto.js')
const { PairingManager } = await load('pairing.js')

const { signJwt, verifyJwt, normalizePairingCode, generatePairingCode, newSecret } = cryptoUtil

function settings(overrides = {}) {
  return () => ({
    codeTtlMs: 10 * 60_000,
    deviceTokenTtlMs: 30 * 24 * 60 * 60_000,
    offlineAfterMs: 25_000,
    idleExpireMs: 30 * 24 * 60 * 60_000,
    maxDevices: 8,
    enabled: true,
    port: 3080,
    bindLan: false,
    autoTunnel: false,
    cloudflaredPath: undefined,
    secret: newSecret(),
    desktopCapTtlMs: 60_000,
    ...overrides,
  })
}

/** A settings resolver whose secret stays stable across calls. */
function stableSettings(overrides = {}) {
  const snapshot = settings(overrides)()
  return () => snapshot
}

test('normalizePairingCode strips separators and uppercases', () => {
  assert.equal(normalizePairingCode('ab3d-e7fq'), 'AB3DE7FQ')
  assert.equal(normalizePairingCode('ab3de7fq'), 'AB3DE7FQ')
})

test('pairing codes are 8 chars from the unambiguous alphabet', () => {
  for (let i = 0; i < 50; i++) {
    const code = generatePairingCode()
    assert.equal(code.length, 8)
    assert.match(code, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/)
  }
})

test('JWT round-trip, tamper, expiry and audience', () => {
  const secret = newSecret()
  const token = signJwt(secret, { sub: 'dev-1', aud: 'device' }, 60_000, 1_000_000)
  const claims = verifyJwt(secret, token, 1_010_000, { aud: 'device' })
  assert.ok(claims)
  assert.equal(claims.sub, 'dev-1')
  // wrong audience
  assert.equal(verifyJwt(secret, token, 1_010_000, { aud: 'desktop' }), undefined)
  // expired
  assert.equal(verifyJwt(secret, token, 1_100_000, { aud: 'device' }), undefined)
  // tampered payload
  const parts = token.split('.')
  const tampered = `${parts[0]}.${Buffer.from(JSON.stringify({ sub: 'dev-2', aud: 'device', exp: 999999999 })).toString('base64url')}.${parts[2]}`
  assert.equal(verifyJwt(secret, tampered, 1_010_000), undefined)
  // wrong secret
  assert.equal(verifyJwt(newSecret(), token, 1_010_000, { aud: 'device' }), undefined)
})

test('pairing manager: mint 鈫?verify 鈫?one-time 鈫?revoke', () => {
  const home = mkdtempSync(join(process.cwd(), '.unit-home-'))
  process.env.DSH_HOME = home
  const manager = new PairingManager(stableSettings())
  try {
    const { code, expiresAt } = manager.mintCode()
    assert.ok(code.length === 8 && expiresAt > Date.now())

    const fail = manager.verifyCode('ZZZZZZZZ', { ip: '1.2.3.4' })
    assert.equal(fail.ok, false)

    const ok = manager.verifyCode(`${code.slice(0, 4)}-${code.slice(4)}`, { ip: '1.2.3.4', name: 'Pixel', os: 'Android' })
    assert.ok(ok.ok)
    if (ok.ok) {
      assert.equal(ok.device.name, 'Pixel')
      assert.ok(ok.token.length > 20)
    }
    const reuse = manager.verifyCode(code, { ip: '1.2.3.4' })
    assert.equal(reuse.ok, false)

    assert.equal(manager.listDevices().length, 1)
    assert.ok(manager.revokeDevice(ok.ok ? ok.device.id : 'x'))
    assert.equal(manager.listDevices().length, 0)
  } finally {
    manager.sweep(Date.now() + 100_000_000)
    rmSync(home, { recursive: true, force: true })
  }
})

test('device auth refuses unknown token', () => {
  const home = mkdtempSync(join(process.cwd(), '.unit-home-'))
  process.env.DSH_HOME = home
  const manager = new PairingManager(stableSettings())
  try {
    assert.equal(manager.authenticate('garbage'), undefined)
    const { code } = manager.mintCode()
    const ok = manager.verifyCode(code, { ip: '5.6.7.8' })
    assert.ok(ok.ok)
    if (ok.ok) {
      assert.ok(manager.authenticate(ok.token))
      manager.revokeDevice(ok.device.id)
      assert.equal(manager.authenticate(ok.token), undefined)
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
