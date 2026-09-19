/**
 * Cloudflare tunnel manager — modelled on the upstream
 * `@linxin666/dsh-remote-web-ui` tunnel policy:
 *
 *   * `--no-autoupdate --protocol http2` for every mode. The default
 *     `auto` transport prefers QUIC (UDP 7844), which wedges on
 *     QUIC-hostile networks and fake-ip TUN proxies: the connector holds the
 *     hostname but never reports a ready connection. http2 rides TCP through
 *     the same paths reliably.
 *   * one attempt per target (idempotent start) so a repeated toggle can
 *     never mint quick tunnels in a burst — the usual cause of Cloudflare
 *     `429 / error 1015` rate limiting.
 *   * a URL timeout, exponential restart backoff, and a long cooldown when
 *     Cloudflare answers with a rate-limit error.
 *   * `quick` (accountless `https://<host>.trycloudflare.com`) and `named`
 *     (`cloudflared tunnel run --token`, fixed public hostname) modes.
 *
 * Binary resolution order: configured path → PATH → the desktop's shared
 * cache → the plugin cache (`$DSH_HOME/remote-gateway/cloudflared(.exe)`),
 * downloaded from the pinned GitHub release and verified by SHA-256.
 */

import { spawn, type ChildProcessByStdio } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { get } from 'node:https'
import { arch, platform, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { tunnelBinDir } from './util/env.js'

export const CLOUDFLARED_VERSION = '2026.8.2'
const CLOUDFLARED_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}`

interface AssetSpec {
  asset: string
  isTarGz: boolean
  sha256: string
}

const CLOUDFLARED_ASSETS: Record<string, AssetSpec> = {
  'darwin-arm64': { asset: 'cloudflared-darwin-arm64.tgz', isTarGz: true, sha256: '9042c2c5d8b2de78e60f313d5fb31b6c5c1cebde787a3caf1f2c9588084ac442' },
  'darwin-x64': { asset: 'cloudflared-darwin-amd64.tgz', isTarGz: true, sha256: 'f1727723c586500e2092368ae21871b3df7ddfd2cb097f22d81bee4a9c458bb4' },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', isTarGz: false, sha256: 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5' },
  'linux-x64': { asset: 'cloudflared-linux-amd64', isTarGz: false, sha256: 'fcfb02b575a52ca1af2e3267af4e1517bcdeb30ac48c834c69abaed3c0576ad2' },
  'linux-arm64': { asset: 'cloudflared-linux-arm64', isTarGz: false, sha256: '7747d94570fb390cf47dcb4f9555c193c6355cda9793f0d878d9049e5d6a7790' },
}

function currentAssetKey(): string {
  const normalizedArch = arch() === 'x64' ? 'x64' : arch()
  return `${platform()}-${normalizedArch}`
}

/** Parse the first minted quick-tunnel URL from cloudflared output. */
export function extractTryCloudflareUrl(text: string): string | undefined {
  const url = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i)?.[0]
  if (url === undefined) return undefined
  return url.toLowerCase() === 'https://api.trycloudflare.com' ? undefined : url
}

/** Cloudflare rate-limit signature (error 1015 / HTTP 429). */
export function isRateLimited(text: string): boolean {
  return /\b1015\b/.test(text) || /429 Too Many Requests/i.test(text) || /rate limit/i.test(text)
}

/** Where the desktop keeps its own cloudflared cache (reused if present). */
function desktopCachePath(): string | undefined {
  const name = platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const path = join(tmpdir(), 'dsh-cloudflared', name)
  return existsSync(path) ? path : undefined
}

function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk as Buffer))
    stream.on('error', rejectPromise)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

/** Follow redirects and download to `toPath`. */
function download(url: string, toPath: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onResponse = (response: import('node:http').IncomingMessage): void => {
      const status = response.statusCode ?? 0
      if (status >= 300 && status < 400 && response.headers.location !== undefined) {
        response.resume()
        download(new URL(response.headers.location, url).toString(), toPath).then(resolvePromise, rejectPromise)
        return
      }
      if (status !== 200) {
        response.resume()
        rejectPromise(new Error(`download failed: HTTP ${status}`))
        return
      }
      const file = createWriteStream(toPath)
      pipeline(response, file).then(() => resolvePromise(), rejectPromise)
    }
    const request = get(url, onResponse)
    request.on('error', rejectPromise)
    request.setTimeout(60_000, () => request.destroy(new Error('download timed out')))
  })
}

async function ensureCloudflared(customPath: string | undefined): Promise<string> {
  if (customPath !== undefined && customPath !== '') {
    if (!existsSync(customPath)) throw new Error(`configured cloudflaredPath not found: ${customPath}`)
    return customPath
  }
  // 1. PATH lookup.
  const names = platform() === 'win32' ? ['cloudflared.exe', 'cloudflared'] : ['cloudflared']
  for (const name of names) {
    try {
      const { execFile } = await import('node:child_process')
      const command = platform() === 'win32' ? 'where' : 'which'
      const { stdout } = await new Promise<{ stdout: string }>((resolvePromise, rejectPromise) => {
        execFile(command, [name], { timeout: 3000, windowsHide: true }, (error, out) => {
          if (error) rejectPromise(error)
          else resolvePromise({ stdout: out })
        })
      })
      const resolved = stdout.trim().split(/\r?\n/)[0]
      if (resolved !== undefined && resolved !== '' && existsSync(resolved)) return resolved
    } catch {
      // keep searching
    }
  }
  // 2. Desktop shared cache.
  const cached = desktopCachePath()
  if (cached !== undefined) return cached

  // 3. Plugin cache: verify or download the pinned binary.
  const spec = CLOUDFLARED_ASSETS[currentAssetKey()]
  if (spec === undefined) throw new Error(`unsupported platform/arch for cloudflared: ${platform()}-${arch()}`)
  const dir = tunnelBinDir()
  mkdirSync(dir, { recursive: true })
  const exeName = platform() === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  const target = join(dir, exeName)
  if (existsSync(target)) {
    const actual = await sha256OfFile(target)
    if (actual === spec.sha256) return target
    rmSync(target, { force: true })
  }
  const downloadUrl = `${CLOUDFLARED_URL}/${spec.asset}`
  const tmpPath = join(dir, `.${basename(spec.asset)}.download`)
  rmSync(tmpPath, { force: true })
  await download(downloadUrl, tmpPath)
  const actual = await sha256OfFile(tmpPath)
  if (actual !== spec.sha256) {
    rmSync(tmpPath, { force: true })
    throw new Error(`cloudflared checksum mismatch: expected ${spec.sha256}, got ${actual}`)
  }
  renameSync(tmpPath, target)
  if (platform() !== 'win32') chmodSync(target, 0o755)
  return target
}

export type TunnelPhase =
  | { phase: 'starting' }
  | { phase: 'running'; url: string; provider: 'cloudflare' | 'named' }
  | { phase: 'failed'; error?: string }
  | { phase: 'stopped' }

/** The concrete child type produced by stdio: ['ignore','pipe','pipe']. */
type TunnelProcess = ChildProcessByStdio<null, Readable, Readable>

/** Target description; identical targets are idempotent to start. */
export type TunnelTarget = { kind: 'quick'; targetUrl: string } | { kind: 'named'; token: string; publicUrl: string }

/** Flags shared by every mode (upstream policy: http2 over TCP, no autoupdate). */
const SHARED_TUNNEL_FLAGS = ['--no-autoupdate', '--protocol', 'http2']

/** How long to wait for a quick-tunnel URL before treating the attempt as failed. */
const URL_TIMEOUT_MS = 30_000
/** Restart backoff bounds (upstream: base 5s, max 60s). */
const RESTART_BASE_MS = 5_000
const RESTART_MAX_MS = 60_000
/** Long cooldown after a Cloudflare rate-limit response. */
const RATE_LIMIT_COOLDOWN_MS = 90_000

function sameTarget(left: TunnelTarget | undefined, right: TunnelTarget): boolean {
  return left !== undefined && JSON.stringify(left) === JSON.stringify(right)
}

export class TunnelManager {
  private process: TunnelProcess | undefined
  private desired = false
  private currentTarget: TunnelTarget | undefined
  private restartTimer: NodeJS.Timeout | undefined
  private urlTimer: NodeJS.Timeout | undefined
  private url: string | undefined
  private phaseListener: ((info: TunnelPhase) => void) | undefined
  private customPath: string | undefined
  private errors: string[] = []

  /** Current minted tunnel URL, when running. */
  currentUrl(): string | undefined {
    return this.url
  }

  isRunning(): boolean {
    return this.desired && this.process !== undefined && this.process.exitCode === null
  }

  onPhase(listener: (info: TunnelPhase) => void): void {
    this.phaseListener = listener
  }

  private phase(info: TunnelPhase): void {
    if (info.phase === 'running') this.url = info.url
    if (info.phase !== 'running') this.url = undefined
    this.phaseListener?.(info)
  }

  private clearTimers(): void {
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    if (this.urlTimer !== undefined) {
      clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
  }

  /** Start (or restart) a tunnel toward the given target. */
  async start(target: TunnelTarget, customPath?: string): Promise<void> {
    this.customPath = customPath
    // Idempotent: the same target that is already desired/running is a no-op
    // (a repeated toggle must never mint tunnels in a burst).
    if (this.desired && sameTarget(this.currentTarget, target)) return
    this.clearTimers()
    if (this.process !== undefined) {
      this.process.kill()
      this.process = undefined
    }
    this.desired = true
    this.currentTarget = target
    this.errors = []
    // Every call site discards the promise; spawnOnce() therefore must never
    // reject, or an unhandled rejection takes the whole harness process down
    // (observed as `dsh: fatal load failure: Error: spawn EPERM`).
    void this.spawnOnceSafely(target, 0)
  }

  /** Stop the tunnel and do not restart it. */
  stop(): void {
    this.desired = false
    this.currentTarget = undefined
    this.clearTimers()
    const child = this.process
    this.process = undefined
    if (child !== undefined && child.exitCode === null) child.kill()
    this.phase({ phase: 'stopped' })
  }

  /** Teardown: stop everything (plugin dispose). */
  dispose(): void {
    this.stop()
  }

  private handleFailure(target: TunnelTarget, attempt: number, message: string, rateLimited: boolean): void {
    this.errors.push(message)
    const combined = this.errors.slice(-3).join(' | ')
    this.phase({ phase: 'failed', error: combined })
    if (!this.desired) return
    const backoff = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** attempt)
    const delay = rateLimited ? Math.max(RATE_LIMIT_COOLDOWN_MS, backoff) : backoff
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      if (this.desired) void this.spawnOnceSafely(target, attempt + 1)
    }, delay)
  }

  /**
   * spawnOnce() with the failure path closed: `spawn()` can throw
   * synchronously (EPERM/ENOENT), which would otherwise reject a promise
   * nobody awaits and crash the host process.
   */
  private async spawnOnceSafely(target: TunnelTarget, attempt: number): Promise<void> {
    try {
      await this.spawnOnce(target, attempt)
    } catch (error) {
      this.handleFailure(
        target,
        attempt,
        `隧道启动异常: ${error instanceof Error ? error.message : String(error)}`,
        false,
      )
    }
  }

  private async spawnOnce(target: TunnelTarget, attempt: number): Promise<void> {
    let binary: string
    try {
      binary = await ensureCloudflared(this.customPath)
    } catch (error) {
      this.handleFailure(target, attempt, `cloudflared 不可用: ${error instanceof Error ? error.message : String(error)}`, false)
      return
    }
    if (!this.desired) return
    this.phase({ phase: 'starting' })

    const args =
      target.kind === 'quick'
        ? ['tunnel', '--url', target.targetUrl, ...SHARED_TUNNEL_FLAGS]
        : ['tunnel', 'run', '--token', target.token, ...SHARED_TUNNEL_FLAGS]
    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    this.process = child

    let output = ''
    const track = (chunk: string): void => {
      output += chunk
      if (output.length > 32_768) output = output.slice(-32_768)
      if (target.kind === 'quick') {
        const url = extractTryCloudflareUrl(chunk)
        if (url !== undefined) this.markRunning(child, url, 'cloudflare')
      } else if (chunk.includes('Registered tunnel connection')) {
        this.markRunning(child, target.publicUrl, 'named')
      }
    }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', track)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', track)

    if (target.kind === 'quick') {
      // No URL within the window: treat the attempt as failed and retry.
      this.urlTimer = setTimeout(() => {
        this.urlTimer = undefined
        if (this.process !== child || !this.desired) return
        this.process = undefined
        child.kill()
        const tail = output.trim().split(/\r?\n/).slice(-2).join(' | ')
        this.handleFailure(
          target,
          attempt,
          `快速隧道 ${URL_TIMEOUT_MS / 1000}s 内未取得地址${tail === '' ? '' : `: ${tail}`}`,
          isRateLimited(output),
        )
      }, URL_TIMEOUT_MS)
    } else {
      // Named tunnels never print a public URL; the fixed hostname applies
      // once the process survives the connection grace window.
      this.urlTimer = setTimeout(() => this.markRunning(child, target.publicUrl, 'named'), 3000)
    }

    child.on('error', (error) => {
      if (this.process === child) this.process = undefined
      if (this.urlTimer !== undefined) {
        clearTimeout(this.urlTimer)
        this.urlTimer = undefined
      }
      if (!this.desired) return
      this.handleFailure(target, attempt, `cloudflared 启动失败: ${error.message}`, false)
    })
    child.on('exit', (code) => {
      if (this.process === child) this.process = undefined
      if (this.urlTimer !== undefined) {
        clearTimeout(this.urlTimer)
        this.urlTimer = undefined
      }
      if (!this.desired) {
        this.phase({ phase: 'stopped' })
        return
      }
      const tail = output.trim().split(/\r?\n/).slice(-3).join(' | ')
      this.handleFailure(
        target,
        attempt,
        `cloudflared 退出 (code ${String(code)})${tail === '' ? '' : `: ${tail}`}`,
        isRateLimited(output),
      )
    })
  }

  private markRunning(child: TunnelProcess, url: string, provider: 'cloudflare' | 'named'): void {
    if (!this.desired || this.process !== child) return
    if (this.urlTimer !== undefined) {
      clearTimeout(this.urlTimer)
      this.urlTimer = undefined
    }
    this.errors = []
    this.phase({ phase: 'running', url, provider })
  }
}
