# 发布指南（dsh-remote-phone + APK）

这份文档是给**你自己动手发布**用的：电脑端插件走 npm + DSH 插件市场，手机端 APK 走 GitHub Release。
所有命令都在本机验证过。

---

## 0. 名字：为什么不是 `dsh-remote`

`dsh-remote` 在 npm 上**已经被占用**（2026-09 实测），而且是同一类插件：

| 包名 | 状态 | 说明 |
|---|---|---|
| `dsh-remote` | ❌ 已占用 | flymysql/[dsh-remote](https://github.com/flymysql/dsh-remote) 0.8.18 —— SSH 连远程主机 + `rw_*` 工具 |
| `dsh-remote-gateway` | ❌ 已占用 | xinzang0 0.2.0 —— 设备审批面板（我们原来的名字也在里面） |
| `dsh-mobile` | ❌ 已占用 | saya-ch 0.4.2 —— 手机适配 + 局域网/远程访问 |
| `dsh-pocket` | ❌ 已占用 | leachzhou 2.10.6 —— 手机扫码同步访问 |
| `dsh-remote-mobile` | ❌ 已占用 | april1993 1.7.0 —— 远程/移动端安全网关 |
| `dsh-bridge` / `dsh-link` | ❌ 已占用 | 手机扫码/浏览器接管方向 |
| **`dsh-remote-phone`** | ✅ **可用（本仓库已改）** | 语义清楚：手机端远程控制 |
| `dsh-phone` / `dsh-remote-app` / `dsh-remote-control` | ✅ 可用 | 备选名 |

> 如果以后想直接用 `dsh-remote` 这个名字，可以发**带 scope 的包**：`@你的npm用户名/dsh-remote` ——
> scope 下的名字不会和任何人冲突（上游那种 `@linxin666/dsh-remote-web-ui` 就是这么做的）。

**市场里已经有 4 个同类竞品**（都是"手机访问电脑上的 DSH"）。我们的差异点是：
**原生 Android App + 立绘 UI + 审批闭环（可以在手机上放行工具调用）**，不是"手机浏览器镜像桌面 Web UI"。
描述里要把这点写实、写准——市场评审会拿描述逐条对代码。

---

## 1. 电脑端插件：发布到 npm

### 1.1 先改三个占位符（`desktop-plugin/package.json`）

```jsonc
"author": "你的名字",
"repository": { "type": "git", "url": "git+https://github.com/你的账号/dsh-remote.git" },
"homepage": "https://github.com/你的账号/dsh-remote#readme",
"bugs": { "url": "https://github.com/你的账号/dsh-remote/issues" }
```

`repository` 必须指向**你在市场条目里登记的那个仓库**，否则 npm 包与仓库不会关联（市场靠这个字段关联，不能手写进 yml）。

### 1.2 检查包里有什么

```powershell
cd C:\Users\33812\Desktop\dsh-apk\desktop-plugin
$env:npm_config_cache = 'C:\Users\33812\Desktop\dsh-apk\.toolchain\npm-cache'   # 沙箱/受限环境需要
npm pack --dry-run
```

当前产物：`dsh-remote-phone-1.0.0.tgz`，83.9 kB，50 个文件（`lib/` + `cordis.patch.yml` + README/LICENSE）。
`package.json` 里的 `files` 已经限定，不会把源码/测试发上去。

### 1.3 发布

```powershell
npm login                 # 第一次：注册 https://www.npmjs.com/signup 然后登录
npm publish               # 公共包，免费
npm view dsh-remote-phone # 确认发布成功
```

以后改版本：`npm version patch|minor|major` 然后 `npm publish`。

### 1.4 装到自己的 DSH 里（不走市场也能装）

```powershell
dsh plugin add dsh-remote-phone
# 或在某个 profile 里：dsh plugin --profile web add dsh-remote-phone
```

装完重启 DSH，Web GUI 右下角会出现鲸鱼按钮 → 打开面板 → 生成配对码。

> 本机 QA 环境已经用 `link:` 方式装好了（`desktop-plugin\scripts\setup-qa-profile.ps1`），
> 开发时不用发 npm，改完代码重启 harness 就是最新版。

---

## 2. 进市场（`awesome-dsh-plugin`）

市场是**收录制**，不是"发到 npm 就自动出现"。收录入口：
[awesome-dsh-plugin/awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
（[contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/HEAD/contributing.md)）。

### 2.1 前置条件（评审会逐条查）

1. **GitHub 仓库**，且 `package.json` 里有 `dsh.bundle`（我们已经有 ✅，只有 `dsh.client` 会被打回）；
2. 仓库**创建满 1 天**；
3. 仓库加 `dsh-plugin` topic；
4. 有真实可用的代码（不是占位/纯 README）；
5. 描述**必须属实**：写了什么功能，代码里就得有。

### 2.2 提一个 PR，只加一个文件

`data/plugins/<你的账号>__dsh-remote.yml`：

```yaml
url: https://github.com/你的账号/dsh-remote
name: 你的账号/dsh-remote
category: remote          # 可用分类见 contributing.md，我们属于 remote
description:
  en: Control the DeepSeek Harness on your PC from a native Android app over LAN or a Cloudflare tunnel; one-time pairing code, sessions and approvals on the phone.
  zh: 用原生安卓 App 通过局域网或 Cloudflare 隧道远程控制电脑上的 DeepSeek Harness：一次性配对码、手机上看会话与审批。
```

> 描述里出现 `: `（冒号+空格）时必须给整行加引号，否则 YAML 解析失败。

一个 PR 最多 3 条；只改自己那一条（别动别人的）。CI 会检查 manifest、仓库年龄、格式。

### 2.3 可选但推荐

- **截图**：仓库里放 `screenshots.json`（1–8 张，相对路径），市场详情页会像 App Store 一样展示
  —— 我们有立绘 UI，放两张截图很占便宜；
- **APK**：把 APK 附到 GitHub Release，市场会展示下载入口；
- npm 包的 `repository` 指回同一仓库，市场才会显示下载量。

---

## 3. 手机端 APK：让手机下载

APK 已经构建好并放在 `dist\dsh-remote-1.0.0.apk`（25 MB，v1.0.0 / versionCode 3）。

### 方式 A：局域网直连（最快，推荐）

在**你自己的终端**里跑（长驻进程，编码代理的 shell 会被回收）：

```powershell
# 只开本地 HTTP（不开隧道）——手机需与电脑同一个 Wi-Fi
node tools\serve-apk.mjs dist\dsh-remote-1.0.0.apk 8099 --no-tunnel
```

脚本会打印形如 `http://192.168.x.x:8099/` 的地址；手机浏览器打开它 → 点"点击下载 APK"。
（第一次装需要在手机上允许"安装未知来源应用"。）

### 方式 B：临时公网链接（不在同一网络时）

```powershell
node tools\serve-apk.mjs dist\dsh-remote-1.0.0.apk 8099
```

会额外起一个 Cloudflare Quick Tunnel，打印 `https://xxx.trycloudflare.com/`，手机在任何网络都能下。

### 方式 C：USB 直装 / 转发

```powershell
adb install -r dist\dsh-remote-1.0.0.apk
# 或者
& .toolchain\android-sdk\platform-tools\adb.exe -s <设备序列号> install -r dist\dsh-remote-1.0.0.apk
```

### 方式 D：发 GitHub Release（长期方案）

把 APK 传到仓库 Release（资产名不要带版本号，或用固定 tag，否则市场里的链接会随下次发版 404）。

---

## 4. 发布检查清单

- [ ] `package.json` 的 author/repository/homepage/bugs 已填真实信息
- [ ] `npm view dsh-remote-phone` 能看到 1.0.0（名字没被抢）
- [ ] GitHub 仓库已建 ≥1 天、带 `dsh-plugin` topic、`dsh.bundle` 在 package.json 里
- [ ] README 里有：装法、配对截图、（可选）APK 下载方式
- [ ] `screenshots.json`（可选）
- [ ] 提交 `data/plugins/<owner>__dsh-remote.yml` 的 PR
- [ ] APK 传到 `dist/` 或 Release，并在 README 写明下载入口
