/**
 * The Remote Gateway HTTP+WebSocket server.
 *
 * A standalone node:http server (own port, default 3080) with an exact-path
 * route table plus a `/ws` WebSocket endpoint for authenticated device event
 * streams. Binds loopback by default; `rebind('0.0.0.0')` exposes it on the
 * LAN. Route security is enforced per-route in `routes.ts` (device JWT for
 * data routes, desktop capability token for control routes, and a
 * loopback-only fence for minting).
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { writeError, writeJson, matchRoute } from './util/http.js'

export interface GatewayRoute {
  method: string
  /** Path template, `/api/sessions/:id` style. */
  path: string
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    url: URL,
  ) => void | Promise<void>
}

export interface GatewayEvents {
  /** Fired after every (re)bind with the current binding. */
  onStateChange: () => void
  /** Fired when a client completes the WS auth handshake. */
  onWsAuth: (deviceId: string) => void
  /** Fired when an authenticated WS client disconnects. */
  onWsClose: (deviceId: string) => void
  /** Fired for each parsed JSON text frame from an authenticated client. */
  onWsMessage?: (deviceId: string, frame: Record<string, unknown>) => void
}

export interface GatewayBind {
  host: string
  port: number
}

const WS_DEVICE_ID = Symbol('remote-gateway.ws.deviceId')

export class GatewayServer {
  private server: Server | undefined
  private wss: WebSocketServer | undefined
  private readonly routes: GatewayRoute[] = []
  private readonly wsSockets = new Map<WebSocket, { deviceId: string }>()
  private bindPromise: Promise<GatewayBind> | undefined

  constructor(private readonly listeners: GatewayEvents) {}

  /** The current binding, if listening. */
  currentBind(): GatewayBind | undefined {
    const address = this.server?.address()
    if (address === null || typeof address === 'string' || address === undefined) return undefined
    const host = this.server !== undefined ? (this.listenHost ?? '127.0.0.1') : undefined
    return host === undefined ? undefined : { host, port: address.port }
  }

  private listenHost: string | undefined

  register(route: GatewayRoute): void {
    this.routes.push(route)
  }

  /** True when the server is currently listening. */
  isListening(): boolean {
    return this.server !== undefined && this.server.listening
  }

  /**
   * Bind the server. The port is taken from `preferredPort`, drifting to the
   * next free one on conflict (clients always read the live port back).
   */
  listen(host: string, preferredPort: number): Promise<GatewayBind> {
    if (this.bindPromise !== undefined) return this.bindPromise
    this.bindPromise = this.doListen(host, preferredPort).finally(() => {
      this.bindPromise = undefined
    })
    return this.bindPromise
  }

  private doListen(host: string, preferredPort: number): Promise<GatewayBind> {
    const server = createServer((req, res) => {
      // Fire-and-forget, but never allowed to reject: an unhandled rejection
      // here would surface as a harness-wide `fatal load failure`.
      void this.handleRequest(req, res).catch(error => this.failRequest(res, error, 'listener'))
    })
    this.listenHost = host
    this.server = server

    const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
    wss.on('connection', (socket, request) => {
      const deviceId = (request as IncomingMessage & { [WS_DEVICE_ID]?: string })[WS_DEVICE_ID]
      if (deviceId === undefined) {
        socket.close(4401, 'unauthorized')
        return
      }
      this.wsSockets.set(socket, { deviceId })
      this.listeners.onWsAuth(deviceId)
      socket.on('close', () => {
        if (this.wsSockets.delete(socket)) this.listeners.onWsClose(deviceId)
      })
      socket.on('error', () => {
        socket.close()
      })
      socket.on('message', (data) => {
        let frame: unknown
        try {
          frame = JSON.parse(data.toString())
        } catch {
          return
        }
        if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) {
          this.listeners.onWsMessage?.(deviceId, frame as Record<string, unknown>)
        }
      })
    })
    wss.on('error', (error) => {
      // Surface instead of crashing the process.
      console.error(`[remote-gateway] ws error: ${error instanceof Error ? error.message : String(error)}`)
    })
    this.wss = wss

    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket as Duplex & { destroy(err?: Error): void }, head).catch(() => {
        try {
          socket.destroy()
        } catch {
          // ignore
        }
      })
    })

    return new Promise<GatewayBind>((resolvePromise, rejectPromise) => {
      const attempt = (port: number, attemptCount: number): void => {
        server.once('error', (error: NodeJS.ErrnoException) => {
          if (error.code === 'EADDRINUSE' && attemptCount < 50) {
            attempt(port + 1, attemptCount + 1)
            return
          }
          this.teardownServer()
          rejectPromise(error)
        })
        server.listen(port, host, () => {
          const address = server.address()
          const livePort = typeof address === 'object' && address !== null ? address.port : port
          this.listeners.onStateChange()
          resolvePromise({ host, port: livePort })
        })
      }
      attempt(preferredPort, 0)
    })
  }

  /** Close the current listener (no-op when not listening). */
  async close(): Promise<void> {
    const server = this.server
    const wss = this.wss
    if (server === undefined && wss === undefined) return
    this.server = undefined
    this.wss = undefined
    this.wsSockets.clear()
    if (wss !== undefined) {
      for (const socket of wss.clients ?? []) socket.close(1001, 'gateway restart')
    }
    await new Promise<void>(resolveServer => {
      if (server !== undefined && server.listening) {
        server.close(() => resolveServer())
        // Also resolve when no sockets remain but close hangs on keep-alive.
        server.closeAllConnections?.()
      } else {
        resolveServer()
      }
    })
    this.listeners.onStateChange()
  }

  /** Rebind to a different host, keeping the live port. */
  async rebind(host: string): Promise<GatewayBind> {
    const bind = this.currentBind()
    const port = bind?.port ?? 0
    await this.close()
    return this.listen(host, port)
  }

  /** Publish a JSON event frame to every authenticated WS client. */
  broadcast(frame: Record<string, unknown>): void {
    const wss = this.wss
    if (wss === undefined) return
    const payload = JSON.stringify(frame)
    for (const socket of wss.clients ?? []) {
      if (this.wsSockets.has(socket)) {
        try {
          socket.send(payload)
        } catch {
          // gone; close handler cleans up
        }
      }
    }
  }

  /** Device ids currently attached over /ws. */
  authedDeviceIds(): string[] {
    return [...this.wsSockets.values()].map(entry => entry.deviceId)
  }

  private async handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const wss = this.wss
    if (wss === undefined) {
      socket.destroy()
      return
    }
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      socket.destroy()
      return
    }
    if (url.pathname !== '/ws') {
      socket.destroy()
      return
    }
    const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? url.searchParams.get('token') ?? ''
    const authed = await this.authenticateWs(req, token)
    if (!authed.ok) {
      // Refuse before the 101 handshake.
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
      return
    }
    ;(req as IncomingMessage & { [WS_DEVICE_ID]?: string })[WS_DEVICE_ID] = authed.deviceId
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  /**
   * Overridden by the gateway owner to authenticate a WS upgrade (device JWT
   * via ?token= or Authorization: Bearer).
   */
  authenticateWs(
    _req: IncomingMessage,
    _token: string,
  ): Promise<{ ok: true; deviceId: string } | { ok: false }> {
    return Promise.resolve({ ok: false })
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const method = (req.method ?? 'GET').toUpperCase()
      for (const route of this.routes) {
        if (route.method.toUpperCase() !== method) continue
        const matched = matchRoute(route.path, url.pathname)
        if (matched === undefined) continue
        await route.handler(req, res, matched.params, url)
        return
      }
      writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `${method} ${url.pathname}` } })
    } catch (error) {
      this.failRequest(res, error, `${req.method ?? 'GET'} ${req.url ?? '/'}`)
    }
  }

  /**
   * Report a handler failure without ever throwing again.
   *
   * Writing a second response (or a response after the handler already sent
   * headers) throws `ERR_HTTP_HEADERS_SENT`; because the request listener runs
   * fire-and-forget, that secondary throw became an unhandled rejection and
   * took the whole harness process down (`dsh: fatal load failure`).
   */
  private failRequest(res: ServerResponse, error: unknown, context: string): void {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[remote-gateway] request failed (${context}): ${message}`)
    try {
      if (res.headersSent) {
        // The handler already started answering: cut the connection instead of
        // attempting a second header write.
        res.destroy()
        return
      }
      writeError(res, 500, 'internal', message)
    } catch {
      // Never let error reporting escalate.
      try {
        res.destroy()
      } catch {
        // ignore
      }
    }
  }

  private teardownServer(): void {
    this.server?.close()
    this.server = undefined
    this.wss = undefined
  }

  /** Dispose everything (plugin teardown). */
  async dispose(): Promise<void> {
    await this.close()
  }
}
