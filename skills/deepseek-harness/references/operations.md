# Bridge operations

All responses are `{ok, protocolVersion, requestId, value}`. Errors contain `{error: {code, message, details}}`. `scripts/bridge.py` returns exit 0 on a successful bridge response, 2 on a bridge refusal, and 3 on a local/transport error. It never retries mutations automatically. An `--output` file contains the full response envelope.

In the commands below, replace `<python>` and `<bridge.py>` with absolute paths from the skill/local setup. Working JSON files belong in the current task's writable directory; their names are examples. Use an available file-writing tool or literal PowerShell here-string to save UTF-8 JSON rather than putting multiline prompts into shell arguments.

## Create or adopt

Save a create request. Generate real unique IDs; preserve them for retries:

```json
{
  "requestId": "create-<uuid>",
  "taskId": "task-codex-<uuid>",
  "workspaceId": "<registered workspace ID>",
  "title": "<user-visible title>",
  "objective": "<goal metadata>",
  "acceptanceCriteria": "<acceptance metadata>",
  "external": {"client": "codex", "conversationId": "<current conversation ID if known>"}
}
```

For adoption, add `sessionId`. Optional supported selection fields are `agentPreset`, `provider`, `model`, and `reasoningEffort`; choose identifiers from `/capabilities`. Reasoning effort requires a provider/model selection. Example when requested: `deepseek-account`, `deepseek-flash`, `high`; discover the creator-mode preset ID (often `cordis`).

```powershell
& '<python>' '<bridge.py>' POST /tasks/create --body-file create.json --output created.json
```

Read `value.task.taskId`, `value.task.sessionId`, `value.task.workspaceId`, `value.task.agentPreset`, and `replayed`. This operation creates/adopts a desktop session and task association; it does **not** start work. The objective and acceptance fields are metadata, so repeat the actual instructions in the append message.

## Submit and review

Save a distinct append request:

```json
{
  "requestId": "round-<uuid>",
  "taskId": "<returned task ID>",
  "kind": "instruction",
  "message": "<complete task instructions, files, constraints and acceptance>",
  "mode": "queue"
}
```

```powershell
& '<python>' '<bridge.py>' POST /tasks/append --body-file round.json
```

Check `value.accepted` and `value.round`. Other supported kinds: `review`, `feedback`, `question`, `clarification`, `note`. Use another unique requestId for a genuinely new round. `mode: steer` is for explicitly steering an in-progress request; use queue for ordinary sequential feedback.

Provider/model/effort can also be selected on append. A received response is only admission, not proof that the agent completed its work.

## Bounded waiting and result reads

Save this wait request using the last processed sequence (initially -1):

```json
{
  "taskId": "<task ID>",
  "waitMs": 25000,
  "condition": {"sinceSeq": -1, "on": ["turn-end", "input-request"]}
}
```

```powershell
& '<python>' '<bridge.py>' POST /tasks/wait --body-file wait.json
& '<python>' '<bridge.py>' GET /tasks/get --query 'taskId=<task ID>'
& '<python>' '<bridge.py>' GET /transcript --query 'taskId=<task ID>' --query 'sinceSeq=<processed sequence>' --query 'limit=200'
```

`wait` returns `cursor`, `status`, `timedOut`, and matching `events`. Finish only after examining an actual terminal phase (`turn-completed`, `turn-failed`, `turn-aborted`, `turn-blocked`, `turn-interrupted`, etc.) or a concrete permission/input request. A settled wait is not automatically successful. Read the final transcript and requested artifacts, then check status/model in `/tasks/get`.

`value.task.observedConfig` or a transcript `execution: request-header` records the actual provider/model/reasoning effort. Verify exact values when the user requested them. Message items contain visible text; tool failures use `failed: true`; internal reasoning blocks are excluded.

For complete history, iterate transcript pages and advance by the largest sequence in the returned `items`. `cursor` is the session frontier and can exceed the delivered page. `truncatedBefore` signals a history gap; inspect the returned history rather than declaring the missing interval empty. Desktop messages can be read even if no bridge append generated them. Match message sources and request IDs when correlating feedback.

## Reconnect, stop, and close

Discovery/status:

```powershell
& '<python>' '<bridge.py>' GET /tasks/list --query 'workspaceId=<workspace ID>'
& '<python>' '<bridge.py>' GET /sessions --query 'workspaceId=<workspace ID>'
```

After a Desktop restart, use health then existing IDs; bindings and histories persist. For a closed binding, create/adopt with the recorded sessionId or use its existing taskId as supported by the bridge. Prefer an already open binding to duplicating one. Multiple tasks can observe a session; closing one releases only its own reference.

Cancel body: `{"taskId":"..."}` to `/tasks/cancel`. It requests cancellation of the active turn, keeps queued work, and does not answer permissions. Close the same body with `/tasks/close` only when observation is no longer needed. Close preserves the actual desktop conversation; stop/cancel first if the user asked to stop executing work.

## Errors to act on

- `auth/missing-token`, `auth/invalid-token`, `auth/workspace-forbidden`: check the dedicated connection configuration/scope; do not print the credential or try cookie authentication.
- `workspace/not-found`, ambiguous title: rediscover workspaces and choose a valid ID; do not invent directories or silently substitute another project.
- `session/workspace-mismatch`, writer-held: respect ownership and workspace association; do not force-release another agent's writer lock.
- `task/not-found`: check whether the binding was closed; adopt the known session if authorized, rather than losing the history in a fresh dialogue.
- `model/unavailable`, `model/reasoning-effort-unavailable`, unsupported preset: discover capabilities and explain the supported choice; no silent downgrade.
- `request/conflict`: determine which existing operation owns the ID. Retry the same operation only with its original body, or use a new ID for a genuinely new request.
- `bridge/not-ready` or transport failure: determine whether the desktop is running and healthy. Preserve IDs/cursors. Do not launch a separate ACP runtime as a workaround.
- Terminal `turn-failed` and failed tool results are execution evidence, not connection success. Keep the original goal and review the actual failure before resubmitting.

See the repository PROTOCOL.md and admin.mjs for advanced administration.
