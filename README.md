# DSH Remote · 用手机远程控制电脑上的 DeepSeek Harness

> **DSH Remote — control the DeepSeek Harness running on your PC from a native Android app.**
> 一个仓库，两件东西：一个 **DSH 桌面插件**（网关 / 配对 / 隧道）和一个 **原生 Android App**（立绘聊天界面）。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Plugin](https://img.shields.io/badge/npm-dsh--remote--phone-cb3837.svg)](https://www.npmjs.com/package/dsh-remote-phone)
[![Android](https://img.shields.io/badge/Android-8.0%2B%20(API%2026)-3ddc84.svg)](#2-装-apk)

出门在外，想让电脑上的 agent 继续干活、想知道它卡在哪、想批准一个工具调用？
装上这个插件 + App：**扫一次码，手机就能看会话、读历史、发指令、实时收回复，并直接在手机上放行审批。**

```
┌──────────────┐        局域网 / Cloudflare 隧道        ┌───────────────────────┐
│  Android App │  ───────────────────────────────────▶  │  DSH 桌面插件（网关）  │
│  DSH Remote  │   REST: 会话/历史/发送/审批             │   dsh-remote-phone    │
│  (Compose)   │   WS:   实时事件 / 审批推送             │   127.0.0.1:3080      │
└──────────────┘  ◀───────────────────────────────────  └───────────┬───────────┘
                                                                     │ 本机回环 RPC
                                                                     ▼
                                                       ┌───────────────────────┐
                                                       │  DeepSeek Harness     │
                                                       └───────────────────────┘
```

## 目录

- [这是什么](#这是什么)
- [功能特性](#功能特性)
- [快速开始](#快速开始)：[① 装插件](#1-装插件) · [② 装 APK](#2-装-apk) · [③ 配对](#3-配对)
- [仓库结构](#仓库结构)
- [开发与验证](#开发与验证)
- [常见问题](#常见问题)
- [安全说明](#安全说明)
- [许可与致谢](#许可与致谢)

## 这是什么

| 组件 | 是什么 | 目录 |
|---|---|---|
| **DSH 桌面插件** | 官方没有开放的"远程数据面"：本插件在 Harness 里起一个**独立的 HTTP + WebSocket 网关**（默认 `3080`），用**一次性配对码 → 长期 JWT** 鉴权，把会话、历史、工作区、审批安全地开放给手机。同时提供局域网/公网两种出口与 DSH GUI 内的配对面板。 | [`desktop-plugin/`](desktop-plugin/) |
| **Android App** | **不是**把桌面网页塞进 WebView 的镜像壳，而是一套**原生 Compose 界面**：顶栏 + 立绘层 + 玻璃聊天卡片 + 左右抽屉。连接只用来取内容、发指令、收事件。 | [`android-app/`](android-app/) |

手机端刻意没有复刻桌面 UI：手机上要的是"看一眼就懂、点一下就发、审批不漏"，所以界面按聊天软件来设计，
并让立绘随状态切换表情（思考中 / 待处理 / 未连接 / 刚回复 / 发送失败）。

## 功能特性

**手机端（Android App）**

- **配对**：扫码（内嵌 ZXing）或粘贴配对链接；也支持 `adb --es dsh_pair_link "<url>"` 一键配对
- **会话抽屉**：按**工作区分组**（工作区数据缺失时按目录兜底），可筛选、可**删除**对话、可一键新建
- **聊天卡片**：时间线（用户 / 助手 / 推理 / 工具调用 / 错误）、"加载更早的消息"（游标翻页）、`queue` 模式发送（排队不打断当前回合）
- **审批卡片**：工具审批 / 提问直接显示在会话里，"允许一次 / 拒绝"点一下就把决定回传给电脑
- **后台保活**：`dataSync` 前台服务保持连接；审批到达时弹**高优先级通知**，点通知直达对应会话
- **实时**：应用级单连接（指数退避 1s→30s）+ 节流刷新；发送后本地回显保留到权威消息出现
- **外观**：主题（跟随系统 / 亮 / 暗）、字号（小 / 标准 / 大）、立绘显示与不透明度

**电脑端（DSH 插件）**

- 独立 **HTTP + WebSocket 网关**（默认端口 `3080`，可配置）
- 一次性**配对码**（10 分钟有效）→ 换发长期 **JWT**；已配对设备列表 + **一键撤销**
- REST：会话列表 / 会话详情（含 `beforeSeq` 翻页、`?limit=`、`?raw=1`）/ 发送消息 / 新建会话 / 删除会话 / 工作区列表与切换
- `/ws`：会话状态与活动、工作区变更、**审批与提问中继**（`hello` 帧还会带上未处理请求，App 冷启动不会漏）
- **三种出口**：局域网直连、**Cloudflare Quick Tunnel**（免账号，公网可扫）、命名隧道（自有域名）
- DSH GUI 内的**鲸鱼按钮 + 配对面板**：二维码、模式切换、设备列表与撤销

## 快速开始

### 1. 装插件

```bash
# 从 npm 安装（推荐）
dsh plugin add dsh-remote-phone

# 或指定 profile
dsh plugin --profile web add dsh-remote-phone
```

装完**重启 DSH**，Web GUI 右下角会出现**鲸鱼按钮** → 打开配对面板。

> 开发时也可以直接从源码装：`dsh plugin add link:/path/to/desktop-plugin`（见 [`desktop-plugin/scripts/setup-qa-profile.ps1`](desktop-plugin/scripts/setup-qa-profile.ps1)）。
> 仓库尚未在插件市场上架，上架流程见 [`PUBLISH.md`](PUBLISH.md)。

### 2. 装 APK

**方式 A：下载现成 APK** —— 从 [Releases](../../releases) 下载 `dsh-remote-<版本>.apk`，传到手机安装
（首次安装需允许"安装未知来源应用"）。

**方式 B：局域网直传** —— 电脑上执行：

```bash
node tools/serve-apk.mjs dist/dsh-remote-1.0.0.apk 8099 --no-tunnel
```

脚本会打印形如 `http://192.168.x.x:8099/` 的地址，**手机浏览器打开即可下载**（去掉 `--no-tunnel` 会额外起一条
Cloudflare 临时公网链接，不在同一网络时用）。

**方式 C：USB 直装** —— `adb install -r dist/dsh-remote-1.0.0.apk`

**方式 D：自己从源码构建**（仓库里 `dist/` 没有 APK 时用这个）

```powershell
# 工具链（JDK 21 + Gradle + Android SDK + 模拟器）装在 .toolchain/，不需要 Android Studio
powershell -ExecutionPolicy Bypass -File tools\emulator.ps1 -Run   # 启动模拟器并安装
powershell -ExecutionPolicy Bypass -File tools\dev-run.ps1         # 只构建 + 安装 + 启动
# 产物：android-app\app\build\outputs\apk\debug\app-debug.apk
```

### 3. 配对

1. 电脑：点 DSH 界面右下角**鲸鱼按钮** → 打开配对面板 → 选择「局域网码」或「公网码」→ 生成二维码
2. 手机：打开 App → **扫码**（或粘贴配对链接）→ 自动进入会话列表
3. 之后直接启动 App 即回到最近一个会话；被撤销或换电脑时重新扫一次即可

> 手机端和电脑端**共用同一份配对凭据**：电脑上面板里的"我的设备"可以随时撤销任意一台手机。

## 仓库结构

```
dsh-apk/
├── desktop-plugin/     # DSH 插件 dsh-remote-phone（TypeScript，零运行时依赖外的 ws/qrcode）
│   ├── src/            #   网关 / 配对 / 官方 RPC 适配 / 隧道 / 桌面探针
│   ├── docs/API.md     #   REST + WS 接口契约（含字段级说明与踩坑记录）
│   ├── docs/ARCHITECTURE.md
│   └── tests/          #   单测 + 独立冒烟 + mock-harness 端到端（26 项断言）
├── android-app/        # Android App（Kotlin + Compose，Material 3）
│   ├── app/src/main/java/com/dsh/remote/
│   │   ├── data/       #   凭据、外观设置、REST/WS 客户端、应用级连接
│   │   ├── service/    #   前台服务（保活 + 审批通知）
│   │   └── ui/         #   theme / shell（顶栏+抽屉）/ chat / character / pair
│   └── docs/FRAMEWORK.md
├── dist/               # 构建产物（APK）
├── tools/              # 模拟器、构建-安装-运行、一键端到端验证、APK 分发、调试签名
├── PUBLISH.md          # 发布指南：npm 发布 + 插件市场收录 + APK 分发
└── upstream/           # 第三方参考源码（Apache-2.0，仅作参照，不参与构建）
```

## 开发与验证

**插件**

```bash
cd desktop-plugin
npm install
npm run build            # tsc（host + client 两个 target）
npm test                 # 单测 + 冒烟 + mock-harness 端到端
```

**App**（本仓库自带工具链，不需要 Android Studio）

```powershell
powershell -ExecutionPolicy Bypass -File tools\emulator.ps1 -Run   # 启动模拟器并安装
powershell -ExecutionPolicy Bypass -File tools\dev-run.ps1         # 改完代码：构建+安装+启动
powershell -ExecutionPolicy Bypass -File tools\e2e-app.ps1         # 端到端：配对→抽屉→发送→回复→新建
powershell -ExecutionPolicy Bypass -File tools\e2e-approval.ps1    # 审批闭环：真实审批→冷启动看卡片→放行→工具真的执行
```

两个脚本是**真机（模拟器）+ 真实 harness** 的黑盒验证：它们用 `adb` 驱动界面、用 REST 校验结果，
因此每次改动都能确认"手机真的能用"。详见 [android-app/README.md](android-app/README.md)。

## 常见问题

**手机上看到的会话和电脑上不是同一批？**
它们可能来自**不同的 DSH 实例**（不同 `DSH_HOME` 就是两个互不相干的会话库）。手机看到的是它所连网关背后那个实例的数据。

**手机上下载/连接不上？**
先确认手机和电脑在同一网络，并检查电脑的防火墙是否放行网关端口（默认 `3080`）与分发端口。
不在同一网络时用面板里的「公网码」（Cloudflare 隧道）。

**电脑键盘在模拟器里打不了字？**
这是模拟器配置：`avdmanager` 建的 AVD 默认 `hw.keyboard = no`（不转发宿主键盘）。`tools/emulator.ps1`
每次启动前会自动改成 `yes`；真机不受影响。

**手机上删掉的对话，工作区文件会没吗？**
不会。删除只清掉该会话的记录（官方 `session/delete` 语义：保留工作区文件）。正在运行的会话会被拒绝删除。

## 安全说明

- 配对码**一次性 + 10 分钟有效**，用掉即失效；换取的是长期 JWT，可随时在电脑面板里**撤销**
- 网关默认**只绑 `127.0.0.1`**；要局域网访问需显式开启，公网则走隧道（每条隧道链接都是一次性的随机域名）
- 审批/提问走的是**你自己电脑上的决定**：手机只是把决定回传，不绕过 Harness 的权限模型
- 手机端凭据存在应用私有 SharedPreferences 中（后续计划迁移到 EncryptedSharedPreferences）

## 许可与致谢

- 本项目：[MIT](LICENSE)
- 手机端界面参考并改编自 [**DeepSeek-whale-Chat**](https://github.com/thecookfish1201-svg/DeepSeek-whale-Chat)（MIT，Copyright © 2026 Pisciculus）
  —— 玻璃拟态配色、卡片/气泡/输入栏尺寸、顶栏与抽屉结构，以及 10 张鲸鱼娘立绘均来自该项目，
  署名与完整许可见 [`android-app/THIRD-PARTY-NOTICES.txt`](android-app/THIRD-PARTY-NOTICES.txt)
- 早期调研参考了 [@linxin666/dsh-remote-web-ui](https://www.npmjs.com/package/@linxin666/dsh-remote-web-ui)（Apache-2.0），源码留在 `upstream/` 仅作对照

---

如果这个项目对你有用，欢迎 Star ⭐；装插件遇到问题，开 issue 时请附上 `DSH` 版本与网关日志。
