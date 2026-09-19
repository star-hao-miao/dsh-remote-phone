/**
 * DSH home / file layout resolution for the remote gateway state.
 *
 * Layout (mirrors the conventions of sibling remote plugins):
 *   $DSH_HOME/remote-gateway.json            gateway prefs + signing secret
 *   $DSH_HOME/remote-gateway-devices.json    paired device sessions
 *   $DSH_HOME/remote-gateway/cloudflared(.exe)  tunnel binary cache
 */

import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Expand a leading `~` in a path. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(home, path.slice(2))
  return path
}

/** DSH home: $DSH_HOME wins, else ~/.dsh (matches the dsh CLI). */
export function dshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.DSH_HOME
  if (raw !== undefined && raw.trim() !== '') {
    const expanded = expandHome(raw.trim())
    return isAbsolute(expanded) ? expanded : resolve(expanded)
  }
  return join(homedir(), '.dsh')
}

/** Prefs + HMAC secret store: $DSH_HOME/remote-gateway.json. */
export function prefsFile(home: string = dshHome()): string {
  return join(home, 'remote-gateway.json')
}

/** Device session store: $DSH_HOME/remote-gateway-devices.json. */
export function devicesFile(home: string = dshHome()): string {
  return join(home, 'remote-gateway-devices.json')
}

/** Directory holding the tunnel binary cache. */
export function tunnelBinDir(home: string = dshHome()): string {
  return join(home, 'remote-gateway')
}

/** The default gateway port. */
export const DEFAULT_PORT = 3080

/** Default LAN bind state (loopback until the user opts in). */
export const DEFAULT_BIND_LAN = false

/** Default auto tunnel state. */
export const DEFAULT_AUTO_TUNNEL = false
