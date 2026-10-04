#!/usr/bin/env node
/**
 * dsh-codex-bridge admin CLI — offline credential and scope management.
 *
 * The bridge itself stores only token *hashes*; this tool is the only place a
 * plaintext token exists, and it prints it exactly once. It never reads the
 * desktop's cookies, account credentials, or process memory.
 *
 *   node admin.mjs token issue   --alias codex-main [--workspace <id>]...
 *   node admin.mjs token list    [--json]
 *   node admin.mjs token revoke  --alias codex-main
 *   node admin.mjs token hash    <token>          # for tokenFile deployments
 *   node admin.mjs state show    [--json]
 *   node admin.mjs state prune   [--task <taskId>]
 *   node admin.mjs doctor
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const TOKEN_PREFIX = 'dshb_'

const usage = `dsh-codex-bridge admin

  token issue  --alias <name> [--workspace <workspaceId>]...   create a scoped token
               [--all-workspaces]                              explicitly widen it to every
                                                              workspace the deployment allows
  token list   [--json]                                        list token aliases and scopes
  token revoke --alias <name>                                  revoke one token
  token hash   <token>                                         print the stored hash of a token
  state show   [--json]                                        print task bindings
  state prune  [--task <taskId>]                               drop finished requestId records
  doctor                                                       report paths and file modes

Scope:
  A token is scoped to the workspaces you name. Omitting --workspace no longer
  grants every workspace: pass --all-workspaces when that is really intended, or
  issue one token per workspace. scope "none" authorizes nothing at all.

Environment:
  DSH_CODEX_BRIDGE_STATE          state directory (default: ~/.dsh/codex-bridge)
  DSH_CODEX_BRIDGE_TOKEN_FILE     plaintext token file the bridge re-reads per request
`

const parseArgs = (argv) => {
  const positional = []
  const flags = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const [name, inline] = token.slice(2).split('=')
    if (inline !== undefined) {
      flags.set(name, inline)
      continue
    }
    const next = argv[index + 1]
    if (next !== undefined && !next.startsWith('--')) {
      const existing = flags.get(name)
      flags.set(name, name === 'workspace' && existing !== undefined ? [...(Array.isArray(existing) ? existing : [existing]), next] : next)
      index += 1
    } else {
      flags.set(name, true)
    }
  }
  const all = (name) => {
    const value = flags.get(name)
    if (value === undefined) return []
    return Array.isArray(value) ? value : [value]
  }
  return { positional, flags, all, one: (name) => flags.get(name) }
}

const stateDir = () => resolve(process.env.DSH_CODEX_BRIDGE_STATE ?? join(homedir(), '.dsh', 'codex-bridge'))

const readJson = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

const writeJson = async (path, value, mode) => {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode })
  await rename(temporary, path)
  await chmod(path, mode).catch(() => {})
}

const hashToken = (token) => createHash('sha256').update(token, 'utf8').digest('hex')

const fail = (message) => {
  process.stderr.write(`admin: ${message}\n`)
  process.exitCode = 1
}

const issue = async (args) => {
  const alias = args.one('alias')
  if (typeof alias !== 'string' || alias === '') return fail('token issue requires --alias <name>')
  const workspaces = args.all('workspace').filter((value) => value !== true)
  const allWorkspaces = args.one('all-workspaces') === true
  // Scope is explicit by design: an unnamed scope is not silently widened to
  // every workspace. A separate, spellable flag is required for that.
  if (workspaces.length === 0 && !allWorkspaces) {
    return fail(
      'token issue needs an explicit scope: pass --workspace with a workspace id (repeatable) '
      + 'or --all-workspaces to allow every workspace this deployment permits',
    )
  }
  const path = join(stateDir(), 'tokens.json')
  const document = await readJson(path, { version: 1, tokens: {} })
  document.version = 1
  document.tokens ??= {}
  if (document.tokens[alias] !== undefined && args.one('force') !== true) {
    return fail(`alias "${alias}" already exists; revoke it first or pass --force`)
  }
  const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
  document.tokens[alias] = {
    alias,
    hash: hashToken(token),
    workspaceIds: allWorkspaces ? null : workspaces,
    createdAt: new Date().toISOString(),
    source: 'admin-cli',
  }
  await writeJson(path, document, 0o600)
  process.stdout.write(`${token}\n`)
  process.stderr.write(`admin: issued "${alias}" (${allWorkspaces ? 'ALL configured workspaces' : `${workspaces.length} workspace(s)`}); written to ${path}\n`)
}

const list = async (args) => {
  const path = join(stateDir(), 'tokens.json')
  const document = await readJson(path, { version: 1, tokens: {} })
  const rows = Object.values(document.tokens ?? {}).map((entry) => ({
    alias: entry.alias,
    scope: Array.isArray(entry.workspaceIds)
      ? (entry.workspaceIds.length === 0 ? 'none' : entry.workspaceIds)
      : 'all-configured',
    createdAt: entry.createdAt,
  }))
  if (args.one('json') === true) {
    process.stdout.write(`${JSON.stringify({ path, tokens: rows }, null, 2)}\n`)
    return
  }
  process.stdout.write(`# ${path}\n`)
  if (rows.length === 0) process.stdout.write('(no tokens issued)\n')
  for (const row of rows) process.stdout.write(`${row.alias}\t${Array.isArray(row.scope) ? row.scope.join(',') : row.scope}\t${row.createdAt ?? ''}\n`)
}

const revoke = async (args) => {
  const alias = args.one('alias')
  if (typeof alias !== 'string' || alias === '') return fail('token revoke requires --alias <name>')
  const path = join(stateDir(), 'tokens.json')
  const document = await readJson(path, { version: 1, tokens: {} })
  if (document.tokens?.[alias] === undefined) return fail(`alias "${alias}" is not issued`)
  delete document.tokens[alias]
  await writeJson(path, document, 0o600)
  process.stdout.write(`revoked ${alias}\n`)
}

const showState = async (args) => {
  const path = join(stateDir(), 'state.json')
  const document = await readJson(path, { version: 1, tasks: {} })
  if (args.one('json') === true) {
    process.stdout.write(`${JSON.stringify(document, null, 2)}\n`)
    return
  }
  process.stdout.write(`# ${path}\n`)
  for (const task of Object.values(document.tasks ?? {})) {
    process.stdout.write(`${task.taskId}\t${task.workspaceId}\t${task.sessionId}\t${task.status}\trounds=${(task.rounds ?? []).length}\n`)
  }
}

const prune = async (args) => {
  const path = join(stateDir(), 'state.json')
  const document = await readJson(path, { version: 1, tasks: {} })
  const only = args.one('task')
  let dropped = 0
  for (const task of Object.values(document.tasks ?? {})) {
    if (typeof only === 'string' && task.taskId !== only) continue
    for (const [key, entry] of Object.entries(task.requests ?? {})) {
      if (entry.state === 'done') {
        delete task.requests[key]
        dropped += 1
      }
    }
  }
  await writeJson(path, document, 0o600)
  process.stdout.write(`pruned ${dropped} finished request record(s)\n`)
}

const doctor = async () => {
  const dir = stateDir()
  process.stdout.write(`state directory: ${dir}\n`)
  for (const name of ['state.json', 'tokens.json']) {
    const path = join(dir, name)
    try {
      const stats = await readFile(path)
      process.stdout.write(`  ${name}: present (${stats.length} bytes)\n`)
    } catch (error) {
      process.stdout.write(`  ${name}: ${error?.code === 'ENOENT' ? 'absent (created on first use)' : `unreadable: ${String(error)}`}\n`)
    }
  }
  process.stdout.write('bridge HTTP surface: prefix /codex-bridge on the running desktop web server (default port 19387)\n')
  process.stdout.write('note: the bridge loads only when the desktop profile mounts the dsh-codex-bridge bundle\n')
}

const main = async () => {
  const [, , group, action, ...rest] = process.argv
  const args = parseArgs(rest)
  switch (`${group ?? ''} ${action ?? ''}`) {
    case 'token issue':
      return issue(args)
    case 'token list':
      return list(args)
    case 'token revoke':
      return revoke(args)
    case 'token hash': {
      const token = group === 'token' && action === 'hash' ? rest.find((value) => !value.startsWith('--')) : undefined
      if (token === undefined) return fail('token hash requires a token argument')
      process.stdout.write(`${hashToken(token)}\n`)
      return undefined
    }
    case 'state show':
      return showState(args)
    case 'state prune':
      return prune(args)
    case 'doctor ':
    case 'doctor':
      return doctor()
    default:
      process.stdout.write(usage)
      return undefined
  }
}

await main()
