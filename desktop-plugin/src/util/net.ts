/**
 * Network helpers: LAN IPv4 enumeration and request-origin fences.
 */

import { networkInterfaces } from 'node:os'
import type { IncomingMessage } from 'node:http'

function octetsOf(address: string): number[] {
  return address.split('.').map(part => Number.parseInt(part, 10))
}

/** Is the IPv4 dotted address inside a private-use / link-local range? */
function isPrivateIPv4(address: string): boolean {
  const o = octetsOf(address)
  if (o.length !== 4 || o.some(part => Number.isNaN(part))) return false
  const [a, b] = o as [number, number, number, number]
  if (a === 10) return true // 10/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16/12
  if (a === 192 && b === 168) return true // 192.168/16
  if (a === 169 && b === 254) return true // link-local, e.g. 169.254.x.x
  return false
}

/** LAN-reachable IPv4 addresses of this host (private ranges only). */
export function lanIPv4Addresses(): string[] {
  const result: string[] = []
  for (const addresses of Object.values(networkInterfaces())) {
    for (const iface of addresses ?? []) {
      if (iface.family !== 'IPv4' || iface.internal) continue
      if (isPrivateIPv4(iface.address)) result.push(iface.address)
    }
  }
  return [...new Set(result)]
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])

export function isLoopbackAddress(hostOrIp: string): boolean {
  const lower = hostOrIp.toLowerCase()
  if (LOOPBACK_HOSTS.has(lower)) return true
  return lower.startsWith('127.')
}

/** The remote socket address of a request (IPv4-mapped IPv6 normalized). */
export function socketAddress(req: IncomingMessage): string {
  const addr = req.socket.remoteAddress
  if (typeof addr !== 'string') return ''
  return addr.startsWith('::ffff:') ? addr.slice(7) : addr
}

/**
 * Is the peer a direct loopback client — i.e. NOT arriving through the
 * Cloudflare quick tunnel? Quick tunnels connect from 127.0.0.1 and stamp an
 * X-Forwarded-For header naming the real client; a forwarded first hop that
 * is not loopback means the caller is remote, and it must never satisfy a
 * loopback fence.
 */
export function isDirectLoopbackClient(req: IncomingMessage): boolean {
  if (!isLoopbackAddress(socketAddress(req))) return false
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string') {
    const first = forwarded.split(',', 1)[0]?.trim() ?? ''
    if (first !== '' && !isLoopbackAddress(first)) return false
  }
  return true
}
