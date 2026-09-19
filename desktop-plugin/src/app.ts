/**
 * GatewayApp — the coordinator that owns every moving part of the remote
 * gateway: the pairing manager, the gateway HTTP+WS server, the quick tunnel,
 * the harness RPC/mux facade, and the desktop capability tokens. Route
 * handlers live here so they share one closure over the live state.
 */

import QRCode from 'qrcode'
import { setTimeout as nodeSetTimeout } from 'node:timers'
import { readJsonBody, writeError, writeHtml, writeJson } from './util/http.js'
import { bearerToken, queryParam } from './util/http.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GATEWAY_VERSION, WHALE_SVG } from './asset.js'
import type { ResolvedSettings } from './config.js'
import { PairingManager, type DeviceView, type PairingEvent } from './pairing.js'
import { GatewayServer, type GatewayBind } from './gateway.js'
import { TunnelManager, type TunnelPhase } from './tunnel.js'
import { InnerAuth, HarnessMux, HarnessRpc } from './harness.js'
import { HarnessFacade } from './dsh-api.js'
import { lanIPv4Addresses, socketAddress } from './util/net.js'

export interface GatewayAppDeps {
  /** Resolve the effective settings on every access. */
  settings: () => ResolvedSettings
  /** Persist gateway prefs (bind/tunnel/port/secret changes). */
  persist: (patch: { bindLan?: boolean; autoTunnel?: boolean; port?: number }) => void
  /** Live webServer port of the official harness (for the loopback data plane). */
  webServerPort: () => number | undefined
  /** The process's launch-token URL for the inner loopback authority. */
  launchUrl: () => string | undefined
  /** Logger. */
  log: (message: string) => void
}

interface InteractionPending {
  eventId: string
  agentId: string
  event: string
  request: Record<string, unknown>
  timer: NodeJS.Timeout
  forwardedAt: number
}

const GATEWAY_JSON = { 'content-type': 'application/json; charset=utf-8', 'referrer-policy': 'no-referrer' } as const

export class GatewayApp {
  readonly pairing: PairingManager
  readonly gateway: GatewayServer

  private readonly tunnel = new TunnelManager()
  private bind: GatewayBind | undefined
  private bindError: string | undefined
  private tunnelPhase: TunnelPhase = { phase: 'stopped' }
  private readonly pendingInteractions = new Map<string, InteractionPending>()
  private harness: { rpc: HarnessRpc; mux: HarnessMux; facade: HarnessFacade } | undefined
  private sweepTimer: NodeJS.Timeout | undefined
  private qrGeneration = 0

  constructor(private readonly deps: GatewayAppDeps) {
    // Field initializers above cannot reference `this.deps` (parameter
    // properties are assigned after initializers run), so these are created
    // here, inside the constructor.
    this.pairing = new PairingManager(() => this.deps.settings())
    this.gateway = new GatewayServer({
      onStateChange: () => this.broadcastState('mode'),
      onWsAuth: deviceId => {
        this.broadcastTo(deviceId, { type: 'hello', version: GATEWAY_VERSION, ...this.stateSnapshot() })
      },
      onWsClose: () => undefined,
      onWsMessage: (deviceId, frame) => this.handleWsMessage(deviceId, frame),
    })
    // Authenticate /ws upgrades with the device registry (Bearer or ?token=).
    this.gateway.authenticateWs = (_req, token) => {
      const device = this.pairing.authenticate(token)
      if (device === undefined) return Promise.resolve({ ok: false } as const)
      return Promise.resolve({ ok: true, deviceId: device.id } as const)
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  /** Bind the gateway and start the harness link + maintenance loops. */
  async start(): Promise<void> {
    const settings = this.deps.settings()
    this.pairing.onEvent(event => this.onPairingEvent(event))

    // Register the full route table (before listen).
    this.registerRoutes()

    // Rebind failures (port busy → EADDRINUSE drift handled inside listen).
    try {
      const host = settings.bindLan ? '0.0.0.0' : '127.0.0.1'
      this.bind = await this.gateway.listen(host, settings.port)
      this.bindError = undefined
      this.deps.log(`remote-gateway listening on ${this.bind.host}:${this.bind.port}`)
    } catch (error) {
      this.bindError = error instanceof Error ? error.message : String(error)
      this.deps.log(`remote-gateway failed to bind: ${this.bindError}`)
    }

    // Optional auto tunnel at boot.
    if (settings.autoTunnel && this.bind !== undefined) {
      void this.toggleTunnel(true).catch(() => undefined)
    }

    // Harness data plane (only when the official web server is reachable).
    this.connectHarness()

    // Presence/code sweep every 10s.
    const tick = (): void => {
      try {
        this.pairing.sweep()
        this.broadcastPresenceIfChanged()
      } finally {
        this.sweepTimer = nodeSetTimeout(tick, 10_000)
      }
    }
    this.sweepTimer = nodeSetTimeout(tick, 10_000)
    this.sweepTimer.unref?.()
  }

  private lastPresenceSignature = ''

  private broadcastPresenceIfChanged(): void {
    const now = Date.now()
    const devices = this.pairing.listDevices(now)
    const signature = devices.map(d => `${d.id}:${d.online ? '1' : '0'}`).join('|')
    if (signature !== this.lastPresenceSignature) {
      this.lastPresenceSignature = signature
      this.broadcast({ type: 'presence', devices })
    }
  }

  /** Teardown: stop tunnel, mux, sweep, gateway. */
  async dispose(): Promise<void> {
    if (this.sweepTimer !== undefined) clearTimeout(this.sweepTimer)
    for (const pending of this.pendingInteractions.values()) clearTimeout(pending.timer)
    this.pendingInteractions.clear()
    this.tunnel.dispose()
    this.harness?.mux.dispose()
    await this.gateway.dispose()
  }

  // ── harness link ─────────────────────────────────────────────────────────

  private connectHarness(): void {
    const port = this.deps.webServerPort()
    if (port === undefined) {
      this.deps.log('remote-gateway: harness web server port unknown — data plane offline (pairing panel still works)')
      return
    }
    const auth = new InnerAuth(() => this.deps.launchUrl())
    const rpc = new HarnessRpc(() => port, auth)
    const mux = new HarnessMux(() => port, auth)
    const facade = new HarnessFacade(rpc, mux, () => ({ maxTranscriptMessages: 200 }))
    this.harness = { rpc, mux, facade }

    mux.connect()
    facade.startWorkspaceWatch(items => {
      this.broadcast({ type: 'workspaces', items, ready: true })
    })
    facade.startEventRelay({
      onEmit: (event, args) => this.onHarnessEmit(event, args),
      onWaterfall: frame => this.onHarnessWaterfall(frame.event, frame.eventId, frame.agentId, frame.request),
    })
  }

  private onHarnessEmit(event: string, args: unknown[]): void {
    const first = args[0]
    switch (event) {
      case 'api-session/status': {
        const sessionId = typeof first === 'string' ? first : undefined
        if (sessionId !== undefined) this.broadcast({ type: 'session.status', sessionId, running: args[1] === true })
        return
      }
      case 'api-session/activity': {
        const sessionId = typeof first === 'string' ? first : undefined
        if (sessionId !== undefined) this.broadcast({ type: 'session.activity', sessionId, updatedAt: args[1] })
        return
      }
      case 'api-session/removed': {
        const sessionId = typeof first === 'string' ? first : undefined
        if (sessionId !== undefined) this.broadcast({ type: 'session.removed', sessionId })
        return
      }
      case 'api-session/added': {
        this.broadcast({ type: 'session.added', summary: first })
        return
      }
      case 'api-session/error': {
        const sessionId = typeof first === 'string' ? first : undefined
        if (sessionId !== undefined) this.broadcast({ type: 'session.error', sessionId, message: args[1] })
        return
      }
      default:
        return
    }
  }

  private onHarnessWaterfall(event: string, eventId: string, agentId: string, request: Record<string, unknown>): void {
    // Forward interactive requests (approvals / user questions) to phones
    // only when at least one device is attached, then auto-delegate once the
    // phone has had a chance to answer.
    const phoneCount = this.gateway.authedDeviceIds().length
    const enabled = this.deps.settings().enabled
    if (!enabled || phoneCount === 0) return
    const kind = event === 'approval/request' ? 'approval' : event === 'user-questions/request' ? 'user-question' : undefined
    if (kind === undefined) return
    const publicRequest = { ...request }
    delete (publicRequest as Record<string, unknown>).signal
    this.broadcast({
      type: 'interaction.request',
      id: eventId,
      kind,
      sessionId: agentId,
      toolName: kind === 'approval' ? request.toolName : undefined,
      callId: request.callId,
      reason: request.reason,
      request: publicRequest,
    })
    const timer = nodeSetTimeout(() => {
      this.pendingInteractions.delete(eventId)
      void this.answerInteraction(eventId, { kind: 'next' })
    }, 60_000)
    this.pendingInteractions.set(eventId, { eventId, agentId, event, request, timer, forwardedAt: Date.now() })
  }

  private async answerInteraction(
    eventId: string,
    outcome: { kind: 'result'; value: string } | { kind: 'rejected'; error: { name: string; message: string } } | { kind: 'next' },
  ): Promise<void> {
    const harness = this.harness
    if (harness === undefined) return
    const result = await harness.facade.answerInteraction(eventId, outcome)
    if (!result.ok) this.deps.log(`remote-gateway: interaction ${eventId} answer failed: ${result.error.code} ${result.error.message}`)
  }

  /** Phone decisions over /ws. */
  private handleWsMessage(deviceId: string, frame: Record<string, unknown>): void {
    const type = frame.type
    if (type === 'ping') {
      this.broadcastTo(deviceId, { type: 'pong', at: Date.now() })
      return
    }
    if (type === 'approval.decision') {
      const eventId = typeof frame.id === 'string' ? frame.id : undefined
      const decision = typeof frame.decision === 'string' ? frame.decision : undefined
      if (eventId === undefined || decision === undefined) return
      const pending = this.pendingInteractions.get(eventId)
      if (pending === undefined || pending.event !== 'approval/request') return
      this.pendingInteractions.delete(eventId)
      clearTimeout(pending.timer)
      if (decision === 'allowed-once' || decision === 'rejected' || decision === 'cancelled') {
        void this.answerInteraction(eventId, { kind: 'result', value: decision })
      } else {
        void this.answerInteraction(eventId, { kind: 'next' })
      }
      return
    }
    if (type === 'user-question.answer') {
      const eventId = typeof frame.id === 'string' ? frame.id : undefined
      if (eventId === undefined) return
      const pending = this.pendingInteractions.get(eventId)
      if (pending === undefined || pending.event !== 'user-questions/request') return
      this.pendingInteractions.delete(eventId)
      clearTimeout(pending.timer)
      const answer = frame.answer
      if (typeof answer === 'string') {
        void this.answerInteraction(eventId, { kind: 'result', value: answer })
      } else {
        void this.answerInteraction(eventId, { kind: 'next' })
      }
    }
  }

  // ── pairing events → broadcast ───────────────────────────────────────────

  private onPairingEvent(event: PairingEvent): void {
    if (event.kind === 'code') {
      this.broadcast({ type: 'pairing.code', state: event.state })
      return
    }
    this.broadcast({ type: 'pairing.device', action: event.action, device: event.device })
    this.lastPresenceSignature = ''
  }

  // ── broadcast helpers ────────────────────────────────────────────────────

  private broadcast(frame: Record<string, unknown>): void {
    this.gateway.broadcast({ ...frame, at: Date.now() })
  }

  private broadcastTo(deviceId: string, frame: Record<string, unknown>): void {
    this.gateway.broadcast({ ...frame, to: deviceId, at: Date.now() })
  }

  private broadcastState(kind: 'mode' | 'pairing' | 'tunnel' | 'bind'): void {
    this.broadcast({ type: 'state', kind, ...this.stateSnapshot() })
  }

  // ── public state snapshot (control plane) ────────────────────────────────

  private stateSnapshot(): Record<string, unknown> {
    const settings = this.deps.settings()
    const bind = this.bind
    const code = this.pairing.codeSnapshot()
    const lanMode = bind?.host === '0.0.0.0'
    return {
      version: GATEWAY_VERSION,
      enabled: settings.enabled,
      port: bind?.port,
      bindHost: bind?.host,
      bindError: this.bindError,
      lanMode,
      lanAddresses: lanIPv4Addresses(),
      tunnel: {
        phase: this.tunnelPhase.phase,
        url: this.tunnelPhase.phase === 'running' ? this.tunnelPhase.url : undefined,
        provider: this.tunnelPhase.phase === 'running' ? this.tunnelPhase.provider : undefined,
        error: this.tunnelPhase.phase === 'failed' ? this.tunnelPhase.error : undefined,
      },
      pairing: code ?? null,
      harnessConnected: this.harness?.mux.isConnected() ?? false,
      devices: this.pairing.listDevices(),
      // Pending approvals / questions ride along with `hello` and `/api/rg/state`
      // so an app that reconnects (or was killed while an approval was raised)
      // can still render the decision card.
      interactions: [...this.pendingInteractions.values()].map(pending => ({
        id: pending.eventId,
        kind: pending.event === 'approval/request' ? 'approval' : 'user-question',
        sessionId: pending.agentId,
        toolName: pending.event === 'approval/request' ? pending.request.toolName : undefined,
        callId: pending.request.callId,
        reason: pending.request.reason,
      })),
    }
  }

  /** Control-plane state (used by /api/rg/state). */
  controlState(): Record<string, unknown> {
    return { ok: true, ...this.stateSnapshot() }
  }

  // ── tunnel + bind controls ───────────────────────────────────────────────

  /** Start/stop the public tunnel; persists the autoTunnel preference. */
  async toggleTunnel(enable: boolean): Promise<void> {
    const bind = this.bind
    if (bind === undefined) throw new Error('gateway not listening')
    if (enable) {
      this.deps.persist({ autoTunnel: true })
      this.tunnel.onPhase(info => {
        this.tunnelPhase = info
        this.broadcastState('tunnel')
      })
      const settings = this.deps.settings()
      const token = settings.tunnelToken
      const publicUrl = settings.publicBaseUrl
      if (token !== undefined && token !== '' && this.isHttpUrl(publicUrl)) {
        // Named tunnel (own Cloudflare domain): the reliable path when
        // trycloudflare.com is rate-limited or blocked on this network.
        await this.tunnel.start({ kind: 'named', token, publicUrl }, settings.cloudflaredPath)
      } else {
        if (publicUrl !== undefined) {
          this.deps.log('publicBaseUrl/tunnelToken 不完整：公网模式回退到 Quick Tunnel（若网络限制 trycloudflare 请配置命名隧道）')
        }
        await this.tunnel.start({ kind: 'quick', targetUrl: `http://127.0.0.1:${bind.port}` }, settings.cloudflaredPath)
      }
    } else {
      this.deps.persist({ autoTunnel: false })
      this.tunnel.stop()
      this.tunnelPhase = { phase: 'stopped' }
      this.broadcastState('tunnel')
    }
  }

  private isHttpUrl(value: string | undefined): value is string {
    if (value === undefined) return false
    try {
      const url = new URL(value)
      return url.protocol === 'http:' || url.protocol === 'https:'
    } catch {
      return false
    }
  }

  /** Toggle LAN bind (rebinds the listener; port is preserved). */
  async toggleLan(enable: boolean): Promise<void> {
    this.deps.persist({ bindLan: enable })
    const host = enable ? '0.0.0.0' : '127.0.0.1'
    try {
      this.bind = await this.gateway.rebind(host)
      this.bindError = undefined
    } catch (error) {
      this.bindError = error instanceof Error ? error.message : String(error)
      throw error
    }
    this.broadcastState('bind')
  }

  // ── QR / pairing URL construction ────────────────────────────────────────

  private pairingBaseUrls(): { lan: string[]; tunnel: string | undefined } {
    // LAN URLs are only advertised while the gateway is actually bound to
    // 0.0.0.0 — otherwise the QR would point at an unreachable address.
    const bind = this.bind
    const port = bind?.port
    const lan =
      bind?.host === '0.0.0.0' && port !== undefined
        ? lanIPv4Addresses().map(address => `http://${address}:${port}`)
        : []
    const tunnel = this.tunnelPhase.phase === 'running' ? this.tunnelPhase.url : undefined
    return { lan, tunnel }
  }

  /** Render the QR for one mode into an SVG data URL. */
  private async qrSvgFor(mode: 'lan' | 'tunnel', ip?: string): Promise<{ svg: string; url: string; expiresAt: number }> {
    const code = this.pairing.codeSnapshot()
    if (code === undefined) throw new QrError('no-active-code', '先铸造配对码 (POST /api/pair)')
    const bases = this.pairingBaseUrls()
    let base: string | undefined
    if (mode === 'tunnel') base = bases.tunnel
    else if (ip !== undefined) base = bases.lan.find(url => new URL(url).hostname === ip) ?? bases.lan[0]
    else base = bases.lan[0]
    if (base === undefined) {
      throw new QrError(
        mode === 'tunnel' ? 'tunnel-offline' : 'lan-unavailable',
        mode === 'tunnel'
          ? '公网隧道未开启：请先在面板启用“公网模式”（Quick Tunnel）'
          : '局域网未启用：请先在面板打开“局域网模式”，并允许 Windows 防火墙弹窗',
      )
    }
    const url = `${base}/pair?code=${encodeURIComponent(code.code)}`
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
    return { svg, url, expiresAt: code.expiresAt }
  }

  // ── auth helpers for handlers ────────────────────────────────────────────

  private requireCap(req: IncomingMessage, res: ServerResponse): boolean {
    const header = req.headers['x-rg-cap']
    const token = typeof header === 'string' ? header : queryParam(new URL(req.url ?? '/', 'http://localhost'), 'cap')
    if (token === undefined || !this.pairing.verifyDesktopCap(token)) {
      writeError(res, 401, 'desktop-cap-required', '需要桌面能力令牌（请从电脑端 DSH 界面打开面板）')
      return false
    }
    return true
  }

  private requireDevice(req: IncomingMessage, res: ServerResponse): DeviceView | undefined {
    const token = bearerToken(req)
    if (token === undefined) {
      writeError(res, 401, 'unauthorized', '缺少 Authorization: Bearer 令牌')
      return undefined
    }
    const device = this.pairing.authenticate(token)
    if (device === undefined) {
      writeError(res, 401, 'unauthorized', '令牌无效或设备已被撤销')
      return undefined
    }
    return device
  }

  // ── route table ──────────────────────────────────────────────────────────

  private registerRoutes(): void {
    const g = this.gateway
    // Health / discovery
    g.register({ method: 'GET', path: '/healthz', handler: (_req, res) => writeJson(res, 200, { ok: true, service: 'dsh-remote-phone', version: GATEWAY_VERSION }) })

    // ── pairing (desktop control plane) ────────────────────────────────────
    g.register({
      method: 'POST',
      path: '/api/pair',
      handler: (req, res) => {
        if (!this.requireCap(req, res)) return
        const minted = this.pairing.mintCode()
        this.broadcastState('pairing')
        writeJson(res, 200, { ok: true, code: minted.code, expiresAt: minted.expiresAt, ...this.pairingBaseUrls() })
      },
    })
    g.register({
      method: 'POST',
      path: '/api/pair/verify',
      handler: async (req, res) => {
        const body = (await readJsonBody(req, { maxBytes: 4096, objectOnly: true })) as Record<string, unknown> | null
        const code = typeof body?.code === 'string' ? body.code : ''
        if (code === '') {
          writeError(res, 400, 'bad-payload', '缺少 code')
          return
        }
        const deviceRaw = body?.device
        const deviceMeta = (typeof deviceRaw === 'object' && deviceRaw !== null ? deviceRaw : {}) as Record<string, unknown>
        const result = this.pairing.verifyCode(code, {
          name: typeof deviceMeta.name === 'string' ? deviceMeta.name : undefined,
          os: typeof deviceMeta.os === 'string' ? deviceMeta.os : undefined,
          ip: socketAddress(req),
        })
        if (!result.ok) {
          const status = result.error === 'invalid' ? 401 : result.error === 'expired' ? 410 : result.error === 'throttled' ? 429 : 409
          writeError(res, status, result.error, result.error)
          return
        }
        this.broadcastState('pairing')
        writeJson(res, 200, {
          ok: true,
          device: result.device,
          token: result.token,
          tokenType: 'Bearer',
          expiresInMs: result.expiresInMs,
          expiresAt: Date.now() + result.expiresInMs,
        })
      },
    })
    g.register({
      method: 'POST',
      path: '/api/pair/revoke',
      handler: async (req, res) => {
        if (!this.requireCap(req, res)) return
        // Awaited (not a detached `.then`): a rejection inside a fire-and-forget
        // chain would be an unhandled rejection and kill the harness process.
        const body = (await readJsonBody(req, { maxBytes: 4096, objectOnly: true })) as Record<string, unknown> | null
        if (body?.all === true) {
          const count = this.pairing.revokeAll()
          writeJson(res, 200, { ok: true, revoked: count })
        } else if (typeof body?.deviceId === 'string') {
          const found = this.pairing.revokeDevice(body.deviceId)
          writeJson(res, found ? 200 : 404, found ? { ok: true, revoked: 1 } : { ok: false, error: { code: 'unknown-device', message: '设备不存在' } })
        } else {
          writeError(res, 400, 'bad-payload', '需要 deviceId 或 all: true')
        }
      },
    })

    // ── device list ────────────────────────────────────────────────────────
    g.register({
      method: 'GET',
      path: '/api/devices',
      handler: (req, res) => {
        // A desktop capability OR a paired device may read the roster. The
        // checks must be side-effect free here: calling requireCap() and then
        // requireDevice() wrote *two* 401 responses (the second threw
        // ERR_HTTP_HEADERS_SENT, which surfaced as a harness-wide fatal load
        // failure because the app calls this route on every refresh).
        const capHeader = req.headers['x-rg-cap']
        const capToken = typeof capHeader === 'string' ? capHeader : queryParam(new URL(req.url ?? '/', 'http://localhost'), 'cap')
        const allowedByCap = capToken !== undefined && this.pairing.verifyDesktopCap(capToken)
        const allowedByDevice = !allowedByCap && this.pairing.authenticate(bearerToken(req) ?? '') !== undefined
        if (!allowedByCap && !allowedByDevice) {
          writeError(res, 401, 'unauthorized', '需要桌面能力令牌或已配对设备的 Bearer 令牌')
          return
        }
        writeJson(res, 200, { ok: true, items: this.pairing.listDevices() })
      },
    })

    // ── device data plane (Bearer) ─────────────────────────────────────────
    g.register({
      method: 'GET',
      path: '/api/sessions',
      handler: async (req, res) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const outcome = await facade.listSessions()
        if (!outcome.ok) {
          this.writeHarnessError(res, outcome)
          return
        }
        writeJson(res, 200, { ok: true, items: outcome.value })
      },
    })
    g.register({
      method: 'GET',
      path: '/api/sessions/:id',
      handler: async (req, res, params) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const includeRaw = queryParam(url, 'raw') === '1'
        const beforeRaw = queryParam(url, 'beforeSeq')
        const limitRaw = queryParam(url, 'limit')
        const beforeSeq = beforeRaw === undefined ? undefined : Number(beforeRaw)
        const limit = limitRaw === undefined ? undefined : Number(limitRaw)
        const outcome = await facade.sessionDetail(params.id ?? '', {
          includeRaw,
          beforeSeq: beforeSeq !== undefined && Number.isFinite(beforeSeq) ? beforeSeq : undefined,
          maxMessages: limit !== undefined && Number.isFinite(limit) ? limit : undefined,
        })
        if (!outcome.ok) {
          this.writeHarnessError(res, outcome)
          return
        }
        writeJson(res, 200, { ok: true, session: outcome.value })
      },
    })
    g.register({
      method: 'POST',
      path: '/api/sessions/:id/message',
      handler: async (req, res, params) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const body = (await readJsonBody(req, { maxBytes: 128 * 1024, objectOnly: true })) as Record<string, unknown> | null
        const content = typeof body?.content === 'string' ? body.content : ''
        if (content.trim() === '') {
          writeError(res, 400, 'bad-payload', 'content 不能为空')
          return
        }
        const mode = body?.mode === 'steer' ? 'steer' : 'queue'
        const imageRaw = body?.image
        const image =
          typeof imageRaw === 'object' && imageRaw !== null && typeof (imageRaw as Record<string, unknown>).mediaType === 'string'
            ? {
                mediaType: (imageRaw as Record<string, unknown>).mediaType as string,
                data: typeof (imageRaw as Record<string, unknown>).data === 'string' ? ((imageRaw as Record<string, unknown>).data as string) : '',
                name: typeof (imageRaw as Record<string, unknown>).name === 'string' ? ((imageRaw as Record<string, unknown>).name as string) : undefined,
              }
            : undefined
        const outcome = await facade.sendMessage(params.id ?? '', content, { mode, image })
        if (!outcome.ok) {
          this.writeHarnessError(res, outcome)
          return
        }
        writeJson(res, 200, { ok: true, ...outcome.value })
      },
    })
    g.register({
      method: 'POST',
      path: '/api/sessions',
      handler: async (req, res) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const body = (await readJsonBody(req, { maxBytes: 8192, objectOnly: true })) as Record<string, unknown> | null
        const workspaceId = typeof body?.workspaceId === 'string' ? body.workspaceId : undefined
        const cwd = typeof body?.cwd === 'string' ? body.cwd : undefined
        if (workspaceId !== undefined && !facade.workspaceSnapshot().items.some(item => item.workspaceId === workspaceId)) {
          writeError(res, 404, 'unknown-workspace', '工作区不存在')
          return
        }
        const outcome = await facade.createSession({ workspaceId, cwd })
        if (!outcome.ok) {
          this.writeHarnessError(res, outcome)
          return
        }
        writeJson(res, 200, { ok: true, ...outcome.value })
      },
    })
    g.register({
      method: 'DELETE',
      path: '/api/sessions/:id',
      handler: async (req, res, params) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const outcome = await facade.deleteSession(params.id ?? '')
        if (!outcome.ok) {
          // `session/agent-busy` is the usual refusal: the agent is still
          // running, and the harness protects the session in that case.
          this.writeHarnessError(res, outcome)
          return
        }
        writeJson(res, 200, { ok: true, ...outcome.value })
      },
    })
    g.register({
      method: 'GET',
      path: '/api/workspaces',
      handler: async (req, res) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const snapshot = facade.workspaceSnapshot()
        if (!snapshot.ready) {
          // Baseline missing (typically right after a harness restart): re-open
          // the follow stream so grouping data recovers on the next poll instead
          // of staying empty for the rest of the gateway's lifetime.
          facade.ensureWorkspaceWatch()
        }
        writeJson(res, 200, { ok: true, items: snapshot.items, ready: snapshot.ready })
      },
    })
    g.register({
      method: 'POST',
      path: '/api/workspaces/:id/switch',
      handler: async (req, res, params) => {
        if (this.requireDevice(req, res) === undefined) return
        const facade = this.harness?.facade
        if (facade === undefined) {
          writeError(res, 502, 'harness-offline', '本机 harness 数据面未连接')
          return
        }
        const workspaceId = params.id ?? ''
        const known = facade.workspaceSnapshot().items.some(item => item.workspaceId === workspaceId)
        if (!known) {
          writeError(res, 404, 'unknown-workspace', '工作区不存在')
          return
        }
        const outcome = await facade.openSessionInWorkspace(workspaceId)
        if (!outcome.ok) {
          this.writeHarnessError(res, outcome)
          return
        }
        writeJson(res, 200, { ok: true, workspaceId, ...outcome.value })
      },
    })

    // ── approvals (decision endpoint) ──────────────────────────────────────
    g.register({
      method: 'POST',
      path: '/api/approvals/:eventId',
      handler: async (req, res, params) => {
        if (this.requireDevice(req, res) === undefined) return
        const eventId = params.eventId ?? ''
        const body = (await readJsonBody(req, { maxBytes: 4096, objectOnly: true })) as Record<string, unknown> | null
        const pending = this.pendingInteractions.get(eventId)
        if (pending === undefined) {
          writeError(res, 404, 'unknown-interaction', '该审批请求不存在或已过期')
          return
        }
        const decision = typeof body?.decision === 'string' ? body.decision : ''
        this.pendingInteractions.delete(eventId)
        clearTimeout(pending.timer)
        if (decision === 'allowed-once' || decision === 'rejected' || decision === 'cancelled') {
          await this.answerInteraction(eventId, { kind: 'result', value: decision })
          writeJson(res, 200, { ok: true, decision })
        } else {
          await this.answerInteraction(eventId, { kind: 'next' })
          writeJson(res, 200, { ok: true, decision: 'next' })
        }
      },
    })

    // ── control plane (desktop cap) ────────────────────────────────────────
    g.register({
      method: 'GET',
      path: '/api/rg/state',
      handler: (req, res) => {
        if (!this.requireCap(req, res)) return
        writeJson(res, 200, this.controlState())
      },
    })
    g.register({
      method: 'GET',
      path: '/api/rg/qr',
      handler: async (req, res) => {
        if (!this.requireCap(req, res)) return
        const url = new URL(req.url ?? '/', 'http://localhost')
        const mode = url.searchParams.get('mode') === 'tunnel' ? 'tunnel' : 'lan'
        const ip = url.searchParams.get('ip') ?? undefined
        const generation = ++this.qrGeneration
        try {
          const qr = await this.qrSvgFor(mode, ip)
          if (generation !== this.qrGeneration) return // superseded
          writeJson(res, 200, { ok: true, mode, ...qr })
        } catch (error) {
          if (error instanceof QrError) writeError(res, error.status, error.code, error.message)
          else writeError(res, 500, 'internal', error instanceof Error ? error.message : String(error))
        }
      },
    })
    g.register({
      method: 'POST',
      path: '/api/rg/mode',
      handler: async (req, res) => {
        if (!this.requireCap(req, res)) return
        const body = (await readJsonBody(req, { maxBytes: 4096, objectOnly: true })) as Record<string, unknown> | null
        if (typeof body?.lan !== 'boolean') {
          writeError(res, 400, 'bad-payload', '需要 {lan: boolean}')
          return
        }
        try {
          await this.toggleLan(body.lan)
          writeJson(res, 200, { ok: true, ...this.stateSnapshot() })
        } catch (error) {
          writeError(res, 500, 'rebind-failed', error instanceof Error ? error.message : String(error))
        }
      },
    })
    g.register({
      method: 'POST',
      path: '/api/rg/tunnel',
      handler: async (req, res) => {
        if (!this.requireCap(req, res)) return
        const body = (await readJsonBody(req, { maxBytes: 4096, objectOnly: true })) as Record<string, unknown> | null
        if (typeof body?.enable !== 'boolean') {
          writeError(res, 400, 'bad-payload', '需要 {enable: boolean}')
          return
        }
        try {
          await this.toggleTunnel(body.enable)
          writeJson(res, 200, { ok: true, ...this.stateSnapshot() })
        } catch (error) {
          writeError(res, 500, 'tunnel-failed', error instanceof Error ? error.message : String(error))
        }
      },
    })
    g.register({
      method: 'POST',
      path: '/api/rg/revoke-all',
      handler: (req, res) => {
        if (!this.requireCap(req, res)) return
        const count = this.pairing.revokeAll()
        writeJson(res, 200, { ok: true, revoked: count })
      },
    })

    // ── public pages ───────────────────────────────────────────────────────
    g.register({
      method: 'GET',
      path: '/panel',
      handler: (req, res) => {
        if (!this.requireCap(req, res)) return
        writeHtml(res, 200, this.panelHtml())
      },
    })
    g.register({
      method: 'GET',
      path: '/pair',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const code = url.searchParams.get('code') ?? ''
        writeHtml(res, 200, this.pairInfoHtml(code))
      },
    })
    g.register({
      method: 'GET',
      path: '/',
      handler: (_req, res) => {
        writeJson(res, 200, { ok: true, service: 'dsh-remote-phone', version: GATEWAY_VERSION, docs: '/pair, /panel, /api/*, /ws' })
      },
    })
  }

  private writeHarnessError(res: ServerResponse, outcome: { ok: false; error: { code?: string; message: string } }): void {
    const code = outcome.error.code ?? 'harness-error'
    const status = code === 'not-found' || code === 'session-not-found' || code === 'unknown-workspace' ? 404 : code === 'forbidden' ? 403 : 502
    writeError(res, status, code, outcome.error.message)
  }

  /** The pairing panel page (served by the gateway itself). */
  private panelHtml(): string {
    return renderPanelHtml(WHALE_SVG)
  }

  private pairInfoHtml(code: string): string {
    const escaped = code.replace(/[<>&"]/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[char]!)
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Remote Gateway 配对</title><style>
body{font:14px/1.6 -apple-system,"Segoe UI",sans-serif;background:#141416;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:20px}.card{max-width:420px;background:#1d1d20;border:1px solid #303034;border-radius:14px;padding:22px}.mono{font-family:ui-monospace,Consolas,monospace;background:#202023;border:1px solid #303034;border-radius:8px;padding:6px 10px;letter-spacing:2px}
</style></head><body><div class="card"><h2>🔗 DSH Remote Gateway</h2><p>请在 <b>DSH Remote</b> 手机 App 中使用配对码完成配对；本页仅供浏览器打开时人工确认。</p><p>配对码：<span class="mono">${escaped}</span></p></div></body></html>`
  }
}

class QrError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message)
  }
}

/** A self-contained control panel page (vanilla JS, no dependencies). */
function renderPanelHtml(whaleSvg: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH Remote Gateway · 配对面板</title><style>
:root{color-scheme:light dark}*{box-sizing:border-box}body{font:14px/1.5 -apple-system,"Segoe UI",sans-serif;margin:0;background:#fff;color:#1b1c1e}
@media(prefers-color-scheme:dark){body{background:#141416;color:#eee}}
.wrap{max-width:420px;margin:0 auto;padding:18px}h1{display:flex;align-items:center;gap:10px;font-size:17px;margin:0 0 4px}.sub{color:#888;font-size:12px;margin-bottom:14px}
.card{background:#f5f6f8;border:1px solid #e6e8eb;border-radius:12px;padding:14px;margin-bottom:12px}
@media(prefers-color-scheme:dark){.card{background:#1d1d20;border-color:#303034}}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{font:inherit;border-radius:8px;border:1px solid #cfd3d9;background:#fff;color:inherit;padding:7px 12px;cursor:pointer}
@media(prefers-color-scheme:dark){button{background:#26272b;border-color:#3a3b41}}
button.primary{background:#3358ff;border-color:#3358ff;color:#fff}button.danger{background:#ffe9e9;border-color:#f3b8b8;color:#b3261e}
@media(prefers-color-scheme:dark){button.danger{background:#3a2020;border-color:#7a3232;color:#ffb4a8}}
button.on{background:#2d7a3e;border-color:#2d7a3e;color:#fff}button:disabled{opacity:.5;cursor:not-allowed}
.qr{display:flex;justify-content:center;background:#fff;border-radius:10px;padding:10px;margin:10px 0}
.url{font:12px ui-monospace,Consolas,monospace;word-break:break-all;background:#eceef1;border-radius:6px;padding:8px}
@media(prefers-color-scheme:dark){.url{background:#26272b}}
.badge{display:inline-block;font-size:11px;border-radius:999px;padding:2px 8px;background:#e8ecf1;color:#444}
@media(prefers-color-scheme:dark){.badge{background:#2f3035;color:#ccc}}
.err{color:#b3261e;font-size:12px;min-height:18px;margin-top:6px}
.list{list-style:none;margin:8px 0 0;padding:0}.list li{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-top:1px solid #eef0f2}
@media(prefers-color-scheme:dark){.list li{border-top-color:#2b2c30}}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px}.dot.on{background:#2d9a50}.dot.off{background:#9aa0a6}
.muted{color:#888;font-size:12px}
</style></head><body><div class="wrap">
<h1><span style="color:#3358ff">${whaleSvg}</span> Remote Gateway <span class="badge" id="ver"></span></h1>
<div class="sub">在 DSH 桌面打开此面板；手机用 <b>DSH Remote</b> App 扫码配对。</div>

<div class="card"><b>连接模式</b>（改动立即生效）<div class="row" style="margin-top:8px">
<button id="btnLan">局域网模式</button><button id="btnPub">公网模式（Quick Tunnel）</button></div>
<div class="muted" id="modeHint"></div><div class="err" id="modeErr"></div></div>

<div class="card"><b>二维码配对</b>
<div class="row" style="margin-top:8px">
<button id="btnMint" class="primary">生成新配对码</button><button id="btnCopy">复制链接</button>
</div>
<div class="row" style="margin-top:8px">
<span class="muted" style="margin-right:2px">二维码地址：</span>
<button id="btnQrAuto">自动</button><button id="btnQrLan">局域网码</button><button id="btnQrTun">公网码</button>
</div>
<div class="qr" id="qrBox"><div id="qr">（点击"生成新配对码"）</div></div>
<div class="url" id="url">—</div>
<div class="muted" id="codeLine"></div><div class="err" id="qrErr"></div></div>

<div class="card"><b>已配对设备</b><span id="deviceCount" class="badge" style="margin-left:6px">0</span>
<button id="btnRevokeAll" class="danger" style="float:right">撤销全部</button>
<ul class="list" id="devices"></ul></div>
</div>
<script>
(function(){
  var cap = new URLSearchParams(location.search).get('cap') || '';
  function api(path, opts){ var o = opts||{}; return fetch(path, {method:o.method||'GET', headers:Object.assign({'x-rg-cap':cap, 'content-type':'application/json'}, o.headers||{}), body:o.body?JSON.stringify(o.body):undefined}).then(function(r){return r.json().then(function(j){return {status:r.status, json:j}})}); }
  function err(resp){ return (resp && resp.json && resp.json.error) ? (resp.json.error.code + ': ' + resp.json.error.message) : '请求失败'; }
  var state = null;
  var qrCache = { mode: '', url: '' };
  var qrPref = 'auto';
  function tunnelUp(){ return !!(state && state.tunnel && state.tunnel.phase==='running' && state.tunnel.url); }
  function modeOf(){ return tunnelUp() ? 'tunnel':'lan'; }
  function effectiveQrMode(){
    if (qrPref==='lan') return (state && state.lanMode===true) ? 'lan' : null;
    if (qrPref==='tunnel') return tunnelUp() ? 'tunnel' : null;
    if (tunnelUp()) return 'tunnel';
    if (state && state.lanMode===true) return 'lan';
    return null;
  }
  function refresh(){ api('/api/rg/state').then(function(r){ if(r.status===401){ document.body.innerHTML='<div style="padding:30px;text-align:center">面板授权已过期，请在电脑上重新打开。</div>'; return;} if(r.status!==200) return; state = r.json; render(); }).catch(function(){}); }
  function render(){
    document.getElementById('ver').textContent = 'v' + (state.version||'');
    document.getElementById('btnLan').classList.toggle('on', state.lanMode===true);
    document.getElementById('btnPub').classList.toggle('on', modeOf()==='tunnel');
    var hint = '';
    if (state.bindError) hint = '监听错误: ' + state.bindError + ' ';
    if (state.lanMode) hint += '局域网已启用：' + (state.lanAddresses||[]).map(function(a){return 'http://' + a + ':' + state.port;}).join('，');
    else hint += '仅本机可访问 (127.0.0.1:' + state.port + ')';
    var t = state.tunnel;
    if (t && t.phase==='running' && t.url) hint += '；公网: ' + t.url;
    else if (t && t.phase==='starting') hint += '；公网隧道创建中…';
    else if (t && t.phase==='failed') hint += '；公网隧道失败: ' + (t.error||'');
    document.getElementById('modeHint').textContent = hint;
    document.getElementById('deviceCount').textContent = String((state.devices||[]).length);
    var ul = document.getElementById('devices'); ul.innerHTML='';
    (state.devices||[]).forEach(function(d){ var li=document.createElement('li'); var span=document.createElement('span');
      span.innerHTML='<span class="dot ' + (d.online?'on':'off') + '"></span>' + escapeHtml(d.name||d.id) + '<div class="muted">' + (d.os||'') + ' · ' + (d.online?'在线':'离线') + '</div>';
      var b=document.createElement('button'); b.className='danger'; b.textContent='撤销'; b.onclick=function(){ revokeOne(d.id); };
      li.appendChild(span); li.appendChild(b); ul.appendChild(li); });
    if (state.pairing) {
      var code = state.pairing.code;
      var eff = effectiveQrMode();
      var src = eff === 'tunnel' ? '（公网码，手机在任何网络都可扫）' : eff === 'lan' ? '（局域网码，手机需与电脑同网段）' : '';
      document.getElementById('codeLine').textContent = '配对码：' + code.slice(0,4) + '-' + code.slice(4) + '（有效期至 ' + new Date(state.pairing.expiresAt).toLocaleTimeString() + '）' + src;
    } else {
      document.getElementById('codeLine').textContent = '';
    }
    var mode = effectiveQrMode();
    document.getElementById('btnQrAuto').classList.toggle('on', qrPref==='auto');
    document.getElementById('btnQrLan').classList.toggle('on', qrPref==='lan');
    document.getElementById('btnQrTun').classList.toggle('on', qrPref==='tunnel');
    maybeLoadQr();
  }
  function escapeHtml(s){ return String(s).replace(/[<>&"]/g, function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];}); }
  function maybeLoadQr(){
    var mode = effectiveQrMode();
    if (!mode || !state || !state.pairing) {
      if (qrCache.mode !== '-') {
        qrCache.mode='-'; qrCache.url='';
        var why = !state ? '正在读取状态…'
          : !state.pairing ? '（点击"生成新配对码"）'
          : qrPref === 'lan' ? '局域网未启用：请先点“局域网模式”'
          : qrPref === 'tunnel' ? '公网未开启：请先点“公网模式”'
          : '启用局域网或公网模式后，此处显示二维码';
        document.getElementById('qr').innerHTML = why;
        document.getElementById('url').textContent = '—';
        document.getElementById('qrErr').textContent = '';
      }
      return;
    }
    var urlKey = mode + '|' + state.pairing.code + '|' + state.pairing.expiresAt;
    if (qrCache.mode === mode && qrCache.url === urlKey) return;
    qrCache.mode = mode; qrCache.url = urlKey;
    var ip = '';
    api('/api/rg/qr?mode=' + mode + (ip?('&ip='+ip):'')).then(function(r){
      if (r.status===200){ document.getElementById('qr').innerHTML = r.json.svg; document.getElementById('url').textContent = r.json.url; document.getElementById('qrErr').textContent = ''; }
      else { document.getElementById('qr').innerHTML = '—'; document.getElementById('qrErr').textContent = err(r); }
    }).catch(function(){});
  }
  function setQrPref(pref){ qrPref = pref; qrCache.mode=''; qrCache.url=''; if (state) render(); }
  document.getElementById('btnQrAuto').onclick = function(){ setQrPref('auto'); };
  document.getElementById('btnQrLan').onclick = function(){ setQrPref('lan'); };
  document.getElementById('btnQrTun').onclick = function(){ setQrPref('tunnel'); };
  document.getElementById('btnMint').onclick = function(){ api('/api/pair', {method:'POST'}).then(function(r){ if(r.status===200){ state=r.json; state.lanMode = (r.json.lan && r.json.lan.length>0); render(); } else { document.getElementById('qrErr').textContent = err(r); } }); };
  document.getElementById('btnCopy').onclick = function(){ navigator.clipboard && navigator.clipboard.writeText(document.getElementById('url').textContent); };
  document.getElementById('btnLan').onclick = function(){ if (state && state.lanMode===true) return; api('/api/rg/mode', {method:'POST', body:{lan:true}}).then(function(r){ if(r.status===200){ state=r.json; render(); } else { document.getElementById('modeErr').textContent = err(r); } }); };
  document.getElementById('btnPub').onclick = function(){ var on = !(state && state.tunnel && state.tunnel.phase==='running'); api('/api/rg/tunnel', {method:'POST', body:{enable:on}}).then(function(r){ if(r.status===200){ state=r.json; render(); if(on){ setTimeout(function(){ refresh(); }, 1500); } } else { document.getElementById('modeErr').textContent = err(r); } }); };
  function revokeOne(id){ api('/api/pair/revoke', {method:'POST', body:{deviceId:id}}).then(function(r){ refresh(); }); }
  document.getElementById('btnRevokeAll').onclick = function(){ api('/api/rg/revoke-all', {method:'POST'}).then(function(){ refresh(); }); };
  function start(){ document.getElementById('btnMint').click(); setInterval(refresh, 2000); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
</script></body></html>`
}
