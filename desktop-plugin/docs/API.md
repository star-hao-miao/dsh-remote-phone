# dsh-remote-phone API（v0.1.0）

网关默认 `http(s)://<host>:3080`（宿主 = 桌面本机回环，或局域网 IP，或 Quick Tunnel 公网域名）。
所有响应统一信封：

```json
{ "ok": true, ... }
{ "ok": false, "error": { "code": "string", "message": "human" } }
```

鉴权分为三类：

| 级别 | 携带方式 | 用途 |
|---|---|---|
| 无 | — | `/healthz`、`/pair`、`/api/pair/verify` |
| 桌面能力令牌 | 请求头 `x-rg-cap: <jwt>`（或 GET `?cap=`） | 控制面（铸造/撤销/模式/面板/QR）——只由电脑端官方 loopback 路由签发 |
| 设备令牌 | `Authorization: Bearer <jwt>` | 数据面（会话/消息/工作区）与 `/ws` |

## 配对

### `POST /api/pair` （控制面，cap）
铸造新的**一次性配对码**（旧码立即失效）。响应：

```json
{ "ok": true, "code": "AB3DE7FQ", "expiresAt": 1750000000000,
  "lan": ["http://192.168.1.5:3080"], "tunnel": "https://xxx.trycloudflare.com" }
```

### `POST /api/pair/verify` （公开，限流）
```json
{ "code": "AB3D-E7FQ", "device": { "name": "Pixel 8", "os": "Android 15" } }
```
→ `200`：`{ ok, device:{id,name,os,createdAt,lastSeenAt,online}, token, tokenType:"Bearer", expiresInMs, expiresAt }`
错误：`401 invalid`（码错）、`409 used-up`、`410 expired`、`429 throttled`。码不区分大小写、可带分隔符，一次性。

### `POST /api/pair/revoke` （cap）
`{ "deviceId": "…" }` → `{ ok, revoked:1 }`；`{ "all": true }` → 撤销全部。

### `GET /api/devices` （cap **或** Bearer）
`{ ok, items:[DeviceView…] }`（在线 = lastSeenAt 距今 ≤25s，由 10s 清扫维护）。

## 数据面（Bearer）

### `GET /api/sessions`
`{ ok, items: [{ id, title?, updatedAt, running, blank, parentSessionId?, origin?, cwd?, createdAt? }] }`

### `GET /api/sessions/:id`
查询参数：
| 参数 | 作用 |
|---|---|
| `beforeSeq=<n>` | **翻页**：取序号小于 n 的更早记录（游标取自上一次返回的 `nextBeforeSeq`） |
| `limit=<n>` | 覆盖本条请求的 `maxTranscriptMessages`（1–500，默认取配置值） |
| `raw=1` | 附带原始事件（`rawTail` 与每条消息的 `raw`）。**默认不下发**，避免手机端白白传输几十倍数据 |

`{ ok, session: { id, transcript: TranscriptMessage[], hasMore, nextBeforeSeq?, rawTail } }`，
`TranscriptMessage = { seq, time, role:"user|assistant|tool|system|other", kind, text?, toolName?, agentId?, raw? }`。

文本还原规则（都对真实 harness 校准过）：
- `user/message` 的正文在 `data.content[]`，`assistant/message` 在 `data.message.content[]`——只取
  `{type:'text'}` 块（`reasoning` 块单独由 chunk 组装成 `assistant/reasoning` 消息，混进来会重复）。
- 注入类消息（`source.kind = "plugin"`，例如 `@deepseek-ai/dsh-system-prompt` 的运行时快照）不算对话，丢弃。
- `tool/call` → `工具名: 描述或命令`（截断），`tool/result` → 工具输出（截断 800 字符）。
- 其余 turn/step/inbox/session-seed 等簿记事件不下发；失败类事件（error/fail/cancel/…）保留。

### `POST /api/sessions`
新建会话：`{ "workspaceId"?: "…", "cwd"?: "C:\\path" }` → `{ ok, sessionId }`。
（未知工作区 → `404 unknown-workspace`；与官方 `session/create` 对应。）

### `POST /api/sessions/:id/message`
```json
{ "content": "继续", "mode": "queue", "image": { "mediaType": "image/png", "data": "<base64>", "name": "x.png" } }
```
mode：`queue`（默认，排队不打断）| `steer`（立即接管）。
→ `{ ok, accepted:true, requestId }`

### `GET /api/workspaces`
`{ ok, items:[{ workspaceId, path, title, sessionIds, createdAt?, updatedAt? }], ready }`
（`ready:false` = 官方工作区流的首帧 baseline 尚未到达。）

### `POST /api/workspaces/:id/switch`
官方没有“切换当前工作区”单一路由，本接口语义＝在该工作区**打开/新建会话**（与官方 Web UI
“进入工作区”一致）：
→ `{ ok, workspaceId, sessionId }`；未知工作区 `404 unknown-workspace`。

### `POST /api/approvals/:eventId` （Bearer）
手机对收到的 `interaction.request`（kind=approval）做决定：
`{ "decision": "allowed-once" | "rejected" | "cancelled" }` → 转发官方 `$events/result`。
超时（60s）或 `{ "decision": "next" }` 委托给桌面下一个审批监听者。

## WebSocket `/ws`

连接：`ws://host:3080/ws?token=<JWT>` 或 `Authorization: Bearer`。文本 JSON 帧。

服务端 → 客户端（事件）：`hello`（连接即发，**含未处理的 `interactions[]`**，供重连/冷启动后仍能渲染审批卡片）、
`state`、`pairing.code`、`pairing.device`、`presence`、
`session.status|activity|added|removed|error`、`workspaces`、`interaction.request`、`tunnel`、`mode`；
每个帧带 `at` 时间戳。

客户端 → 服务端：`{type:"ping"}` → `pong`；`{type:"approval.decision", id, decision}`；
`{type:"user-question.answer", id, answer}`。

```jsonc
// 示例：审批请求
{ "type":"interaction.request", "id":"evt_…", "kind":"approval",
  "sessionId":"session-…", "toolName":"bash", "callId":"call-…",
  "reason":"…", "request":{…原始字段去掉 signal…}, "at": … }
```

## 控制面（cap，面板使用）

- `GET  /api/rg/state` → `{ ok, version, enabled, port, bindHost, lanMode, lanAddresses, tunnel:{phase,url?,error?}, pairing:{code,expiresAt}|null, harnessConnected, devices }`
- `GET  /api/rg/qr?mode=lan|tunnel[&ip=192.168.x.x]` → `{ ok, mode, svg, url, expiresAt }`
- `POST /api/rg/mode` `{ "lan": true|false }` → 重绑监听（0.0.0.0/127.0.0.1），返回 state
- `POST /api/rg/tunnel` `{ "enable": true|false }` → 启动/停止 Quick Tunnel，返回 state
- `POST /api/rg/revoke-all` → `{ ok, revoked }`
- `GET  /panel?cap=…` 配对面板页面（iframe 使用）
- `GET  /pair?code=…` 手机浏览器/App 可读的小页面；`GET /`、`GET /healthz` 服务信息

## 官方 harness 对接层（本插件内部）

`docs/HARNESS-API.md` 记录了官方 loopback RPC 信封与 remote.mux 协议（含出处行号），
`src/harness.ts` + `src/dsh-api.ts` 是对该协议的唯一封装点；后续版本演进只需改这两处。
