# dsh-apk — DSH 远程控制（插件 + 手机 App）

目标：从手机远程连接并控制本机运行的 DeepSeek Harness（DSH）。

```
dsh-apk/
├── desktop-plugin/   # 阶段一：DSH 插件 dsh-remote-phone（Remote Gateway）—— REST/WS + 配对/JWT + 隧道
├── android-app/      # 阶段二：Android APK（Kotlin + Compose 原生 UI，非镜像桌面界面）
├── dist/             # 构建产物（dsh-remote-1.0.0.apk，供手机下载）
├── tools/            # 工具链：SDK/模拟器、构建-安装-运行、一键 E2E、APK 分发、调试签名
├── PUBLISH.md        # 发布指南：npm + 插件市场收录 + APK 分发
└── upstream/         # 参考实现源码（@linxin666/dsh-remote-web-ui，Apache-2.0，从 npm 取源）
```

> npm 包名：`dsh-remote`、`dsh-remote-gateway`、`dsh-mobile`、`dsh-pocket` 等均已被他人占用，
> 因此插件发布名取 **`dsh-remote-phone`**（App 显示名仍是 DSH Remote）。详见 [PUBLISH.md](PUBLISH.md)。

## 当前状态

| 部分 | 状态 |
|---|---|
| `desktop-plugin`（自研插件） | ✅ 完成：3080 网关 + 配对码→JWT + 设备撤销 + 会话/消息/工作区 REST + `/ws` + 面板（鲸鱼按钮/二维码/模式切换）；单测 5/5、mock-harness E2E 24/24 断言全绿 |
| `android-app`（原生 App） | ✅ **可正常运行**：配对→会话→详情→发送→实时回复→审批闭环全部在模拟器上验证通过；**v2 界面**按用户要求仿照 [`DeepSeek-whale-Chat`](https://github.com/thecookfish1201-svg/DeepSeek-whale-Chat)（MIT）的「玻璃拟态 + 立绘」外壳重做（见 `android-app/THIRD-PARTY-NOTICES.txt`） |
| 手机连通 | ✅ 局域网 `10.0.2.2:3080`（模拟器）/ 真机走局域网 IP；公网用 Cloudflare Quick Tunnel（`--protocol http2`、幂等启动、429 冷却） |
| 后台保活 | ✅ `dataSync` 前台服务 + 审批高优先级通知（已验证：App 在后台时 agent 触发审批 → 通知弹出） |

## 阶段一：desktop-plugin（自研网关插件）

一个第三方 DSH 插件（cordis bundle），为自研手机端提供：

- 独立 **HTTP + WebSocket 网关**（默认端口 3080，可配置）；
- 一次性**配对码**（10 分钟有效）→ 换发长期 **JWT**；
- 已配对**设备管理与一键撤销**（持久化到 `$DSH_HOME/remote-gateway-devices.json`）；
- 会话列表 / 会话详情 / 发送消息 / 工作区列表 / 工作区切换的 **REST API**；
- `/ws` 实时事件推送（会话事件、设备在线、审批/提问中继）；
- **局域网 / Cloudflare Quick Tunnel（公网）/ 命名隧道（自有域名）** 三种出口，二维码扫码配对；
- DSH GUI 内的 **鲸鱼按钮 + 配对面板**（模式切换、二维码地址选择、设备列表与撤销）。

细节见 [desktop-plugin/README.md](desktop-plugin/README.md)、`desktop-plugin/docs/API.md`、
`desktop-plugin/docs/ARCHITECTURE.md`。

## 阶段二：android-app（Kotlin + Compose 原生 UI）

**不是**镜像电脑上的 DSH 界面：手机端是一套全新设计的原生 UI，连接只用于取内容/取历史/发指令/收实时事件。

- 首次启动 → 配对（扫码 ZXing 或粘贴配对链接；也支持 `adb --es dsh_pair_link` 直接配对）
- 主界面三 Tab：**会话**（工作区筛选 chip / ＋新建 / 下拉刷新 / 运行中徽标）、**工作区**、**设置**
- 会话详情：时间线（用户/助手/推理/工具/错误）、"加载更早的消息"、输入栏（`queue` 默认）、审批卡片
- 应用级单连接 `RemoteConnection`（指数退避 1s→30s）+ `dataSync` 前台服务保活 + 审批通知
- WebView 兼容模式保留在设置里（`WebViewActivity`），两边共用同一份配对凭据

开发循环（模拟器已内置于 `.toolchain/`）：

```powershell
# 1) 启动模拟器（首次会建 AVD，1-2 分钟）
powershell -ExecutionPolicy Bypass -File tools\emulator.ps1 -Run
# 2) 改完代码：构建 + 安装 + 启动
powershell -ExecutionPolicy Bypass -File tools\dev-run.ps1
# 3) 一键端到端验证（配对→列表→进会话→发送→等回复→＋新建会话）
powershell -ExecutionPolicy Bypass -File tools\e2e-app.ps1
# 4) 审批闭环验证（真实审批→冷启动看卡片→点允许一次→确认 harness 真的执行）
powershell -ExecutionPolicy Bypass -File tools\e2e-approval.ps1
```

细节见 [android-app/README.md](android-app/README.md)、`android-app/docs/FRAMEWORK.md`。

## 后续

1. M5 视觉精修（品牌色/字体/图标/启动页/动效/深浅色）—— 由你确认细节后开始
2. 离线可读：Room 缓存最近拉到的会话与消息
3. 凭据加密（EncryptedSharedPreferences）+ 设置页设备撤销入口
4. 可选：把自研网关插件与上游镜像插件的配对/隧道能力合并为单一插件
