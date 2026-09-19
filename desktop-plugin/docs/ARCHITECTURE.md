# 架构说明（基于本机 DSH Desktop 0.7.2 实测）

## 1. 背景：这台机器上已经有什么

- **DSH Desktop v0.7.2 原生“Connect Phone…”**：主进程内置 QR 配对 + 局域网/Cloudflare Quick Tunnel
  （打包产物 `out/main/index.js` 内含 `qrcode`/`ws`/cloudflared 下载与 pairing 页面）。协议封闭，面向
  官方 Web GUI 的“手机=另一个浏览器”模型。
- **已安装第三方插件 `@linxin666/dsh-remote-web-ui`（当前停用）**：完整实现了扫码配对 + 门控 `/remote`
  通道 + 局域网绑定 + 隧道 + 设备撤销 + 移动端 UI 适配。同样是“镜像官方 GUI”路线。
- 你的目标不同：**给自研 APK 一套干净 JSON REST/WS 控制面**。因此本插件不与上述两者冲突。

## 2. 本插件在两进程中的形态（“双半区”）

| 半区 | 运行位置 | 入口 | 职责 |
|---|---|---|---|
| host | harness 进程（Node，桌面 web profile 内） | `lib/index.js` 导出 `{name,inject,apply}` | 配对/JWT、独立 3080 网关、隧道、官方 loopback 数据面、webServer 桌面探测路由 |
| browser | 官方 Web GUI 页面（浏览器） | `lib/client.js`（`window.__ModuleLoader__.load({id,factory})` 自注册，导出 `{inject:[], apply}`） | 右下角鲸鱼按钮 + 面板 iframe |

装载链（对齐官方机制，出处见下）：包 `package.json` 的 `dsh.bundle.patch` 把 `cordis.patch.yml`
插进 profile 补丁层 → loader 把 `{id:'remote-gateway', name:'dsh-remote-phone'}` 作为插件行装载
host 半区；host 半区的 `dsh.client{platform:'web'}` 元数据被 client-modules 扫描，浏览器端以
`window.__ModuleLoader__.load` 注册浏览器半区。

> 与你在原方案里提到的“注册 ApiProxy 注入点”的差异：0.1.2-alpha.2 官方运行时**无人发射
> `api/gate`**（`dsh-host-apiproxy` 也不存在）。等效替代 = ①host 插件注入 `webServer`/`connection`
> 等官方服务注册精确路由；②需要“拦 DSH 核心 /api”时，走官方 loopback `/api`（用进程内浏览器凭据
> 兑换）—— 这正是官方生态（remote-web-ui、内置桥）与本案共同采用的现实做法。

## 3. 端口/进程拓扑

```
DSH Desktop
 └─ harness 进程（web profile）
     ├─ 官方 webServer       127.0.0.1:<随机>   （浏览器 GUI + /api）
     ├─ dsh-remote-phone  host 半区
     │    ├─ 独立网关 server  127.0.0.1:3080（可重绑 0.0.0.0）→ /api/pair…/api/sessions…/ws/panel
     │    ├─ cloudflared      （Quick Tunnel，仅在公网模式 spawn）→ 转发到 127.0.0.1:3080
     │    ├─ loopback 客户端   → 官方 webServer /api（RPC 信封）+ /api/remote.mux（事件）
     │    └─ 官方 webServer 上的探测路由 /api/remote-gateway/config（发桌面能力令牌）
     └─ 浏览器 GUI  ← 鲸鱼按钮(client.js) fetch /api/remote-gateway/config → iframe 打开 /panel?cap=
手机 App（阶段二）→ 3080 网关 REST/WS
```

## 4. 关键安全决策

1. **数据面 = 设备 JWT**；撤销即删注册表项，下一请求 401（注册表是权威，光验签名不够）。
2. **控制面 = “桌面能力令牌”**：因为网关在局域网/公网都可达，回环判断不可靠（tunnel 来自
   127.0.0.1 + XFF）。所以控制操作要求短时 `aud=desktop` JWT —— 只能从**官方 webServer** 的
   loopback 路由（`/api/remote-gateway/config`，自带 Host/Origin fence 的拷贝实现）获取。
   公网/局域网浏览器拿不到该令牌 → 控制面永远留在“电脑本机”。
3. **数据面直连官方 /api**：host 内换进程级浏览器凭据（`GET /?token=…` redirect manual 取 cookie，
   语义同 `ctx.connection.authenticatedUrl`）；401 自动失效重换一次。网关侧设备被撤销后，网关不再
   使用该进程内凭据代理任何请求。
4. **配对码**：单活、10min、一次性、5 次错废、按 IP 限流（20 次/10min）。
5. **QR 只含配对信息**：`/pair?code=…`，本身不含任何长期凭据；`verify` 拿到的是带过期时间的 JWT。

## 5. 官方 loopback 协议封装（本插件只信这两处）

官方 Web 前端 ↔ harness 的 wire（依据考古，含 `文件:行号`，见 docs 注释与源码注释）：
- 一元 RPC：`POST /api/<ns>/<method>`，body
  `{"type":"client-request","rpcId","method","payload":{"args":{…}}}`；响应取值 `result.value`。
  本插件用到的：`session/list`（`args:{_request:{}}`）、`session/page`（历史）、`session/prompt`
  （发送）、`session/create`（工作区开会话）、`$events/result`（事件应答）。
- 实时 mux：`ws://127.0.0.1:<port>/api/remote.mux`，文本帧 `open/cancel/item/end/error/ready/emit/
  waterfall`。本插件开两条逻辑流：`workspace/follow`（工作区列表缓存）与 `$events`（会话事件、
  审批/提问中继）。
- 鉴权 cookie：`dsh-auth-<b64url(sha256(authority))>`，由 GET 根路径带 launch token 签发；与
  authority（host:port）绑定，无 loopback 豁免 —— 这正是必须“进程内再兑一次”的原因。
- `dsh-api.ts` 把所有官方值视为 `unknown` 做防御性归一；未来官方升级只改 `harness.ts`/`dsh-api.ts`。

## 6. 诚实边界（v0.1.0）

- 消息历史：`session/page` 记录含压缩 chunkrow 与复杂事件；当前提供 `transcript[]`（含 user/
  assistant 文本完整还原）+ `rawTail`。**chunk 流的逐字组装与 tool call 展示需真实会话数据校准**
  （接入真实 harness 后做，属阶段二联调项）。
- 审批/提问：`interaction.request` 中继仅在“有手机在线”时消费，60s 未决自动 `next` 委托；
  不会越权自动批准。与桌面 UI 的瀑布分发共存行为需真实 harness 验证。
- “切换工作区”官方没有单一路由，语义=进入该工作区（开/复用会话），见 API 文档。
- 局域网开 0.0.0.0 会触发系统防火墙弹窗（用户允许一次）；自动 netsh 规则管理未做（后续里程碑）。
- 鲸鱼图为占位自绘，非官方品牌素材，可替换（`src/asset.ts` / client 内联 SVG）。
- 状态页轮询（2s）+ 事件广播并用；未实现事件源压缩/断线续传（APK 阶段按需补）。

## 7. 后续里程碑

- 阶段二 Android APK：扫码（解析 `/pair?code=`）→ `verify` 换 JWT → REST/WS 控制。
- 真实 harness E2E：历史重建、审批中继校准、多客户端 waterfall、局域网 + 公网全链路回归。
- Windows 防火墙 netsh 规则、命名隧道（自有域名）、固定域名中继、官方设置面 schema 卡片。
