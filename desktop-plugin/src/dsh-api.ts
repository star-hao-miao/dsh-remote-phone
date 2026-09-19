/**
 * HarnessFacade: the typed seam between the gateway's REST/WS contract and
 * the official harness RPC/event surfaces. All official calls go through
 * HarnessRpc/HarnessMux (see harness.ts). Normalization is defensive: every
 * official value is `unknown` and every field access is optional — malformed
 * payloads degrade to the raw record instead of throwing.
 */

import { randomUUID } from 'node:crypto'
import { HarnessMux, HarnessRpc, type RpcOutcome } from './harness.js'

/** A session summary (the gateway's /api/sessions item). */
export interface SessionItem {
  id: string
  title: string | undefined
  updatedAt: number | undefined
  running: boolean
  blank: boolean
  parentSessionId: string | undefined
  origin: string | undefined
  cwd: string | undefined
  createdAt: number | undefined
}

export interface WorkspaceItem {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: number | undefined
  updatedAt: number | undefined
}

/** One simplified message of a session transcript. */
export interface TranscriptMessage {
  seq: number
  time: number
  role: 'user' | 'assistant' | 'tool' | 'system' | 'other'
  kind: string
  text: string | undefined
  toolName: string | undefined
  agentId: string | undefined
  /** Tool-call id, when the record is a tool call/result (dedupe key). */
  callId?: string
  raw: unknown
}

export interface SessionDetail {
  id: string
  transcript: TranscriptMessage[]
  hasMore: boolean
  /**
   * Cursor for the next older page (`?beforeSeq=`), i.e. the sequence of the
   * oldest message in this page. Absent when the page is empty.
   */
  nextBeforeSeq?: number
  /** Tail of raw event records, newest first, capped for debugging. */
  rawTail: unknown[]
}

/**
 * One progressive chunk row of the official transcript: the streamed pieces of
 * an assistant text/reasoning/tool-call row, identified by (turn, step, index).
 * The harness re-sends a row as it grows, keeping the longest variant correct.
 */
interface ChunkRow {
  kind: string
  turn: number
  step: number
  index: number
  seq: number
  time: number
  fragments: string[]
  toolName: string | undefined
  toolId: string | undefined
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * Drop consecutive duplicates (the harness can record the same user message
 * twice — once as the prompt echo and once as the spliced inbox entry).
 */
function dedupeMessages(messages: TranscriptMessage[]): TranscriptMessage[] {
  const result: TranscriptMessage[] = []
  for (const message of messages) {
    const previous = result[result.length - 1]
    if (
      previous !== undefined &&
      previous.role === message.role &&
      previous.kind === message.kind &&
      (previous.text ?? '') === (message.text ?? '')
    ) {
      continue
    }
    result.push(message)
  }
  return result
}

export class HarnessFacade {
  private workspaceItems = new Map<string, WorkspaceItem>()
  private workspaceReady = false
  private workspaceStreamId: string | undefined
  /** Callback the workspace watch reports changes through (kept for re-opens). */
  private workspaceWatchChanged: ((items: WorkspaceItem[]) => void) | undefined

  constructor(
    private readonly rpc: HarnessRpc,
    private readonly mux: HarnessMux,
    private readonly config: () => { maxTranscriptMessages: number },
  ) {}

  // ── sessions ────────────────────────────────────────────────────────────

  /** Map an official session/list item onto the gateway contract. */
  private mapSessionItem(value: unknown): SessionItem | undefined {
    const item = asRecord(value)
    if (item === undefined) return undefined
    const id = asString(item.sessionId)
    if (id === undefined) return undefined
    const projections = asRecord(item.projections)
    const values = asRecord(projections?.values)
    const title = asString(values?.title) ?? asString(item.title)
    return {
      id,
      title,
      updatedAt: asNumber(item.updatedAt),
      running: item.running === true,
      blank: item.blank === true,
      parentSessionId: asString(item.parentSessionId),
      origin: asString(item.origin),
      cwd: asString(item.cwd),
      createdAt: asNumber(item.createdAt),
    }
  }

  /** GET /api/sessions → official session/list. */
  async listSessions(): Promise<RpcOutcome<SessionItem[]>> {
    const outcome = await this.rpc.call('session/list', { _request: {} })
    if (!outcome.ok) return outcome
    const list = asRecord(outcome.value)
    const items = Array.isArray(list?.items) ? list.items : []
    const mapped = items
      .map(value => this.mapSessionItem(value))
      .filter((item): item is SessionItem => item !== undefined)
    return { ok: true, value: mapped }
  }

  /** The projection cursor (`projections.asOfSeq`) of one session, if known. */
  private async seqCursorFor(sessionId: string): Promise<number> {
    // Largest safe sequence: `log.slice(0, throughSeq + 1)` then yields the
    // newest page, which is what a phone transcript wants.
    const fallback = 2_147_483_647
    const outcome = await this.rpc.call('session/list', { _request: {} })
    if (!outcome.ok) return fallback
    const list = asRecord(outcome.value)
    const items = Array.isArray(list?.items) ? list.items : []
    for (const raw of items) {
      const item = asRecord(raw)
      if (item === undefined || asString(item.sessionId) !== sessionId) continue
      const asOf = asNumber(asRecord(item.projections)?.asOfSeq)
      if (asOf !== undefined && asOf >= 0) return asOf
    }
    return fallback
  }

  private mapRecord(value: unknown, includeRaw: boolean): TranscriptMessage | undefined {
    const record = asRecord(value)
    if (record === undefined) return undefined
    if (record.type === 'chunks') {
      const event = asRecord(record.event)
      if (event === undefined) return undefined
      // Raw `chunkrow/*` rows are folded into readable messages by
      // assembleChunkMessages(); nothing to emit here.
      return undefined
    }
    if (record.type !== 'event') return undefined
    const event = asRecord(record.event)
    if (event === undefined) return undefined
    const type = asString(event.type) ?? 'unknown'
    const data = asRecord(event.data)
    const seq = asNumber(event.seq) ?? 0
    const time = asNumber(event.time) ?? 0
    let role: TranscriptMessage['role'] = 'other'
    if (type.startsWith('user/')) role = 'user'
    else if (type.startsWith('assistant/')) role = 'assistant'
    else if (type.startsWith('tool/')) role = 'tool'
    else if (type.startsWith('system/')) role = 'system'
    const text = type.startsWith('tool/') ? extractToolText(type, data) : extractEventText(type, data)
    // The harness records injected system prompts as `user/message` events whose
    // `source.kind` is `plugin` (e.g. `@deepseek-ai/dsh-system-prompt`). They are
    // not conversation: keep them off the phone timeline.
    if (type === 'user/message') {
      const sourceKind = asString(asRecord(data?.source)?.kind)
      if (sourceKind !== undefined && sourceKind !== 'user') return undefined
    }
    // A phone transcript shows conversation, not harness bookkeeping
    // (turn/step/permission/sandbox/title-llm/... records). Keep real
    // conversation entries plus anything that reports a failure.
    const isConversation =
      role === 'user' || role === 'assistant' || role === 'tool' || role === 'system'
    const isFailure = /error|fail|cancel|interrupt|denied|timeout/i.test(type)
    if (!isConversation && !isFailure) return undefined
    // Empty assistant scaffolding events (`assistant/chunk`, `assistant/start`, …)
    // carry no text; the assembled stream message represents them.
    if (role === 'assistant' && (text === undefined || text === '') && !isFailure) return undefined
    return {
      seq,
      time,
      role,
      kind: type,
      text,
      toolName: type.startsWith('tool/') ? asString(data?.name) ?? asString(data?.toolName) : undefined,
      agentId: asString(data?.agentId),
      callId: extractCallId(data),
      // Raw events are large; the phone UI never needs them, so they are only
      // attached when the caller opts in (`GET /api/sessions/:id?raw=1`).
      raw: includeRaw ? value : undefined,
    }
  }

  /**
   * GET /api/sessions/:id → official session/page, normalized to a transcript.
   *
   * `session/page` requires `throughSeq` (strict wire schema); the official
   * client seeds it from the session's projection cursor (`asOfSeq`) and pages
   * backwards from there. We do the same, falling back to "through the end of
   * the log" when the list has no cursor yet (blank sessions).
   */
  async sessionDetail(
    sessionId: string,
    options: { includeRaw?: boolean; beforeSeq?: number; maxMessages?: number } = {},
  ): Promise<RpcOutcome<SessionDetail>> {
    const includeRaw = options.includeRaw === true
    const throughSeq = await this.seqCursorFor(sessionId)
    const configured = this.config().maxTranscriptMessages
    const limit =
      options.maxMessages !== undefined && Number.isFinite(options.maxMessages)
        ? Math.min(Math.max(Math.trunc(options.maxMessages), 1), 500)
        : configured
    const request: Record<string, unknown> = {
      address: { kind: 'session', sessionId },
      throughSeq,
      maxMessages: limit,
    }
    // Older pages: `beforeSeq` is the sequence of the oldest message already
    // held by the client. The harness returns the records just before it.
    if (options.beforeSeq !== undefined && Number.isFinite(options.beforeSeq)) {
      request.beforeSeq = Math.max(0, Math.trunc(options.beforeSeq))
    }
    const outcome = await this.rpc.call('session/page', { request })
    if (!outcome.ok) return outcome
    const value = asRecord(outcome.value)
    const records = Array.isArray(value?.records) ? value.records : []
    const mapped: TranscriptMessage[] = []
    const rawTail: unknown[] = []
    /** Progressive chunk rows, keyed by `<kind>:<turn>:<step>:<index>`. */
    const chunkRows = new Map<string, ChunkRow>()
    for (const record of records) {
      const message = this.mapRecord(record, includeRaw)
      if (message !== undefined) mapped.push(message)
      this.collectChunkRow(record, chunkRows)
      if (includeRaw) rawTail.unshift(record)
    }
    // Assistant output arrives as progressive `chunkrow/*` records; fold them
    // into readable messages, then drop any that a completed `assistant/message`
    // event already covers (avoids duplicated text once streaming settles).
    mapped.push(...this.assembleChunkMessages(chunkRows, mapped))
    mapped.sort((a, b) => a.seq - b.seq)
    const transcript = dedupeMessages(mapped).slice(-200)
    const oldest = transcript.length > 0 ? transcript[0].seq : undefined
    return {
      ok: true,
      value: {
        id: sessionId,
        transcript,
        hasMore: value?.hasMore === true,
        nextBeforeSeq: oldest,
        rawTail: includeRaw ? rawTail.slice(0, 50) : [],
      },
    }
  }

  /** Accumulate one progressive chunk record (see ChunkRow). */
  private collectChunkRow(record: unknown, rows: Map<string, ChunkRow>): void {
    const outer = asRecord(record)
    if (outer?.type !== 'chunks') return
    const event = asRecord(outer.event)
    if (event === undefined) return
    const kind = asString(event.type)
    if (kind === undefined || !kind.startsWith('chunkrow/')) return
    const data = asRecord(event.data)
    if (data === undefined) return
    const turn = asNumber(data.turn) ?? 0
    const step = asNumber(data.step) ?? 0
    const index = asNumber(data.index) ?? 0
    const key = `${kind}:${turn}:${step}:${index}`
    const fragments = kind === 'chunkrow/tool-call-chunks'
      ? (Array.isArray(data.args) ? data.args : []).filter((item): item is string => typeof item === 'string')
      : (Array.isArray(data.texts) ? data.texts : []).filter((item): item is string => typeof item === 'string')
    const existing = rows.get(key)
    const seq = asNumber(event.seq) ?? 0
    // A row is re-sent as it grows; keep the longest variant seen.
    if (existing !== undefined && existing.fragments.length >= fragments.length) return
    rows.set(key, {
      kind,
      turn,
      step,
      index,
      seq,
      time: asNumber(event.time) ?? 0,
      fragments,
      toolName: asString(data.name),
      toolId: asString(data.id),
    })
  }

  /**
   * Fold chunk rows into messages: one assistant message per (turn, step) for
   * text chunks, a reasoning message, and one tool message per tool call.
   */
  private assembleChunkMessages(rows: Map<string, ChunkRow>, existing: TranscriptMessage[]): TranscriptMessage[] {
    const grouped = new Map<string, ChunkRow[]>()
    for (const row of rows.values()) {
      const key = `${row.kind}:${row.turn}:${row.step}`
      const bucket = grouped.get(key)
      if (bucket === undefined) grouped.set(key, [row])
      else bucket.push(row)
    }
    const assembled: TranscriptMessage[] = []
    const finalAssistantText = existing
      .filter(message => message.role === 'assistant' && message.text !== undefined)
      .map(message => (message.text ?? '').replace(/\s+/g, ' ').trim())
      .filter(text => text.length > 0)
    // Tool calls have two representations on the wire: the settled `tool/call`
    // event (name + arguments) and the progressive `chunkrow/tool-call-chunks`
    // row. Keep the event, drop the streamed duplicate — they share a callId.
    const settledToolIds = new Set(
      existing
        .map(message => message.callId)
        .filter((id): id is string => id !== undefined),
    )

    for (const bucket of grouped.values()) {
      const sorted = bucket.slice().sort((a, b) => a.index - b.index)
      const first = sorted[0]!
      const text = sorted.map(row => row.fragments.join('')).join('')
      if (text.trim() === '') continue
      const isTool = first.kind === 'chunkrow/tool-call-chunks'
      const isReasoning = first.kind === 'chunkrow/reasoning-chunks'
      if (isTool && first.toolId !== undefined && settledToolIds.has(first.toolId)) continue
      if (!isTool && !isReasoning) {
        // Skip streamed text already present in a completed assistant message.
        const normalized = text.replace(/\s+/g, ' ').trim()
        const covered = finalAssistantText.some(final => final.includes(normalized) || normalized.includes(final))
        if (covered) continue
      }
      assembled.push({
        seq: first.seq,
        time: first.time,
        role: isTool ? 'tool' : 'assistant',
        kind: isTool ? 'assistant/tool-call' : isReasoning ? 'assistant/reasoning' : 'assistant/stream',
        text,
        toolName: isTool ? first.toolName : undefined,
        agentId: undefined,
        raw: { assembledFrom: first.kind, turn: first.turn, step: first.step },
      })
    }
    return assembled
  }

  /** POST /api/sessions/:id/message → official session/create? + session/prompt. */
  async sendMessage(
    sessionId: string,
    content: string,
    opts: { mode?: 'queue' | 'steer'; image?: { mediaType: string; data: string; name?: string } } = {},
  ): Promise<RpcOutcome<{ accepted: boolean; requestId: string }>> {
    const requestId = randomUUID()
    const blocks: Array<Record<string, unknown>> = []
    if (opts.image !== undefined) {
      blocks.push({
        type: 'image',
        mediaType: opts.image.mediaType,
        data: opts.image.data,
        ...(opts.image.name !== undefined ? { name: opts.image.name } : {}),
      })
    }
    blocks.push({ type: 'text', text: content })
    const outcome = await this.rpc.call('session/prompt', {
      request: {
        requestId,
        sessionId,
        mode: opts.mode ?? 'queue',
        content: blocks,
      },
    })
    if (!outcome.ok) return outcome
    const value = asRecord(outcome.value)
    return { ok: true, value: { accepted: value?.accepted === true, requestId } }
  }

  /** Start (or reuse) a blank session in a workspace — the workspace switch verb. */
  async openSessionInWorkspace(workspaceId: string): Promise<RpcOutcome<{ sessionId: string }>> {
    const outcome = await this.rpc.call('session/create', { request: { workspaceId } })
    if (!outcome.ok) return outcome
    const value = asRecord(outcome.value)
    const sessionId = asString(value?.sessionId)
    if (sessionId === undefined) return { ok: false, error: { code: 'harness-error', message: 'session/create returned no sessionId' } }
    return { ok: true, value: { sessionId } }
  }

  /**
   * Permanently delete one session (`session/delete`), keeping its workspace
   * files. The harness refuses while the session's agent is live
   * (`session/agent-busy`), which the caller surfaces to the user as-is.
   */
  async deleteSession(sessionId: string): Promise<RpcOutcome<{ deleted: boolean }>> {
    const outcome = await this.rpc.call('session/delete', { request: { sessionId } })
    if (!outcome.ok) return outcome
    const value = asRecord(outcome.value)
    return { ok: true, value: { deleted: value?.deleted !== false } }
  }

  /**
   * Create a session, optionally pinned to a workspace and/or a cwd.
   *
   * `session/create` accepts `{workspaceId?, cwd?, sessionId?, agentPreset?}`;
   * the workspace one is the form the official client uses when you press
   * "new session" inside a project.
   */
  async createSession(options: {
    workspaceId?: string
    cwd?: string
  }): Promise<RpcOutcome<{ sessionId: string }>> {
    const request: Record<string, unknown> = {}
    if (options.workspaceId !== undefined && options.workspaceId !== '') request.workspaceId = options.workspaceId
    if (options.cwd !== undefined && options.cwd !== '') request.cwd = options.cwd
    const outcome = await this.rpc.call('session/create', { request })
    if (!outcome.ok) return outcome
    const value = asRecord(outcome.value)
    const sessionId = asString(value?.sessionId)
    if (sessionId === undefined) return { ok: false, error: { code: 'harness-error', message: 'session/create returned no sessionId' } }
    return { ok: true, value: { sessionId } }
  }

  // ── workspaces (live cache over workspace/follow) ───────────────────────

  /** The current workspace snapshot (empty until the first baseline lands). */
  workspaceSnapshot(): { items: WorkspaceItem[]; ready: boolean } {
    return { items: [...this.workspaceItems.values()], ready: this.workspaceReady }
  }

  private applyWorkspaceValue(value: unknown, onChanged: () => void): void {
    const frame = asRecord(value)
    const type = asString(frame?.type)
    if (type === 'baseline') {
      const payload = asRecord(frame?.value)
      this.workspaceItems.clear()
      for (const raw of Array.isArray(payload?.items) ? payload.items : []) {
        const item = this.mapWorkspaceItem(raw)
        if (item !== undefined) this.workspaceItems.set(item.workspaceId, item)
      }
      this.workspaceReady = true
      onChanged()
      return
    }
    if (type === 'upsert') {
      // Observed on the wire: `{type:'upsert', workspace:{…}}` (the baseline
      // uses `{type:'baseline', value:{items:[…]}}`). Accept both shapes.
      const raw = frame?.workspace ?? frame?.value
      const item = this.mapWorkspaceItem(raw)
      if (item !== undefined) {
        this.workspaceItems.set(item.workspaceId, item)
        onChanged()
      }
      return
    }
    if (type === 'remove') {
      const payload = asRecord(frame?.value) ?? asRecord(frame?.workspace)
      const id = asString(payload?.workspaceId)
      if (id !== undefined && this.workspaceItems.delete(id)) onChanged()
      return
    }
    if (type === 'order' || type === 'archived') {
      // Ordering is cosmetic; archive entries are removed by later upserts.
      return
    }
  }

  private mapWorkspaceItem(raw: unknown): WorkspaceItem | undefined {
    const item = asRecord(raw)
    if (item === undefined) return undefined
    const workspaceId = asString(item.workspaceId)
    if (workspaceId === undefined) return undefined
    return {
      workspaceId,
      path: asString(item.path) ?? '',
      title: asString(item.title) ?? workspaceId,
      sessionIds: asStringArray(item.sessionIds),
      createdAt: asNumber(item.createdAt),
      updatedAt: asNumber(item.updatedAt),
    }
  }

  /** Start watching workspaces (idempotent). */
  startWorkspaceWatch(onChanged: (items: WorkspaceItem[]) => void): void {
    if (this.workspaceStreamId !== undefined) return
    this.workspaceWatchChanged = onChanged
    const streamId = this.mux.open(
      'workspace/follow',
      // The mux `open` frame mirrors the unary envelope: `payload` must be the
      // single-key `{ args }` object. Sending a bare `{}` made the harness
      // accept the frame but never start the stream, which left the workspace
      // cache empty (`ready=false`, no items) and turned every
      // /api/workspaces/:id/switch into a 404.
      { args: {} },
      {
        onItem: value => {
          this.applyWorkspaceValue(value, () => onChanged(this.workspaceSnapshot().items))
        },
      },
    )
    this.workspaceStreamId = streamId
  }

  /**
   * Re-open the workspace stream when its baseline never arrived.
   *
   * The baseline can be lost across a harness restart (the mux socket is new,
   * the harness may have dropped the subscription without closing our side), and
   * without it the phone cannot group conversations by workspace. Re-opening the
   * same endpoint is safe: the harness answers a fresh baseline.
   */
  ensureWorkspaceWatch(): void {
    if (this.workspaceStreamId === undefined) return
    if (this.workspaceReady) return
    const onChanged = this.workspaceWatchChanged
    this.mux.cancel(this.workspaceStreamId)
    this.workspaceStreamId = undefined
    if (onChanged !== undefined) this.startWorkspaceWatch(onChanged)
  }

  // ── realtime event relay ────────────────────────────────────────────────

  /**
   * Subscribe to $events. `emit` frames are broadcast events (safe to
   * consume). `waterfall` frames are interactive requests (approval /
   * user-question): they are forwarded only when the caller opts in, and the
   * gateway answers them through HarnessRpc `$events/result`.
   */
  startEventRelay(handlers: {
    onEmit: (event: string, args: unknown[]) => void
    onWaterfall: (frame: { event: string; eventId: string; agentId: string; request: Record<string, unknown> }) => void
  }): void {
    // Carrier-level frames: kept as a fallback for lines that deliver them here.
    this.mux.onGlobal = frame => {
      if (frame.type === 'emit') handlers.onEmit(frame.event, frame.args)
      else if (frame.type === 'waterfall') {
        handlers.onWaterfall({
          event: frame.event,
          eventId: frame.eventId,
          agentId: frame.agentId,
          request: asRecord(frame.request) ?? {},
        })
      }
    }
    // On this harness line the forwarded events are *items* of the `$events`
    // stream: `{type:'ready'|'emit'|'waterfall'|'cancel'}`. The mux records the
    // `ready` clientId itself before handing the value to us.
    this.mux.open('$events', { args: {} }, {
      onItem: value => {
        const item = asRecord(value)
        const type = asString(item?.type)
        if (type === 'emit') {
          const args = Array.isArray(item?.args) ? (item?.args as unknown[]) : []
          handlers.onEmit(asString(item?.event) ?? '', args)
          return
        }
        if (type === 'waterfall') {
          handlers.onWaterfall({
            event: asString(item?.event) ?? '',
            eventId: asString(item?.eventId) ?? '',
            agentId: asString(item?.agentId) ?? '',
            request: asRecord(item?.request) ?? {},
          })
        }
      },
    })
  }

  /** Answer an interactive waterfall request (approval / user question). */
  async answerInteraction(
    eventId: string,
    outcome: { kind: 'result'; value: string } | { kind: 'rejected'; error: { name: string; message: string } } | { kind: 'next' },
  ): Promise<RpcOutcome<unknown>> {
    const clientId = this.mux.readyClientId()
    if (clientId === undefined) {
      return { ok: false, error: { code: 'not-ready', message: 'harness event generation not ready' } }
    }
    return this.rpc.call('$events/result', { clientId, eventId, outcome })
  }
}

export type { RpcOutcome }

/**
 * Readable summary of a tool event, for a phone-sized bubble.
 *
 * `tool/call` is `{name, arguments}` where `arguments` is a JSON *string*; the
 * most useful one-liner is the model's own `description`, else the command.
 * `tool/result` nests the output under
 * `message.content[].content[]` (a list of already-stringified entries).
 * Without this both events rendered as empty bubbles.
 */
function extractToolText(type: string, data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined
  if (type === 'tool/call' || type === 'tool/start') {
    const name = asString(data.name) ?? asString(data.toolName) ?? 'tool'
    const rawArgs = asString(data.arguments)
    let summary = ''
    if (rawArgs !== undefined) {
      let parsed: Record<string, unknown> | undefined
      try {
        parsed = asRecord(JSON.parse(rawArgs))
      } catch {
        parsed = undefined
      }
      summary = asString(parsed?.description) ?? asString(parsed?.command) ?? asString(parsed?.path) ?? rawArgs
    }
    const clipped = clip(summary, 300)
    return clipped === '' ? name : `${name}: ${clipped}`
  }
  if (type === 'tool/result' || type === 'tool/error') {
    const message = asRecord(data.message)
    const blocks = Array.isArray(message?.content) ? message.content : []
    const parts: string[] = []
    for (const block of blocks) {
      const record = asRecord(block)
      if (record === undefined) continue
      const inner = Array.isArray(record.content) ? record.content : []
      for (const entry of inner) {
        const asText = asString(entry)
        if (asText !== undefined) {
          parts.push(asText)
          continue
        }
        const entryRecord = asRecord(entry)
        const entryText = asString(entryRecord?.text)
        if (entryText !== undefined) parts.push(entryText)
      }
      const ownText = asString(record.text)
      if (ownText !== undefined && inner.length === 0) parts.push(ownText)
    }
    if (parts.length === 0) return undefined
    return clip(parts.join('\n'), 800)
  }
  return asString(data.text)
}

/** Truncate for transport: a phone transcript should not carry whole logs. */
function clip(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

/**
 * The tool-call id of an event: flat on `tool/call`, nested under
 * `message.source.callId` on `tool/result`.
 */
function extractCallId(data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined
  return asString(data.callId) ?? asString(asRecord(asRecord(data.message)?.source)?.callId)
}

/**
 * Readable text of one conversation event.
 *
 * The official wire format does not put the prose in a flat `text` field:
 * `user/message` carries `data.content` (an array of blocks), and a completed
 * `assistant/message` nests the same array under `data.message.content`.
 * Reading only `data.text` silently produced empty user bubbles.
 *
 * Only `{type:'text'}` blocks count: the same array also carries `reasoning`
 * blocks, and folding those in duplicated the model's thinking into the reply
 * (reasoning is surfaced separately by the `chunkrow/reasoning-chunks` rows).
 */
function extractEventText(type: string, data: Record<string, unknown> | undefined): string | undefined {
  if (data === undefined) return undefined
  const direct = asString(data.text)
  if (direct !== undefined && direct !== '') return direct
  if (type !== 'user/message' && type !== 'assistant/message') return direct
  const containers: unknown[] = [data.content, asRecord(data.message)?.content]
  for (const container of containers) {
    if (!Array.isArray(container)) continue
    const parts: string[] = []
    for (const block of container) {
      const record = asRecord(block)
      if (record === undefined) continue
      const blockType = asString(record.type)
      if (blockType !== undefined && blockType !== 'text') continue
      const text = asString(record.text)
      if (text !== undefined && text !== '') parts.push(text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return direct
}

