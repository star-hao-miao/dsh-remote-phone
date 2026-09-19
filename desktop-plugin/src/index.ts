/**
 * dsh-remote-phone — host half.
 *
 * Loads as a cordis bundle plugin row (`cordis.patch.yml` inserts
 * { id: remote-gateway, name: dsh-remote-phone }). Exports the cordis
 * contract: name / inject / apply. Mounting is idempotent within a process
 * (mountOnce), mirroring the family convention.
 */

import { loadPrefs, resolveSettings, savePrefs, type GatewayConfig } from './config.js'
import { GatewayApp } from './app.js'
import { dshHome } from './util/env.js'
import { mountDesktopProbe, type WebServerLike } from './desktop-probe.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'remote-gateway'

/** Host services the plugin needs before mounting. */
export const inject = ['webServer', 'connection']

/**
 * Minimal structural host context (the real one is merged by the official
 * @deepseek-ai packages; only the members used below are declared here).
 */
interface HostContextLike {
  webServer: {
    host: string
    port: number
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }): () => void
  }
  connection?: {
    authenticatedUrl?: (base: string) => string | undefined
  }
  effect(fn: () => void | (() => void), label?: string): () => void
  get<T>(name: string): T | undefined
}

function mountOnce(
  packageName: string,
  applyImpl: (ctx: unknown, config?: GatewayConfig) => (() => void) | undefined,
): (ctx: unknown, config?: GatewayConfig) => void {
  const registry = (globalThis as Record<symbol, Set<string>>)[Symbol.for('dsh-web.mounted-plugins')] ?? new Set<string>()
  ;(globalThis as Record<symbol, Set<string>>)[Symbol.for('dsh-web.mounted-plugins')] = registry
  const key = packageName
  return (ctx, config) => {
    if (registry.has(key)) return
    registry.add(key)
    const unmarker = applyImpl(ctx, config)
    const context = ctx as HostContextLike
    context.effect(() => () => {
      registry.delete(key)
      unmarker?.()
    }, `dsh-remote-phone: mount guard (${key})`)
  }
}

export const apply = mountOnce('dsh-remote-phone', applyImpl)

function applyImpl(ctx: unknown, config?: GatewayConfig): (() => void) | undefined {
  const host = ctx as HostContextLike
  const home = dshHome()
  // Load persisted prefs once; config (the cordis patch row) wins per field at
  // resolve time. Runtime toggles mutate and persist the prefs object.
  const prefsRef = { current: loadPrefs(config, home) }
  const settings = (): ReturnType<typeof resolveSettings> => resolveSettings(config, prefsRef.current)
  const persist = (patch: { bindLan?: boolean; autoTunnel?: boolean; port?: number }): void => {
    prefsRef.current = { ...prefsRef.current, ...patch }
    savePrefs(prefsRef.current, home)
  }

  const webServerPort = (): number | undefined => (Number.isFinite(host.webServer.port) ? host.webServer.port : undefined)
  const launchUrl = (): string | undefined => {
    const port = webServerPort()
    if (port === undefined) return undefined
    try {
      return host.connection?.authenticatedUrl?.(`http://127.0.0.1:${port}/`)
    } catch {
      return undefined
    }
  }

  const app = new GatewayApp({
    settings,
    persist,
    webServerPort,
    launchUrl,
    log: (message: string) => {
      try {
        // eslint-disable-next-line no-console
        console.log(`[remote-gateway] ${message}`)
      } catch {
        // noop
      }
    },
  })

  // The desktop probe on the official webServer (fenced, loopback only).
  const probeDispose = host.effect(() => {
    try {
      return mountDesktopProbe(host.webServer as WebServerLike, {
        settings,
        gatewayPort: () => app.gateway.currentBind()?.port,
      })
    } catch (error) {
      console.error(`[remote-gateway] desktop probe failed to mount: ${error instanceof Error ? error.message : String(error)}`)
      return () => undefined
    }
  }, 'remote-gateway: desktop probe')

  void app.start().catch((error: unknown) => {
    console.error(`[remote-gateway] start failed: ${error instanceof Error ? error.message : String(error)}`)
  })

  // Teardown: stop tunnel, mux, gateway.
  return () => {
    probeDispose()
    void app.dispose().catch(() => undefined)
  }
}
