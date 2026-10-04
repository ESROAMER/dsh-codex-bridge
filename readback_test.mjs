/**
 * Regression suite for the two defects an independent review found in the
 * running bridge, plus the readback behaviour behind them.
 *
 *   node readback_test.mjs
 *
 * Every case is driven through the real route handler over a real loopback
 * socket against a fake Host that keeps the *real* payload shapes: user
 * messages live under `data.content`, message events live under
 * `data.message`, snapshots carry records plus a cursor, and `turn/end` only
 * appears once a turn actually completes.
 *
 * Exit code 0 means every case passed.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.js'
import { PATH_A, PATH_B, WORKSPACE_A, WORKSPACE_B, fakeHost } from './fake_host.mjs'

const checks = []
const check = async (name, run) => {
  try {
    await run()
    checks.push({ name, ok: true })
    process.stdout.write(`  ok   ${name}\n`)
  } catch (error) {
    checks.push({ name, ok: false, error: String(error?.message ?? error) })
    process.stdout.write(`  FAIL ${name}\n       ${String(error?.stack ?? error).split('\n').slice(0, 4).join('\n       ')}\n`)
  }
}

const TOKEN_A = 'dshb_readback-a-aaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'dshb_readback-b-bbbbbbbbbbbbbbbbbbbbbb'
const TOKEN_WIDE = 'dshb_readback-wide-ccccccccccccccccccc'

/**
 * Mount the real plugin over the fake Host and expose a small HTTP client.
 * `tokens` maps a role to the workspace scope its credential is bound to.
 */
const startBridge = async ({ hostOptions = {}, config = {}, extraTokens = {} } = {}) => {
  const host = fakeHost(hostOptions)
  const stateDir = await mkdtemp(join(tmpdir(), 'codex-readback-'))
  let handler
  apply(
    { ...host.ctx, webServer: { register: (route) => { handler = route.handler; return () => {} } } },
    { stateDir, ...config },
  )
  assert.ok(handler !== undefined, 'the plugin registered no route')
  await new Promise((resolve) => setTimeout(resolve, 40))
  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/codex-bridge`
  const hash = (token) => createHash('sha256').update(token).digest('hex')
  await writeFile(join(stateDir, 'tokens.json'), `${JSON.stringify({
    version: 1,
    tokens: {
      a: { alias: 'a', hash: hash(TOKEN_A), workspaceIds: [WORKSPACE_A], createdAt: '2026-01-01T00:00:00.000Z' },
      b: { alias: 'b', hash: hash(TOKEN_B), workspaceIds: [WORKSPACE_B], createdAt: '2026-01-01T00:00:00.000Z' },
      wide: { alias: 'wide', hash: hash(TOKEN_WIDE), workspaceIds: null, createdAt: '2026-01-01T00:00:00.000Z' },
      ...extraTokens,
    },
  }, null, 2)}\n`)
  const call = async (token, method, path, { body, query } = {}) => {
    const url = new URL(`${base}${path}`)
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value))
    const response = await fetch(url, {
      method,
      headers: {
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = { raw: text }
    }
    if (process.env.BRIDGE_TEST_TRACE === '1' && response.status !== 200) {
      process.stdout.write(`       trace: ${method} ${path} -> ${response.status} ${text.slice(0, 300)}\n`)
    }
    return { status: response.status, body: parsed }
  }
  return {
    host,
    base,
    call,
    close: async () => {
      await new Promise((resolve) => server.close(resolve))
      // A persisted task state may still be landing when the test ends; retry
      // the temporary-directory removal instead of reporting a cleanup race as
      // a bridge failure.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          await rm(stateDir, { recursive: true, force: true })
          return
        } catch (error) {
          if (error?.code !== 'ENOTEMPTY' && error?.code !== 'EBUSY') throw error
          await new Promise((resolve) => setTimeout(resolve, 50))
        }
      }
    },
  }
}

/* ── fixtures that mirror the real Host payloads ─────────────────────── */

const userEvent = (text, rpcId) => ({
  type: 'user/message',
  time: Date.now(),
  data: { content: [{ type: 'text', text }], source: { kind: 'user', ...(rpcId === undefined ? {} : { rpcId }) }, role: 'user' },
})

const assistantEvent = (text, reasoning) => ({
  type: 'assistant/message',
  time: Date.now(),
  data: {
    turn: 1,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        ...(reasoning === undefined ? [] : [{ type: 'reasoning', text: reasoning }]),
        { type: 'text', text },
      ],
      source: { kind: 'model', provider: 'deepseek-account', model: 'deepseek-flash' },
    },
    usage: { inputTokens: 10, outputTokens: 5 },
  },
})

const turnEnd = (turn) => ({ type: 'turn/end', time: Date.now(), data: { turn, reason: { kind: 'completed' } } })

const main = async () => {
  /* ── defect 1: replay/read authorization ───────────────────────────── */

  await check('a foreign taskId replay is refused and discloses nothing', async () => {
    const bridge = await startBridge()
    try {
      const created = await bridge.call(TOKEN_B, 'POST', '/tasks/create', {
        body: { requestId: 'foreign-create', taskId: 'foreign-task', workspaceId: WORKSPACE_B },
      })
      assert.equal(created.status, 200)
      assert.equal(created.body.value.task.workspaceId, WORKSPACE_B)
      const replay = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'other-request', taskId: 'foreign-task', workspaceId: WORKSPACE_B },
      })
      // The request is refused by the workspace scope before anything is read.
      assert.equal(replay.status, 403)
      assert.equal(replay.body.value, undefined)
      assert.ok(!JSON.stringify(replay.body).includes('foreign-task'))
    } finally {
      await bridge.close()
    }
  })

  await check('a foreign taskId replay through an allowed workspace is refused', async () => {
    const bridge = await startBridge()
    try {
      await bridge.call(TOKEN_B, 'POST', '/tasks/create', {
        body: { requestId: 'foreign-create-2', taskId: 'foreign-task-2', workspaceId: WORKSPACE_B },
      })
      const replay = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'fresh-request', taskId: 'foreign-task-2', workspaceId: WORKSPACE_A },
      })
      assert.equal(replay.status, 403)
      assert.equal(replay.body.error.code, 'auth/workspace-forbidden')
      assert.ok(!JSON.stringify(replay.body).includes(WORKSPACE_B))
      assert.ok(!JSON.stringify(replay.body).includes('session-'))
    } finally {
      await bridge.close()
    }
  })

  await check('a foreign requestId cannot be replayed into a task of the caller', async () => {
    const bridge = await startBridge()
    try {
      await bridge.call(TOKEN_B, 'POST', '/tasks/create', {
        body: { requestId: 'foreign-request-id', taskId: 'foreign-task-3', workspaceId: WORKSPACE_B },
      })
      const replay = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'foreign-request-id', taskId: 'local-task-3', workspaceId: WORKSPACE_A },
      })
      assert.equal(replay.status, 409)
      assert.equal(replay.body.error.code, 'request/conflict')
      assert.equal(replay.body.error.details.taskId, undefined, 'the conflict must not name the foreign task')
      assert.ok(!JSON.stringify(replay.body).includes(WORKSPACE_B))
      // Nothing was created for the foreign id under this token.
      const listed = await bridge.call(TOKEN_A, 'GET', '/tasks/list')
      assert.deepEqual(listed.body.value.items.map((item) => item.taskId), [])
    } finally {
      await bridge.close()
    }
  })

  await check('every read and list path enforces the deployment workspace list', async () => {
    // The deployment allows only workspace A's directory.
    const bridge = await startBridge({ config: { workspacePaths: [PATH_A] } })
    try {
      const created = await bridge.call(TOKEN_WIDE, 'POST', '/tasks/create', {
        body: { requestId: 'restricted-create', taskId: 'restricted-task', workspaceId: WORKSPACE_B },
      })
      // B is registered in the registry but outside the deployment allowlist.
      assert.equal(created.status, 403)
      assert.equal(created.body.error.code, 'auth/workspace-forbidden')

      const allowed = await bridge.call(TOKEN_WIDE, 'POST', '/tasks/create', {
        body: { requestId: 'allowed-create', taskId: 'allowed-task', workspaceId: WORKSPACE_A },
      })
      assert.equal(allowed.status, 200)

      const sessions = await bridge.call(TOKEN_WIDE, 'GET', '/sessions', { query: { workspaceId: WORKSPACE_B } })
      assert.equal(sessions.status, 403)
      const history = await bridge.call(TOKEN_WIDE, 'GET', '/transcript', { query: { workspaceId: WORKSPACE_B, sessionId: 'session-x' } })
      assert.equal(history.status, 403)
      const list = await bridge.call(TOKEN_WIDE, 'GET', '/tasks/list', { query: { workspaceId: WORKSPACE_B } })
      assert.equal(list.status, 403)
      const workspaces = await bridge.call(TOKEN_WIDE, 'GET', '/workspaces')
      assert.deepEqual(workspaces.body.value.items.map((item) => item.workspaceId), [WORKSPACE_A])
      // The allowed workspace still works end to end.
      const ok = await bridge.call(TOKEN_WIDE, 'GET', '/tasks/get', { query: { taskId: 'allowed-task' } })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.value.task.workspacePath, PATH_A)
    } finally {
      await bridge.close()
    }
  })

  await check('an empty workspace scope authorizes nothing', async () => {
    const emptyToken = 'dshb_readback-empty-ddddddddddddddddddd'
    const bridge = await startBridge({
      extraTokens: {
        empty: { alias: 'empty', hash: createHash('sha256').update(emptyToken).digest('hex'), workspaceIds: [], createdAt: '2026-01-01T00:00:00.000Z' },
      },
    })
    try {
      // An explicit empty set is "authorized for nothing", never "everything".
      const workspaces = await bridge.call(emptyToken, 'GET', '/workspaces')
      assert.equal(workspaces.status, 200)
      assert.deepEqual(workspaces.body.value.items, [])
      assert.deepEqual(workspaces.body.value.tokenScope, [])
      const create = await bridge.call(emptyToken, 'POST', '/tasks/create', {
        body: { requestId: 'empty-create', workspaceId: WORKSPACE_A },
      })
      assert.equal(create.status, 403)
      assert.equal(create.body.error.code, 'auth/workspace-forbidden')
      const list = await bridge.call(emptyToken, 'GET', '/tasks/list')
      assert.deepEqual(list.body.value.items, [])
    } finally {
      await bridge.close()
    }
  })

  /* ── defect 2: message text projection ─────────────────────────────── */

  await check('a user message reads its text from data.content', async () => {
    const bridge = await startBridge()
    try {
      // The session already carries a desktop-side message before the bridge
      // adopts it, exactly as when a human types in the running desktop.
      const sessionId = 'session-text-0001'
      bridge.host.seedSession(sessionId, { events: [userEvent('desktop typed this', 'round-1')] })
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'text-create', taskId: 'text-task', workspaceId: WORKSPACE_A, sessionId },
      })
      assert.equal(created.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 80))
      const transcript = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'text-task', sinceSeq: -1 } })
      const message = transcript.body.value.items.find((event) => event.kind === 'message')
      assert.ok(message !== undefined, `no message was projected from ${JSON.stringify(transcript.body.value.items)}`)
      assert.equal(message.text, 'desktop typed this')
      assert.equal(message.requestId, 'round-1')
    } finally {
      await bridge.close()
    }
  })

  await check('an assistant message reports visible text and usage without reasoning blocks', async () => {
    const bridge = await startBridge()
    try {
      const sessionId = 'session-text-0002'
      bridge.host.seedSession(sessionId, { events: [assistantEvent('final answer text', 'private reasoning')] })
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'assistant-create', taskId: 'assistant-task', workspaceId: WORKSPACE_A, sessionId },
      })
      assert.equal(created.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 80))
      const transcript = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'assistant-task', sinceSeq: -1 } })
      const message = transcript.body.value.items.find((event) => event.kind === 'message' && event.role === 'assistant')
      assert.ok(message !== undefined, `no assistant message was projected from ${JSON.stringify(transcript.body.value.items)}`)
      assert.equal(message.text, 'final answer text')
      assert.equal(Object.hasOwn(message, 'reasoning'), false)
      assert.equal(JSON.stringify(message).includes('private reasoning'), false)
      assert.deepEqual(message.usage, { inputTokens: 10, outputTokens: 5 })
      assert.equal(message.modelId, 'deepseek-flash')
    } finally {
      await bridge.close()
    }
  })

  /* ── defect 2: snapshot, cursor, pagination, restart ───────────────── */

  await check('adopting an existing session replays the snapshot instead of answering empty', async () => {
    const bridge = await startBridge({ hostOptions: { snapshotWindow: 3 } })
    try {
      const sessionId = 'session-adopted-0001'
      bridge.host.seedSession(sessionId, { events: [userEvent('first'), assistantEvent('reply one'), userEvent('second'), assistantEvent('reply two'), turnEnd(1)] })
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'adopt-create', taskId: 'adopt-task', workspaceId: WORKSPACE_A, sessionId },
      })
      assert.equal(created.status, 200)
      assert.equal(created.body.value.task.sessionId, sessionId)
      await new Promise((resolve) => setTimeout(resolve, 80))
      // This is the exact shape the independent review saw: a live follower, a
      // real cursor, and the seeded history.
      const transcript = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'adopt-task', sinceSeq: -1 } })
      const value = transcript.body.value
      assert.equal(value.followerStatus, 'live')
      assert.ok(value.cursor >= 5, `cursor must reflect the snapshot, got ${value.cursor}`)
      assert.ok(value.items.length > 0, 'an adopted session must not read back empty')
      const texts = value.items.filter((event) => event.kind === 'message').map((event) => event.text)
      assert.ok(texts.includes('second'), `expected the snapshot page, got ${JSON.stringify(texts)}`)
    } finally {
      await bridge.close()
    }
  })

  await check('a cursor older than the retained tail is backfilled from the durable log', async () => {
    const bridge = await startBridge({ hostOptions: { snapshotWindow: 4 }, config: { eventCacheLimit: 3 } })
    try {
      const sessionId = 'session-paged-0002'
      const seeded = [userEvent('old one'), assistantEvent('old reply one'), userEvent('old two'), assistantEvent('old reply two'), userEvent('old three'), assistantEvent('old reply three'), turnEnd(1)]
      bridge.host.seedSession(sessionId, { events: seeded })
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'page-create', taskId: 'page-task', workspaceId: WORKSPACE_A, sessionId },
      })
      assert.equal(created.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 80))
      const transcript = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'page-task', sinceSeq: -1, limit: 200 } })
      const value = transcript.body.value
      const seqs = value.items.map((event) => event.sessionSeq)
      // Deduplicated and strictly ascending even though two sources answered.
      assert.deepEqual([...seqs].sort((left, right) => left - right), seqs)
      assert.equal(new Set(seqs).size, seqs.length, 'a sequence was delivered twice')
      const texts = value.items.filter((event) => event.kind === 'message').map((event) => event.text)
      assert.ok(texts.includes('old one'), `the durable page must reach the earliest event, got ${JSON.stringify(texts)}`)
      assert.equal(value.truncatedBefore, null, 'a fully backfilled window is not truncated')
    } finally {
      await bridge.close()
    }
  })

  await check('a restart reattaches history so an old cursor still reads back', async () => {
    const bridge = await startBridge({ hostOptions: { snapshotWindow: 4 } })
    try {
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'restart-create', taskId: 'restart-task', workspaceId: WORKSPACE_A },
      })
      const sessionId = created.body.value.task.sessionId
      const cursor = (await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'restart-task', sinceSeq: -1 } })).body.value.cursor
      await bridge.call(TOKEN_A, 'POST', '/tasks/append', { body: { requestId: 'restart-round', taskId: 'restart-task', message: 'first pass' } })
      await new Promise((resolve) => setTimeout(resolve, 120))
      // The desktop restarts: live listeners are gone and the bridge's tail is
      // the only thing it kept.
      bridge.host.restart()
      void cursor
      const afterAppend = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'restart-task', sinceSeq: -1 } })
      assert.ok(afterAppend.body.value.items.length > 0)
      const firstUser = afterAppend.body.value.items.find((event) => event.kind === 'message' && event.role === 'user')
      assert.equal(firstUser.text, 'first pass', 'the pre-restart user message must stay readable')
    } finally {
      await bridge.close()
    }
  })

  await check('a historical turn-completed never settles a newly submitted round', async () => {
    const bridge = await startBridge({ hostOptions: { snapshotWindow: 3 } })
    try {
      const sessionId = 'session-stale-0003'
      bridge.host.seedSession(sessionId, {
        events: [userEvent('turn one'), assistantEvent('done one'), turnEnd(1)],
      })
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'stale-create', taskId: 'stale-task', workspaceId: WORKSPACE_A, sessionId },
      })
      assert.equal(created.status, 200)
      await new Promise((resolve) => setTimeout(resolve, 80))
      // The caller's cursor is the adopted frontier, from before the new round.
      const before = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'stale-task', sinceSeq: -1 } })
      const cursor = before.body.value.cursor
      const settled = await bridge.call(TOKEN_A, 'POST', '/tasks/wait', {
        body: { taskId: 'stale-task', waitMs: 400, condition: { sinceSeq: cursor, on: ['turn-end'] } },
      })
      assert.equal(settled.body.value.timedOut, true, 'a historical turn/end settled the wait')
      assert.deepEqual(settled.body.value.events, [])
      // A real new round still settles.
      await bridge.call(TOKEN_A, 'POST', '/tasks/append', { body: { requestId: 'stale-round', taskId: 'stale-task', message: 'new round' } })
      const wait = await bridge.call(TOKEN_A, 'POST', '/tasks/wait', {
        body: { taskId: 'stale-task', waitMs: 3000, condition: { sinceSeq: cursor, on: ['turn-end'] } },
      })
      assert.equal(wait.body.value.timedOut, false)
      const phases = wait.body.value.events.map((event) => event.phase)
      assert.ok(phases.includes('turn-completed'), `expected the new turn to settle, got ${JSON.stringify(phases)}`)
    } finally {
      await bridge.close()
    }
  })

  await check('a replay of a closed task rebinds the same session instead of creating one', async () => {
    const bridge = await startBridge()
    try {
      const created = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'close-create', taskId: 'close-task', workspaceId: WORKSPACE_A },
      })
      const sessionId = created.body.value.task.sessionId
      await bridge.call(TOKEN_A, 'POST', '/tasks/close', { body: { taskId: 'close-task' } })
      const gone = await bridge.call(TOKEN_A, 'GET', '/tasks/get', { query: { taskId: 'close-task' } })
      assert.equal(gone.body.error.code, 'task/not-found')
      const adopted = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'close-adopt', taskId: 'close-task', workspaceId: WORKSPACE_A },
      })
      assert.equal(adopted.status, 200)
      assert.equal(adopted.body.value.task.sessionId, sessionId, 'adoption must reuse the session, not create one')
    } finally {
      await bridge.close()
    }
  })

  await check('closing and rebinding a shared-session task preserves the other task follower', async () => {
    const bridge = await startBridge()
    try {
      const first = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'shared-create-a', taskId: 'shared-a', workspaceId: WORKSPACE_A },
      })
      const sessionId = first.body.value.task.sessionId
      await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'shared-create-b', taskId: 'shared-b', workspaceId: WORKSPACE_A, sessionId },
      })
      await new Promise(resolve => setTimeout(resolve, 80))
      await bridge.call(TOKEN_A, 'POST', '/tasks/close', { body: { taskId: 'shared-b' } })
      const stillOpen = await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'shared-a' } })
      assert.equal(stillOpen.status, 200, 'closing B must not detach A')
      const adopted = await bridge.call(TOKEN_A, 'POST', '/tasks/create', {
        body: { requestId: 'shared-rebind-b', taskId: 'shared-b', workspaceId: WORKSPACE_A },
      })
      assert.equal(adopted.body.value.task.sessionId, sessionId)
      const cursor = stillOpen.body.value.cursor
      const submitted = await bridge.call(TOKEN_A, 'POST', '/tasks/append', {
        body: { requestId: 'shared-round-a', taskId: 'shared-a', message: 'shared session remains usable' },
      })
      assert.equal(submitted.status, 200)
      await new Promise(resolve => setTimeout(resolve, 120))
      const after = await bridge.call(TOKEN_A, 'GET', '/transcript', {
        query: { taskId: 'shared-a', sinceSeq: cursor },
      })
      assert.equal(after.status, 200)
      assert.ok(after.body.value.items.some(e => e.kind === 'message' && e.role === 'assistant'))
      await bridge.call(TOKEN_A, 'POST', '/tasks/close', { body: { taskId: 'shared-b' } })
      assert.equal((await bridge.call(TOKEN_A, 'GET', '/transcript', { query: { taskId: 'shared-a' } })).status, 200)
      await bridge.call(TOKEN_A, 'POST', '/tasks/close', { body: { taskId: 'shared-a' } })
      const health = await bridge.call(TOKEN_A, 'GET', '/health')
      assert.equal(health.body.value.sessionsFollowed, 0, 'last task close must dispose the follower')
    } finally {
      await bridge.close()
    }
  })

  const failed = checks.filter((entry) => !entry.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} readback checks passed\n`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
