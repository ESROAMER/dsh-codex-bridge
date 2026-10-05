/**
 * dsh-codex-bridge — the Cordis host half of the Codex ⇄ DeepSeek Harness
 * collaboration bridge.
 *
 * The plugin mounts one loopback HTTP route on the running desktop web server
 * and re-exposes the *existing* Harness services (`workspaceRegistry`,
 * `sessionController`, `agentPresets`, `sessionQuery`) to an external client
 * under its own token authentication. It creates no session runtime of its
 * own, holds no model credentials, never approves a tool permission, and
 * serves no browser surface: the desktop continues to own the sessions, the
 * approval flow, and the sandbox.
 *
 * Configuration lives in the row that mounts this module; see README.md.
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, writeFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute, parse } from 'node:path'

export const name = 'dsh-codex-bridge'

/** Every service `apply` reads; the loader waits for all of them. */
export const inject = ['webServer', 'workspaceRegistry', 'sessionController']

const PROTOCOL_VERSION = 1
const DEFAULT_PREFIX = '/codex-bridge'
const DEFAULT_MAX_BODY_BYTES = 262144
const DEFAULT_MAX_WAIT_MS = 30000
const DEFAULT_EVENT_CACHE = 2000
const DEFAULT_REQUEST_TTL_MS = 86400000
const TOKEN_PREFIX = 'dshb_'

/** All failure codes the bridge returns; each maps to one HTTP status. */
const ERROR_STATUS = {
  'auth/missing-token': 401,
  'auth/invalid-token': 403,
  'auth/workspace-forbidden': 403,
  'request/bad-request': 400,
  'request/too-large': 413,
  'request/unsupported': 404,
  'request/conflict': 409,
  'workspace/not-found': 404,
  'session/not-found': 404,
  'session/workspace-mismatch': 409,
  'session/writer-held': 409,
  'session/agent-busy': 409,
  'task/not-found': 404,
  'task/round-not-found': 409,
  'model/unavailable': 409,
  'model/reasoning-effort-unavailable': 409,
  'bridge/not-ready': 503,
  'bridge/timeout': 504,
  'bridge/internal': 500,
}

/** Stable bridge failure. */
class BridgeError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.code = code
    this.details = details
  }
}

const fail = (code, message, details) => new BridgeError(code, message, details)

/* ─────────────────────────── generic helpers ─────────────────────────── */

const asString = (value) => (typeof value === 'string' ? value : undefined)
const asObject = (value) => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined)

const requireString = (value, field) => {
  const text = asString(value)
  if (text === undefined || text.trim() === '') throw fail('request/bad-request', `${field} must be a non-empty string`)
  return text
}

const requireRequestId = (value) => {
  const text = requireString(value, 'requestId')
  if (text.length > 200) throw fail('request/bad-request', 'requestId must be at most 200 characters')
  return text
}

const clampInt = (value, fallback, min, max) => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(parsed)))
}

const redact = (text, limit) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex')

const tokenMatches = (candidate, expected) => {
  const left = Buffer.from(hashToken(candidate), 'hex')
  const right = Buffer.from(expected, 'hex')
  return left.length === right.length && timingSafeEqual(left, right)
}

async function writeFileAtomic(path, text, mode) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, text, mode === undefined ? 'utf8' : { encoding: 'utf8', mode })
  await rename(temporary, path)
  if (mode !== undefined) await chmod(path, mode).catch(() => {})
}

const readJsonFile = async (path) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * One JSON document on disk, serialized through a single in-process chain.
 * Writes are atomic (temp file + rename) so an interrupted write cannot
 * truncate the previous document.
 */
class JsonStore {
  #path
  #mode
  #value
  #chain = Promise.resolve()

  constructor(path, mode) {
    this.#path = path
    this.#mode = mode
  }

  async load() {
    if (this.#value !== undefined) return this.#value
    const parsed = await readJsonFile(this.#path)
    this.#value = asObject(parsed) ?? {}
    return this.#value
  }

  async update(mutate) {
    const next = this.#chain.then(async () => {
      const current = { ...(await this.load()) }
      const result = await mutate(current)
      this.#value = current
      await mkdir(dirname(this.#path), { recursive: true })
      await writeFileAtomic(this.#path, `${JSON.stringify(current, null, 2)}\n`, this.#mode)
      return result
    })
    this.#chain = next.then(() => undefined, () => undefined)
    return next
  }
}

/* ──────────────────────────── plugin state ──────────────────────────── */

const TURN_END_KINDS = {
  completed: 'turn-completed',
  aborted: 'turn-aborted',
  error: 'turn-failed',
  'max-tokens': 'turn-truncated',
  blocked: 'turn-blocked',
  interrupted: 'turn-interrupted',
  forked: 'turn-forked',
}

/** Phases that mean the turn is over, as opposed to merely under way. */
const TURN_SETTLED_PHASES = new Set(Object.values(TURN_END_KINDS))

const ARTIFACT_TOOLS = new Set(['write', 'edit', 'str-replace-editor', 'apply_patch', 'notebook-edit'])

const PATH_KEYS = ['file_path', 'path', 'filePath', 'notebook_path', 'target_file', 'targetFile']

/** Pull `{path, bytes}`-shaped artifact references out of one tool-call payload. */
function artifactsOf(toolName, rawArguments, turn) {
  let parsed
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    return []
  }
  const record = asObject(parsed)
  if (record === undefined) return []
  const found = []
  for (const key of PATH_KEYS) {
    const candidate = asString(record[key])
    if (candidate !== undefined && candidate !== '') {
      found.push({ kind: ARTIFACT_TOOLS.has(toolName) ? 'file-write' : 'file-reference', path: candidate, via: toolName, turn })
      break
    }
  }
  return found
}

/**
 * Message blocks of one event payload.
 *
 * The Host writes message content under two shapes: user messages carry
 * `data.content` alongside `data.role`/`data.source`, while assistant and
 * system messages carry the whole message under `data.message`. Only the second
 * shape was read before, which is why every real `user/message` and
 * `assistant/message` projected an empty `text`. Both are accepted here.
 */
function messageBlocks(data) {
  if (Array.isArray(data?.message?.content)) return { blocks: data.message.content, container: 'message' }
  if (Array.isArray(data?.content)) return { blocks: data.content, container: 'data' }
  return { blocks: [], container: null }
}

/** Concatenate the text blocks of a message-shaped payload, bounded. */
function messageText(data, limit = 2000) {
  const { blocks } = messageBlocks(data)
  if (blocks.length === 0) return ''
  const texts = []
  for (const block of blocks) {
    if (asObject(block)?.type === 'text') texts.push(String(block.text ?? ''))
  }
  return redact(texts.join('\n'), limit)
}

/**
 * Text carried by a tool result payload.
 *
 * A tool result keeps the strict message shape (`data.message.content`), and a
 * tool failure can carry no content at all, in which case the error reason is
 * the only readable output.
 */
function toolResultText(data, limit = 1000) {
  const text = messageText(data, limit)
  if (text !== '') return text
  return redact(asString(data?.error?.reason) ?? '', limit)
}

/**
 * Project one raw Session event into the bridge's client-facing event shape.
 *
 * The bridge never rewrites Harness state: this projection only picks the
 * fields an external collaborator needs — message text, execution progress,
 * tool failures, the model actually used, and artifact references.
 */
function projectEvent(event, taskId) {
  const type = asString(event?.type) ?? 'unknown'
  const data = asObject(event?.data) ?? {}
  const base = {
    taskId,
    sessionSeq: Number(event?.seq ?? -1),
    at: Number(event?.time ?? Date.now()),
    sessionEventType: type,
  }
  switch (type) {
    case 'user/message':
      return {
        ...base,
        kind: 'message',
        role: 'user',
        source: asString(data.source?.kind) ?? 'user',
        ...(asString(data.source?.rpcId) === undefined ? {} : { requestId: asString(data.source.rpcId) }),
        text: messageText(data),
      }
    case 'assistant/message': {
      const usage = asObject(data.usage)
      return {
        ...base,
        kind: 'message',
        role: 'assistant',
        model: asString(data.message?.source?.provider),
        modelId: asString(data.message?.source?.model),
        interrupted: data.interrupted === true,
        text: messageText(data),
        ...(usage === undefined ? {} : { usage }),
      }
    }
    case 'turn/start':
      return { ...base, kind: 'execution', phase: 'turn-start', turn: Number(data.turn ?? 0) }
    case 'turn/end': {
      const reason = asObject(data.reason) ?? {}
      const kind = asString(reason.kind) ?? 'unknown'
      return {
        ...base,
        kind: 'execution',
        phase: TURN_END_KINDS[kind] ?? 'turn-end',
        turn: Number(data.turn ?? 0),
        reason: kind,
        ...(kind === 'error' ? { error: { name: 'model', code: asString(reason.error?.code) ?? 'model/error', message: redact(reason.error?.message, 2000) } } : {}),
      }
    }
    case 'step/start':
      return { ...base, kind: 'execution', phase: 'step-start', turn: Number(data.turn ?? 0), step: Number(data.step ?? 0) }
    case 'step/end':
      return { ...base, kind: 'execution', phase: 'step-end', turn: Number(data.turn ?? 0), step: Number(data.step ?? 0) }
    case 'tool/call':
      return {
        ...base,
        kind: 'execution',
        phase: 'tool-call',
        turn: Number(data.turn ?? 0),
        step: Number(data.step ?? 0),
        callId: asString(data.callId),
        tool: asString(data.name),
        argumentsPreview: redact(data.arguments, 1000),
      }
    case 'tool/result': {
      const error = asObject(data.error)
      return {
        ...base,
        kind: 'execution',
        phase: 'tool-result',
        turn: Number(data.turn ?? 0),
        step: Number(data.step ?? 0),
        callId: asString(data.message?.toolCallId),
        failed: error !== undefined || data.message?.isError === true,
        ...(error === undefined ? {} : { error: { name: asString(error.name) ?? 'tool', code: asString(error.code) ?? 'tool/error', message: redact(error.reason, 1000) } }),
        outputPreview: toolResultText(data, 1000),
      }
    }
    case 'request/header': {
      const config = asObject(data.header?.config) ?? {}
      return {
        ...base,
        kind: 'execution',
        phase: 'request-header',
        observedConfig: {
          provider: asString(config.provider),
          model: asString(config.model),
          reasoningEffort: asString(config.reasoningEffort) ?? null,
          reason: asString(data.reason) ?? null,
        },
      }
    }
    case 'model/selection': {
      const selection = asObject(data) ?? {}
      return {
        ...base,
        kind: 'execution',
        phase: 'model-selection',
        selectedConfig: {
          provider: asString(selection.provider),
          model: asString(selection.model),
          reasoningEffort: asString(selection.reasoningEffort) ?? null,
        },
      }
    }
    case 'user/question':
    case 'question/asked':
      return { ...base, kind: 'permission', phase: 'input-requested', question: redact(data.question ?? data.text, 1000), callId: asString(data.callId) }
    case 'tool/approval-request':
      return { ...base, kind: 'permission', phase: 'approval-requested', tool: asString(data.name), callId: asString(data.callId) }
    case 'approval/asked':
      // The desktop's own approval waterfall: observed and reported only, never
      // answered by the bridge.
      return {
        ...base,
        kind: 'permission',
        phase: 'approval-requested',
        tool: asString(data.toolName) ?? asString(data.name),
        callId: asString(data.callId),
        reason: redact(data.reason, 1000),
      }
    case 'session/title':
      return { ...base, kind: 'status', phase: 'title', title: asString(data.title) }
    default: {
      // The raw payload stays available for diagnosis, but a bounded digest is
      // also projected so a caller never has to walk a multi-megabyte body.
      const summary = dataDigest(data)
      return { ...base, kind: 'log', data, ...(summary === null ? {} : { summary }) }
    }
  }
}

/** One bounded, human-readable line describing an unprojected event payload. */
function dataDigest(data, limit = 300) {
  const preferred = ['title', 'text', 'message', 'reason', 'question', 'toolName', 'name', 'kind', 'mode', 'policy', 'id', 'target']
  const parts = []
  for (const key of preferred) {
    const value = data?.[key]
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    parts.push(`${key}=${String(value)}`)
  }
  for (const [key, value] of Object.entries(asObject(data) ?? {})) {
    if (preferred.includes(key)) continue
    if (typeof value !== 'object' && value !== null) parts.push(`${key}=${String(value)}`)
    else if (Array.isArray(value)) parts.push(`${key}[${value.length}]`)
  }
  return parts.length === 0 ? null : redact(parts.join(' '), limit)
}

/* ──────────────────────────── plugin entry ──────────────────────────── */

export function apply(ctx, config = {}) {
  const prefix = (typeof config.prefix === 'string' && config.prefix.startsWith('/') ? config.prefix.replace(/\/+$/, '') : DEFAULT_PREFIX) || DEFAULT_PREFIX
  const stateDir = typeof config.stateDir === 'string' && config.stateDir !== '' ? config.stateDir : join(homedir(), '.dsh', 'codex-bridge')
  const tokenFile = typeof config.tokenFile === 'string' && config.tokenFile !== '' ? config.tokenFile : undefined
  const workspacePaths = Array.isArray(config.workspacePaths) ? config.workspacePaths.filter((entry) => typeof entry === 'string' && entry !== '') : undefined
  const maxBodyBytes = clampInt(config.maxRequestBytes, DEFAULT_MAX_BODY_BYTES, 1024, 8 * 1024 * 1024)
  const maxWaitMs = clampInt(config.maxWaitMs, DEFAULT_MAX_WAIT_MS, 0, 120000)
  const eventCacheLimit = clampInt(config.eventCacheLimit, DEFAULT_EVENT_CACHE, 50, 20000)
  const requestTtlMs = clampInt(config.requestIdTtlMs, DEFAULT_REQUEST_TTL_MS, 60000, 30 * 86400000)

  const statePath = join(stateDir, 'state.json')
  const tokensPath = join(stateDir, 'tokens.json')
  const stateStore = new JsonStore(statePath, 0o600)
  const tokenStore = new JsonStore(tokensPath, 0o600)

  /** taskId → sessionId for every tracked task. */
  let tasks = {}
  /** One follower per session; each owns the live tail of that session. */
  const followers = new Map()
  const logger = ctx.logger ?? console

  /* ── durable state ─────────────────────────────────────────────────── */

  const persistTasks = () => stateStore.update((current) => {
    current.tasks = tasks
    current.version = 1
    return undefined
  }).catch((error) => logger.warn?.(`codex-bridge: could not persist task state: ${String(error)}`))

  const schedulePersist = () => {
    void persistTasks()
  }

  /**
   * Addressable task: not revoked and not closed.
   *
   * A closed task stops being addressable by `taskId`, which is what
   * `POST /tasks/close` documents. Its binding stays on disk, so a later
   * `tasks/create` can adopt the same session again.
   */
  const taskById = (taskId) => Object.values(tasks).find((task) => task.taskId === taskId && task.revoked !== true && task.status !== 'closed')

  /** Any recorded task, including a closed one, for adoption and admin views. */
  const taskByIdIncludingClosed = (taskId) => Object.values(tasks).find((task) => task.taskId === taskId && task.revoked !== true)

  const notRevoked = (task) => task.revoked !== true

  /* ── authentication ───────────────────────────────────────────────── */

  /**
   * Read the current credential set. Both sources are re-read on every request
   * (they are tiny), so an issued or revoked token takes effect immediately and
   * a restart is never needed to rotate a credential.
   */
  const loadTokens = async () => {
    const tokens = {}
    if (tokenFile !== undefined && existsSync(tokenFile)) {
      let text
      try {
        text = (await readFile(tokenFile, 'utf8')).trim()
      } catch (error) {
        throw fail('bridge/internal', `bridge token file is unreadable: ${String(error)}`)
      }
      if (text !== '') {
        const alias = `file:${tokenFile}`
        tokens[alias] = {
          alias,
          hash: hashToken(text.startsWith(TOKEN_PREFIX) ? text : `${TOKEN_PREFIX}${text}`),
          workspaceIds: null,
          createdAt: new Date(0).toISOString(),
          source: 'token-file',
        }
      }
    }
    const stored = await readJsonFile(tokensPath)
    for (const entry of Object.values(asObject(stored?.tokens) ?? {})) {
      const record = asObject(entry)
      if (record === undefined || typeof record.hash !== 'string') continue
      tokens[record.alias ?? record.hash.slice(0, 12)] = record
    }
    return tokens
  }

  /** Resolve a bearer credential to an authorized client, or throw. */
  const authenticate = async (authorization) => {
    const header = asString(authorization) ?? ''
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) throw fail('auth/missing-token', 'provide an Authorization: Bearer <token> header')
    const presented = match[1].trim()
    const tokens = await loadTokens()
    let matched
    for (const record of Object.values(tokens)) {
      if (typeof record?.hash !== 'string') continue
      if (tokenMatches(presented, record.hash)) {
        matched = record
        break
      }
    }
    if (matched === undefined) throw fail('auth/invalid-token', 'the presented token is not valid; revoke and issue a new one')
    // Scope is explicit and never widened by accident:
    //   workspaceIds absent/not an array → the credential is a deliberate
    //                                     deployment-wide token
    //   workspaceIds: []               → authorized for nothing
    //   workspaceIds: [ids…]           → authorized for exactly those ids
    let allowed = null
    if (Array.isArray(matched.workspaceIds)) {
      allowed = new Set(matched.workspaceIds.filter((id) => typeof id === 'string' && id !== ''))
    }
    return { clientId: asString(matched.alias) ?? 'client', allowedWorkspaceIds: allowed, allowWorkspaceCreate: matched.allowWorkspaceCreate === true }
  }

  /**
   * Resolve the workspace for a request and enforce both authorization layers:
   * the client's configured scope and the deployment's configured workspace list.
   */
  const resolveWorkspace = (client, workspaceId) => {
    const id = requireString(workspaceId, 'workspaceId')
    if (client.allowedWorkspaceIds !== null && !client.allowedWorkspaceIds.has(id)) {
      throw fail('auth/workspace-forbidden', `token "${client.clientId}" is not configured for workspace "${id}"`, { workspaceId: id })
    }
    const workspace = ctx.workspaceRegistry.get(id)
    if (workspace === undefined) throw fail('workspace/not-found', `workspace "${id}" is not registered in this Harness`, { workspaceId: id })
    if (workspacePaths !== undefined && !workspacePaths.includes(workspace.path)) {
      throw fail('auth/workspace-forbidden', `workspace "${id}" (${workspace.path}) is outside this deployment's configured workspace list`, { workspaceId: id })
    }
    return workspace
  }

  /**
   * Whether a token may address one workspace id, including the deployment's
   * directory allowlist.
   *
   * Every replay, read, and list path asks this question *before* it discloses
   * anything about a task, so a token can never learn that a task exists in a
   * workspace it is not configured for.
   */
  const workspaceAllowedFor = (client, workspaceId) => {
    if (typeof workspaceId !== 'string' || workspaceId === '') return false
    if (client.allowedWorkspaceIds !== null && !client.allowedWorkspaceIds.has(workspaceId)) return false
    const workspace = ctx.workspaceRegistry.get(workspaceId)
    if (workspace === undefined) return false
    if (workspacePaths !== undefined && !workspacePaths.includes(workspace.path)) return false
    return true
  }

  /**
   * The uniform refusal for a task outside the caller's scope.
   *
   * It carries no task, workspace, or session identity: a token must never be
   * able to learn that foreign work exists, let alone which workspace holds it.
   */
  const refuseTask = () => fail(
    'auth/workspace-forbidden',
    'this token is not configured for the addressed task or workspace',
  )

  /* ── session followers (live tail) ─────────────────────────────────── */

  const followerFor = (sessionId) => followers.get(sessionId)

  const ensureFollower = (task) => {
    const existing = followers.get(task.sessionId)
    if (existing !== undefined) {
      existing.tasks.add(task.taskId)
      return existing
    }
    const follower = {
      sessionId: task.sessionId,
      tasks: new Set([task.taskId]),
      tail: [],
      lastSeq: -1,
      /** Sessions covered by the tail start here; a client below it needs the durable log. */
      truncatedBeforeSeq: -1,
      /** Frontier at adoption time: events at or below it are history, not this round. */
      adoptionSeq: -1,
      status: 'starting',
      failure: undefined,
      assistantStreaming: false,
      /** Bounded page of durable history fetched for a cursor that predates the tail. */
      durable: undefined,
      durableLoading: false,
      waiters: new Set(),
      listeners: new Set(),
      controller: new AbortController(),
      pump: undefined,
    }
    followers.set(task.sessionId, follower)
    follower.pump = pumpFollower(follower).catch((error) => {
      follower.status = 'failed'
      follower.failure = { code: 'bridge/internal', message: redact(String(error), 500) }
      logger.warn?.(`codex-bridge: session follower for ${task.sessionId} stopped: ${String(error)}`)
      emit(follower, { kind: 'status', phase: 'follower-failed', error: follower.failure })
    })
    return follower
  }

  /** One projected status line; kept in the same tail as session events. */
  const emit = (follower, partial) => {
    record(follower, {
      taskId: null,
      sessionSeq: follower.lastSeq,
      at: Date.now(),
      sessionEventType: 'bridge/status',
      ...partial,
    })
  }

  /**
   * Record one event at the tail frontier.
   *
   * Events are accepted whether they arrive live from the Host stream or were
   * reconstructed from a snapshot record or a durable-log page, so every read
   * path shares one cursor. A non-advancing sequence is ignored (the delivery
   * contract is at-least-once), but a same-sequence status line is still
   * forwarded to listeners so a waiter never misses a follower change.
   */
  /** Drop the oldest cached events until the tail fits the configured limit. */
  const trimTail = (follower) => {
    const limit = Math.max(1, eventCacheLimit)
    const overflow = follower.tail.length - limit
    if (overflow <= 0) return
    const dropped = follower.tail.splice(0, overflow)
    for (const entry of dropped) {
      const droppedSeq = Number(entry?.sessionSeq)
      if (Number.isFinite(droppedSeq) && droppedSeq > follower.truncatedBeforeSeq) {
        follower.truncatedBeforeSeq = droppedSeq
      }
    }
  }

  /** Notify listeners and waiters of one accepted event. */
  const publish = (follower, event) => {
    for (const listener of follower.listeners) {
      try {
        listener(event)
      } catch (error) {
        logger.warn?.(`codex-bridge: event listener failed: ${String(error)}`)
      }
    }
    for (const waiter of follower.waiters) waiter(event)
  }

  const record = (follower, event) => {
    const seq = Number(event?.sessionSeq)
    if (!Number.isFinite(seq)) return
    if (seq > follower.lastSeq) {
      follower.lastSeq = seq
      follower.tail.push(event)
      trimTail(follower)
    } else if (String(event?.sessionEventType ?? '') === 'bridge/status') {
      // A same-sequence status line is still forwarded so a waiter never
      // misses a follower change.
      follower.tail.push(event)
      trimTail(follower)
    } else {
      return
    }
    publish(follower, event)
    // History at or below the adoption frontier must never be folded into the
    // live task state: a replayed `turn-completed` is not the end of a round
    // the caller just submitted.
    if (seq > follower.adoptionSeq) applyTaskState(follower, event)
  }

  /**
   * Install one snapshot page.
   *
   * The page is history: it is cached for replay and published to listeners,
   * but it never advances a task's live state (the adoption frontier already
   * covers it) and it never raises `lastSeq` beyond the frame cursor. Inserting
   * a page explicitly is what makes the opening snapshot usable — routing it
   * through `record`, which accepts only strictly newer sequences, silently
   * dropped every record of a snapshot whose cursor had already landed.
   */
  const applySnapshotPage = (follower, records) => {
    const inserted = []
    for (const record_ of records) {
      const seq = Number(record_?.sessionSeq)
      if (!Number.isFinite(seq)) continue
      if (follower.tail.some((entry) => Number(entry?.sessionSeq) === seq)) continue
      const last = follower.tail[follower.tail.length - 1]
      if (last === undefined || seq > Number(last.sessionSeq)) {
        follower.tail.push(record_)
      } else {
        const index = follower.tail.findIndex((entry) => Number(entry?.sessionSeq) > seq)
        follower.tail.splice(index === -1 ? follower.tail.length : index, 0, record_)
      }
      inserted.push(record_)
    }
    trimTail(follower)
    // Listeners see only the newly cached history, in order, so a stream that
    // attached after the reconnect can still resynchronise.
    inserted.sort((left, right) => Number(left.sessionSeq) - Number(right.sessionSeq))
    for (const entry of inserted) publish(follower, entry)
    return inserted.length
  }

  /**
   * The lowest sequence a wait may report as a settled turn.
   *
   * `waitFloor` is the sequence at which the current round was submitted, so
   * everything at or below it belongs to an earlier round. A `turn-completed`
   * replayed by a snapshot or a durable page therefore can never be reported as
   * the end of the round just submitted, while that round's own terminal event —
   * necessarily above the pre-submission frontier — still settles the wait.
   */
  const settleFrontier = (task, condition) => {
    const requested = clampInt(condition?.sinceSeq, -1, -1, Number.MAX_SAFE_INTEGER)
    const roundFloor = Number.isFinite(Number(task?.waitFloor)) ? Number(task.waitFloor) : -1
    return Math.max(requested, roundFloor)
  }

  /** Fold one projected event into every task that owns this session. */
  const applyTaskState = (follower, event) => {
    const phase = String(event.phase ?? '')
    for (const taskId of follower.tasks) {
      const task = taskById(taskId)
      if (task === undefined) continue
      if (event.observedConfig !== undefined) task.observedConfig = event.observedConfig
      if (phase === 'turn-start') {
        task.status = 'running'
        task.activeTurn = event.turn
      } else if (phase.startsWith('turn-')) {
        task.status = phase === 'turn-completed' ? 'idle' : 'attention'
        task.lastTurn = { turn: event.turn, reason: event.reason ?? phase, at: event.at }
        task.activeTurn = undefined
      } else {
        continue
      }
      task.updatedAt = new Date().toISOString()
      schedulePersist()
    }
  }

  /**
   * One bounded page of durable history that ends at or before `throughSeq`.
   *
   * It is the recovery path for a cursor the in-memory tail cannot serve: after
   * a desktop restart, or when a task adopts a session the bridge was not
   * following. The page is cached per follower because the observation is the
   * expensive part and a transcript read has no way to page backwards by itself.
   */
  const DURABLE_WINDOW_LIMIT = 1000
  const DURABLE_WINDOW_TTL_MS = 15000

  const durableWindow = async (follower, throughSeq, signal) => {
    const cached = follower.durable
    const fresh = cached !== undefined && (Date.now() - cached.at) < DURABLE_WINDOW_TTL_MS && cached.throughSeq >= throughSeq
    if (fresh) return cached
    const queryService = ctx.get('sessionQuery')
    if (queryService === undefined) return undefined
    const observation = await queryService.observeSession(follower.sessionId, { projectionMode: 'none', signal })
    try {
      const events = []
      for (const event of observation.events ?? []) {
        const seq = Number(event?.seq)
        if (!Number.isFinite(seq) || seq > throughSeq) continue
        events.push(event)
      }
      const window = events.slice(-DURABLE_WINDOW_LIMIT)
      follower.durable = {
        at: Date.now(),
        throughSeq,
        events: window,
        firstSeq: window.length === 0 ? undefined : Number(window[0].seq),
        hasMore: window.length < events.length,
        cursor: Number(observation.cursor ?? -1),
      }
      return follower.durable
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  /**
   * Fold one Host snapshot frame into the follower.
   *
   * The snapshot carries the cursor and the message-aligned page the Host
   * already loaded; ignoring them (as an earlier revision did) left a follower
   * that was "live" with an empty tail, which is exactly the state a client saw
   * as `followerStatus: live, cursor: -1, items: []`.
   */
  const applySnapshot = (follower, frame) => {
    const cursor = Number(frame?.cursor)
    follower.status = 'live'
    follower.revision = frame?.cursor
    if (frame?.header?.cwd !== undefined) follower.cwd = frame.header.cwd
    if (Number.isFinite(cursor) && cursor > follower.lastSeq) follower.lastSeq = cursor
    if (frame?.hasMore === true) {
      for (const entry of frame.records ?? []) {
        const seq = Number(entry?.event?.seq)
        if (Number.isFinite(seq) && seq - 1 > follower.truncatedBeforeSeq) follower.truncatedBeforeSeq = seq - 1
      }
    }
    // Everything at or below the snapshot cursor is history for this follower:
    // the page is cached for replay and never folded into the live task state.
    if (Number.isFinite(cursor) && cursor > follower.adoptionSeq) follower.adoptionSeq = cursor
    const taskId = [...follower.tasks][0] ?? null
    const page = []
    for (const entry of frame?.records ?? []) {
      const event = entry?.event
      if (!Number.isFinite(Number(event?.seq))) continue
      page.push(projectEvent(event, taskId))
    }
    applySnapshotPage(follower, page)
  }

  async function pumpFollower(follower) {
    const signal = follower.controller.signal
    const stream = ctx.sessionController.follow({ address: { kind: 'session', sessionId: follower.sessionId } }, signal)
    for await (const frame of stream) {
      if (signal.aborted) break
      if (frame?.type === 'snapshot') {
        applySnapshot(follower, frame)
        continue
      }
      if (frame?.type === 'assistant-stream') {
        if (follower.assistantStreaming !== true) {
          follower.assistantStreaming = true
          emit(follower, { kind: 'status', phase: 'assistant-streaming' })
        }
        continue
      }
      if (frame?.type === 'event') {
        const taskId = [...follower.tasks][0] ?? null
        const projected = projectEvent(frame.event, taskId)
        follower.assistantStreaming = false
        record(follower, projected)
      }
    }
    if (!signal.aborted) {
      follower.status = 'ended'
      emit(follower, { kind: 'status', phase: 'stream-ended' })
    }
  }

  /** Stop one follower and release its listeners, waiters, and stream. */
  const dropFollower = (sessionId) => {
    const follower = followers.get(sessionId)
    if (follower === undefined) return
    followers.delete(sessionId)
    try {
      follower.controller.abort()
    } catch {
      /* an already-aborted controller is not an error */
    }
    follower.waiters.clear()
    follower.listeners.clear()
  }

  // A session can be adopted by several tasks. Closing/rebinding one task
  // releases only its reference; the remaining tasks must keep receiving data.
  const releaseTaskFollower = (task) => {
    const follower = followers.get(task.sessionId)
    if (follower === undefined) return
    follower.tasks.delete(task.taskId)
    if (follower.tasks.size === 0) dropFollower(task.sessionId)
  }

  /* ── state reconstruction on load ─────────────────────────────────── */

  const bootstrap = async () => {
    const stored = await stateStore.load()
    tasks = asObject(stored?.tasks) ?? {}
    for (const task of Object.values(tasks)) {
      if (task.revoked === true || task.sessionId === undefined) continue
      // A desktop restart resumed no follower: reattach one for every task that
      // is still open so the client's next reconnect replays from the log. The
      // follower re-reads the session snapshot, so a client cursor from before
      // the restart is served from the durable log instead of an empty tail.
      if (task.status !== 'closed') {
        // A round cannot survive a restart: clear any in-flight marker so the
        // first wait after the restart is not gated by a stale floor.
        delete task.awaitingSettle
        delete task.awaitingSettleSeq
        delete task.waitFloor
        ensureFollower(task)
      }
    }
  }

  /* ── HTTP plumbing ─────────────────────────────────────────────────── */

  const sendJson = (res, status, payload, requestId) => {
    const body = JSON.stringify(payload, null, 2)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      ...(requestId === undefined ? {} : { 'x-bridge-request-id': requestId }),
    })
    res.end(body)
  }

  const sendOk = (res, value, requestId) => sendJson(res, 200, {
    ok: true,
    protocolVersion: PROTOCOL_VERSION,
    requestId: requestId ?? null,
    value,
  }, requestId)

  const sendError = (res, error, requestId) => {
    const code = error instanceof BridgeError ? error.code : 'bridge/internal'
    const status = ERROR_STATUS[code] ?? 500
    if (!(error instanceof BridgeError)) logger.warn?.(`codex-bridge: internal failure: ${error?.stack ?? String(error)}`)
    sendJson(res, status, {
      ok: false,
      protocolVersion: PROTOCOL_VERSION,
      requestId: requestId ?? null,
      error: {
        code,
        message: error instanceof BridgeError ? error.message : 'the bridge failed to complete the request',
        ...(error instanceof BridgeError && error.details !== undefined ? { details: error.details } : {}),
      },
    }, requestId)
  }

  const readBody = async (req, signal) => {
    if (req.method === 'GET' || req.method === 'HEAD') return {}
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      if (signal?.aborted === true) throw fail('request/bad-request', 'the client disconnected before the body was complete')
      total += chunk.length
      if (total > maxBodyBytes) throw fail('request/too-large', `request body exceeds ${maxBodyBytes} bytes`)
      chunks.push(chunk)
    }
    if (total === 0) return {}
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const record = asObject(parsed)
      if (record === undefined) throw fail('request/bad-request', 'request body must be a JSON object')
      return record
    } catch (error) {
      if (error instanceof BridgeError) throw error
      throw fail('request/bad-request', 'request body is not valid JSON')
    }
  }

  /* ── idempotency ───────────────────────────────────────────────────── */

  const beginRequest = (task, requestId, op) => {
    task.requests = task.requests ?? {}
    const prior = task.requests[requestId]
    if (prior !== undefined) {
      if (prior.op !== op) throw fail('request/conflict', `requestId "${requestId}" was already used for "${prior.op}"`, { requestId, op: prior.op })
      if (prior.state === 'done') return { replay: prior.response }
      throw fail('request/conflict', `requestId "${requestId}" is still in flight`, { requestId })
    }
    const createdAt = Date.now()
    task.requests[requestId] = { op, state: 'pending', createdAt }
    const cutoff = createdAt - requestTtlMs
    for (const [key, entry] of Object.entries(task.requests)) {
      if (entry.state === 'done' && entry.createdAt < cutoff) delete task.requests[key]
    }
    return { replay: undefined }
  }

  const finishRequest = (task, requestId, response) => {
    if (task?.requests?.[requestId] !== undefined) {
      task.requests[requestId] = { ...task.requests[requestId], state: 'done', response, finishedAt: Date.now() }
      schedulePersist()
    }
  }

  const abortRequest = (task, requestId) => {
    if (task?.requests?.[requestId] !== undefined) delete task.requests[requestId]
  }

  /* ── operation handlers ────────────────────────────────────────────── */

  const canCreateWorkspace = (client) => config.allowWorkspaceCreate !== false && typeof ctx.workspaceRegistry.create === 'function' && client.allowedWorkspaceIds === null && client.allowWorkspaceCreate === true

  const createWorkspace = async (client, body) => {
    if (!canCreateWorkspace(client)) throw fail('auth/workspace-forbidden', 'workspace creation requires an all-workspaces credential with allowWorkspaceCreate enabled')
    const requestId = requireRequestId(body.requestId)
    const path = requireString(body.path, 'path')
    if (!isAbsolute(path) || (process.platform === 'win32' && ['\\', '/'].includes(parse(path).root))) throw fail('request/bad-request', 'path must be a fully qualified existing directory')
    if (body.createDirectory === true) throw fail('request/bad-request', 'directory creation is not supported; create the directory explicitly first')
    const title = body.title === undefined ? undefined : requireString(body.title, 'title')
    let canonical
    try {
      canonical = await realpath(path)
      if (!(await stat(canonical)).isDirectory()) throw new Error('not a directory')
    } catch {
      throw fail('request/bad-request', 'path must reference an existing directory')
    }
    if (workspacePaths !== undefined && !workspacePaths.includes(canonical)) throw fail('auth/workspace-forbidden', 'path is outside the deployment workspace allowlist')
    // Serialize and persist idempotency with task state; registry.create also
    // reuses canonical paths if host creation succeeds before a client disconnect.
    return stateStore.update(async current => {
      current.workspaceRequests ??= {}
      const key = JSON.stringify([client.clientId, requestId])
      const fingerprint = JSON.stringify([canonical, title ?? null])
      const prior = current.workspaceRequests[key]
      if (prior && prior.fingerprint !== fingerprint) throw fail('request/conflict', 'requestId already belongs to a different workspace request')
      if (prior) {
        const workspace = resolveWorkspace(client, prior.workspaceId)
        return {workspace: {workspaceId: workspace.id, title: workspace.title, path: workspace.path}, replayed: true, reused: true}
      }
      const existed = ctx.workspaceRegistry.list().some(w => w.path === canonical)
      const workspace = await ctx.workspaceRegistry.create(canonical, title)
      resolveWorkspace(client, workspace.id)
      current.workspaceRequests[key] = {fingerprint, workspaceId: workspace.id}
      return {workspace: {workspaceId: workspace.id, title: workspace.title, path: workspace.path}, replayed: false, reused: existed}
    })
  }

  const capabilities = async (client) => {
    const presets = ctx.get('agentPresets')
    let presetList = []
    let presetError
    if (presets === undefined) presetError = 'this deployment mounts no agent-preset registry'
    else {
      try {
        presetList = (await presets.list()).map((preset) => ({ id: asString(preset?.id) ?? String(preset), name: asString(preset?.name ?? preset?.id) ?? String(preset) }))
      } catch (error) {
        presetError = redact(String(error), 300)
      }
    }
    let catalog
    let catalogError
    try {
      catalog = await ctx.sessionController.modelCatalog()
    } catch (error) {
      catalogError = redact(String(error), 300)
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      routePrefix: prefix,
      capabilities: {
        workspaces: { list: true, create: canCreateWorkspace(client), createDirectory: false, scope: client.allowedWorkspaceIds === null ? 'all-configured' : 'selected' },
        sessions: { create: true, adopt: true, rename: true, list: true, cancel: true },
        models: { catalog: catalogError === undefined, select: true, verifyObserved: true },
        presets: { list: presetError === undefined, select: true },
        events: { longPoll: true, sse: true, replay: true, cursor: 'sessionSeq' },
        permissions: { autoApprove: false, observeWaits: true },
      },
      modelCatalog: catalog === undefined
        ? { unavailable: catalogError }
        : {
            default: catalog.default,
            routableProviders: catalog.routableProviders,
            groups: catalog.groups.map((group) => ({
              id: group.id,
              name: group.name,
              models: group.models.map((model) => ({
                id: model.id,
                name: model.name,
                description: model.description ?? null,
                reasoning: model.reasoning === undefined ? null : {
                  defaultEffort: model.reasoning.defaultEffort ?? null,
                  efforts: model.reasoning.efforts.map((effort) => ({ id: effort.id, name: effort.name, description: effort.description ?? null })),
                },
              })),
            })),
            failures: catalog.failures,
          },
      agentPresets: presetError === undefined ? presetList : { unavailable: presetError },
      unavailable: {
        ...(presetError === undefined ? {} : { agentPresets: presetError }),
        ...(catalogError === undefined ? {} : { modelCatalog: catalogError }),
      },
    }
  }

  const listWorkspaces = async (client) => {
    const items = []
    for (const workspace of ctx.workspaceRegistry.list()) {
      if (client.allowedWorkspaceIds !== null && !client.allowedWorkspaceIds.has(workspace.id)) continue
      if (workspacePaths !== undefined && !workspacePaths.includes(workspace.path)) continue
      let status = 'unknown'
      try {
        status = await workspace.status()
      } catch {
        status = 'unknown'
      }
      items.push({
        workspaceId: workspace.id,
        title: workspace.title,
        path: workspace.path,
        status,
        sessionCount: workspace.sessionIds.length,
        sessionIds: [...workspace.sessionIds],
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
      })
    }
    return { items, tokenScope: client.allowedWorkspaceIds === null ? 'all-configured' : [...client.allowedWorkspaceIds] }
  }

  /**
   * Validate one requested selection against the live model catalog before it
   * reaches the session: an unavailable model or an unsupported reasoning
   * effort is reported, never silently replaced.
   */
  const validateSelection = async (selection) => {
    const requested = {}
    if (selection.provider !== undefined || selection.model !== undefined) {
      const catalog = await ctx.sessionController.modelCatalog()
      const providerId = requireString(selection.provider, 'provider')
      const modelId = requireString(selection.model, 'model')
      const group = catalog.groups.find((candidate) => candidate.id === providerId)
      if (group === undefined) {
        throw fail('model/unavailable', `provider "${providerId}" is not routable in this Harness`, {
          provider: providerId,
          routableProviders: catalog.routableProviders,
          failures: catalog.failures,
        })
      }
      const model = group.models.find((candidate) => candidate.id === modelId)
      if (model === undefined) {
        throw fail('model/unavailable', `model "${modelId}" is not available under provider "${providerId}"`, {
          provider: providerId,
          availableModels: group.models.map((candidate) => candidate.id),
        })
      }
      requested.provider = providerId
      requested.model = modelId
      if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
        const effort = requireString(selection.reasoningEffort, 'reasoningEffort')
        const efforts = model.reasoning?.efforts?.map((candidate) => candidate.id) ?? []
        if (!efforts.includes(effort)) {
          throw fail('model/reasoning-effort-unavailable', `model "${modelId}" does not support reasoning effort "${effort}"`, {
            model: modelId,
            requestedEffort: effort,
            supportedEfforts: efforts,
          })
        }
        requested.reasoningEffort = effort
      }
    } else if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
      throw fail('request/bad-request', 'reasoningEffort requires provider and model')
    }
    return Object.keys(requested).length === 0 ? undefined : requested
  }

  const createTask = async (client, body) => {
    const requestId = requireRequestId(body.requestId)
    const taskId = body.taskId === undefined ? `task-${randomUUID()}` : requireString(body.taskId, 'taskId')
    // Authorization comes first: resolve the target workspace before this
    // request may learn anything about an existing task. An existing-task or
    // requestId replay used to be answered before `resolveWorkspace` ran, so a
    // token scoped to workspace A could read a workspace B task by offering its
    // `taskId` or a `requestId` that B had already used.
    const workspace = resolveWorkspace(client, body.workspaceId)
    // An empty scope means "no workspace is authorized", never "every
    // workspace": the task statement requires an explicit range.
    if (client.allowedWorkspaceIds !== null && client.allowedWorkspaceIds.size === 0) {
      throw fail('auth/workspace-forbidden', `token "${client.clientId}" is configured for no workspace`, { workspaceId: workspace.id })
    }
    for (const candidate of Object.values(tasks)) {
      if (candidate.revoked === true || candidate.requests?.[requestId] === undefined) continue
      // A `requestId` is the caller's own idempotency key. When it is already
      // recorded for a task this token may not address, the conflict is
      // reported without naming that task, its workspace, or its session:
      // replay must never be the way a token learns about foreign work.
      if (!workspaceAllowedFor(client, candidate.workspaceId)) {
        throw fail('request/conflict', `requestId "${requestId}" is already in use`, { requestId })
      }
      if (candidate.taskId !== taskId) {
        throw fail('request/conflict', `requestId "${requestId}" was already used to create task "${candidate.taskId}"`, { requestId, taskId: candidate.taskId })
      }
      return { task: publicTask(candidate), replayed: true }
    }
    // Adoption of a closed task is intentional; it is what `tasks/close`
    // documents. The new taskId rebinds the *same* session instead of creating
    // a second one, which is the point of a rebindable task id.
    const recorded = taskByIdIncludingClosed(taskId)
    let adoptSessionId
    if (recorded !== undefined) {
      // Both refusals are uniform so this request cannot probe which task IDs
      // exist outside the caller's scope.
      if (!workspaceAllowedFor(client, recorded.workspaceId)) throw refuseTask()
      if (recorded.workspaceId !== workspace.id) {
        throw fail('request/conflict', `taskId "${taskId}" already exists in another workspace`, { taskId })
      }
      if (recorded.status !== 'closed') {
        ensureFollower(recorded)
        return { task: publicTask(recorded), replayed: true }
      }
      adoptSessionId = recorded.sessionId
      delete tasks[recorded.taskId]
      releaseTaskFollower(recorded)
    }
    const requested = await validateSelection({
      provider: body.provider,
      model: body.model,
      reasoningEffort: body.reasoningEffort,
    })
    const sessionId = body.sessionId !== undefined
      ? requireString(body.sessionId, 'sessionId')
      : adoptSessionId
    const created = await ctx.sessionController.create({
      workspaceId: workspace.id,
      agentPreset: body.agentPreset === undefined ? undefined : requireString(body.agentPreset, 'agentPreset'),
      sessionId,
    })
    const task = {
      taskId,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      sessionId: created.sessionId,
      agentPreset: created.agentPreset ?? null,
      title: body.title === undefined ? null : requireString(body.title, 'title'),
      objective: body.objective === undefined ? null : redact(body.objective, 4000),
      acceptanceCriteria: body.acceptanceCriteria === undefined ? null : redact(body.acceptanceCriteria, 4000),
      taskContext: body.taskContext === undefined ? null : redact(JSON.stringify(body.taskContext), 4000),
      external: asObject(body.external) ?? null,
      requestedConfig: requested ?? null,
      observedConfig: null,
      status: 'idle',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      rounds: [],
      requests: {},
      createdBy: client.clientId,
      revoked: false,
    }
    if (task.title !== null) {
      try {
        await ctx.sessionController.rename({ sessionId: task.sessionId, title: task.title })
      } catch (error) {
        logger.warn?.(`codex-bridge: title was not applied to ${task.sessionId}: ${String(error)}`)
      }
    }
    tasks[taskId] = task
    ensureFollower(task)
    const response = { taskId: task.taskId, sessionId: task.sessionId, workspaceId: task.workspaceId, replayed: false }
    task.requests[requestId] = { op: 'tasks/create', state: 'done', createdAt: Date.now(), finishedAt: Date.now(), response }
    await persistTasks()
    return { task: publicTask(task), replayed: false }
  }

  const appendRound = async (client, body, signal) => {
    const requestId = requireRequestId(body.requestId)
    const task = requireTask(client, body.taskId)
    const kind = body.kind === undefined ? 'instruction' : requireString(body.kind, 'kind')
    if (!['instruction', 'feedback', 'question', 'review', 'clarification', 'note'].includes(kind)) {
      throw fail('request/bad-request', `unknown round kind "${kind}"`)
    }
    const message = requireString(body.message, 'message')
    const gate = beginRequest(task, requestId, `tasks/append:${kind}`)
    if (gate.replay !== undefined) return { ...gate.replay, replayed: true }
    try {
      const requested = await validateSelection({ provider: body.provider, model: body.model, reasoningEffort: body.reasoningEffort })
      if (requested !== undefined) {
        const selected = await ctx.sessionController.selectModel({ sessionId: task.sessionId, ...requested })
        task.requestedConfig = selected.selected
      }
      const round = {
        round: task.rounds.length + 1,
        kind,
        message,
        requestId,
        at: new Date().toISOString(),
        promptRequestId: requestId,
      }
      task.rounds.push(round)
      task.updatedAt = new Date().toISOString()
      const follower = ensureFollower(task)
      if (follower.status === 'failed') {
        throw fail('bridge/internal', `the session event follower for ${task.sessionId} is not running: ${follower.failure?.message ?? 'unknown reason'}`)
      }
      // The floor is sampled *before* submission: everything already in the log
      // belongs to an earlier round, and only a terminal event above this
      // sequence can be this round's end. Sampling after the prompt would race
      // the round's own events and bury them under the floor.
      task.waitFloor = Number(follower.lastSeq ?? -1)
      const accepted = await ctx.sessionController.prompt({
        requestId,
        sessionId: task.sessionId,
        mode: body.mode === 'steer' ? 'steer' : 'queue',
        content: [{ type: 'text', text: message }],
      }, signal)
      round.accepted = accepted.accepted === true
      task.status = follower.status === 'live' ? 'running' : 'starting'
      const response = { taskId: task.taskId, sessionId: task.sessionId, round: round.round, accepted: round.accepted, replayed: false }
      finishRequest(task, requestId, response)
      await persistTasks()
      return response
    } catch (error) {
      task.rounds = task.rounds.filter((round) => round.requestId !== requestId)
      abortRequest(task, requestId)
      if (!(error instanceof BridgeError)) throw fail('bridge/internal', `prompt admission failed: ${redact(String(error), 500)}`)
      throw error
    }
  }

  const requireTask = (client, taskIdValue) => {
    const taskId = requireString(taskIdValue, 'taskId')
    const task = taskById(taskId)
    if (task === undefined) throw fail('task/not-found', `task "${taskId}" is unknown to this bridge`, { taskId })
    const workspace = ctx.workspaceRegistry.get(task.workspaceId)
    if (workspace === undefined) throw fail('workspace/not-found', `task "${taskId}" references a workspace that no longer exists`, { workspaceId: task.workspaceId })
    // Token scope and the deployment's directory allowlist both apply here.
    if (!workspaceAllowedFor(client, task.workspaceId)) throw refuseTask()
    if (task.workspacePath !== undefined && workspace.path !== task.workspacePath) {
      throw fail('session/workspace-mismatch', `task "${taskId}" was bound to ${task.workspacePath} but its workspace now resolves to ${workspace.path}`, { taskId })
    }
    return task
  }

  const publicTask = (task) => ({
    taskId: task.taskId,
    workspaceId: task.workspaceId,
    workspacePath: task.workspacePath,
    sessionId: task.sessionId,
    agentPreset: task.agentPreset ?? null,
    title: task.title ?? null,
    objective: task.objective ?? null,
    acceptanceCriteria: task.acceptanceCriteria ?? null,
    external: task.external ?? null,
    status: task.status,
    requestedConfig: task.requestedConfig ?? null,
    observedConfig: task.observedConfig ?? null,
    lastTurn: task.lastTurn ?? null,
    rounds: task.rounds.map((round) => ({ round: round.round, kind: round.kind, requestId: round.requestId, at: round.at, accepted: round.accepted === true })),
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  })

  /**
   * Read one page of a task's transcript.
   *
   * The in-memory tail is the fast path, but it is not the only source of
   * truth: after a desktop restart the tail starts empty, and a task that
   * adopted an existing session begins at that session's frontier. Whenever the
   * caller's cursor predates what the tail still holds, one bounded durable
   * page is read to fill the gap, so history is never silently reported as
   * empty. Duplicate sequences between the two sources are collapsed here, and
   * `truncatedBefore` states honestly how far back the bridge can answer.
   */
  const readTranscript = async (client, body, signal) => {
    const task = requireTask(client, body.taskId)
    const follower = followerFor(task.sessionId)
    if (follower === undefined) throw fail('bridge/not-ready', `no live follower is attached to session "${task.sessionId}"`)
    const sinceSeq = clampInt(body.sinceSeq, -1, -1, Number.MAX_SAFE_INTEGER)
    const limit = clampInt(body.limit, 200, 1, 2000)
    const followerCursor = Number.isFinite(Number(follower.lastSeq)) ? Number(follower.lastSeq) : -1
    // The tail holds the newest events; a cursor at or after its truncation
    // point is fully served without touching persistence.
    const tailServesCursor = sinceSeq >= Number(follower.truncatedBeforeSeq ?? -1)
    let durable
    if (!tailServesCursor) {
      try {
        durable = await durableWindow(follower, followerCursor, signal)
      } catch (error) {
        // A durable read is a recovery path, not a prerequisite: the tail is
        // still returned, and `truncatedBefore` keeps the gap explicit.
        logger.warn?.(`codex-bridge: durable history read for ${task.sessionId} failed: ${String(error)}`)
      }
    }
    const bySeq = new Map()
    for (const event of durable?.events ?? []) {
      const seq = Number(event?.seq)
      if (!Number.isFinite(seq) || seq <= sinceSeq || seq > followerCursor) continue
      bySeq.set(seq, projectEvent(event, task.taskId))
    }
    for (const event of follower.tail) {
      const seq = Number(event?.sessionSeq)
      if (!Number.isFinite(seq) || seq <= sinceSeq) continue
      // The live tail wins over a durable copy of the same sequence.
      bySeq.set(seq, event)
    }
    const ordered = [...bySeq.values()].sort((left, right) => Number(left.sessionSeq) - Number(right.sessionSeq))
    const cursor = Math.max(followerCursor, ...ordered.map((event) => Number(event.sessionSeq)), -1)
    const oldest = ordered.length === 0 ? undefined : Number(ordered[0].sessionSeq)
    // `truncatedBefore` states the sequence below which this answer is
    // incomplete. A gap is only declared when nothing can fill it: when the
    // durable window already reaches back to the caller's cursor there is no
    // gap, and when nothing was returned there is nothing to qualify.
    const coverage = Number(follower.truncatedBeforeSeq ?? -1)
    let truncatedBefore = null
    if (cursor >= 0) {
      const durableReached = durable !== undefined && durable.firstSeq !== undefined && durable.firstSeq <= coverage
      if (durableReached) truncatedBefore = null
      else if (coverage >= 0) truncatedBefore = coverage
      else if (oldest !== undefined && oldest > Math.max(sinceSeq, -1) + 1) truncatedBefore = oldest
    }
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      followerStatus: follower.status,
      followerFailure: follower.failure ?? null,
      cursor,
      truncatedBefore,
      source: durable === undefined ? 'bridge-follower' : 'bridge-follower+durable',
      items: ordered.slice(-limit),
    }
  }

  /** Non-terminal conditions honour only the caller's own cursor. */
  const eventFloor = (condition) => clampInt(condition?.sinceSeq, -1, -1, Number.MAX_SAFE_INTEGER)

  const collectConditions = (task, follower, condition) => {
    const kinds = Array.isArray(condition?.on) && condition.on.length > 0 ? condition.on : ['turn-end', 'input-request']
    const matched = []
    const terminal = []
    const settledFloor = settleFrontier(task, condition)
    const plainFloor = eventFloor(condition)
    const floor = Math.min(settledFloor, plainFloor)
    for (const event of follower.tail) {
      const seq = Number(event?.sessionSeq)
      if (!Number.isFinite(seq) || seq <= floor) continue
      const settlesRound = seq > settledFloor
      if (kinds.includes('turn-end') && TURN_SETTLED_PHASES.has(String(event.phase ?? '')) && settlesRound) {
        matched.push(event)
        terminal.push(event)
      }
      if (event.kind === 'permission' && (kinds.includes('input-request') || kinds.includes('approval')) && settlesRound) {
        matched.push(event)
        terminal.push(event)
      }
      if (kinds.includes('tool-failure') && event.kind === 'execution' && event.phase === 'tool-result' && event.failed === true) matched.push(event)
      if (kinds.includes('artifact') && event.kind === 'artifact') matched.push(event)
      if (kinds.includes('message') && event.kind === 'message') matched.push(event)
    }
    if (follower.status === 'failed') {
      return { matched, terminal: [...terminal, { kind: 'status', phase: 'follower-failed', error: follower.failure ?? null, sessionSeq: follower.lastSeq, at: Date.now(), taskId: task.taskId, sessionEventType: 'bridge/status' }] }
    }
    return { matched, terminal }
  }

  /**
   * Whether one delivered event settles a wait for the requested conditions.
   *
   * `turn-end` means the turn is over — a `turn-start` or a step boundary is
   * progress, not completion, and must not settle a wait that asked for the
   * turn to end. `turn-start` is therefore its own condition name.
   */
  const settlesWait = (event, kinds) => {
    const phase = String(event.phase ?? '')
    if (kinds.includes('turn-end') && TURN_SETTLED_PHASES.has(phase)) return true
    if (kinds.includes('turn-start') && phase === 'turn-start') return true
    if (event.kind === 'permission' && (kinds.includes('input-request') || kinds.includes('approval'))) return true
    if (event.kind === 'status' && event.phase === 'follower-failed') return true
    if (kinds.includes('message') && event.kind === 'message') return true
    if (kinds.includes('tool-failure') && event.kind === 'execution' && event.phase === 'tool-result' && event.failed === true) return true
    if (kinds.includes('artifact') && event.kind === 'artifact') return true
    return false
  }

  const waitForEvents = async (client, body) => {
    const task = requireTask(client, body.taskId)
    const follower = followerFor(task.sessionId)
    if (follower === undefined) throw fail('bridge/not-ready', `no live follower is attached to session "${task.sessionId}"`)
    const waitMs = clampInt(body.waitMs, maxWaitMs, 0, maxWaitMs)
    const condition = asObject(body.condition) ?? {}
    const requested = Array.isArray(condition.on) && condition.on.length > 0 ? condition.on : ['turn-end', 'input-request']
    const immediate = collectConditions(task, follower, condition)
    // Already-satisfied conditions are delivered at once; `terminal` is only
    // used to distinguish "the session already settled" from "nothing yet".
    if (immediate.matched.length > 0 || immediate.terminal.length > 0 || waitMs === 0) {
      return { taskId: task.taskId, sessionId: task.sessionId, cursor: follower.lastSeq, status: task.status, timedOut: false, events: immediate.matched }
    }
    const outcome = await new Promise((resolve) => {
      let settled = false
      const finish = (timedOut) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        follower.waiters.delete(onEvent)
        resolve({ timedOut })
      }
      const onEvent = (event) => {
        const seq = Number(event?.sessionSeq)
        if (!Number.isFinite(seq)) return
        // Only a terminal phase is additionally gated by the round floor: a
        // message or tool result carries no round-completion meaning.
        if (TURN_SETTLED_PHASES.has(String(event?.phase ?? '')) || event?.kind === 'permission') {
          if (seq <= settleFrontier(task, condition)) return
        } else if (seq <= eventFloor(condition)) {
          return
        }
        if (settlesWait(event, requested)) finish(false)
      }
      const timer = setTimeout(() => finish(true), waitMs)
      timer.unref?.()
      follower.waiters.add(onEvent)
      if (follower.status === 'failed') finish(false)
    })
    const after = collectConditions(task, follower, condition)
    return {
      taskId: task.taskId,
      sessionId: task.sessionId,
      cursor: follower.lastSeq,
      status: task.status,
      timedOut: outcome.timedOut,
      events: after.matched,
    }
  }

  const streamEvents = async (client, req, res, query) => {
    const task = requireTask(client, query.get('taskId'))
    const follower = followerFor(task.sessionId)
    if (follower === undefined) throw fail('bridge/not-ready', `no live follower is attached to session "${task.sessionId}"`)
    const requestedSince = clampInt(query.get('sinceSeq'), -1, -1, Number.MAX_SAFE_INTEGER)
    // Replaying from below the retained tail would present a gap as if it were
    // the whole stream; the first cached sequence is the real start, and clients
    // read the gap-free history through `GET /transcript` when they need it.
    const truncatedBefore = Number(follower.truncatedBeforeSeq ?? -1)
    const sinceSeq = Math.max(requestedSince, truncatedBefore)
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...(requestedSince < truncatedBefore ? { 'x-bridge-truncated-before': String(truncatedBefore) } : {}),
    })
    const write = (event) => {
      if (res.writableEnded || res.destroyed) return
      res.write(`event: bridge\ndata: ${JSON.stringify(event)}\n\n`)
    }
    for (const event of follower.tail) if (event.sessionSeq > sinceSeq) write(event)
    const listener = (event) => {
      if (event.sessionSeq > sinceSeq) write(event)
    }
    follower.listeners.add(listener)
    const keepAlive = setInterval(() => {
      if (res.writableEnded || res.destroyed) return
      res.write(': keep-alive\n\n')
    }, 15000)
    keepAlive.unref?.()
    const close = () => {
      clearInterval(keepAlive)
      follower.listeners.delete(listener)
    }
    req.on('close', close)
    res.on('close', close)
  }

  const cancelTask = async (client, body) => {
    const task = requireTask(client, body.taskId)
    let accepted = false
    try {
      const result = ctx.sessionController.cancel({ sessionId: task.sessionId })
      accepted = result?.accepted === true
    } catch (error) {
      if (!(error instanceof BridgeError)) throw fail('bridge/internal', `cancel failed: ${redact(String(error), 300)}`)
      throw error
    }
    task.status = 'idle'
    task.updatedAt = new Date().toISOString()
    await persistTasks()
    return { taskId: task.taskId, sessionId: task.sessionId, accepted }
  }

  /**
   * Cancellation for one HTTP request.
   *
   * Several Host controller methods dereference their `signal` argument
   * unconditionally (`sessionController.prompt` and `.list` among them), so a
   * bridge caller must always supply one. Only a genuine client disconnect
   * aborts it: Node also emits `close` on a normally finished request, and
   * aborting there would cancel work the caller already committed to.
   */
  const requestSignal = (req) => {
    const controller = new AbortController()
    req.on('aborted', () => controller.abort())
    return controller.signal
  }

  const listSessions = async (client, query, signal) => {
    const workspace = resolveWorkspace(client, query.get('workspaceId'))
    const sessions = await ctx.sessionController.list({}, signal)
    const items = sessions.items.filter((item) => item.cwd !== undefined && item.cwd === workspace.path)
    return { workspaceId: workspace.id, items }
  }

  const readSessionHistory = async (client, query, signal) => {
    const taskId = query.get('taskId')
    if (taskId !== null && taskId !== '') {
      // Bridge-tracked session: read the live tail, which is also what the
      // client's cursor is expressed in. A cursor the tail cannot serve is
      // filled from the durable log inside `readTranscript`.
      return await readTranscript(client, { taskId, sinceSeq: query.get('sinceSeq'), limit: query.get('limit') }, signal)
    }
    const workspace = resolveWorkspace(client, query.get('workspaceId'))
    const sessionId = requireString(query.get('sessionId'), 'sessionId')
    if (!workspace.sessionIds.includes(sessionId)) {
      throw fail('session/workspace-mismatch', `session "${sessionId}" is not attached to workspace "${workspace.id}"`, { sessionId, workspaceId: workspace.id })
    }
    // A persisted task for this session must still be addressable by *this*
    // token, even when the caller addressed the session by workspace instead of
    // by taskId.
    const tracked = Object.values(tasks).find((candidate) => candidate.sessionId === sessionId && notRevoked(candidate))
    if (tracked !== undefined) {
      if (!workspaceAllowedFor(client, tracked.workspaceId)) throw refuseTask()
      return { source: 'bridge-follower', ...(await readTranscript(client, { taskId: tracked.taskId, sinceSeq: query.get('sinceSeq'), limit: query.get('limit') }, signal)) }
    }
    const queryService = ctx.get('sessionQuery')
    if (queryService === undefined) throw fail('bridge/not-ready', 'this deployment mounts no session query service and the session has no bridge task')
    const observation = await queryService.observeSession(sessionId, { projectionMode: 'none', signal })
    try {
      return {
        source: 'durable-log',
        sessionId,
        cursor: Number(observation.cursor ?? -1),
        items: observation.events.map((event) => projectEvent(event, null)),
      }
    } finally {
      observation[Symbol.dispose]?.()
    }
  }

  const routes = {
    'GET /health': async () => ({
      bridge: 'ready',
      protocolVersion: PROTOCOL_VERSION,
      routePrefix: prefix,
      pid: process.pid,
      sessionsFollowed: followers.size,
      trackedTasks: Object.values(tasks).filter((task) => task.revoked !== true).length,
      permissions: { autoApprove: false },
    }),
    'GET /workspaces': async (client) => listWorkspaces(client),
    'GET /capabilities': async (client) => capabilities(client),
    'POST /workspaces/create': async (client, body) => createWorkspace(client, body),
    'GET /sessions': async (client, _body, _req, query, signal) => listSessions(client, query, signal),
    'GET /transcript': async (client, _body, _req, query, signal) => readSessionHistory(client, query, signal),
    'POST /tasks/create': async (client, body) => createTask(client, body),
    'GET /tasks/get': async (client, _body, _req, query) => {
      const task = requireTask(client, query.get('taskId'))
      const follower = followerFor(task.sessionId)
      return {
        task: publicTask(task),
        follower: follower === undefined ? null : {
          status: follower.status,
          cursor: follower.lastSeq,
          truncatedBefore: Number(follower.truncatedBeforeSeq ?? -1) < 0 ? null : Number(follower.truncatedBeforeSeq),
          failure: follower.failure ?? null,
        },
      }
    },
    'GET /tasks/list': async (client, _body, _req, query) => {
      const requestedWorkspace = query.get('workspaceId')
      // An explicit workspace filter is resolved like every other addressed
      // workspace, so it cannot be used to probe for unregistered or
      // out-of-scope workspaces.
      if (requestedWorkspace !== null && requestedWorkspace !== '') resolveWorkspace(client, requestedWorkspace)
      const items = Object.values(tasks)
        .filter((task) => notRevoked(task))
        .filter((task) => requestedWorkspace === null || requestedWorkspace === '' || task.workspaceId === requestedWorkspace)
        .filter((task) => workspaceAllowedFor(client, task.workspaceId))
        .map(publicTask)
      return { items }
    },
    'POST /tasks/append': async (client, body, _req, _query, signal) => appendRound(client, body, signal),
    'POST /tasks/wait': async (client, body) => waitForEvents(client, body),
    'POST /tasks/cancel': async (client, body) => cancelTask(client, body),
    'POST /tasks/close': async (client, body) => {
      const task = requireTask(client, body.taskId)
      task.status = 'closed'
      task.updatedAt = new Date().toISOString()
      releaseTaskFollower(task)
      await persistTasks()
      return { taskId: task.taskId, status: task.status, sessionKept: true }
    },
  }

  const handle = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const route = url.pathname.slice(prefix.length) || '/'
    const method = req.method ?? 'GET'
    const signal = requestSignal(req)
    let requestId
    try {
      const body = await readBody(req, signal)
      requestId = asString(body.requestId)
      const client = await authenticate(req.headers.authorization)
      if (method === 'GET' && route === '/events') {
        await streamEvents(client, req, res, url.searchParams)
        return
      }
      const handler = routes[`${method} ${route}`]
      if (handler === undefined) throw fail('request/unsupported', `${method} ${prefix}${route} is not a bridge endpoint`)
      const value = await handler(client, body, req, url.searchParams, signal)
      sendOk(res, value, requestId)
    } catch (error) {
      sendError(res, error, requestId)
    }
  }

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  ctx.effect(() => {
    const dispose = ctx.webServer.register({ kind: 'prefix', path: prefix, handler: handle })
    return () => {
      for (const sessionId of [...followers.keys()]) dropFollower(sessionId)
      dispose()
    }
  }, 'codex-bridge: route and followers')

  void bootstrap().catch((error) => logger.warn?.(`codex-bridge: state bootstrap failed: ${String(error)}`))
  logger.info?.(`codex-bridge: mounted at ${prefix} (state: ${stateDir})`)
}

export default { name, inject, apply }
