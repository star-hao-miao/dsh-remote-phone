/**
 * Resumable downloader (node fetch works in this sandbox; PowerShell/.NET and
 * curl cannot acquire TLS credentials here).
 *
 * Usage: node tools/fetch.mjs <url> <outPath> [label]
 *
 * Behaviour: keeps a `<out>.part` file, resumes with Range when the server
 * supports it, retries up to 6 times with backoff, and gives up when the
 * connection stalls (no bytes for 60s).
 */

import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const [url, outPath, label = ''] = process.argv.slice(2)
if (url === undefined || outPath === undefined) {
  console.error('usage: node tools/fetch.mjs <url> <outPath> [label]')
  process.exit(2)
}

const name = label || outPath
mkdirSync(dirname(outPath), { recursive: true })
if (existsSync(outPath) && statSync(outPath).size > 0) {
  const total = Number(process.env.EXPECT_BYTES ?? 0)
  if (total === 0 || statSync(outPath).size === total) {
    console.log(`[skip] ${name} (${(statSync(outPath).size / 1048576).toFixed(1)}MB)`)
    process.exit(0)
  }
}

// The partial file is namespaced by the source URL: resuming must never mix
// bytes from two different mirrors (an earlier bug silently corrupted a JDK
// archive by appending a mirror's tail to another mirror's head).
const sourceKey = createHash('sha1').update(url).digest('hex').slice(0, 10)
const part = `${outPath}.${sourceKey}.part`
const MAX_ATTEMPTS = 6

async function attemptOnce(attempt) {
  const have = existsSync(part) ? statSync(part).size : 0
  const headers = have > 0 ? { range: `bytes=${have}-` } : {}
  const controller = new AbortController()
  let lastProgress = Date.now()
  const stall = setInterval(() => {
    if (Date.now() - lastProgress > 60_000) controller.abort(new Error('stalled'))
  }, 5_000)

  try {
    const response = await fetch(url, { headers, redirect: 'follow', signal: controller.signal })
    if (have > 0 && response.status !== 206) {
      // Server ignored the range: start over.
      rmSync(part, { force: true })
      throw new Error(`range unsupported (HTTP ${response.status}); restarting`)
    }
    if (!response.ok && response.status !== 206) throw new Error(`HTTP ${response.status}`)
    if (response.body === null) throw new Error('empty body')

    const remaining = Number(response.headers.get('content-length') ?? 0)
    const total = response.status === 206 ? have + remaining : remaining
    let seen = have

    const source = Readable.fromWeb(response.body)
    source.on('data', chunk => {
      seen += chunk.length
      lastProgress = Date.now()
      const pct = total > 0 ? ` ${((seen / total) * 100).toFixed(1)}%` : ''
      process.stdout.write(
        `\r[get ] ${name} ${(seen / 1048576).toFixed(1)}MB${total > 0 ? `/${(total / 1048576).toFixed(1)}MB` : ''}${pct} (try ${attempt})   `,
      )
    })
    await pipeline(source, createWriteStream(part, { flags: 'a' }))
    const size = statSync(part).size
    if (total > 0 && size !== total) throw new Error(`short read: ${size}/${total}`)
    rmSync(outPath, { force: true })
    renameSync(part, outPath)
    console.log(`\r[done] ${name} ${(size / 1048576).toFixed(1)}MB                      `)
    return true
  } catch (error) {
    console.log(`\r[warn] ${name} attempt ${attempt} failed: ${String(error?.message ?? error).slice(0, 90)}`)
    return false
  } finally {
    clearInterval(stall)
  }
}

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  if (await attemptOnce(attempt)) process.exit(0)
  const keep = existsSync(part) ? statSync(part).size : 0
  console.log(`[wait] resuming ${name} from ${(keep / 1048576).toFixed(1)}MB`)
  await new Promise(resolve => setTimeout(resolve, Math.min(20_000, 2_000 * attempt)))
}

console.error(`[fail] ${name} after ${MAX_ATTEMPTS} attempts`)
process.exit(1)
