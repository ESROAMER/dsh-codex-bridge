/**
 * Offline protocol test for Codex–DSH Collaboration.
 *
 * It mounts the real plugin into an in-process fake Cordis context that
 * implements only the Host services the bridge consumes, then drives the real
 * route handler over a real loopback HTTP socket. This is a protocol and
 * error-path test: it proves the bridge's own contract (auth, scope checks,
 * idempotency, error mapping, replay cursor, event projection) without claiming
 * that a live desktop loaded it.
 *
 *   node protocol_test.mjs
 *
 * Exit code 0 means every check passed.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
    process.stdout.write(`  FAIL ${name}\n       ${String(error?.stack ?? error).split('\n').slice(0, 3).join('\n       ')}\n`)
  }
}

/* -- harness ------------------------------------------------------------- */

const startBridge = async (options = {}) => {
  const host = fakeHost(options)
  const stateDir = await mkdtemp(join(tmpdir(), 'codex-bridge-test-'))
  let handler
  const capturing = {
    ...host.ctx,
    webServer: {
      register: (route) => {
        handler = route.handler
        return () => {
          handler = undefined
        }
      },
    },
  }
  apply(capturing, { stateDir, ...(options.config ?? {}) })
  // The plugin mounts inside ctx.effect, which the fake runs synchronously.
  assert.ok(handler !== undefined, 'the plugin registered no route')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const server = createServer((req, res) => handler(req, res))
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return {
    host,
    stateDir,
    // The web server dispatches by prefix to this handler, so the test client
    // addresses the same absolute paths a real client would.
    base: `http://127.0.0.1:${port}/codex-bridge`,
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

const call = async (base, method, path, { token, body, query } = {}) => {
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

const main = async () => {
  const token = 'dshb_test-token-aaaaaaaaaaaaaaaaaaaaaaaa'
  const otherToken = 'dshb_test-token-bbbbbbbbbbbbbbbbbbbbbbbb'
  const bridge = await startBridge({ config: { workspacePaths: [PATH_A, PATH_B] } })
  const tokensPath = join(bridge.stateDir, 'tokens.json')
  const { createHash } = await import('node:crypto')
  await writeFile(tokensPath, `${JSON.stringify({
    version: 1,
    tokens: {
      main: { alias: 'main', hash: createHash('sha256').update(token).digest('hex'), workspaceIds: [WORKSPACE_A], createdAt: '2026-01-01T00:00:00.000Z' },
      wide: { alias: 'wide', hash: createHash('sha256').update(otherToken).digest('hex'), workspaceIds: null, createdAt: '2026-01-01T00:00:00.000Z' },
    },
  }, null, 2)}\n`)

  try {
    await check('GET /health requires a valid token', async () => {
      const anonymous = await call(bridge.base, 'GET', '/health')
      assert.equal(anonymous.status, 401)
      assert.equal(anonymous.body.error.code, 'auth/missing-token')
      const wrong = await call(bridge.base, 'GET', '/health', { token: 'dshb_wrong' })
      assert.equal(wrong.status, 403)
      assert.equal(wrong.body.error.code, 'auth/invalid-token')
      const ok = await call(bridge.base, 'GET', '/health', { token })
      assert.equal(ok.status, 200)
      assert.equal(ok.body.ok, true)
      assert.equal(ok.body.value.permissions.autoApprove, false)
    })

    await check('workspace discovery honours the token scope', async () => {
      const scoped = await call(bridge.base, 'GET', '/workspaces', { token })
      assert.deepEqual(scoped.body.value.items.map((item) => item.workspaceId), [WORKSPACE_A])
      const wide = await call(bridge.base, 'GET', '/workspaces', { token: otherToken })
      assert.deepEqual(wide.body.value.items.map((item) => item.workspaceId), [WORKSPACE_A, WORKSPACE_B])
    })

    await check('capabilities expose real catalog and preset identifiers', async () => {
      const result = await call(bridge.base, 'GET', '/capabilities', { token: otherToken })
      assert.equal(result.body.value.modelCatalog.groups[0].models[0].name, 'V41 Flash')
      assert.deepEqual(result.body.value.modelCatalog.groups[0].models[0].reasoning.efforts.map((effort) => effort.id), ['off', 'low', 'high', 'max'])
      assert.deepEqual(result.body.value.agentPresets.map((preset) => preset.id), ['standard', 'creator'])
      assert.equal(result.body.value.capabilities.permissions.autoApprove, false)
    })

    await check('out-of-scope workspace is refused before any session work', async () => {
      const result = await call(bridge.base, 'POST', '/tasks/create', {
        token,
        body: { requestId: 'r-forbidden', workspaceId: WORKSPACE_B, provider: 'deepseek-account', model: 'deepseek-flash' },
      })
      assert.equal(result.status, 403)
      assert.equal(result.body.error.code, 'auth/workspace-forbidden')
    })

    await check('unknown workspace and unavailable model are distinguished', async () => {
      const missing = await call(bridge.base, 'POST', '/tasks/create', {
        token: otherToken,
        body: { requestId: 'r-missing', workspaceId: '99999999-9999-4999-8999-999999999999' },
      })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.error.code, 'workspace/not-found')
      const badModel = await call(bridge.base, 'POST', '/tasks/create', {
        token: otherToken,
        body: { requestId: 'r-model', workspaceId: WORKSPACE_A, provider: 'deepseek-account', model: 'gpt-9' },
      })
      assert.equal(badModel.status, 409)
      assert.equal(badModel.body.error.code, 'model/unavailable')
      const badEffort = await call(bridge.base, 'POST', '/tasks/create', {
        token: otherToken,
        body: { requestId: 'r-effort', workspaceId: WORKSPACE_A, provider: 'deepseek-account', model: 'deepseek-flash-2', reasoningEffort: 'low' },
      })
      assert.equal(badEffort.status, 409)
      assert.equal(badEffort.body.error.code, 'model/reasoning-effort-unavailable')
      assert.deepEqual(badEffort.body.error.details.supportedEfforts, ['high'])
    })

    let taskId
    let sessionId
    await check('task creation binds workspace, session, and requested config', async () => {
      const result = await call(bridge.base, 'POST', '/tasks/create', {
        token: otherToken,
        body: {
          requestId: 'r-create-1',
          taskId: 'task-offline-1',
          workspaceId: WORKSPACE_A,
          title: 'Offline protocol test',
          provider: 'deepseek-account',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
          external: { client: 'codex', conversationId: 'conv-1' },
        },
      })
      assert.equal(result.status, 200)
      taskId = result.body.value.task.taskId
      sessionId = result.body.value.task.sessionId
      assert.equal(taskId, 'task-offline-1')
      assert.equal(result.body.value.task.workspaceId, WORKSPACE_A)
      assert.deepEqual(result.body.value.task.requestedConfig, { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' })
      assert.equal(bridge.host.counts().renamed[0].title, 'Offline protocol test')
    })

    await check('a repeated create requestId returns the same task instead of a second session', async () => {
      const before = bridge.host.counts().prompts
      const replay = await call(bridge.base, 'POST', '/tasks/create', {
        token: otherToken,
        body: { requestId: 'r-create-1', workspaceId: WORKSPACE_A, taskId: 'task-offline-1' },
      })
      assert.equal(replay.status, 200)
      assert.equal(replay.body.value.replayed, true)
      assert.equal(replay.body.value.task.sessionId, sessionId)
      assert.equal(bridge.host.counts().prompts, before)
    })

    await check('taskId collision in another workspace is a conflict, not a silent reuse', async () => {
      const result = await call(bridge.base, 'POST', '/tasks/create', {
        token: otherToken,
        body: { requestId: 'r-create-2', taskId: 'task-offline-1', workspaceId: WORKSPACE_B },
      })
      assert.equal(result.status, 409)
      assert.equal(result.body.error.code, 'request/conflict')
    })

    await check('round one accepts a prompt and the event stream replays it', async () => {
      const sent = await call(bridge.base, 'POST', '/tasks/append', {
        token: otherToken,
        body: { requestId: 'r-round-1', taskId, message: 'run the offline pass', kind: 'instruction' },
      })
      assert.equal(sent.status, 200)
      assert.equal(sent.body.value.accepted, true)
      await new Promise((resolve) => setTimeout(resolve, 120))
      const transcript = await call(bridge.base, 'GET', '/transcript', { token: otherToken, query: { taskId: taskId, sinceSeq: 0 } })
      const items = transcript.body.value.items
      const kinds = items.map((event) => `${event.kind}:${event.phase ?? event.role ?? ''}`)
      assert.ok(kinds.includes('message:user'), `expected a user message in ${JSON.stringify(kinds)}`)
      assert.ok(kinds.includes('execution:tool-result'), 'expected the tool result to be projected')
      const failed = items.find((event) => event.failed === true)
      assert.equal(failed.error.code, 'fs/denied', 'a failed tool must be reported as a failure')
      const header = items.find((event) => event.phase === 'request-header')
      assert.ok(header !== undefined, 'expected a request-header projection')
      assert.equal(header.observedConfig.provider, 'deepseek-account')
      assert.equal(header.observedConfig.model, 'deepseek-flash')
      assert.equal(header.observedConfig.reasoningEffort, 'high')
      const artifact = items.find((event) => event.phase === 'tool-call' && event.tool === 'write')
      assert.ok(artifact.argumentsPreview.includes('report.md'), 'a tool call must carry a bounded argument preview')
    })

    await check('duplicate requestId does not submit a second prompt', async () => {
      const before = bridge.host.counts().prompts
      const replay = await call(bridge.base, 'POST', '/tasks/append', {
        token: otherToken,
        body: { requestId: 'r-round-1', taskId, message: 'run the offline pass', kind: 'instruction' },
      })
      assert.equal(replay.status, 200)
      assert.equal(replay.body.value.replayed, true)
      assert.equal(bridge.host.counts().prompts, before, 'the duplicate reached sessionController.prompt')
    })

    await check('reusing a requestId for a different kind is refused', async () => {
      const result = await call(bridge.base, 'POST', '/tasks/append', {
        token: otherToken,
        body: { requestId: 'r-round-1', taskId, message: 'different', kind: 'review' },
      })
      assert.equal(result.status, 409)
      assert.equal(result.body.error.code, 'request/conflict')
    })

    await check('a second round keeps the same session and task binding', async () => {
      const second = await call(bridge.base, 'POST', '/tasks/append', {
        token: otherToken,
        body: { requestId: 'r-round-2', taskId, message: 'now review your own result', kind: 'review' },
      })
      assert.equal(second.status, 200)
      const state = await call(bridge.base, 'GET', '/tasks/get', { token: otherToken, query: { taskId } })
      assert.equal(state.body.value.task.sessionId, sessionId)
      assert.equal(state.body.value.task.rounds.length, 2)
      assert.deepEqual(state.body.value.task.rounds.map((round) => round.kind), ['instruction', 'review'])
    })

    await check('a wait for turn-end is not settled by turn-start', async () => {
      // `turn-end` means the turn is over, so early progress must not be
      // reported as a settled turn to a caller that asked for completion.
      const current = await call(bridge.base, 'GET', '/transcript', { token: otherToken, query: { taskId, sinceSeq: 0 } })
      const cursor = current.body.value.cursor
      const sent = await call(bridge.base, 'POST', '/tasks/append', {
        token: otherToken,
        body: { requestId: 'r-round-3', taskId, message: 'third round', kind: 'instruction' },
      })
      assert.equal(sent.status, 200)
      const wait = await call(bridge.base, 'POST', '/tasks/wait', {
        token: otherToken,
        body: { taskId, waitMs: 3000, condition: { sinceSeq: cursor, on: ['turn-end'] } },
      })
      assert.equal(wait.status, 200)
      const phases = wait.body.value.events.map((event) => event.phase)
      assert.ok(!phases.includes('turn-start'), `turn-start settled a turn-end wait: ${JSON.stringify(phases)}`)
      assert.ok(phases.includes('turn-completed'), `expected the completed turn, got ${JSON.stringify(phases)}`)
    })

    await check('events follow a desktop-side message through the cursor', async () => {
      const before = await call(bridge.base, 'GET', '/transcript', { token: otherToken, query: { taskId, sinceSeq: 0 } })
      const cursor = before.body.value.cursor
      // Simulate the user typing in the desktop app: the message lands in the
      // session log, so the follower must deliver it without a bridge prompt.
      bridge.host.desktopMessage(sessionId, 'one more thing from the desktop')
      await new Promise((resolve) => setTimeout(resolve, 80))
      const wait = await call(bridge.base, 'POST', '/tasks/wait', {
        token: otherToken,
        body: { taskId, waitMs: 1500, condition: { sinceSeq: cursor, on: ['message'] } },
      })
      assert.equal(wait.status, 200)
      assert.equal(wait.body.value.timedOut, false, 'the desktop message must settle the wait')
      const delivered = wait.body.value.events.filter((event) => event.kind === 'message' && event.role === 'user')
      assert.ok(delivered.length > 0, `expected the desktop message, got ${JSON.stringify(wait.body.value.events)}`)
      assert.ok(delivered.some((event) => event.text.includes('one more thing')), 'the desktop reply text must be readable')
      assert.ok(wait.body.value.cursor > cursor, 'the cursor must advance past the desktop message')
    })

    await check('a wait with no new activity times out without inventing events', async () => {
      const current = await call(bridge.base, 'GET', '/transcript', { token: otherToken, query: { taskId, sinceSeq: 0 } })
      const wait = await call(bridge.base, 'POST', '/tasks/wait', {
        token: otherToken,
        body: { taskId, waitMs: 300, condition: { sinceSeq: current.body.value.cursor, on: ['message'] } },
      })
      assert.equal(wait.body.value.timedOut, true)
      assert.deepEqual(wait.body.value.events, [])
    })

    await check('cancel reaches the session controller without touching permissions', async () => {
      const result = await call(bridge.base, 'POST', '/tasks/cancel', { token: otherToken, body: { taskId } })
      assert.equal(result.status, 200)
      assert.equal(result.body.value.accepted, true)
      assert.equal(bridge.host.counts().cancelCount, 1)
    })

    await check('session/workspace mismatch is detected', async () => {
      const result = await call(bridge.base, 'GET', '/transcript', {
        token: otherToken,
        query: { workspaceId: WORKSPACE_B, sessionId },
      })
      assert.equal(result.status, 409)
      assert.equal(result.body.error.code, 'session/workspace-mismatch')
    })

    await check('session listing is scoped to the workspace path', async () => {
      const inA = await call(bridge.base, 'GET', '/sessions', { token: otherToken, query: { workspaceId: WORKSPACE_A } })
      assert.equal(inA.body.value.items.length, 1)
      const inB = await call(bridge.base, 'GET', '/sessions', { token: otherToken, query: { workspaceId: WORKSPACE_B } })
      assert.equal(inB.body.value.items.length, 0, 'workspace B must not see workspace A sessions')
    })

    await check('unknown endpoint and oversized body fail closed', async () => {
      const missing = await call(bridge.base, 'GET', '/nope', { token: otherToken })
      assert.equal(missing.status, 404)
      assert.equal(missing.body.error.code, 'request/unsupported')
      const big = await call(bridge.base, 'POST', '/tasks/append', {
        token: otherToken,
        body: { requestId: 'r-big', taskId, message: 'x'.repeat(300000) },
      })
      assert.equal(big.status, 413)
      assert.equal(big.body.error.code, 'request/too-large')
    })

    await check('token revoked on disk stops working on the next request', async () => {
      await writeFile(tokensPath, `${JSON.stringify({ version: 1, tokens: { main: { alias: 'main', hash: 'deadbeef', workspaceIds: [WORKSPACE_A] } } }, null, 2)}\n`)
      const result = await call(bridge.base, 'GET', '/health', { token: otherToken })
      assert.equal(result.status, 403)
      assert.equal(result.body.error.code, 'auth/invalid-token')
      // Restore the credential so the remaining checks exercise their own paths.
      await writeFile(tokensPath, `${JSON.stringify({ version: 1, tokens: { wide: { alias: 'wide', hash: createHash('sha256').update(otherToken).digest('hex'), workspaceIds: null } } }, null, 2)}\n`)
    })

    await check('task bindings are durable, including the model actually observed', async () => {
      const { readFile } = await import('node:fs/promises')
      const persisted = JSON.parse(await readFile(join(bridge.stateDir, 'state.json'), 'utf8'))
      assert.ok(persisted.tasks[taskId], 'the task binding was not persisted')
      assert.equal(persisted.tasks[taskId].sessionId, sessionId)
      assert.ok(persisted.tasks[taskId].rounds.length >= 2)
      assert.equal(persisted.tasks[taskId].observedConfig.model, 'deepseek-flash')
      assert.equal(persisted.tasks[taskId].observedConfig.reasoningEffort, 'high')
    })

    await check('closing a task keeps its session and stops following it', async () => {
      const result = await call(bridge.base, 'POST', '/tasks/close', { token: otherToken, body: { taskId } })
      assert.equal(result.status, 200)
      assert.equal(result.body.value.sessionKept, true)
      const health = await call(bridge.base, 'GET', '/health', { token: otherToken })
      assert.equal(health.body.value.sessionsFollowed, 0)
      const gone = await call(bridge.base, 'GET', '/tasks/get', { token: otherToken, query: { taskId } })
      assert.equal(gone.body.error.code, 'task/not-found', 'a closed task must not be addressable')
    })
  } finally {
    await bridge.close()
  }

  const failed = checks.filter((entry) => !entry.ok)
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`)
  if (failed.length > 0) process.exitCode = 1
}

await main()
