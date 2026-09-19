# dsh-remote-phone（阶段一 · DSH 桌面插件）

让手机上的自研 App（阶段二，Android）通过**干净 JSON REST + WebSocket** 远程控制 DeepSeek Harness：
一次性**配对码**（10 分钟）→ 长期 **JWT**；网关默认监听 **127.0.0.1:3080**（可开局域网 `0.0.0.0`）；
会话 / 消息 / 工作区接口直连官方 loopback API；支持 **Cloudflare Quick Tunnel（公网）**；
桌面 GUI 里有一只**鲸鱼按钮**弹出配对面板（局域网/公网模式切换 + 二维码 + 设备撤销）。

> ⚠️ 认知校正：DSH Desktop 0.7.2 本身已内置“Connect Phone…”，本机还装着一个同类第三方插件
> `@linxin666/dsh-remote-web-ui`。它们走“把官方 Web GUI 镜像给手机浏览器”的封闭协议；本插件是
> **为你自己的 APK 提供独立控制面**，可与之并存，不冲突。你方案里的“ApiProxy 注入点”在本版本
> 并不存在（官方无人发射 `api/gate`），本插件用 host 半区注入 `webServer`/`connection` + 自建
> 独立网关替代 —— 详见 `docs/ARCHITECTURE.md`。

## 快速开始（构建 + 单测）

```sh
npm install                 # 仅需一次
npm run build               # tsc → lib/（host: lib/*.js，browser: lib/client.js）
npm run smoke               # build + 独立冒烟测试（网关+配对闭环，无 harness）
```

## 安装进 DSH Desktop

> ⚠️ **Desktop web profile 的已知限制**：桌面用自带“插件商店/generation”体系管理插件，其 profile
> 里钉了一些**公开 npm 上不存在的版本**（如 `dsh-whale-widget@0.3.0`），因此对桌面 profile 直接
> 执行 `dsh plugin add` / pnpm 会因整树重解析 npmjs 而失败
> （`ERR_PNPM_NO_MATCHING_VERSION dsh-whale-widget@0.3.0`），属正常现象，不会损坏原 profile。
> Desktop 上正确的安装通道是**桌面内置插件管理/市场流程**（generation 安装器）。日常开发请用下方
> **独立 QA profile** 验证，确认稳定后再走发布/市场流程进桌面。

### 快速迭代：独立 QA profile（推荐开发用）

```powershell
# 1) 创建隔离的 QA profile 并装入本插件（首次会联网下载核心 bundles，耐心等）
powershell -ExecutionPolicy Bypass -File "C:\Users\33812\Desktop\dsh-apk\desktop-plugin\scripts\setup-qa-profile.ps1"

# 2) 另开一个终端，保持运行：
$env:DSH_HOME = 'C:\Users\33812\Desktop\dsh-apk\.qa\home'
node 'C:\Users\33812\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js' web --no-open --port 3939

# 3) 浏览器打开 http://127.0.0.1:3939 → 右下角鲸鱼按钮；网关在 http://127.0.0.1:3080（GET /healthz 验证）
```

### Desktop 正式安装（备用记录）

Windows 上 `dsh` 不在 PATH。脚本方式（**先退出 DSH Desktop**）：

```powershell
powershell -ExecutionPolicy Bypass -File "C:\Users\33812\Desktop\dsh-apk\desktop-plugin\scripts\install-to-desktop.ps1"
```

**方式 B（裸命令，等价）**：

```powershell
$env:DSH_HOME = 'C:\Users\33812\AppData\Roaming\dsh-desktop\harness'
node 'C:\Users\33812\AppData\Local\Programs\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh\lib\bin.js' plugin --profile web add link:C:\Users\33812\Desktop\dsh-apk\desktop-plugin
```

> 它本质是 `dsh plugin --profile web add link:<本目录绝对路径>`，只是把 dsh 换成应用内置路径、
> 并显式带上 Desktop 用的 `DSH_HOME`。

然后**重启 DSH Desktop**（`cordis.patch.yml` 的插入行在下次启动生效）。桌面 Web GUI 右下角出现
鲸鱼按钮 → 打开“Remote Gateway”面板 → 选模式 → 生成配对码 → 手机 App 扫码（或输入码）配对。

> Desktop 用户的 profile 在 `%APPDATA%\dsh-desktop\harness\profiles\web`；不用 `dsh plugin` 时也可
> 手动 `pnpm add <path>` 并把它加进该 profile `package.json` 的 `dsh.profile.bundles` + 在
> `cordis.patch.yml` 增加 `- insert: [{id: remote-gateway, name: dsh-remote-phone}]`。
> 若重启后桌面市场注册表把手动加的依赖“修剪”掉，请走桌面内的插件管理/市场流程安装（见上 FAQ）。

## 功能

- **配对**：`POST /api/pair`（桌面控制面，需能力令牌）铸造一次性配对码，默认 10 分钟有效；
  `POST /api/pair/verify` 手机用配对码换 JWT（限流、一次性、单活码）；`POST /api/pair/revoke` /
  `POST /api/rg/revoke-all` 撤销设备。设备会话持久化在 `$DSH_HOME/remote-gateway-devices.json`（0600 原子写）。
- **数据面**（Bearer JWT）：
  - `GET  /api/sessions` 会话列表（标题/时间/运行态，来自官方 `session/list`）
  - `GET  /api/sessions/:id` 会话消息（`session/page` 归一化的 transcript）
  - `POST /api/sessions/:id/message` 发送消息（`session/prompt`，支持 queue/steer 与图片块）
  - `GET  /api/workspaces` 工作区列表（实时缓存官方 `workspace/follow` 流）
  - `POST /api/workspaces/:id/switch` “切换工作区”＝在该工作区打开/复用会话（官方语义，无单一路由）
- **实时** `/ws`（Bearer 或 `?token=`）：gateway 生命周期、`session.*` 事件、设备在线状态、
  工作区变更、审批/提问请求中继（`interaction.request`；决策回 `/api/approvals/:eventId` 或 WS 帧）。
- **两种网络模式**（面板切换，立即生效）：
  - 局域网：网关重绑 `0.0.0.0`，二维码 = `http://<LAN-IP>:3080/pair?code=…`
  - 公网：自动拉取 pinned cloudflared 二进制并 `tunnel --url http://127.0.0.1:<port>`，
    二维码 = `https://<xxx>.trycloudflare.com/pair?code=…`
- **桌面入口**：鲸鱼按钮（右下角悬浮）→ iframe 面板（网关自托管，零 CORS）；能力令牌经官方
  loopback 路由 `/api/remote-gateway/config` 签发（Host/Origin 围栏，仅本机 GUI 可拿到）。

## REST 参考与 WS 协议

见 [`docs/API.md`](docs/API.md)。

## 目录与结构

```
src/
  index.ts         插件入口（name/inject/apply + mount-once）
  config.ts        配置/持久化偏好（$DSH_HOME/remote-gateway.json）
  pairing.ts       配对管理器（一次性码/设备注册表/JWT 校验/撤销/清扫）
  app.ts           GatewayApp 协调器 + 全部 REST/控制路由 + QR
  gateway.ts       自建 HTTP+WS 服务器（精确路由/upgrade/广播/重绑）
  harness.ts       loopback 内凭据 + 官方 RPC 信封 + remote.mux 客户端
  dsh-api.ts       官方会话/消息/工作区/事件 → 网关 DTO 的映射层
  tunnel.ts        cloudflared Quick Tunnel 管理（pinned 校验和/退避重启）
  desktop-probe.ts 官方 webServer 上的桌面配置/能力路由（loopback fence）
  panel.ts/html    （内联在 app.ts）配对面板页面
  client/index.ts  浏览器半区：鲸鱼按钮 + 面板 iframe（零依赖，自注册）
tests/
  standalone-smoke.mjs   独立冒烟（不需要 harness）
```

## 安全模型（要点）

- 数据面每个请求必须 `Authorization: Bearer <JWT>`，设备撤销/过期即时 401（注册表为权威）。
- 铸造/撤销/模式切换等控制面：仅回环源 + 短时**桌面能力令牌**（官方 loopback `/api/remote-gateway/config`
  签发，Host/Origin 围栏；通过 tunnel 进来的公网请求带 `X-Forwarded-For`，不会被当成回环）。
- 配对码 8 位不混淆字符、单活、10 分钟、一次性、5 次失败即废、verify 按 IP 限流。
- 数据面是 harness **官方授权面**的再封装（进程内凭据仅供网关在本机 loopback 兑换），
  撤销立即切断网关侧；无法撤销手机已自行兑换的浏览器凭据（与官方模型一致）。
- 公网 Quick Tunnel 域名每次随机；`cloudflared` 二进制固定版本 + SHA-256 校验后落盘。
- 建议：仅在可信网络开局域网模式；共享电脑优先回环 + 公网隧道。

## 已知边界（诚实清单）

- **消息历史归一化是 best-effort**：官方会话记录含压缩 chunk 与复杂事件，当前 transcript 提供
  `{seq,time,role,kind,text?,toolName?,agentId,raw}` 与 `rawTail`，文本还原对 `user/message`、
  `assistant/message` 完整，chunk 流组装与 tool 调用详情需接真实会话数据校验（阶段二联调项）。
- **审批/提问中继**：`interaction.request` 仅在“有手机在线 + 应答超时自动 `next` 委托”时消费；
  与桌面 UI 并存的行为需真实 harness 验证（默认安全：不越权自动批准）。
- **工作区“切换”**官方无单一路由，语义=在该工作区打开会话（详见 API 文档）。
- 局域网绑定变化、隧道 URL 变化通过广播与面板轮询呈现；Windows 防火墙入站规则未自动管理
  （系统会弹窗询问，选择“允许”即可；有管理员权限时可加 netsh 规则）。
- 二维码 UI 里的鲸鱼为自绘占位图，可自行替换为正式品牌素材。

## Roadmap（后续）

- 阶段二：Android APK 消费本协议（扫码 → JWT → REST/WS 控制）。
- 真实 harness 上的端到端联调：历史重建、审批中继、多客户端 waterfall 行为校准。
- Windows 防火墙规则管理、命名隧道（自有域名）模式、固定域名中继。
- 配置项落官方设置面（settings schema 卡片）。
