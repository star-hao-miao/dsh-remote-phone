/**
 * Pairing manager: one live one-time code at a time, device registry with
 * revocable long-lived sessions, idle sweep, and persistence. The registry is
 * the source of truth for device authentication: a JWT alone is not enough —
 * the referenced device must still exist and be unrevoked.
 */

import { devicesFile } from './util/env.js'
import { JsonFile } from './util/store.js'
import {
  generatePairingCode,
  normalizePairingCode,
  randomToken,
  safeEqual,
  signJwt,
  verifyJwt,
} from './util/crypto.js'
import type { ResolvedSettings } from './config.js'

export interface PairedDevice {
  /** Opaque device id — also the JWT subject. */
  id: string
  /** Human name reported at pairing time (User-Agent/OS based). */
  name: string
  /** Optional free-form OS / model hint from the device. */
  os?: string
  createdAt: number
  lastSeenAt: number
}

interface PersistedDevices {
  devices: PairedDevice[]
}

interface PendingCode {
  code: string
  createdAt: number
  expiresAt: number
  /** Failures against this code before invalidation. */
  tries: number
}

export type PairingEvent =
  | { kind: 'code'; state: 'minted' | 'consumed' | 'expired' }
  | {
      kind: 'device'
      action: 'paired' | 'revoked' | 'revoked-all' | 'evicted' | 'online'
      device?: DeviceView
    }

/** Snapshot of a device for API/panel output (never exposes tokens/secrets). */
export interface DeviceView {
  id: string
  name: string
  os?: string
  createdAt: number
  lastSeenAt: number
  online: boolean
}

/** Per-IP verify throttling state. */
interface ThrottleBucket {
  count: number
  resetAt: number
}

const VERIFY_WINDOW_MS = 10 * 60_000
const VERIFY_MAX_PER_WINDOW = 20
const MAX_CODE_TRIES = 5

/** Result of a code exchange. */
export type VerifyResult =
  | { ok: true; device: DeviceView; token: string; expiresInMs: number }
  | { ok: false; error: 'invalid' | 'expired' | 'throttled' | 'used-up' }

export class PairingManager {
  private pending: PendingCode | undefined
  private devices: PairedDevice[]
  private readonly file: JsonFile<PersistedDevices>
  private throttles = new Map<string, ThrottleBucket>()
  private listener: ((event: PairingEvent) => void) | undefined

  constructor(private readonly settings: () => ResolvedSettings) {
    this.file = new JsonFile<PersistedDevices>(devicesFile())
    this.devices = this.file.read()?.devices ?? []
    this.cleanupExpired()
  }

  /** Subscribe to pairing lifecycle events (single subscriber: the gateway hub). */
  onEvent(listener: (event: PairingEvent) => void): void {
    this.listener = listener
  }

  private emit(event: PairingEvent): void {
    this.listener?.(event)
  }

  /** Mint a fresh code, invalidating any previous one. */
  mintCode(): { code: string; expiresAt: number } {
    const now = Date.now()
    this.pending = {
      code: generatePairingCode(),
      createdAt: now,
      expiresAt: now + this.settings().codeTtlMs,
      tries: 0,
    }
    this.emit({ kind: 'code', state: 'minted' })
    return { code: this.pending.code, expiresAt: this.pending.expiresAt }
  }

  /** Snapshot of the live code, or none when absent/expired. */
  codeSnapshot(): { code: string; expiresAt: number } | undefined {
    const pending = this.pending
    if (pending === undefined || pending.expiresAt <= Date.now()) return undefined
    return { code: pending.code, expiresAt: pending.expiresAt }
  }

  /** Expire a stale code (called by the periodic sweep). */
  private dropCodeIfExpired(now: number): void {
    const pending = this.pending
    if (pending !== undefined && pending.expiresAt <= now) {
      this.pending = undefined
      this.emit({ kind: 'code', state: 'expired' })
    }
  }

  private throttleBucket(ip: string, now: number): ThrottleBucket {
    let bucket = this.throttles.get(ip)
    if (bucket === undefined || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + VERIFY_WINDOW_MS }
      this.throttles.set(ip, bucket)
    }
    return bucket
  }

  /** Exchange a pairing code for a device session + JWT. */
  verifyCode(
    codeInput: string,
    meta: { name?: string; os?: string; ip: string },
    now: number = Date.now(),
  ): VerifyResult {
    const bucket = this.throttleBucket(meta.ip, now)
    if (bucket.count >= VERIFY_MAX_PER_WINDOW) return { ok: false, error: 'throttled' }
    bucket.count += 1

    const normalized = normalizePairingCode(codeInput)
    const pending = this.pending
    if (pending === undefined) return { ok: false, error: normalized === '' ? 'invalid' : 'used-up' }
    if (pending.expiresAt <= now) {
      this.pending = undefined
      this.emit({ kind: 'code', state: 'expired' })
      return { ok: false, error: 'expired' }
    }
    if (normalized === '' || !safeEqual(normalized, pending.code)) {
      pending.tries += 1
      if (pending.tries >= MAX_CODE_TRIES) this.pending = undefined
      return { ok: false, error: 'invalid' }
    }

    // One-time use: consume the code immediately.
    this.pending = undefined
    const settings = this.settings()
    // Evict the oldest device when at capacity.
    if (this.devices.length >= settings.maxDevices) {
      const oldest = [...this.devices].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest !== undefined) {
        this.devices = this.devices.filter(device => device.id !== oldest.id)
        this.emit({ kind: 'device', action: 'evicted', device: this.toView(oldest, settings, now) })
      }
    }
    const device: PairedDevice = {
      id: randomToken(16),
      name: meta.name?.trim() !== '' && meta.name !== undefined ? meta.name.trim().slice(0, 60) : '未命名设备',
      os: meta.os !== undefined && meta.os !== '' ? meta.os.slice(0, 60) : undefined,
      createdAt: now,
      lastSeenAt: now,
    }
    this.devices.push(device)
    this.persist()
    const token = signJwt(
      settings.secret,
      { sub: device.id, aud: 'device', iss: 'dsh-remote-phone' },
      settings.deviceTokenTtlMs,
      now,
    )
    this.emit({ kind: 'device', action: 'paired', device: this.toView(device, settings, now) })
    return {
      ok: true,
      device: this.toView(device, settings, now),
      token,
      expiresInMs: settings.deviceTokenTtlMs,
    }
  }

  /** Validate a Bearer device JWT; touches presence on success. */
  authenticate(token: string, now: number = Date.now()): DeviceView | undefined {
    const settings = this.settings()
    const payload = verifyJwt(settings.secret, token, now, { aud: 'device' })
    if (payload === undefined || typeof payload.sub !== 'string') return undefined
    const device = this.devices.find(candidate => candidate.id === payload.sub)
    if (device === undefined) return undefined
    const wasOffline = now - device.lastSeenAt > settings.offlineAfterMs
    // Presence writes are throttled to at most one per 10s per device.
    if (now - device.lastSeenAt > 10_000) {
      device.lastSeenAt = now
      this.persist()
      if (wasOffline) this.emit({ kind: 'device', action: 'online', device: this.toView(device, settings, now) })
    }
    return this.toView(device, settings, now)
  }

  /** Verify a desktop capability token minted by the desktop UI probe. */
  verifyDesktopCap(token: string, now: number = Date.now()): boolean {
    const payload = verifyJwt(this.settings().secret, token, now, { aud: 'desktop' })
    return payload !== undefined && payload.sub === 'desktop'
  }

  listDevices(now: number = Date.now()): DeviceView[] {
    const settings = this.settings()
    return this.devices
      .slice()
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map(device => this.toView(device, settings, now))
  }

  revokeDevice(id: string, now: number = Date.now()): boolean {
    const before = this.devices.length
    const device = this.devices.find(candidate => candidate.id === id)
    this.devices = this.devices.filter(candidate => candidate.id !== id)
    if (this.devices.length === before) return false
    this.persist()
    if (device !== undefined) this.emit({ kind: 'device', action: 'revoked', device: this.toView(device, this.settings(), now) })
    return true
  }

  revokeAll(): number {
    const count = this.devices.length
    if (count === 0) return 0
    this.devices = []
    this.persist()
    this.emit({ kind: 'device', action: 'revoked-all' })
    return count
  }

  /** Periodic maintenance: expire codes and drop idle sessions. */
  sweep(now: number = Date.now()): void {
    const settings = this.settings()
    this.dropCodeIfExpired(now)
    const cutoff = now - settings.idleExpireMs
    const before = this.devices.length
    const dropped: PairedDevice[] = []
    this.devices = this.devices.filter(device => {
      if (device.lastSeenAt >= cutoff) return true
      dropped.push(device)
      return false
    })
    if (this.devices.length !== before) {
      this.persist()
      for (const device of dropped) {
        this.emit({ kind: 'device', action: 'revoked', device: this.toView(device, settings, now) })
      }
    }
  }

  private toView(device: PairedDevice, settings: ResolvedSettings, now: number): DeviceView {
    return {
      id: device.id,
      name: device.name,
      os: device.os,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      online: now - device.lastSeenAt <= settings.offlineAfterMs,
    }
  }

  private cleanupExpired(): void {
    const now = Date.now()
    const cutoff = now - this.settings().idleExpireMs
    const before = this.devices.length
    this.devices = this.devices.filter(device => device.lastSeenAt >= cutoff)
    if (this.devices.length !== before) this.persist()
  }

  private persist(): void {
    this.file.write({ devices: this.devices })
  }
}
