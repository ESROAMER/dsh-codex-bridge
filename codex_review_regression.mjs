// Independent review: authorization must apply to every create/replay path.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {apply} from './index.js';
import {fakeHost, WORKSPACE_A, WORKSPACE_B} from './fake_host.mjs';

const dir = await mkdtemp(join(tmpdir(), 'dsh-codex-review-'));
const host = fakeHost();
let handler;
const tokenA = 'offline-review-A';
const tokenWide = 'offline-review-wide';
await writeFile(join(dir, 'tokens.json'), JSON.stringify({version: 1, tokens: {
  a: {alias: 'a', hash: createHash('sha256').update(tokenA).digest('hex'), workspaceIds: [WORKSPACE_A]},
  wide: {alias: 'wide', hash: createHash('sha256').update(tokenWide).digest('hex'), workspaceIds: null},
}}));
apply({...host.ctx, webServer: {register(route) {handler = route.handler; return () => {};}}}, {stateDir: dir});
await new Promise(resolve => setTimeout(resolve, 60));
const server = createServer((req, res) => handler(req, res));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const call = async (token, body) => {
  const res = await fetch(`http://127.0.0.1:${server.address().port}/codex-bridge/tasks/create`, {
    method: 'POST', headers: {'content-type': 'application/json', authorization: `Bearer ${token}`},
    body: JSON.stringify(body),
  });
  return {status: res.status, body: await res.json()};
};
let failures = 0;
try {
  const created = await call(tokenWide, {requestId: 'foreign-create', taskId: 'foreign-task', workspaceId: WORKSPACE_B});
  assert.equal(created.status, 200);
  const cases = [
    ['foreign taskId replay', {requestId: 'other-request', taskId: 'foreign-task', workspaceId: WORKSPACE_B}],
    ['foreign requestId replay through allowed workspace', {requestId: 'foreign-create', taskId: 'local-task', workspaceId: WORKSPACE_A}],
  ];
  for (const [index, [name, body]] of cases.entries()) {
    const result = await call(tokenA, body);
    const leaked = result.body?.value?.task?.workspaceId === WORKSPACE_B;
    // Scoped request IDs may legitimately create a new A task. They must never
    // reuse/disclose B's task; explicit B access must still be rejected.
    const validLocalCreate = index === 1 && result.status === 200 &&
      result.body?.value?.task?.workspaceId === WORKSPACE_A &&
      result.body?.value?.task?.taskId === 'local-task' &&
      result.body?.value?.replayed === false;
    const passed = !leaked && (result.status >= 400 || validLocalCreate);
    console.log(JSON.stringify({case: name, passed, status: result.status, foreignTaskDisclosed: leaked}));
    if (!passed) failures++;
  }
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, {recursive: true, force: true});
}
process.exitCode = failures ? 1 : 0;
