# DSH Remote · 原生 App 框架设计（v1 草案，待确认）

> 方向确认：**不镜像电脑上的 DSH 界面**。手机端是一套**全新设计的原生 UI**；
> 与电脑的连接只用于「取内容 / 取历史 / 发指令 / 收实时事件」，即调用我们自己的
> `desktop-plugin`（Remote Gateway）的 REST + WebSocket 接口。细节视觉下一步再定。

## 1. 目标与原则

- **原生优先**：会话列表、消息流、审批、工作区切换都用原生控件渲染，不加载桌面页面。
- **连接即数据源**：网关（默认 `http://<电脑>:3080`）提供配对、会话、消息、工作区、设备、实时事件。
- **离线可读**：最近一次拉到的会话/消息本地缓存，断网时能看、能标"离线"，恢复后自动同步。
- **渐进交付**：M1 骨架（可跑、可看结构）→ M2 会话列表真数据 → M3 会话详情 + 发送 + 实时 → M4 审批/设备 → M5 视觉精修。
- **可回退**：现有 WebView 壳保留为「兼容模式」入口（设置里切换），原生 UI 为默认；两边共用同一份配对凭据。

## 2. 技术选型（建议）

| 关注点 | 选择 | 理由 |
|---|---|---|
| 语言 | **Kotlin** | Compose 生态、协程/Flow 天然适配事件流 |
| UI | **Jetpack Compose + Material 3** | 快速迭代、主题化容易，适合"先框架后细节" |
| 导航 | Compose Navigation（单 Activity） | 屏幕少，嵌套简单 |
| 状态 | ViewModel + `StateFlow`（UI State 数据类） | 单向数据流，便于后续加缓存 |
| 网络 | OkHttp + kotlinx.serialization（或 Retrofit） | 轻量、HTTP/WS 同栈 |
| 实时 | OkHttp WebSocket + `callbackFlow` | `/ws` 事件直接映射成 Flow |
| 本地存储 | DataStore（凭据/设置）+ Room（会话与消息缓存，M3 引入） | 标准化、可迁移 |
| 依赖注入 | 手工构造（Hilt 可选，M4 再评估） | 早期少一层复杂度 |

> 备选：继续用 Java + View 体系（构建更快，但 UI 迭代成本高）。**建议 Compose**。

## 3. 架构分层

```
com.dsh.remote
├─ data
│  ├─ remote   GatewayApi(HTTP) · GatewaySocket(WS) · Dto(数据模型)
│  ├─ local    CredentialStore(DataStore) · SessionCache(Room, M3+)
│  └─ repo     SessionsRepository · WorkspacesRepository · DevicesRepository
├─ domain      Session · Message · Workspace · Device · Interaction(审批/提问)
├─ ui
│  ├─ theme    Color/Type/Shape（M5 精修）
│  ├─ pair     PairingScreen(扫码/手输) · PairingViewModel
│  ├─ sessions SessionsScreen · SessionDetailScreen · Composer · MessageTimeline
│  ├─ workspaces WorkspacesScreen
│  ├─ settings SettingsScreen(连接状态/设备管理/兼容模式/关于)
│  └─ common   AppScaffold(底部导航) · 状态徽标 · 空态/错误态组件
└─ WebView 兼容模式（保留现有 MainActivity 能力，独立入口）
```

## 4. 数据来源：与网关 API 的映射

| App 功能 | 网关接口 | 备注 |
|---|---|---|
| 扫码配对 | `POST /api/pair/verify {code, device{name,os}}` → `token`、`expiresInMs` | 二维码内容形如 `https://host:3080/pair?code=XXXX`，App 解析出 base + code |
| 撤销本机 | `POST /api/pair/revoke`（cap）或本地清除 | 设置页"解除配对" |
| 会话列表 | `GET /api/sessions`（Bearer） | 返回 `id/title/updatedAt/running/blank/cwd/...` |
| 会话历史 | `GET /api/sessions/:id` | 当前返回归一化 `transcript[]` + `rawTail`；**chunk 组装待补强** |
| 发送消息 | `POST /api/sessions/:id/message {content, mode}` | `mode=queue/steer`；返回 `requestId` |
| 工作区列表 | `GET /api/workspaces` | 有 `ready` 标志（官方流 baseline 是否到达） |
| 切换工作区 | `POST /api/workspaces/:id/switch` | 语义=在该工作区开/复用会话，返回 `sessionId` |
| 实时事件 | `WS /ws?token=…` | `hello`、`session.status|activity|added|removed|error`、`workspaces`、`interaction.request`、`presence` |
| 审批决策 | `POST /api/approvals/:eventId {decision}` 或 WS 帧 | 词表：`allowed-once` / `rejected` / `cancelled` |
| 已配对设备 | `GET /api/devices` | 面板用于"我的设备"页 |

**鉴权**：JWT 存 DataStore（加密存储 M4 再加强）；所有数据请求带 `Authorization: Bearer`；WS 用 `?token=`。

## 5. 屏幕与信息架构（框架级）

1. **首次启动 → 配对流程**
   - 欢迎页（Logo + 一句话）→ 扫码（ZXing）或"手动粘贴配对链接" → 校验 → 进入主界面
   - 失败态：二维码过期/被使用/网络不通，各有明确文案与重试
2. **主界面（底部导航 3 个 Tab）**
   - **会话**：按工作区分组的会话列表（标题、最后活动时间、运行中徽标）+ 顶部当前工作区切换器 + 下拉刷新
   - **工作区**：工作区卡片列表（名称/路径/会话数），点按切换当前工作区
   - **设置**：连接状态（在线/离线/延迟）、电脑信息（版本、网关地址）、设备管理（解除配对/撤销）、兼容模式开关、关于
3. **会话详情**
   - 顶部：会话标题 + 运行状态点 + 当前工作区
   - 中部：消息时间线（用户/助手/工具调用/错误；支持分页加载更早）
   - 底部：输入栏（文本 + 发送；`queue/steer` 模式切换；图片 M3+）
   - **审批卡片**：`interaction.request` 到达时在时间线内插入"允许一次 / 拒绝"，并同步桌面端决策结果
4. **全局状态呈现**
   - 顶部细进度条（加载中）、离线横幅（WebSocket 断开）、错误 Snackbar + 重试

## 6. 状态与数据流

```
DataStore(凭据/设置) ─┐
GatewayApi(HTTP) ─────┼─► Repository ─► ViewModel(StateFlow<UiState>) ─► Compose UI
GatewaySocket(WS) ────┘                      ▲
                                       用户意图(发送/切换/审批)
```

- `UiState` 为不可变数据类；每个屏幕一个 `ViewModel`，Repository 只暴露 `Flow`/挂起函数。
- WebSocket 事件 → Repository 内部的 `MutableSharedFlow` → 合并进列表状态（`session.activity` 触发列表时间排序与"有更新"标记；`status` 更新运行态）。
- 断线策略：指数退避重连（1s→30s），期间 `offline=true`，UI 显示横幅；恢复后全量刷新一次。

## 7. 里程碑（建议顺序）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M1 骨架** | Kotlin+Compose 接入、主题、单 Activity 导航、配对页 | ✅（v2 改为抽屉式外壳） |
| **M2 会话列表** | 配对落库、`GET /api/sessions`、刷新、离线/错误态、工作区筛选 chip | ✅ |
| **M3 会话详情** | 历史加载（`beforeSeq` 翻页）、时间线渲染、发送消息、`/ws` 实时追加 | ✅（本地缓存待做） |
| **M4 审批与设备** | `interaction.request` 卡片 + 决策回传、前台服务保活、审批通知、设备列表 | ✅（凭据加密待做） |
| **M5 视觉精修** | 品牌色/字体/图标、启动页、动效、深浅色 | 🟡 v2 按参考项目重做外壳，细节可继续调 |

### M5 · v2 外壳（仿照参考项目重做）

用户要求**不再自研视觉**，直接仿照成熟 UI：参考项目
[`thecookfish1201-svg/DeepSeek-whale-Chat`](https://github.com/thecookfish1201-svg/DeepSeek-whale-Chat)（MIT，HTML/CSS/JS + 10 张立绘）。
落地对照：

| 参考实现 | 本项目（Compose） |
|---|---|
| CSS 变量（`--card`/`--border`/`--accent`…，亮暗两套） | `ui/theme/Color.kt` 同名常量 + `LocalGlassPalette` |
| `backdrop-filter: blur(20px)` 玻璃卡片 | Compose 无法模糊"背后内容"，改用同款半透明色 + 1dp 描边 + 柔和阴影（`Modifier.glassCard`） |
| `.chat-card`（圆角 24 / 消息区 / 输入区） | `ui/chat/ChatCard.kt`（标题栏 + 时间线 + 审批卡片 + 输入栏 + 渐变发送键） |
| `.bubble`（82% 宽、16dp 圆角且单角 6dp、`msgIn` 动效） | `ui/chat/Bubbles.kt`（`animateFloatAsState` 复刻 0.25s 淡入上移） |
| `.character-layer` + `charShake` / `ringPulse` | `ui/character/CharacterLayer.kt`（Crossfade 换表情、点击抖动、发送失败红圈脉冲；手机端布局取参考的 `@media (max-width:768px)` 版本：立绘在上、聊天卡片在下） |
| 左抽屉会话列表 / 右抽屉设置 | `ui/shell/SessionsDrawer.kt`、`SettingsDrawer.kt`、`DrawerHost.kt`（250ms 滑入 + 遮罩） |
| 主题 / 字号 / 立绘透明度三个开关 | `Appearance`（SharedPreferences）+ 主题里用 `LocalDensity` 的 fontScale 统一缩放 |

立绘"情绪"由 App 状态推导（`ui/Emotion.kt`）：思考中＝agent 在跑，待处理＝有审批/提问，
未连接＝离线，开心＝刚收到回复，发送失败＝生气脸 + 红圈。

**已知取舍**：真正的背景模糊需要 API 31+ 的 RenderEffect 或第三方 `haze` 库，暂不引入依赖；
10 张立绘按 675×900 打包（APK 18MB → 26MB）；参考项目为 MIT，署名见 `THIRD-PARTY-NOTICES.txt`。

### 已实现的结构要点（与本文档其他章节的对应关系）

- **单连接**：`data/remote/RemoteConnection.kt` 是**应用级**的 `/ws` 持有者（指数退避 1s→30s），
  ViewModel 与前台服务都只是它的观察者——因此全进程只有一个 socket。
- **后台保活**：`service/RemoteConnectionService.kt`（`dataSync` 前台服务）常驻通知显示连接状态；
  收到 `interaction.request` 时用**高优先级 channel** 弹审批通知，点通知直达对应会话
  （`MainActivity.EXTRA_SESSION_ID`）。
- **审批不丢**：gateway 的 `hello` 帧携带未处理 `interactions[]`，App 重连/冷启动后会补上卡片；
  未授权的 `interaction` 事件按 id 去重。
- **实时而不打爆 harness**：`session.activity`/`status` 触发的历史拉取是"前沿节流 + 一次尾随"
  （最少间隔 1s），发送后再补刷 4 次（0.6s/1.8s/4s/8s）以覆盖"用户消息落库 + 助手回合"。
- **翻页不跳屏**：只有**最新一条**的 seq 变化才自动滚到底部；`pending=true` 的本地回显在权威数据到达后丢弃。

## 8. 需要插件侧（desktop-plugin）补强的点

| # | 项 | 状态 |
|---|---|---|
| 1 | **历史消息组装**：`chunkrow/*` 拼成完整助手消息 | ✅ 已实现（文本/推理/工具调用三类 chunk 行） |
| 2 | **新建会话**：`POST /api/sessions`（App 右上角 ＋ 按钮） | ✅ 已实现 |
| 3 | **会话标题**：`projections.values.title` 不可用时兜底 | ✅ App 侧用目录名兜底（harness 会异步生成标题） |
| 4 | **事件覆盖校准**：`session.status|activity`、审批/提问中继 | ✅ 已对真实 harness 验证（含后台审批通知） |
| 5 | **设备列表**：`GET /api/devices` | ✅ 可用；"改设备名"如需再加 `PATCH` |
| 6 | **历史分页**：`?beforeSeq=` + `nextBeforeSeq` | ✅ 已实现（App 有"加载更早的消息"） |
| 7 | **原始载荷按需**：`?raw=1` | ✅ 默认不下发，省手机流量 |

## 9. 待你确认的框架决策

1. 技术栈：**Kotlin + Compose**（推荐）还是继续 Java + View？
2. 底部导航 3 Tab（**会话 / 工作区 / 设置**）是否符合预期？是否需要把"审批"提为独立 Tab（待处理队列）？
3. 首屏策略：**未配对先走配对引导**（推荐）还是默认进会话列表、需要时再弹配对？
4. WebView 兼容模式是否保留（推荐保留，作为兜底与对照）？
5. 会话详情的"发送模式"默认用 `queue`（排队不打断，推荐）还是 `steer`（立即接管）？
