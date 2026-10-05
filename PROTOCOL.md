# 接口与事件协议（Codex ↔ DSH Collaboration v1）

本文档是协议的唯一权威说明，供 Codex 侧实现或审计客户端使用。协议版本：`protocolVersion: 1`。

## 全工作区授权与注册（0.2.0 新增）

令牌 `workspaceIds: null` 表示覆盖全部已注册及未来工作区（仍受部署 `workspacePaths` 限制）。独立字段 `allowWorkspaceCreate: true` 允许注册新工作区，且仅在全工作区范围下生效。旧令牌缺少该字段时不获得创建权限。部署 `allowWorkspaceCreate: false` 可禁用注册。`GET /capabilities` 的 `workspaces.create` 反映当前调用者的实际权限。

`POST /workspaces/create` 请求：`{"requestId":"唯一ID","path":"已存在目录的绝对路径","title":"可选标题"}`。必须使用完整路径，拒绝相对路径、非目录、不存在的路径、范围外路径。此接口不创建目录。成功返回 `value.workspace {workspaceId,title,path}`、`replayed`、`reused`。通过 DSH 原生 registry.create 注册，复用同一个规范路径，不修改已有标题。客户端随后用返回的 workspaceId 创建 task 并 append 指令。

相同调用者、requestId 和规范路径/标题返回持久化回放；相同 ID 改变内容返回 409；注册权限不足/吊销或部署不允许返回 403（先检查权限，再读取回放记录）。重复目录注册不产生新工作区。请求记录与 task 状态一起保存，不包含凭据。

- 基址：`http://127.0.0.1:<desktop port>/codex-bridge`（桌面默认端口 `19387`，前缀可由配置改写）。
- 认证：每个请求都必须带 `Authorization: Bearer <token>`。缺头 → 401 `auth/missing-token`；未知/已吊销 → 403 `auth/invalid-token`。
- 传输：HTTP/1.1，JSON 请求与响应；事件流为 `text/event-stream`。
- 请求体上限默认 256 KiB（`maxRequestBytes`）；超限 → 413 `request/too-large`。
- 只用回环地址；不提供任何浏览器 CORS 许可，也不接受跨站预检。

## 1. 信封

成功：

```json
{ "ok": true, "protocolVersion": 1, "requestId": "round-7", "value": { } }
```

失败：

```json
{
  "ok": false,
  "protocolVersion": 1,
  "requestId": "round-7",
  "error": { "code": "model/unavailable", "message": "…", "details": { } }
}
```

`requestId` 在请求里出现（POST 体或 SSE 查询串）时回显，便于 Codex 把响应与自己发出的调用对齐。`details` 是可选的结构化补充（例如可用模型列表、支持的推理强度）。

### 错误码与 HTTP 状态

| code | HTTP | 触发条件 | 客户端应有行为 |
|---|---|---|---|
| `auth/missing-token` | 401 | 没有 `Authorization` 头 | 补凭据；不要重试 |
| `auth/invalid-token` | 403 | 令牌未知或已吊销 | 重新签发；不要重试 |
| `auth/workspace-forbidden` | 403 | 工作区超出令牌范围或部署允许列表；也用于按 `taskId`/`requestId` 命中范围外任务时 | 换令牌或用范围内的 `workspaceId`；不要探测范围外任务 |
| `request/bad-request` | 400 | 缺字段/类型错/`workspaceId` 与 `cwd` 冲突等 | 修参数；不要重试 |
| `request/too-large` | 413 | 体超过 `maxRequestBytes` | 拆分内容 |
| `request/unsupported` | 404 | 未知端点或方法 | 修客户端 |
| `request/conflict` | 409 | 同 `requestId` 换操作、同 `taskId` 换工作区、请求仍在飞行 | 换 `requestId`，或先读状态 |
| `workspace/not-found` | 404 | 工作区未注册 | 重新发现工作区 |
| `session/not-found` | 404 | 会话不存在 | 重新创建任务 |
| `session/workspace-mismatch` | 409 | 会话不属于该工作区，或工作区路径已变 | 停止跨工作区寻址；人工确认 |
| `session/writer-held` | 409 | 另一运行时持有 writer lock | 退避后重试，或让用户在桌面处理 |
| `session/agent-busy` | 409 | Agent 拒绝接纳提示 | 稍后重试或改用 `mode: "steer"` |
| `task/not-found` | 404 | 任务未知或已 `close` | 重新 `create`（会得到新会话） |
| `model/unavailable` | 409 | provider/model 不可路由 | 读 `details.availableModels` 后改选 |
| `model/reasoning-effort-unavailable` | 409 | 模型未声明该 effort | 读 `details.supportedEfforts` 后改选 |
| `bridge/not-ready` | 503 | 缺少对端服务，或会话跟随器不可用 | 退避重试；检查插件是否加载 |
| `bridge/timeout` | 504 | 请求未能在时限内完成 | 重试（幂等键相同） |
| `bridge/internal` | 500 | 其他内部失败 | 记录并上报；不要当成用户可见结果 |

**权限等待不是错误码**：会话在等用户批准时表现为事件 `kind: "permission"`，HTTP 调用本身是成功的。

## 2. 端点

### GET /health
无需业务参数。`value`：`bridge`、`protocolVersion`、`routePrefix`、`pid`（桌面宿主进程号，可用于判断桌面是否重载）、`sessionsFollowed`、`trackedTasks`、`permissions.autoApprove`（恒为 `false`）。

### GET /workspaces
`value.items[]`：`workspaceId`、`title`、`path`、`status`（`ok` / `missing-dir` / `unknown`）、`sessionCount`、`sessionIds`、`createdAt`、`updatedAt`；`value.tokenScope` 为 `"all-configured"` 或令牌绑定的 ID 列表。
只返回令牌范围内的工作区；名称可能重复，客户端必须按 ID 选择，不得猜测。

### GET /capabilities
`value`：`protocolVersion`、`routePrefix`、`capabilities`（工作区/会话/模型/preset/事件/权限各自的能力位；`permissions.autoApprove` 恒为 `false`）、`modelCatalog`（`default`、`routableProviders`、`groups[].models[].reasoning.efforts[]`、`failures[]`）、`agentPresets[]`、`unavailable`（哪些能力本次不可用及原因）。

约定：`agentPresets` 只列出宿主真实返回的 preset（本机为 `standard/ptc/minimal/cordis`）；任何未列出的模式名都不得被客户端“猜测可用”。

### GET /sessions?workspaceId=
`value.items[]` 来自 `sessionController.list`，且只保留 `cwd` 等于该工作区路径的会话。
错误：未知/超范围工作区 → 404/403。

### GET /transcript
两种用法，二选一：

- `?taskId=&sinceSeq=&limit=`：读桥跟踪会话的事件页（`limit` 默认 200，上限 2000）。`value`：`taskId`、`sessionId`、`followerStatus`、`followerFailure`、`cursor`（当前最新 `sessionSeq`）、`truncatedBefore`（可用最早 `sessionSeq`，`null` 表示无缺口）、`source`（`bridge-follower` / `bridge-follower+durable`）、`items[]`。
- `?workspaceId=&sessionId=&sinceSeq=&limit=`：任意属于该工作区的会话。桥跟踪的走同一事件页，否则走宿主 `sessionQuery.observeSession` 的持久化日志（`value.source` = `bridge-follower` / `durable-log`）。
  会话不属于该工作区 → 409 `session/workspace-mismatch`。

**回读语义**（本次修复）：宿主 `follow` 的首帧 `snapshot` 带 `cursor` 与 `records`，桥会把这页历史装入事件尾，因此“采用既有会话”和“桌面重启后重连”都能读到真实历史（含用户与助手文本），不再返回 `followerStatus: live, cursor: -1, items: []`。当客户端的 `sinceSeq` 早于内存尾缓存（默认 2000 条，`eventCacheLimit`）时，桥从持久化日志补读一页、按 `sessionSeq` 去重合并，并在无法补齐缺口时用 `truncatedBefore` 明示。历史事件（≤ 采用前沿）只回读，不折叠进任务的实时状态。

### GET /tasks/get?taskId=
`value.task`（任务公开视图）+ `value.follower`（`status` / `cursor` / `failure`）。
`value.task` 字段：`taskId`、`workspaceId`、`workspacePath`、`sessionId`、`agentPreset`、`title`、`objective`、`acceptanceCriteria`、`external`、`status`、`requestedConfig`、`observedConfig`、`lastTurn`、`rounds[]`、`createdAt`、`updatedAt`。

`status` 取值：`starting`、`running`、`idle`（回合以 `completed` 结束）、`attention`（回合以非完成原因结束，或出现权限等待）、`closed`。

### GET /tasks/list[?workspaceId=]
`value.items[]` 为未关闭任务的公开视图，按令牌范围过滤。

### POST /tasks/create

```json
{
  "requestId": "create-1",          // 必填，幂等键
  "taskId": "task-titanic-eda",     // 可选，缺省由桥生成
  "workspaceId": "<workspace-id>",      // 必填
  "sessionId": "session-…",         // 可选：采用既有会话（须已在同一工作区目录）
  "title": "Titanic EDA",           // 可选，写入会话标题
  "objective": "…",                 // 可选，任务目标（≤4000 字）
  "acceptanceCriteria": "…",        // 可选（≤4000 字）
  "taskContext": { },               // 可选，任意 JSON（序列化后 ≤4000 字）
  "external": { "client": "codex", "conversationId": "…" },
  "agentPreset": "standard",        // 可选；须来自 /capabilities
  "provider": "deepseek-account",   // 可选，与 model 同时给出
  "model": "deepseek-flash",
  "reasoningEffort": "high"         // 可选；须在该模型声明的集合内
}
```

`value`：`task`（公开视图）、`replayed`（`true` 表示命中幂等，未新建会话）。
行为：`workspaceId` 不存在 → 404；超范围 → 403；模型/effort 不可用 → 409；同 `taskId` 已在别的 `workspaceId` → 409；同 `requestId` 且已完成 → 返回原任务。

**授权先于任何回放/读取**（本次修复）：

- 请求先解析 `workspaceId`（令牌范围 + 部署 `workspacePaths` 允许列表），之后才可能返回既有任务的任何字段。
- 同 `taskId` 命中**范围外**任务 → 403，且响应体不含该任务的 `taskId`/`workspaceId`/`sessionId`，无法据此探测范围外任务是否存在。
- 同 `requestId` 命中范围外任务 → 409 `request/conflict`，同样只回显 `requestId`，不透露归属。
- `tasks/create` 的 `sessionId` 可以**采用**既有会话；采用后桥的事件尾由宿主首帧快照的 `records` 与 `cursor` 填充，因此 `transcript` 能立即回读该会话已有历史。
- 用同名 `taskId` 重新采用一个已 `close` 的任务时，会复用其原 `sessionId`（不新建会话）。

### POST /tasks/append

```json
{
  "requestId": "round-2",                                   // 必填，幂等键
  "taskId": "task-titanic-eda",                             // 必填
  "kind": "instruction|feedback|question|review|clarification|note",
  "message": "先做数据体检再建模",                            // 必填，非空白
  "mode": "queue|steer",                                    // 可选，默认 queue
  "provider": "deepseek-account", "model": "…", "reasoningEffort": "…"   // 可选：本会话改用该模型
}
```

`value`：`taskId`、`sessionId`、`round`、`accepted`、`replayed`。
幂等规则：同一 `requestId` + 同一 `kind` → 回放上次结果（`replayed: true`），**不会**再次提交；同一 `requestId` + 不同 `kind` → 409。`requestId` 也是宿主 `prompt` 的幂等键，双保险。
`kind` 只影响桥侧记录与任务历史，会话消息本身仍是普通用户消息；`message` 的来源在事件里标注为 `user`。

### POST /tasks/wait

```json
{
  "taskId": "task-titanic-eda",
  "waitMs": 25000,                    // 可选，上限 maxWaitMs（默认 30000）
  "condition": {
    "sinceSeq": 42,                   // 必填：客户端已持有的游标
    "on": ["turn-end", "input-request", "message", "tool-failure", "artifact"]
  }
}
```

`value`：`taskId`、`sessionId`、`cursor`、`status`、`timedOut`、`events[]`。
语义：条件已满足时立即返回（`timedOut: false`）；否则最多等待 `waitMs`。`turn-end` 与 `input-request` 是默认条件；请求中列出的其它条件也会唤醒等待。超时返回 `timedOut: true` 且不编造事件。

### POST /tasks/cancel
`{ taskId }` → `{ taskId, sessionId, accepted }`。取消当前回合，队列保留；不触碰任何权限等待。

### POST /tasks/close
`{ taskId }` → `{ taskId, status: "closed", sessionKept: true }`。停止跟随与事件缓存，**会话本身与桌面显示不受影响**。关闭后该 `taskId` 不再可寻址（想继续同一会话，用 `tasks/create` + `sessionId` 采用它）。

### GET /events?taskId=&sinceSeq=
SSE。先补发 `sessionSeq > sinceSeq` 的缓存事件，再推送实时事件；每 15 秒发送 `: keep-alive` 注释行。每帧格式：

```
event: bridge
data: { …event… }

```

## 3. 事件模型

每个事件都带：`taskId`（桥跟踪任务；持久化读取时为 `null`）、`sessionSeq`（游标，整数）、`at`（毫秒时间戳）、`sessionEventType`（宿主原始事件名）、以及 `kind` 及其投影字段。

| kind | phase / 字段 | 含义 |
|---|---|---|
| `message` | `role: "user"` + `source` + `requestId?` + `text` | 用户消息（桌面直发或桥提交，`source` 区分来源；`requestId` 来自宿主 `source.rpcId`，便于把回应与回合对应） |
| `message` | `role: "assistant"` + `model`/`modelId` + `text` + `usage?` + `interrupted` | 助手可见消息及 token 用量，不返回内部 reasoning 块 |
| `execution` | `turn-start` / `turn-completed` / `turn-aborted` / `turn-failed` / `turn-truncated` / `turn-blocked` / `turn-interrupted` / `turn-forked` | 回合生命周期；`turn-failed` 带 `error{name,code,message}` |
| `execution` | `step-start` / `step-end`（`turn`,`step`） | 模型步边界 |
| `execution` | `tool-call`（`tool`,`callId`,`argumentsPreview`） | 工具调用（参数截断，便于审计又不泄全文） |
| `execution` | `tool-result`（`callId`,`failed`,`error?`,`outputPreview`） | 工具结果；**失败以 `failed: true` + `error.code` 表达** |
| `execution` | `request-header`（`observedConfig{provider,model,reasoningEffort}`） | 本次请求**实际**使用的配置，用于核验 |
| `execution` | `model-selection`（`selectedConfig`） | 会话内模型切换 |
| `permission` | `input-requested`（`question`,`callId?`） | 会话在等用户输入/答复 |
| `permission` | `approval-requested`（`tool`,`callId?`,`reason?`） | 会话在等权限批准（含宿主 `approval/asked`）；桥**不会**代答 |
| `status` | `assistant-streaming` / `stream-ended` / `follower-failed` | 跟随器状态；`follower-failed` 带 `error` |
| `log` | `data` + `summary?` | 未投影的宿主事件，原样透出并附一行有界摘要，便于排查 |

`text`、`argumentsPreview`、`outputPreview`、`question` 都有长度上限，避免把整份文件或完整提示写入消费端日志。

## 4. 游标、重连与幂等

1. **游标**：`sessionSeq`。客户端持久化“最后处理的序号”，重连时作为 `sinceSeq` 传入。
2. **补读**：桥先补发缓存中 `> sinceSeq` 的事件，再增量推送；内存尾不足时从持久化日志补一页并按 `sessionSeq` 去重；`truncatedBefore` 告知最早可用序号（`null` 表示无缺口）。
3. **至少一次**：同一事件可能重复投递（重连、缓存重放、桥重启后的重新读入），**客户端必须按 `(sessionId, sessionSeq)` 去重**；桥自身已按序号合并两路来源。
4. **缺口与重启**：采用既有会话或桌面重启后，桥的跟随器以宿主首帧快照为准建立事件尾，因此 `sinceSeq` 早于内存缓存的读取会从持久化日志补齐；确实无法补齐时返回 `truncatedBefore`，不伪造中间事件。
5. **幂等**：
   - `tasks/append` 的 `requestId` 是桥与宿主的双重幂等键；响应丢失后重发**不会**产生第二条用户消息。
   - `tasks/create` 的 `requestId` 命中已落盘任务时返回原 `taskId`/`sessionId`；命中范围外任务时按上面的规则拒绝，不回放、不泄露。
   - 同一 `taskId` + 同一 `requestId` 是唯一合法的重放组合；`requestId` 被别的 `taskId` 用过 → 409。
6. **顺序**：同一会话的事件按 `sessionSeq` 严格递增（桥返回的 `items` 已排序并去重）；不同会话之间不保证顺序。
7. **回合判定**：`tasks/wait` 的 `turn-end` 只由**本次提交回合之后**出现的终态事件满足；早先回合的 `turn-completed`（快照或持久化补读带回）不会被当作新回合的完成。
8. **桌面重启**：桥随桌面启动自动加载；客户端用 `/health` 的 `pid` 变化判断“桌面已重载”，随后照常以 `taskId`/`sessionId` 继续，不需要 DevTools、不需要重建任务。桌面进程会一直持有**首次加载**的模块实例，因此改代码后必须重启桌面才能在 `/health` 上看到新版行为。

## 5. 安全边界（协议层）

- 认证只有 bearer token；令牌只以哈希存储，可随时吊销；范围限定到工作区 ID 集合。**范围必须显式给出**：未给范围不会被放宽为“全部工作区”，空范围等于无权限。
- `workspaceId` 是唯一的定位方式，协议**不接受**任意 `cwd`，因此不可能把会话建到未注册目录。
- 每次操作都校验“会话属于该工作区”且“工作区路径未变”，跨工作区寻址一律 409。
- 部署层 `workspacePaths` 目录允许列表对创建、回放、读取、列表一律生效；范围外任务在回放路径上也只回 403/409，不透露任务存在。
- 协议不提供任何 shell、eval、文件读写、权限批准端点；`autoApprove` 恒为 `false`。
- 插件把另一个 agent 的文本当作**任务数据**传递，不构成用户授权，也不改变工具权限。
