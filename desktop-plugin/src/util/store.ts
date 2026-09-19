/**
 * Tiny atomic JSON persistence used by the pairing registry and the gateway
 * prefs: write a temp file in the same directory, chmod 0600, then rename
 * over the target. Plain-synchronous on purpose — the state is small and the
 * operations happen from the (single-threaded) event loop only.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

/** A JSON document persisted atomically at one path. */
export class JsonFile<T> {
  constructor(private readonly path: string) {}

  /** Read the current document, or `undefined` when absent/invalid. */
  read(): T | undefined {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      return parsed as T
    } catch {
      return undefined
    }
  }

  /** Atomically persist a document (0600 on POSIX; best-effort on Windows). */
  write(value: T): void {
    const dir = dirname(this.path)
    mkdirSync(dir, { recursive: true })
    const tmp = join(dir, `.${randomUUID()}.tmp`)
    writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
    try {
      renameSync(tmp, this.path)
    } catch {
      // Windows occasionally refuses to overwrite (antivirus handle); fall
      // back to remove + rename.
      try {
        rmSync(this.path, { force: true })
        renameSync(tmp, this.path)
      } catch (error) {
        try {
          rmSync(tmp, { force: true })
        } catch {
          // ignore
        }
        throw error
      }
    }
  }
}
