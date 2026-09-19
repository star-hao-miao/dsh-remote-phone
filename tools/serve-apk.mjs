/**
 * serve-apk.mjs - serve the built APK over a temporary public tunnel so the
 * phone can download it without USB or a file-transfer app.
 *
 *   node tools/serve-apk.mjs [apkPath] [port]
 *
 * Starts a local HTTP file server, then runs the pinned cloudflared quick
 * tunnel (`--protocol http2`, matching the plugin's tunnel policy) and prints
 * the public URL. Ctrl+C stops both.
 */

import { createServer } from 'node:http'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { networkInterfaces } from 'node:os'
import { join, basename } from 'node:path'

const apkPath = process.argv[2] ?? join(import.meta.dirname, '..', 'android-app', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
const port = Number(process.argv[3] ?? 8099)

if (!existsSync(apkPath)) {
  console.error(`APK not found: ${apkPath}`)
  process.exit(1)
}
const apkName = basename(apkPath)
const apkSize = statSync(apkPath).size

const candidates = [
  process.env.DSH_HOME ? join(process.env.DSH_HOME, 'remote-gateway', 'cloudflared.exe') : '',
  'C:\\Users\\33812\\Desktop\\dsh-apk\\.qa\\home\\remote-gateway\\cloudflared.exe',
  join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'dsh-cloudflared', 'cloudflared.exe'),
].filter(Boolean)
const cloudflared = candidates.find(path => existsSync(path))
if (cloudflared === undefined) {
  console.error(`cloudflared not found in: ${candidates.join(' | ')}`)
  process.exit(1)
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/' ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<body style="font:15px/1.6 system-ui;padding:24px;background:#101114;color:#eee">` +
        `<h2>DSH Remote APK</h2><p>${apkName} · ${(apkSize / 1048576).toFixed(2)} MB</p>` +
        `<p><a style="color:#7fa0ff;font-size:18px" href="/${apkName}">点击下载 APK</a></p>` +
        `<p style="color:#888;font-size:13px">下载后在手机上允许"安装未知来源应用"即可安装。</p></body>`,
    )
    return
  }
  if (url.pathname === `/${apkName}`) {
    res.writeHead(200, {
      'content-type': 'application/vnd.android.package-archive',
      'content-length': String(apkSize),
      'content-disposition': `attachment; filename="${apkName}"`,
    })
    createReadStream(apkPath).pipe(res)
    return
  }
  res.writeHead(404).end('not found')
})

server.listen(port, '0.0.0.0', () => {
  // Bind every interface: a phone on the same Wi-Fi cannot reach a loopback-only
  // listener, which is exactly how someone ends up with a link that "works" in
  // the PC browser and times out on the phone.
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter(info => info && info.family === 'IPv4' && !info.internal)
    .map(info => info.address)
  console.log(`[serve] 本机:   http://127.0.0.1:${port}/${apkName} (${(apkSize / 1048576).toFixed(2)} MB)`)
  for (const address of lan) {
    console.log(`[serve] 手机:   http://${address}:${port}/          <- 手机浏览器打开这个下载`)
  }
  if (lan.length === 0) console.log('[serve] (no LAN address found - phone must use the tunnel below)')
  if (process.argv.includes('--no-tunnel')) {
    console.log('[serve] tunnel skipped (--no-tunnel)')
    return
  }
  const child = spawn(cloudflared, ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate', '--protocol', 'http2'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let printed = false
  const scan = (chunk) => {
    const text = chunk.toString()
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/i)
    if (match && !printed) {
      printed = true
      console.log(`\n[public] ${match[0]}/          <- 手机浏览器打开这个地址下载\n`)
    }
    if (/error|ERR|failed/i.test(text)) process.stderr.write(`[cf] ${text.trim().slice(0, 200)}\n`)
  }
  child.stdout.on('data', scan)
  child.stderr.on('data', scan)
  child.on('exit', code => {
    console.error(`[cf] cloudflared exited (${code})`)
    server.close()
    process.exit(1)
  })
  process.on('SIGINT', () => {
    child.kill()
    server.close()
    process.exit(0)
  })
})
