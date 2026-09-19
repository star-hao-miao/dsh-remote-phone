# DSH Remote（Android 原生客户端）

手机端是一套**原生 UI**（Kotlin + Jetpack Compose），**不镜像**电脑上的 DSH 界面：
连接只用于取内容 / 取历史 / 发指令 / 收实时事件（走本仓库 `desktop-plugin` 的 REST + `/ws`）。

**v2 外观**：按你的要求整体仿照 GitHub 项目
[`thecookfish1201-svg/DeepSeek-whale-Chat`](https://github.com/thecookfish1201-svg/DeepSeek-whale-Chat)（MIT）——**玻璃拟态 + 立绘驱动**。
它的配色变量、卡片/气泡/输入栏尺寸、顶栏与抽屉结构被 1:1 搬到 Compose；10 张鲸鱼娘立绘（按情绪切换）
随包分发，署名与完整许可见 `THIRD-PARTY-NOTICES.txt`。

```
顶栏（标题 + 会话抽屉 + 设置抽屉）
立绘层（鲸鱼娘：随状态切换表情，可点、可调不透明度、可关闭）
玻璃聊天卡片（会话标题 / 刷新 / 消息时间线 / 审批卡片 / 输入栏 + 渐变发送键）
左抽屉 = 会话列表（工作区筛选 chip、＋新会话）
右抽屉 = 设置（连接 / 工作区 / 外观 / 设备 / 兼容模式）
```

## 当前能力

- **配对**：扫码（ZXing 内嵌）或粘贴配对链接；也支持 `adb --es dsh_pair_link "<url>"` 直接配对；
  凭据存 SharedPreferences（`dsh_remote_gateway`），`unauthorized` 时自动解除配对
- **会话**：启动自动打开最近一个会话；左侧抽屉按工作区筛选、一键新建会话、运行中徽标
- **详情**：时间线（用户 / 助手 / 推理 / 工具调用 / 错误）、"加载更早的消息"（`beforeSeq` 翻页）、
  输入栏（`queue` 模式，排队不打断当前回合）、审批卡片（允许一次 / 拒绝）
- **实时**：应用级单连接 `RemoteConnection`（指数退避 1s→30s）+ 节流 1s 的历史刷新；
  发送后本地回显保留到权威消息出现
- **立绘情绪**：思考中（agent 在跑）/ 待处理（有审批或提问）/ 未连接 / 开心（刚回复）/ 发送失败（红圈脉冲）
- **后台**：`dataSync` 前台服务保活；审批到达时高优先级通知，点通知直达对应会话；
  App 冷启动后用 `hello` 帧里的未处理审批补回卡片
- **外观**：主题（跟随系统 / 亮 / 暗）、字号（小 / 标准 / 大）、立绘显示开关与不透明度

架构与里程碑见 `docs/FRAMEWORK.md`。

## 环境要求

- 本仓库已内置工具链：`.toolchain\jdk21` + `gradle-8.11.1` + `android-sdk`（platform 35 / build-tools 35 / 模拟器）
- 或使用 Android Studio（自带 JDK 21 与 SDK）
- 手机 Android 8.0（API 26）及以上；targetSdk 35

## 日常预览与开发循环（本机已配好工具链）

```powershell
# ① 打开"电脑里的手机"（模拟器）+ 编译安装启动 App —— 一条命令
powershell -ExecutionPolicy Bypass -File C:\Users\33812\Desktop\dsh-apk\tools\emulator.ps1 -Run

# ② 之后改完代码，只重编译+安装+启动（约 1 分钟）
powershell -ExecutionPolicy Bypass -File C:\Users\33812\Desktop\dsh-apk\tools\dev-run.ps1

# ③ 只是再打开 App（不重编译，几秒）
powershell -ExecutionPolicy Bypass -File C:\Users\33812\Desktop\dsh-apk\tools\dev-run.ps1 -NoBuild

# ④ 一键端到端验证（配对→外壳结构→抽屉→发送→等回复→新会话）
powershell -ExecutionPolicy Bypass -File C:\Users\33812\Desktop\dsh-apk\tools\e2e-app.ps1

# ⑤ 审批闭环验证（触发真实审批→冷启动看卡片→点"允许一次"→确认 harness 真的执行了）
powershell -ExecutionPolicy Bypass -File C:\Users\33812\Desktop\dsh-apk\tools\e2e-approval.ps1

# ⑥ 关闭模拟器：直接关窗口，或
& C:\Users\33812\Desktop\dsh-apk\.toolchain\android-sdk\platform-tools\adb.exe -s emulator-5554 emu kill
```

> ⚠️ 模拟器必须由**你自己的终端**启动：编码代理（DSH）的 shell 进程树在命令结束后会被回收，
> 模拟器/隧道这类长驻进程活不下来（任务计划程序也被沙箱禁止）。

> ⌨️ **电脑键盘打字没反应？** 这是模拟器配置，不是 App 的问题：`avdmanager` 建出来的 AVD 默认
> `hw.keyboard = no`，即不把宿主机键盘转发给 Android，只能用模拟器自带软键盘。
> `tools/emulator.ps1` 现在每次启动前都会自动改成 `yes`（重启模拟器后生效）；真机不受影响。

**调试签名**：默认调试 keystore 在 `%USERPROFILE%\.android`（工作区外，沙箱/CI 用不了）。
`app/build.gradle.kts` 优先使用仓库内的 `android-app/debug.keystore`，
用 `tools\make-debug-keystore.ps1` 生成（无 BOM 的 JKS，密码 `android`，仅用于 debug）。

**真机镜像（可选）**：手机用 USB 连接并开启「USB 调试」后，运行
`.toolchain\scrcpy\scrcpy-win64-v4.1\scrcpy.exe`，即可把真机画面镜像到电脑窗口并用鼠标操作；
配套 `dev-run.ps1 -Serial <真机序列号>` 是同一套安装循环。

## 构建（其他环境）

**方式 A：Android Studio（推荐）**

1. Android Studio → Open → 选择本目录 `android-app/`
2. 首次会自动下载 Gradle 与依赖（需要能访问 Google Maven；网络受限时可换国内镜像，见下）
3. 连接手机 → Run ▶；或 Build → Build Bundle(s)/APK(s) → Build APK(s)
4. 产物：`app/build/outputs/apk/debug/app-debug.apk`，传到手机安装即可

**方式 B：命令行（需自行安装 Gradle 8.9+ 与 Android SDK）**

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
gradle -p android-app :app:assembleDebug
```

国内网络受限时，可在 `settings.gradle.kts` 的仓库列表里加入镜像（阿里云等），例如
`maven("https://maven.aliyun.com/repository/google")`。

## 配对流程

1. 电脑上打开 DSH 的远程面板（GUI 里的鲸鱼按钮），生成二维码（局域网码或公网码）
2. 手机 App 首次启动 → 扫码（或粘贴配对链接）→ 自动完成配对并进入会话
3. 之后直接启动 App 即回到最近一个会话；换电脑/被撤销时重新扫码即可（`unauthorized` 会自动退回配对页）

## 后续

- 离线可读：Room 缓存最近拉到的会话与消息
- 凭据加密（EncryptedSharedPreferences）+ 设置抽屉里的设备撤销入口
- 立绘表情再细化（长任务"忙碌"、空闲"发呆"等），按你的偏好调整出现规则

## 踩坑记录（重要，别再犯）

**targetSdk 35 强制 edge-to-edge**：Android 15 起 `setDecorFitsSystemWindows(true)` 是空操作，
界面会画到状态栏/导航栏下面——顶栏点不动（点到了系统状态栏）、发送键压在导航栏上。
根容器必须自己加 `Modifier.windowInsetsPadding(WindowInsets.safeDrawing)`（背景仍铺满整窗）。

**OkHttp 的 `pingInterval` 会在对端消失时杀掉进程。** 电脑端网关停机后约 20 秒 App 崩溃：

```
FATAL EXCEPTION: main
sun.net.ConnectionResetException: Connection reset
  at java.net.SocketOutputStream.socketWrite0(Native Method)
  at okhttp3.internal.ws.RealWebSocket$initReaderAndWriter$lambda$3$$inlined$schedule$1.runOnce
```

原因：`pingInterval` 让 OkHttp 在自己的 task-runner 线程上写 ping 帧，连接已被 RST 时异常**不会**走到
`WebSocketListener.onFailure`，而是冒泡成未捕获异常 → Android 直接杀进程。

处理（已在代码里落实，实测 crash buffer 干净、离线时 App 存活）：

1. `GatewayApi.defaultClient()` **不使用** `pingInterval`；
2. 保活改成应用层心跳：客户端每 20s 发 `{"type":"ping"}`（网关会回 `pong`），并且用 `runCatching` 包裹；
3. `GatewaySocket` 的 `onOpen/onMessage/onFailure/onClosed` 与 `send` 全部 `runCatching`；
4. 重连循环（现在在 `RemoteConnection` 里）用 `runCatching` 包住 `collect{}`，断开后置 Offline 并指数退避重试。

**时间线刷新是"前沿节流 + 一次尾随"**（最少间隔 1s）：`session.activity` 在流式输出时每条记录都会推一次，
逐条拉历史会把 harness 打爆。

**本地回显不能一见刷新就丢**：`queue` 模式的消息在 harness 日志里要等当前回合结束才出现，
所以"刷新即丢弃 pending"会让刚发出的气泡消失几分钟。现在的规则是：直到权威消息出现（或 120s 超时）才丢。

**"今天"这类中文匹配要按整词**：`前` 也出现在工作区 chip 的「当**前**」里，
自动化脚本用**相对时间**（刚刚/分钟前/小时前/天前）定位会话行，否则会点到筛选 chip。

**其他环境坑**：Android 工具链的 `HOME`/`ANDROID_AVD_HOME`/`ANDROID_USER_HOME` 必须指向工作区内
（否则沙箱拒绝写 `%USERPROFILE%\.android`，模拟器会卡在锁文件重试、永远不开 adb 端口）；但 Gradle/AGP
**不能**继承被改过的 `HOME`（会在 `AndroidDirectoryCreator` 失败），所以 `dev-run.ps1` 里把它删掉。

**自动化脚本本身的两个坑**（`tools/*.ps1`，Windows PowerShell 5.1）：

- 无 BOM 的 UTF-8 `.ps1` 会被按 ANSI 代码页读取 → 脚本里的中文**字面量**会变成乱码、匹配不上；
  所以脚本统一用码点构造中文（`[char]0x53D1 + [char]0x9001`）。
- `uiautomator dump` 在界面动画时会失败，并且**保留上一次的文件** → 直接 pull 会拿到过期画面；
  必须用每次唯一的远端路径 + `rm -f` + 重试（`DumpUi` 就是这么做的）。

