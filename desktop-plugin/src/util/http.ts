/**
 * Shared HTTP helpers for the gateway's route handlers: bounded JSON body
 * reads, JSON/text writers, and a small exact + `:param` route matcher.
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'

export const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'referrer-policy': 'no-referrer',
} satisfies OutgoingHttpHeaders

export const DEFAULT_BODY_MAX = 64 * 1024

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read a request body as JSON, bounded to `maxBytes`. Resolves null for an
 * empty body, invalid JSON, or an over-limit body (the request is destroyed
 * in the over-limit case).
 */
export async function readJsonBody(
  req: IncomingMessage,
  opts: { maxBytes?: number; objectOnly?: boolean } = {},
): Promise<unknown | null> {
  const maxBytes = opts.maxBytes ?? DEFAULT_BODY_MAX
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > maxBytes) {
      req.destroy()
      return null
    }
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text === '') return null
  try {
    const parsed: unknown = JSON.parse(text)
    if (opts.objectOnly && !isJsonObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: OutgoingHttpHeaders = {},
): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, ...headers })
  res.end(payload)
}

export function writeText(
  res: ServerResponse,
  status: number,
  text: string,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers })
  res.end(text)
}

export function writeHtml(
  res: ServerResponse,
  status: number,
  html: string,
  headers: OutgoingHttpHeaders = {},
): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers })
  res.end(html)
}

/** Send a JSON error envelope shared by every handler. */
export function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { ok: false, error: { code, message } })
}

export type RouteParams = Record<string, string>

export interface RouteMatch {
  params: RouteParams
}

/**
 * Match a concrete request path against a template such as
 * `/api/sessions/:id/message`. Segments prefixed with `:` capture one path
 * segment. Trailing slashes are ignored. Query strings must be stripped
 * before matching.
 */
export function matchRoute(template: string, pathname: string): RouteMatch | undefined {
  const left = template.split('/').filter(Boolean)
  const right = pathname.split('/').filter(Boolean)
  if (left.length !== right.length) return undefined
  const params: RouteParams = {}
  for (let i = 0; i < left.length; i++) {
    const a = left[i]!
    const b = right[i]!
    if (a.startsWith(':')) {
      params[a.slice(1)] = decodeURIComponent(b)
    } else if (a !== b) {
      return undefined
    }
  }
  return { params }
}

/** Extract a URL-decoded search parameter. */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

/** Bearer token from an Authorization header, if present. */
export function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization
  if (typeof header !== 'string') return undefined
  const [scheme, token] = header.split(' ', 2)
  if (scheme?.toLowerCase() !== 'bearer' || token === undefined || token === '') return undefined
  return token
}
