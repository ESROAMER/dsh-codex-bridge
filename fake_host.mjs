/**
 * In-process stand-in for the Host services consumed by Codex–DSH Collaboration.
 *
 * Shared by `protocol_test.mjs` and `client_smoke_test.mjs`. It is deliberately
 * small and deterministic: it records what the bridge asked of the Host, and it
 * can inject a desktop-side message so a test can prove the bridge replays it.
 *
 * This is a test double, not a Harness implementation: it never proves that a
 * live desktop loaded the plugin.
 */

import assert from 'node:assert/strict'

export const WORKSPACE_A = '11111111-1111-4111-8111-111111111111'
export const WORKSPACE_B = '22222222-2222-4222-8222-222222222222'
export const PATH_A = 'C:\\BridgeTests\\workspace-a'
export const PATH_B = 'C:\\BridgeTests\\workspace-b'

export function fakeHost({ failPrompt, snapshotWindow } = {}) {
  const events = new Map()
  const listeners = new Map()
  const sessions = new Map()
  const renamed = []
  const prompts = []
  let cancelCount = 0
  let serverHandler
  let followCount = 0

  const emit = (sessionId, event) => {
    const log = events.get(sessionId) ?? []
    log.push(event)
    events.set(sessionId, log)
    for (const listener of listeners.get(sessionId) ?? []) listener(event)
  }

  const workspaces = [
    { id: WORKSPACE_A, title: 'kaggle', path: PATH_A, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', sessionIds: [], status: async () => 'ok' },
    { id: WORKSPACE_B, title: 'default-workspace', path: PATH_B, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', sessionIds: [], status: async () => 'ok' },
  ]

  const presets = {
    list: async () => [
      { id: 'standard', name: 'Standard' },
      { id: 'creator', name: 'Creator' },
    ],
  }

  /** The Host's own message-aligned page: the newest `maxMessages` messages. */
  const pageTail = (log, maxMessages) => {
    if (!Number.isFinite(maxMessages) || maxMessages <= 0 || maxMessages >= log.length) {
      return { events: [...log], hasMore: false }
    }
    return { events: log.slice(-maxMessages), hasMore: true }
  }

  const query = {
    observeSession: async (sessionId) => {
      if (!events.has(sessionId)) throw new Error('SESSION_QUERY_SESSION_NOT_FOUND')
      const log = events.get(sessionId)
      return {
        header: { id: sessionId, cwd: sessions.get(sessionId)?.cwd, isSeeded: false },
        cursor: log.length,
        events: [...log],
        [Symbol.dispose]: () => {},
      }
    },
  }

  const ctx = {
    logger: {
      info: () => {},
      debug: () => {},
      error: (...parts) => console.error('[bridge]', ...parts),
      warn: (...parts) => {
        if (process.env.BRIDGE_TEST_TRACE === '1') console.error('[bridge warn]', ...parts)
      },
    },
    effect: (callback) => {
      const dispose = callback()
      return () => dispose?.()
    },
    get: (name) => (name === 'agentPresets' ? presets : name === 'sessionQuery' ? query : undefined),
    workspaceRegistry: {
      get: (id) => workspaces.find((workspace) => workspace.id === id),
      list: () => workspaces,
    },
    webServer: {
      register: (route) => {
        serverHandler = route.handler
        return () => {
          serverHandler = undefined
        }
      },
    },
    sessionController: {
      create: async ({ workspaceId, sessionId }) => {
        const id = sessionId ?? `session-${sessions.size + 1}`
        if (!sessions.has(id)) {
          sessions.set(id, { workspaceId, cwd: workspaces.find((workspace) => workspace.id === workspaceId).path, preset: 'standard' })
          workspaces.find((workspace) => workspace.id === workspaceId).sessionIds.push(id)
        }
        // Adopting a session the bridge never followed is exactly the case that
        // used to come back as an empty transcript; an existing log is kept.
        if (!events.has(id)) events.set(id, [])
        return { sessionId: id, agentPreset: 'standard' }
      },
      rename: async ({ sessionId, title }) => {
        renamed.push({ sessionId, title })
        return { title, seq: 1 }
      },
      selectModel: async ({ sessionId, ...selection }) => {
        assert.ok(sessions.has(sessionId), 'selectModel on an unknown session')
        return { selected: selection }
      },
      prompt: async (request, signal) => {
        // The real Host dereferences `signal` unconditionally here; a fake that
        // tolerated `undefined` would hide exactly the defect this guards.
        signal.throwIfAborted()
        if (failPrompt) throw new Error(failPrompt)
        prompts.push(request)
        const log = events.get(request.sessionId) ?? []
        const turn = log.filter((event) => event.type === 'turn/start').length + 1
        const base = log.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0)
        const text = request.content.map((part) => part.text).join('\n')
        queueMicrotask(() => {
          // The real Host writes a user message as `data.content` (not
          // `data.message.content`), which is why the old projection produced
          // an empty `text`.
          emit(request.sessionId, { type: 'user/message', seq: base + 1, time: Date.now(), data: { content: [{ type: 'text', text }], source: { kind: 'user', rpcId: request.requestId }, role: 'user' } })
          emit(request.sessionId, { type: 'turn/start', seq: base + 2, time: Date.now(), data: { turn } })
          emit(request.sessionId, { type: 'request/header', seq: base + 3, time: Date.now(), data: { header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } }, reason: 'initial' } })
          emit(request.sessionId, { type: 'tool/call', seq: base + 4, time: Date.now(), data: { turn, step: 1, callId: 'call-1', name: 'write', arguments: JSON.stringify({ file_path: `${PATH_A}\\report.md`, content: 'x' }) } })
          emit(request.sessionId, { type: 'tool/result', seq: base + 5, time: Date.now(), data: { turn, step: 1, message: { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'wrote report.md' }] }, error: { name: 'ToolError', code: 'fs/denied', reason: 'sandbox refused the write' } } })
          emit(request.sessionId, { type: 'assistant/message', seq: base + 6, time: Date.now(), data: { turn, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking about it' }, { type: 'text', text: `ack: ${text}` }], source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' } } } })
          emit(request.sessionId, { type: 'step/end', seq: base + 7, time: Date.now(), data: { turn, step: 1 } })
          emit(request.sessionId, { type: 'turn/end', seq: base + 8, time: Date.now(), data: { turn, reason: { kind: 'completed' } } })
        })
        return { accepted: true }
      },
      cancel: ({ sessionId }) => {
        cancelCount += 1
        assert.ok(sessions.has(sessionId), 'cancel on an unknown session')
        return { accepted: true }
      },
      list: async (_request, signal) => {
        signal.throwIfAborted()
        return {
          items: [...sessions.entries()].map(([sessionId, meta]) => ({ sessionId, cwd: meta.cwd, running: false, blank: false, agentAvailable: true, updatedAt: Date.now() })),
        }
      },
      modelCatalog: async () => ({
        default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' },
        routableProviders: ['deepseek-account'],
        groups: [
          {
            id: 'deepseek-account',
            name: 'DeepSeek',
            models: [
              {
                id: 'deepseek-flash',
                name: 'V41 Flash',
                reasoning: { defaultEffort: 'high', efforts: [{ id: 'off', name: 'off' }, { id: 'low', name: 'low' }, { id: 'high', name: 'high' }, { id: 'max', name: 'max' }] },
              },
              { id: 'deepseek-flash-2', name: 'V41 Flash 2', reasoning: { defaultEffort: 'high', efforts: [{ id: 'high', name: 'high' }] } },
            ],
          },
        ],
        failures: [],
      }),
      follow: (request) => {
        const sessionId = request.address.sessionId
        const log = events.get(sessionId) ?? []
        const queue = []
        let wake
        const listener = (event) => {
          queue.push(event)
          wake?.()
        }
        listeners.set(sessionId, [...(listeners.get(sessionId) ?? []), listener])
        const signal = request.signal
        followCount += 1
        // The opening snapshot carries the cursor *and* the page the Host
        // already loaded; a follower that drops them starts empty and live.
        const page = pageTail(log, snapshotWindow)
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'snapshot',
              header: { id: sessionId, cwd: sessions.get(sessionId)?.cwd, isSeeded: false },
              cursor: log.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0),
              records: page.events.map((event) => ({ type: 'event', event })),
              hasMore: page.hasMore,
              projections: { asOfSeq: -1, values: {} },
            }
            for (const event of log) yield { type: 'event', event }
            while (!signal?.aborted) {
              if (queue.length === 0) {
                await new Promise((resolvePromise) => {
                  wake = resolvePromise
                  signal?.addEventListener('abort', resolvePromise, { once: true })
                })
                wake = undefined
                continue
              }
              yield { type: 'event', event: queue.shift() }
            }
          },
        }
      },
    },
  }

  return {
    ctx,
    workspaceIdA: WORKSPACE_A,
    workspaceIdB: WORKSPACE_B,
    pathA: PATH_A,
    counts: () => ({ cancelCount, prompts: prompts.length, renamed, followCount }),
    handler: () => serverHandler,
    /**
     * Seed a session log that the bridge never followed (an adopted session).
     *
     * `snapshotWindow` models the Host's message-aligned snapshot page, so the
     * newest seeded events stand in for durable history the opening snapshot
     * does not carry.
     */
    seedSession: (sessionId, { workspaceId = WORKSPACE_A, events: seeded = [] } = {}) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId)
      if (!sessions.has(sessionId)) {
        sessions.set(sessionId, { workspaceId, cwd: workspace.path, preset: 'standard' })
        if (!workspace.sessionIds.includes(sessionId)) workspace.sessionIds.push(sessionId)
      }
      const log = events.get(sessionId) ?? []
      let seq = log.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0)
      for (const event of seeded) {
        seq += 1
        log.push({ ...event, seq })
      }
      events.set(sessionId, log)
      return seq
    },
    /** Simulate a desktop restart: live listeners and in-flight log are lost. */
    restart: () => {
      listeners.clear()
    },
    /**
     * Keep only the newest `keep` events of a session log, as a real Host does
     * for a snapshot page that has `hasMore`.
     */
    trimSession: (sessionId, keep) => {
      const log = events.get(sessionId) ?? []
      const kept = keep <= 0 ? [] : log.slice(-keep)
      events.set(sessionId, kept)
      return kept.length
    },
    /** Simulate the human typing in the desktop app: append one session event. */
    desktopMessage: (sessionId, text) => {
      const log = events.get(sessionId) ?? []
      const seq = log.reduce((max, event) => Math.max(max, Number(event.seq) || 0), 0) + 1
      emit(sessionId, {
        type: 'user/message',
        seq,
        time: Date.now(),
        data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
      })
      return seq
    },
  }
}
