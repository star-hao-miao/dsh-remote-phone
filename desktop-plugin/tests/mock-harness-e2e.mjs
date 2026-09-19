/**
 * End-to-end test against a MOCK harness (no real DSH needed).
 *
 * A fake official web server answers the RPC envelope (/api/<ns>/<method>),
 * the launch-token cookie exchange (GET /?token=…), and the remote.mux
 * WebSocket (ready / workspace baseline / $events push). We boot GatewayApp
 * pointed at it and drive the whole gateway: pair → sessions → send message →
 * history → workspaces → switch → session event relay → approval decision.
 *
 * Run: node tests/mock-harness-e2e.mjs
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { WebSocket, WebSocketServer } from 'ws'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const lib = join(here, '..', 'lib')
const load = async (rel) => await import(pathToFileURL(join(lib, rel)).href)
const { GatewayApp } = await load('app.js')
const { loadPrefs, resolveSettings } = await load('config.js')
const { signJwt } = await load('util/crypto.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let failures = 0
function check(name, ok, extra = '') {
  if (ok) console.log(`  ✔ ${name}`)
  else {
    failures += 1
    console.error(`  ✘ ${name}${extra === '' ? '' : ` — ${extra}`}`)
  }
}

const SESSIONS = [
  { sessionId: 'session-a', updatedAt: Date.now(), running: false, blank: false, projections: { values: { title: 'Hi from phone test' } } },
]
const sentMessages = []
const resultEvents = []
/** Every `session/page` request the facade issued (paging assertions). */
const pageRequests = []
/** Session ids the facade asked the harness to delete. */
const deletedSessions = []

function startMock() {
  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(303, {
        location: '/',
        'set-cookie': 'dsh-auth-mock=abc.def.ghi; Path=/; HttpOnly; SameSite=Strict',
      })
      res.end()
      return
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const envelope = JSON.parse(raw)
      const method = String(envelope.method)
      const respond = (value) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'server-response', rpcId: envelope.rpcId, result: { ok: true, value } }))
      }
      const args = envelope.payload?.args ?? {}
      if (method === 'session/list') return respond({ items: SESSIONS })
      if (method === 'session/page') {
        if (args.request?.address?.sessionId !== 'session-a') {
          res.writeHead(404).end(JSON.stringify({ type: 'server-response', result: { ok: false, error: { code: 'not-found' } } }))
          return
        }
        const record = (type, seq, data) => ({ type: 'event', event: { type, seq, time: Date.now(), data } })
        // Official payload shapes: user text lives in `data.content[]`, an
        // assistant message nests it under `data.message.content[]`. Reading a
        // flat `text` field produced empty user bubbles on the phone.
        pageRequests.push(args.request)
        if (args.request?.beforeSeq !== undefined) {
          return respond({
            records: [record('user/message', 0, { content: [{ type: 'text', text: 'older hello' }], role: 'user' })],
            hasMore: true,
          })
        }
        return respond({
          records: [
            // Injected system prompt: recorded as `user/message`, but not chat.
            record('user/message', 0, {
              content: [{ type: 'text', text: 'runtime context injection' }],
              source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
              role: 'user',
            }),
            record('user/message', 1, { content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, role: 'user' }),
            record('assistant/message', 2, {
              message: {
                role: 'assistant',
                content: [
                  { type: 'reasoning', text: 'the user greets me' },
                  { type: 'text', text: 'hello back' },
                ],
              },
            }),
            record('tool/call', 3, {
              turn: 1,
              step: 1,
              callId: 'call_1',
              name: 'pwsh',
              arguments: JSON.stringify({ command: 'Get-Date', description: 'show the current time' }),
            }),
            record('tool/result', 4, {
              turn: 1,
              step: 1,
              message: {
                source: { kind: 'tool', callId: 'call_1' },
                content: [{ type: 'tool-result', toolCallId: 'call_1', content: ['@{type=text; text=19:20}'] }],
              },
            }),
            // Streaming duplicate of the same tool call: only the settled
            // `tool/call` event above should reach the transcript.
            {
              type: 'chunks',
              event: {
                type: 'chunkrow/tool-call-chunks',
                seq: 3,
                time: Date.now(),
                data: { turn: 1, step: 1, index: 0, id: 'call_1', name: 'pwsh', args: ['{"command": "Get-Date"}'] },
              },
            },
          ],
          hasMore: false,
        })
      }
      if (method === 'session/prompt') {
        sentMessages.push(args.request)
        return respond({ accepted: true })
      }
      if (method === 'session/create') {
        const sessionId = `session-${String(Math.random()).slice(2)}`
        SESSIONS.push({ sessionId, updatedAt: Date.now(), running: false, blank: true, projections: {} })
        return respond({ sessionId })
      }
      if (method === 'session/delete') {
        deletedSessions.push(args.request?.sessionId)
        return respond({ deleted: true })
      }
      if (method === '$events/result') {
        resultEvents.push({ eventId: args.eventId, outcome: args.outcome })
        return respond({ ok: true })
      }
      res.writeHead(404).end(JSON.stringify({ type: 'server-response', result: { ok: false, error: { code: 'no-such-method' } } }))
      return
    }
    res.writeHead(404).end()
  })

  const wss = new WebSocketServer({ noServer: true })
  const socketsByStream = new Map() // endpoint -> Set<socket>
  wss.on('connection', (socket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString())
      if (frame.type === 'open') {
        if (!socketsByStream.has(frame.endpoint)) socketsByStream.set(frame.endpoint, new Set())
        socketsByStream.get(frame.endpoint).add(socket)
        if (frame.endpoint === 'workspace/follow') {
          socket.send(
            JSON.stringify({
              type: 'item',
              streamId: frame.streamId,
              value: {
                type: 'baseline',
                value: {
                  items: [
                    { workspaceId: 'ws-1', path: 'C:/demo', title: 'Demo', sessionIds: ['session-a'], createdAt: Date.now(), updatedAt: Date.now() },
                  ],
                  archivedSessionIds: [],
                },
              },
            }),
          )
        }
      }
      if (frame.type === 'cancel') {
        socketsByStream.get(frame.endpoint)?.delete(socket)
      }
    })
  })
  const api = {
    push(endpoint, frame) {
      for (const socket of socketsByStream.get(endpoint) ?? []) {
        socket.send(JSON.stringify(frame))
      }
    },
  }
  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost')
    if (url.pathname === '/api/remote.mux') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req)
        ws.send(JSON.stringify({ type: 'ready', clientId: 'mock-c1', host: { home: 'mock' } }))
      })
    } else socket.destroy()
  })

  return new Promise((resolve) => {
    http.listen(0, '127.0.0.1', () => {
      resolve({ http, port: http.address().port, api })
    })
  })
}

async function main() {
  const home = mkdtempSync(join(process.cwd(), '.e2e-home-'))
  process.env.DSH_HOME = home
  const mock = await startMock()
  const prefsRef = { current: loadPrefs({ port: 3198, bindLan: false }, home) }
  const secret = prefsRef.current.secret

  const app = new GatewayApp({
    settings: () => resolveSettings(undefined, prefsRef.current),
    persist: (patch) => {
      prefsRef.current = { ...prefsRef.current, ...patch }
    },
    webServerPort: () => mock.port,
    launchUrl: () => `http://127.0.0.1:${mock.port}/?token=launch`,
    log: () => undefined,
  })

  let wsClient
  try {
    await app.start()
    const base = `http://127.0.0.1:${app.gateway.currentBind().port}`
    const capHeaders = { 'content-type': 'application/json', 'x-rg-cap': signJwt(secret, { sub: 'desktop', aud: 'desktop' }, 60_000) }

    // 1) pair
    const minted = await fetch(`${base}/api/pair`, { method: 'POST', headers: capHeaders }).then((r) => r.json())
    check('mint code', minted.ok === true)
    const verified = await fetch(`${base}/api/pair/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: minted.code, device: { name: 'phone' } }),
    }).then((r) => r.json())
    check('pair verify', verified.ok === true, JSON.stringify(verified).slice(0, 160))
    const auth = { authorization: `Bearer ${verified.token}` }

    // 2) harness link reaches mux ready
    let connected = false
    for (let i = 0; i < 50; i++) {
      connected = app.harness?.mux.isConnected() ?? false
      if (connected) break
      await sleep(100)
    }
    check('harness mux connected', connected)

    // 3) sessions
    const list = await fetch(`${base}/api/sessions`, { headers: auth }).then((r) => r.json())
    check('sessions mapped', list.ok === true && list.items.length === 1 && list.items[0].title === 'Hi from phone test')

    // 4) send message + history
    const sent = await fetch(`${base}/api/sessions/session-a/message`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'ping from phone', mode: 'queue' }),
    }).then((r) => r.json())
    check('message accepted', sent.ok === true && sent.accepted === true)
    check('mock captured prompt', sentMessages[0]?.content[0]?.text === 'ping from phone')

    const detail = await fetch(`${base}/api/sessions/session-a`, { headers: auth }).then((r) => r.json())
    const texts = detail.ok ? detail.session.transcript.map((m) => m.text) : []
    check('history transcript', detail.ok === true && texts.includes('hello') && texts.includes('hello back'))
    check(
      'user text read from content blocks',
      detail.ok === true && detail.session.transcript.some((m) => m.role === 'user' && m.text === 'hello'),
    )
    check(
      'injected plugin prompt stays off the timeline',
      detail.ok === true && !texts.some((t) => typeof t === 'string' && t.includes('runtime context injection')),
    )
    check(
      'reasoning blocks are not folded into the reply',
      detail.ok === true && detail.session.transcript.some((m) => m.text === 'hello back') &&
        !texts.some((t) => typeof t === 'string' && t.includes('the user greets me')),
    )
    check(
      'tool call shows name + description',
      detail.ok === true && detail.session.transcript.some((m) => m.kind === 'tool/call' && m.text === 'pwsh: show the current time'),
    )
    check(
      'tool result output is surfaced',
      detail.ok === true && detail.session.transcript.some((m) => m.kind === 'tool/result' && typeof m.text === 'string' && m.text.includes('19:20')),
    )
    check(
      'streamed tool-call row is not duplicated',
      detail.ok === true &&
        detail.session.transcript.filter((m) => m.text === 'pwsh: show the current time' || m.kind === 'assistant/tool-call').length === 1,
    )
    check('detail omits raw payload by default', detail.ok === true && detail.session.rawTail.length === 0)
    const rawDetail = await fetch(`${base}/api/sessions/session-a?raw=1`, { headers: auth }).then((r) => r.json())
    check('detail raw payload is opt-in', rawDetail.ok === true && rawDetail.session.rawTail.length > 0)

    // older page: the cursor from the first page is forwarded as `beforeSeq`
    const older = await fetch(`${base}/api/sessions/session-a?beforeSeq=${detail.session.nextBeforeSeq}`, {
      headers: auth,
    }).then((r) => r.json())
    check('older page requests beforeSeq', pageRequests.some((r) => typeof r?.beforeSeq === 'number'))
    check(
      'older page returns earlier messages with a cursor',
      older.ok === true &&
        older.session.transcript.some((m) => m.text === 'older hello') &&
        older.session.hasMore === true &&
        typeof older.session.nextBeforeSeq === 'number',
    )

    // 5) workspaces via follow cache (async baseline)
    let workspaces = null
    for (let i = 0; i < 50; i++) {
      workspaces = await fetch(`${base}/api/workspaces`, { headers: auth }).then((r) => r.json())
      if (workspaces.ok && workspaces.ready && workspaces.items.length > 0) break
      await sleep(100)
    }
    check('workspaces cached', workspaces?.ok === true && workspaces.items[0]?.workspaceId === 'ws-1')
    const switched = await fetch(`${base}/api/workspaces/ws-1/switch`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }).then((r) => r.json())
    check('workspace switch creates session', switched.ok === true && typeof switched.sessionId === 'string')

    // delete (the app's conversation-delete action)
    const deleted = await fetch(`${base}/api/sessions/session-a`, { method: 'DELETE', headers: auth }).then((r) => r.json())
    check(
      'delete forwards session/delete to the harness',
      deleted.ok === true && deleted.deleted === true && deletedSessions[0] === 'session-a',
    )

    // 6) realtime relay: session.activity emit forwarded over /ws
    const frames = []
    wsClient = new WebSocket(`ws://127.0.0.1:${app.gateway.currentBind().port}/ws?token=${encodeURIComponent(verified.token)}`)
    wsClient.on('message', (data) => frames.push(JSON.parse(data.toString())))
    await new Promise((resolve, reject) => {
      wsClient.once('open', resolve)
      wsClient.once('error', reject)
    })
    await sleep(300)
    const hello = frames[0]
    check('ws hello', hello?.type === 'hello', JSON.stringify(frames.slice(0, 2)))

    frames.length = 0
    mock.api.push('$events', { type: 'emit', event: 'api-session/activity', args: ['session-a', Date.now()] })
    await sleep(400)
    const sawActivity = frames.some((f) => f.type === 'session.activity' && f.sessionId === 'session-a')
    check('session.activity relayed', sawActivity, JSON.stringify(frames.slice(0, 3)))

    // 7) approval waterfall → interaction.request → phone decision → $events/result
    mock.api.push('$events', {
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'evt-1',
      agentId: 'session-a',
      request: { agent: 'session-a', toolName: 'bash', reason: 'run tests' },
    })
    let approval = null
    for (let i = 0; i < 50; i++) {
      approval = frames.find((f) => f.type === 'interaction.request' && f.id === 'evt-1')
      if (approval !== undefined) break
      await sleep(100)
    }
    check('approval forwarded', approval !== undefined, JSON.stringify(frames.slice(-6)))
    check('approval carries toolName', approval?.toolName === 'bash')

    wsClient.send(JSON.stringify({ type: 'approval.decision', id: 'evt-1', decision: 'allowed-once' }))
    for (let i = 0; i < 50; i++) {
      if (resultEvents.some((e) => e.eventId === 'evt-1')) break
      await sleep(100)
    }
    const decision = resultEvents.find((e) => e.eventId === 'evt-1')
    check('decision reaches harness', decision !== undefined && decision.outcome?.kind === 'result' && decision.outcome?.value === 'allowed-once')
  } catch (error) {
    failures += 1
    console.error('fatal:', error)
  } finally {
    try {
      wsClient?.close()
    } catch {
      // ignore
    }
    await sleep(100)
    try {
      await app?.dispose()
    } catch {
      // ignore
    }
    try {
      mock.http.close()
    } catch {
      // ignore
    }
    rmSync(home, { recursive: true, force: true })
  }

  console.log(failures === 0 ? '\nMOCK HARNESS E2E PASS' : `\nMOCK HARNESS E2E FAIL (${failures})`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
