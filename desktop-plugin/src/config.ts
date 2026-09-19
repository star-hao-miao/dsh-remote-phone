/**
 * Gateway configuration model: static config (from the cordis patch row) is
 * authoritative at boot; runtime changes made in the pairing panel persist to
 * the prefs file and are reapplied on top at the next boot only when the
 * static config does not name them.
 */

import { DEFAULT_AUTO_TUNNEL, DEFAULT_BIND_LAN, DEFAULT_PORT, dshHome, prefsFile } from './util/env.js'
import { JsonFile } from './util/store.js'
import { newSecret } from './util/crypto.js'

export interface GatewayConfig {
  /** Master switch. */
  enabled?: boolean
  /** Gateway listen port (default 3080). */
  port?: number
  /** Bind 0.0.0.0 at boot so LAN devices can reach the gateway. */
  bindLan?: boolean
  /** Start a Cloudflare Quick Tunnel at boot. */
  autoTunnel?: boolean
  /** One-time pairing code TTL in ms (default 10 minutes). */
  codeTtlMs?: number
  /** Device JWT lifetime in ms (default 30 days). */
  deviceTokenTtlMs?: number
  /** A device flips offline after this many ms without a request (25s). */
  offlineAfterMs?: number
  /** Idle paired sessions are dropped after this many ms (30 days). */
  idleExpireMs?: number
  /** Hard cap on paired devices (oldest evicted when full). */
  maxDevices?: number
  /** Absolute path to a cloudflared binary override. */
  cloudflaredPath?: string
  /**
   * Cloudflare named-tunnel token (`cloudflared tunnel run --token <t>`).
   * When set together with a valid `publicBaseUrl` (the fixed public hostname
   * configured in the Cloudflare dashboard) the "公网模式" toggle runs a
   * named tunnel instead of the Quick Tunnel — the reliable path on networks
   * where trycloudflare.com is rate-limited or blocked.
   */
  tunnelToken?: string
  /**
   * The fixed public hostname of the named tunnel, e.g.
   * `https://dsh.example.com`. Required (with `tunnelToken`) for named mode.
   */
  publicBaseUrl?: string
}

/** Runtime-persisted gateway preferences. */
export interface GatewayPrefs {
  port: number
  bindLan: boolean
  autoTunnel: boolean
  /** HMAC secret signing device JWTs and desktop capability tokens. */
  secret: string
  /** TTL for desktop capability tokens minted for the desktop UI. */
  desktopCapTtlMs: number
}

export const DEFAULTS = {
  codeTtlMs: 10 * 60_000,
  deviceTokenTtlMs: 30 * 24 * 60 * 60_000,
  offlineAfterMs: 25_000,
  idleExpireMs: 30 * 24 * 60 * 60_000,
  maxDevices: 8,
  desktopCapTtlMs: 12 * 60 * 60_000,
} as const

export interface ResolvedSettings {
  enabled: boolean
  port: number
  bindLan: boolean
  autoTunnel: boolean
  codeTtlMs: number
  deviceTokenTtlMs: number
  offlineAfterMs: number
  idleExpireMs: number
  maxDevices: number
  cloudflaredPath: string | undefined
  tunnelToken: string | undefined
  publicBaseUrl: string | undefined
  secret: string
  desktopCapTtlMs: number
}

/** Load or initialize the persisted prefs + signing secret. */
export function loadPrefs(config: GatewayConfig | undefined, home: string = dshHome()): GatewayPrefs {
  const file = new JsonFile<GatewayPrefs>(prefsFile(home))
  const existing = file.read()
  if (existing !== undefined && (typeof existing.secret !== 'string' || existing.secret === '')) {
    const fixed = { ...existing, secret: newSecret() }
    file.write(fixed)
    return fixed
  }
  if (existing !== undefined) return existing
  const created: GatewayPrefs = {
    port: config?.port ?? DEFAULT_PORT,
    bindLan: config?.bindLan ?? DEFAULT_BIND_LAN,
    autoTunnel: config?.autoTunnel ?? DEFAULT_AUTO_TUNNEL,
    secret: newSecret(),
    desktopCapTtlMs: DEFAULTS.desktopCapTtlMs,
  }
  file.write(created)
  return created
}

/** Persist updated preferences. */
export function savePrefs(prefs: GatewayPrefs, home: string = dshHome()): void {
  new JsonFile<GatewayPrefs>(prefsFile(home)).write(prefs)
}

/** Resolve the effective settings: static config wins per field. */
export function resolveSettings(config: GatewayConfig | undefined, prefs: GatewayPrefs): ResolvedSettings {
  return {
    enabled: config?.enabled ?? true,
    port: config?.port ?? prefs.port ?? DEFAULT_PORT,
    bindLan: config?.bindLan ?? prefs.bindLan ?? DEFAULT_BIND_LAN,
    autoTunnel: config?.autoTunnel ?? prefs.autoTunnel ?? DEFAULT_AUTO_TUNNEL,
    codeTtlMs: config?.codeTtlMs ?? DEFAULTS.codeTtlMs,
    deviceTokenTtlMs: config?.deviceTokenTtlMs ?? DEFAULTS.deviceTokenTtlMs,
    offlineAfterMs: config?.offlineAfterMs ?? DEFAULTS.offlineAfterMs,
    idleExpireMs: config?.idleExpireMs ?? DEFAULTS.idleExpireMs,
    maxDevices: config?.maxDevices ?? DEFAULTS.maxDevices,
    cloudflaredPath: config?.cloudflaredPath,
    tunnelToken: config?.tunnelToken,
    publicBaseUrl: config?.publicBaseUrl,
    secret: prefs.secret,
    desktopCapTtlMs: DEFAULTS.desktopCapTtlMs,
  }
}
