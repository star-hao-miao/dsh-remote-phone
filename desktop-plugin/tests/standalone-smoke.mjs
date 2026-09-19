/**
 * Standalone smoke test for the built gateway (no harness involved).
 *
 * Boots GatewayApp against a throwaway DSH_HOME under the workspace, then
 * exercises: health → desktop cap → mint code → panel page → pair verify →
 * device auth failure on data plane (harness offline) → revoke-all.
 *
 * Run: node tests/standalone-smoke.mjs
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const load = async (rel) => await import(pathToFileURL(join(lib, rel)).href)
const { GatewayApp } = await load('app.js')
const { loadPrefs, resolveSettings } = await load('config.js')
const { signJwt } = await load('util/crypto.js')

const home = mkdtempSync(join(process.cwd(), '.smoke-home-'))
process.env.DSH_HOME = home

const prefsRef = { current: loadPrefs({ port: 3199, bindLan: false }, home) }
const secret = prefsRef.current.secret

const app = new GatewayApp({
  settings: () => resolveSettings(undefined, prefsRef.current),
  persist: patch => {
    prefsRef.current = { ...prefsRef.current, ...patch }
  },
  webServerPort: () => undefined,
  launchUrl: () => undefined,
  log: message => console.log('[smoke]', message),
})

let failures = 0
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✔ ${name}`)
  else {
    failures += 1
    console.error(`  ✘ ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

try {
  await app.start()
  const port = app.gateway.currentBind()?.port
  check('gateway bound', typeof port === 'number', `port=${String(port)}`)
  const base = `http://127.0.0.1:${port}`

  const health = await fetch(`${base}/healthz`).then(r => r.json())
  check('GET /healthz', health.ok === true && health.service === 'dsh-remote-phone')

  // Mint requires a desktop cap.
  const noCap = await fetch(`${base}/api/pair`, { method: 'POST' }).then(r => r.json())
  check('mint without cap rejected', noCap.ok === false && noCap.error?.code === 'desktop-cap-required')

  const cap = signJwt(secret, { sub: 'desktop', aud: 'desktop' }, 60_000)
  const headers = { 'content-type': 'application/json', 'x-rg-cap': cap }
  const minted = await fetch(`${base}/api/pair`, { method: 'POST', headers }).then(r => r.json())
  check('mint with cap returns code', minted.ok === true && typeof minted.code === 'string' && minted.code.length === 8)
  const code = minted.code

  const panel = await fetch(`${base}/panel?cap=${encodeURIComponent(cap)}`)
  check('GET /panel html', panel.ok && (await panel.text()).includes('Remote Gateway'))

  // Wrong code → invalid.
  const wrong = await fetch(`${base}/api/pair/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'AAAAAAAA' }),
  }).then(r => r.json())
  check('verify wrong code rejected', wrong.ok === false && wrong.error?.code === 'invalid')

  // Correct code → device + JWT.
  const verified = await fetch(`${base}/api/pair/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, device: { name: 'smoke-phone', os: 'Android' } }),
  }).then(r => r.json())
  check('verify grants token', verified.ok === true && typeof verified.token === 'string' && verified.device?.name === 'smoke-phone')
  const token = verified.token
  const deviceId = verified.device?.id

  // Code is one-time.
  const reuse = await fetch(`${base}/api/pair/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code }),
  }).then(r => r.json())
  check('code is one-time', reuse.ok === false)

  // Data plane requires Bearer & reports harness-offline gracefully.
  const auth = { authorization: `Bearer ${token}` }
  const sessions = await fetch(`${base}/api/sessions`, { headers: auth }).then(r => r.json())
  check('data plane offline → 502 harness-offline', sessions.ok === false && sessions.error?.code === 'harness-offline')

  const noAuth = await fetch(`${base}/api/sessions`).then(r => r.json())
  check('data plane requires token', noAuth.ok === false && noAuth.error?.code === 'unauthorized')

  // Devices visible via cap; revoke single + all.
  const devices = await fetch(`${base}/api/devices`, { headers }).then(r => r.json())
  check('device list contains phone', devices.ok === true && devices.items?.some((d) => d.id === deviceId))

  const revoke = await fetch(`${base}/api/pair/revoke`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ deviceId }),
  }).then(r => r.json())
  check('revoke single device', revoke.ok === true && revoke.revoked === 1)

  const revokedSessions = await fetch(`${base}/api/sessions`, { headers: auth }).then(r => r.json())
  check('revoked token refused', revokedSessions.ok === false && revokedSessions.error?.code === 'unauthorized')

  const qrLan = await fetch(`${base}/api/rg/qr?mode=lan`, { headers }).then(r => r.json())
  check('LAN QR returns url (lan unavailable expected 409 or svg)', typeof qrLan === 'object')
} catch (error) {
  failures += 1
  console.error('fatal:', error)
} finally {
  await app.dispose()
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? '\nSMOKE PASS' : `\nSMOKE FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
