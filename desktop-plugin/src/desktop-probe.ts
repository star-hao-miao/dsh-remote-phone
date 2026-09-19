/**
 * The desktop probe: one route on the *official* webServer
 * (GET /api/remote-gateway/config) that the browser half (the whale button)
 * fetches same-origin to discover the gateway port and redeem a desktop
 * capability token. It is loopback-fenced: the Host header must be a
 * loopback literal and any attached Origin must match the request Host, so a
 * GUI opened from a LAN/tunnel origin can never mint a control token.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { isLoopbackAddress, isLoopbackAddress as isLoopback } from './util/net.js'
import { signJwt } from './util/crypto.js'
import { GATEWAY_VERSION } from './asset.js'
import type { ResolvedSettings } from './config.js'

/** Minimal structural view of the services we touch (official types come from
 *  @deepseek-ai/* at build time for consumers; the plugin itself stays
 *  dependency-free at runtime). */
export interface WebServerLike {
  host: string
  port: number
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
}

interface ProbeDeps {
  settings: () => ResolvedSettings
  /** Resolve the live gateway port (undefined before the gateway listens). */
  gatewayPort: () => number | undefined
}

/** Copy of the connection plugin's browser fence (Host/Origin based). */
function isLoopbackFencedRequest(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname.toLowerCase()
  if (!isLoopbackAddress(hostname) && hostname !== 'localhost') return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/**
 * Register the probe route. Returns a disposer.
 * @param webServer - the official webServer service (from the plugin ctx).
 */
export function mountDesktopProbe(webServer: WebServerLike, deps: ProbeDeps): () => void {
  const disposers: Array<() => void> = []
  disposers.push(
    webServer.register({
      kind: 'prefix',
      path: '/api/remote-gateway',
      handler: (req, res) => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== '/api/remote-gateway/config') {
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'not-found', message: url.pathname } }))
          return
        }
        if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
          res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed' } }))
          return
        }
        if (!isLoopbackFencedRequest(req)) {
          res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'forbidden', message: '配对面板仅限电脑本机使用' } }))
          return
        }
        const settings = deps.settings()
        if (!settings.enabled) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: true, enabled: false }))
          return
        }
        const port = deps.gatewayPort()
        if (port === undefined) {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify({ ok: false, error: { code: 'gateway-not-ready', message: '网关尚未就绪' } }))
          return
        }
        const cap = signJwt(
          settings.secret,
          { sub: 'desktop', aud: 'desktop', iss: 'dsh-remote-phone' },
          settings.desktopCapTtlMs,
        )
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(
          JSON.stringify({
            ok: true,
            service: 'dsh-remote-phone',
            version: GATEWAY_VERSION,
            enabled: true,
            port,
            bindHost: webServer.host,
            cap,
            panelPath: `/panel?cap=${encodeURIComponent(cap)}`,
          }),
        )
      },
    }),
  )
  return () => {
    for (const dispose of disposers.splice(0)) dispose()
  }
}

export { isLoopback }
