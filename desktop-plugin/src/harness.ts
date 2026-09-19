/**
 * Harness loopback client: the plugin talks to the *official* harness web
 * server as an inner client (fetch with the process's own browser credential)
 * and speaks the official RPC envelope + remote.mux WebSocket protocol.
 *
 * Wire summary (see docs/HARNESS-API.md for sources):
 *   unary   POST /api/<ns>/<method>  body {type:"client-request",rpcId,method,
 *                                     payload:{args}} → result at
 *                                     body.result.value / .error
 *   mux     ws://127.0.0.1:<port>/api/remote.mux        text frames
 *                                     open|cancel|item|end|error|ready|emit|waterfall
 *   cookie  dsh-auth-<b64(sha256(authority))> minted by GET <base>/?token=
 */

import { randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import WebSocket, { type RawData } from 'ws'

export const BROWSER_AUTH_COOKIE_PREFIX = 'dsh-auth-'

/** Verbose mux/stream tracing, enabled with DSH_REMOTE_GATEWAY_DEBUG=1. */
const DEBUG = process.env.DSH_REMOTE_GATEWAY_DEBUG === '1'

export interface HarnessError {
  code?: string
  message: string
  details?: unknown
}

/** Result of an official unary RPC call. */
export type RpcOutcome<T> = { ok: true; value: T } | { ok: false; error: HarnessError }

/**
 * Inner browser credential for one loopback authority. Minted by redeeming
 * the process launch token (GET base/?token=… with redirect manual, capture
 * the Set-Cookie) — the same exchange a browser performs on first visit.
 */
export class InnerAuth {
  private cached: string | undefined
  private inflight: Promise<string | undefined> | undefined

  constructor(
    private readonly launchUrl: () => string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async ready(): Promise<string | undefined> {
    if (this.cached !== undefined) return this.cached
    this.inflight ??= this.redeem().then(
      value => {
        if (value !== undefined) this.cached = value
        this.inflight = undefined
        return value
      },
      () => {
        this.inflight = undefined
        return undefined
      },
    )
    return this.inflight
  }

  invalidate(): void {
    this.cached = undefined
  }

  private async redeem(): Promise<string | undefined> {
    const url = this.launchUrl()
    if (url === undefined) return undefined
    try {
      const response = await this.fetchImpl(url, { redirect: 'manual' })
      const raw = response.headers.get('set-cookie')
      if (raw === null) return undefined
      const entry = raw
        .split(',')
        .map(part => part.trim())
        .find(part => part.startsWith(BROWSER_AUTH_COOKIE_PREFIX))
      if (entry === undefined) return undefined
      const pair = entry.split(';')[0]?.trim()
      return pair !== undefined && pair.includes('=') ? pair : undefined
    } catch {
      return undefined
    }
  }
}

interface ServerResponseEnvelope {
  type?: string
  rpcId?: string
  result?: { ok?: boolean; value?: unknown; error?: HarnessError }
}

/**
 * Unary RPC client over the official /api envelope. Every call re-issues once
 * when the credential expired (HTTP 401) by re-redeeming the inner cookie.
 */
export class HarnessRpc {
  constructor(
    private readonly port: () => number | undefined,
    private readonly auth: InnerAuth,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private baseUrl(): string | undefined {
    const port = this.port()
    if (port === undefined) return undefined
    return `http://127.0.0.1:${port}`
  }

  /** Call <ns>/<method> (path /api/<ns>/<method>). */
  async call(nsMethod: string, args: Record<string, unknown>, opts: { timeoutMs?: number } = {}): Promise<RpcOutcome<unknown>> {
    const result = await this.attempt(nsMethod, args, opts, 0)
    return result
  }

  private async attempt(
    nsMethod: string,
    args: Record<string, unknown>,
    opts: { timeoutMs?: number },
    retried: number,
  ): Promise<RpcOutcome<unknown>> {
    const base = this.baseUrl()
    if (base === undefined) {
      return { ok: false, error: { code: 'harness-unavailable', message: 'harness web server port unknown' } }
    }
    const cookie = await this.auth.ready()
    const timeoutMs = opts.timeoutMs ?? 30_000
    const body = {
      type: 'client-request',
      rpcId: randomUUID(),
      method: nsMethod,
      payload: { args },
    }
    try {
      const response = await this.fetchImpl(`${base}/api/${nsMethod}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cookie !== undefined ? { cookie } : {}),
        },
        body: JSON.stringify(body),
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      })
      if (response.status === 401 && retried === 0) {
        this.auth.invalidate()
        return this.attempt(nsMethod, args, opts, 1)
      }
      if (response.status === 403) {
        return { ok: false, error: { code: 'forbidden', message: `harness /api refused this origin (HTTP ${response.status})` } }
      }
      if (!response.ok) {
        return { ok: false, error: { code: 'harness-http', message: `harness answered HTTP ${response.status}` } }
      }
      const envelope = (await response.json()) as ServerResponseEnvelope
      if (envelope.result?.ok === true) return { ok: true, value: envelope.result.value }
      const error = envelope.result?.error
      return { ok: false, error: error ?? { code: 'harness-error', message: 'malformed harness response' } }
    } catch (error) {
      const code = error instanceof Error && error.name === 'TimeoutError' ? 'harness-timeout' : 'harness-network'
      return { ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }
    }
  }
}

/** Inbound mux frames (server → client). */
export type MuxInbound =
  | { type: 'ready'; clientId: string; host: { home?: string } }
  | { type: 'item'; streamId: string; value: unknown }
  | { type: 'end'; streamId: string }
  | { type: 'error'; streamId: string; error: HarnessError }
  | { type: 'emit'; event: string; args: unknown[] }
  | { type: 'waterfall'; event: string; eventId: string; agentId: string; request: Record<string, unknown> }

interface StreamSpec {
  endpoint: string
  payload: Record<string, unknown>
  onItem: (value: unknown) => void
  onEnd?: () => void
}

/**
 * Remote-mux client (single physical WS): opens logical streams
 * (`workspace/follow`, `$events`, …) and dispatches inbound frames. Reconnects
 * with backoff and replays the subscribed streams after each reconnect; frames
 * are only replayed once the next `ready` arrives.
 */
export class HarnessMux {
  private ws: WebSocket | undefined
  private readonly streams = new Map<string, StreamSpec>()
  private nextStreamId = 1
  private clientId: string | undefined
  private closedByUs = false
  private reconnectAttempt = 0
  private reconnectTimer: NodeJS.Timeout | undefined

  /** Listener for global (non-stream) frames: emits and waterfalls. */
  onGlobal: ((frame: MuxInbound) => void) | undefined

  constructor(
    private readonly port: () => number | undefined,
    private readonly auth: InnerAuth,
  ) {}

  connect(): void {
    this.closedByUs = false
    void this.doConnect()
  }

  private url(): string | undefined {
    const port = this.port()
    if (port === undefined) return undefined
    return `ws://127.0.0.1:${port}/api/remote.mux`
  }

  private async doConnect(): Promise<void> {
    const url = this.url()
    if (url === undefined) return
    const cookie = await this.auth.ready()
    if (DEBUG) {
      console.log(`[remote-gateway:debug] mux connect ${url} cookie=${cookie === undefined ? 'MISSING' : 'ok'}`)
    }
    const ws = new WebSocket(url, {
      headers: cookie !== undefined ? { cookie } : undefined,
      handshakeTimeout: 10_000,
    })
    this.ws = ws
    ws.on('open', () => {
      this.reconnectAttempt = 0
      this.clientId = undefined
      // The carrier never sends a socket-level "ready": logical streams must be
      // opened as soon as the socket is up (the `$events` stream's first item is
      // the generation marker). Waiting for a carrier-level ready deadlocked
      // every stream on this harness line.
      this.openAllStreams()
    })
    ws.on('message', (data: RawData) => {
      let frame: MuxInbound
      try {
        frame = JSON.parse(data.toString()) as MuxInbound
      } catch {
        if (DEBUG) console.log('[remote-gateway:debug] mux <- unparsable frame')
        return
      }
      this.handleFrame(frame)
    })
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.ws === ws) this.ws = undefined
      if (DEBUG) {
        console.log(`[remote-gateway:debug] mux ws close code=${code} reason=${reason?.toString() ?? ''} closedByUs=${this.closedByUs}`)
      }
      if (this.closedByUs) return
      const delay = Math.min(15_000, 500 * 2 ** this.reconnectAttempt)
      this.reconnectAttempt += 1
      this.reconnectTimer = setTimeout(() => this.doConnect(), delay)
    })
    ws.on('error', (error: Error) => {
      if (DEBUG) console.log(`[remote-gateway:debug] mux ws error: ${error.message}`)
    })
  }

  private handleFrame(frame: MuxInbound): void {
    if (DEBUG) {
      const detail = frame.type === 'item'
        ? ` stream=${frame.streamId} value=${JSON.stringify(frame.value).slice(0, 160)}`
        : frame.type === 'error'
          ? ` stream=${frame.streamId} error=${JSON.stringify(frame.error)}`
          : frame.type === 'emit' || frame.type === 'waterfall'
            ? ` event=${frame.event}`
            : ''
      console.log(`[remote-gateway:debug] mux <- ${frame.type}${detail}`)
    }
    switch (frame.type) {
      case 'ready': {
        // Not emitted by the mux carrier itself on this line, but harmless to
        // honour if a future build adds it.
        this.clientId = frame.clientId
        this.openAllStreams()
        return
      }
      case 'item': {
        const spec = this.streams.get(frame.streamId)
        if (spec === undefined) return
        // The `$events` stream carries its own control items: the FIRST item is
        // `{type:'ready', clientId}` (the generation marker used for
        // `$events/result` replies), followed by `{type:'emit'|'waterfall'|'cancel'}`
        // items. They arrive as *items*, not as carrier-level frames.
        const value = frame.value
        if (spec.endpoint === '$events') {
          const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined
          if (record?.type === 'ready' && typeof record.clientId === 'string') {
            this.clientId = record.clientId
            if (DEBUG) console.log(`[remote-gateway:debug] $events ready clientId=${record.clientId}`)
          }
        }
        spec.onItem(value)
        return
      }
      case 'end': {
        this.streams.get(frame.streamId)?.onEnd?.()
        return
      }
      case 'error': {
        const spec = this.streams.get(frame.streamId)
        console.error(
          `[remote-gateway] harness stream error (${spec?.endpoint ?? 'unknown'}): ${JSON.stringify(frame.error)}`,
        )
        this.onGlobal?.({ type: 'error', streamId: frame.streamId, error: frame.error })
        return
      }
      case 'emit':
      case 'waterfall': {
        // Fallback: some builds deliver these as carrier-level frames.
        this.onGlobal?.(frame)
        return
      }
    }
  }

  private sendFrame(frame: Record<string, unknown>): void {
    const ws = this.ws
    if (ws === undefined || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(frame))
  }

  /** (Re)open every subscribed logical stream on the current socket. */
  private openAllStreams(): void {
    for (const [streamId, spec] of this.streams) {
      this.sendFrame({ type: 'open', streamId, endpoint: spec.endpoint, payload: spec.payload })
      if (DEBUG) {
        console.log(
          `[remote-gateway:debug] mux -> open ${spec.endpoint} stream=${streamId} payload=${JSON.stringify(spec.payload)}`,
        )
      }
    }
  }

  /** Open a logical stream. Items/ends dispatch to the given handlers. */
  open(endpoint: string, payload: Record<string, unknown>, spec: Omit<StreamSpec, 'endpoint' | 'payload'>): string {
    const streamId = `rg-${this.nextStreamId++}-${randomUUID()}`
    this.streams.set(streamId, { endpoint, payload, onItem: spec.onItem, onEnd: spec.onEnd })
    if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) {
      // The server queues domain streams until the ready frame; opening before
      // ready is fine (the client waits for ready to re-open/replay).
      this.sendFrame({ type: 'open', streamId, endpoint, payload })
    }
    return streamId
  }

  cancel(streamId: string): void {
    this.streams.delete(streamId)
    this.sendFrame({ type: 'cancel', streamId })
  }

  /** The clientId from the last ready frame (for $events result replies). */
  readyClientId(): string | undefined {
    return this.clientId
  }

  isConnected(): boolean {
    return this.ws !== undefined && this.ws.readyState === WebSocket.OPEN
  }

  dispose(): void {
    this.closedByUs = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.streams.clear()
    this.ws?.close()
    this.ws = undefined
  }
}
