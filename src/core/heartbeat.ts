/**
 * Generic host-heartbeat mechanism: a small JSON file written under
 * `$DSH_HOME` once a driver has registered its provider, so a boot-free
 * status CLI can report whether the host bundle is alive independently of
 * any browser card.
 *
 * The mechanism (write/read/clear, PID liveness, recycled-PID detection via
 * process start time, format validation) is platform-agnostic; the driver
 * supplies the identity — its own file name and package marker — so several
 * drivers never collide on one file.
 *
 * The browser (client) bundle cannot write files; its health is reported
 * only through `console.error` on failure. This asymmetry is intentional:
 * the host is the load-bearing half, and a missing heartbeat unambiguously
 * means the host never started.
 *
 * @module dsh-llm-bridge/core/heartbeat
 */

import { execFileSync } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Current on-disk heartbeat format; readers reject others. */
const HEARTBEAT_FORMAT_VERSION = 1

/** On-disk shape of the heartbeat. */
export interface HostHeartbeat {
  version: typeof HEARTBEAT_FORMAT_VERSION
  /** Package marker of the bundle that wrote the file, validated on read. */
  package: string
  pluginVersion: string
  /** Epoch milliseconds when the host registered the provider. */
  registeredAt: number
  /** Host process PID, to distinguish a stale heartbeat after a crash. */
  pid: number
}

/** Driver-supplied identity for its heartbeat file. */
export interface HeartbeatIdentity {
  /** Basename of the heartbeat file inside the Harness home. */
  fileName: string
  /** Package marker required on read (rejects foreign/stale documents). */
  packageName: string
}

/** Read/write handle bound to one driver's heartbeat identity. */
export interface HostHeartbeatHandle {
  /** Absolute path of the heartbeat file. */
  path(): string
  /** Write (or overwrite) the heartbeat; a failed write is non-fatal. */
  write(): Promise<void>
  /** Remove the heartbeat on plugin disposal; best-effort. */
  clear(): Promise<void>
  /** Read and validate the heartbeat; `undefined` when absent or malformed. */
  read(): Promise<HostHeartbeat | undefined>
}

/** Bind the heartbeat mechanism to one driver identity. */
export function createHostHeartbeat(identity: HeartbeatIdentity, pluginVersion: string): HostHeartbeatHandle {
  const path = (): string => join(resolveDshHome(), identity.fileName)

  const document = (): HostHeartbeat => ({
    version: HEARTBEAT_FORMAT_VERSION,
    package: identity.packageName,
    pluginVersion,
    registeredAt: Date.now(),
    pid: process.pid,
  })

  const write = async (): Promise<void> => {
    try {
      await writeFile(path(), JSON.stringify(document()), 'utf8')
    } catch {
      // Non-fatal: the CLI status will show "heartbeat missing".
    }
  }

  const clear = async (): Promise<void> => {
    try {
      await rm(path(), { force: true })
    } catch {
      // Best-effort cleanup; a stale heartbeat is harmless (PID mismatch is detected by the reader).
    }
  }

  const read = async (): Promise<HostHeartbeat | undefined> => {
    let raw: string
    try {
      raw = await readFile(path(), 'utf8')
    } catch {
      return undefined
    }
    try {
      const parsed = JSON.parse(raw) as Partial<HostHeartbeat>
      if (
        parsed.version === HEARTBEAT_FORMAT_VERSION
        && parsed.package === identity.packageName
        && typeof parsed.registeredAt === 'number'
        && typeof parsed.pid === 'number'
      ) {
        return {
          version: HEARTBEAT_FORMAT_VERSION,
          package: identity.packageName,
          pluginVersion: typeof parsed.pluginVersion === 'string' ? parsed.pluginVersion : 'unknown',
          registeredAt: parsed.registeredAt,
          pid: parsed.pid,
        }
      }
    } catch {
      // Malformed JSON; treat as absent.
    }
    return undefined
  }

  return { path, write, clear, read }
}

/**
 * Absolute start time (epoch ms) of the process holding `pid`, or `undefined`
 * when it cannot be determined (no such PID, platform lacks a readable source).
 *
 * - macOS / Linux: `ps -o lstart=` prints a local-time "EEE MMM DD HH:MM:SS YYYY";
 *   `Date.parse` resolves it against the local clock, which matches how
 *   `registeredAt` (a `Date.now()` absolute value) is expressed.
 * - Windows: WMI `CreationDate` is UTC (`YYYYMMDDHHMMSS.mmm+zzzz`); parsed with
 *   `Date.UTC`, again comparable to `registeredAt`.
 *
 * Failures return `undefined` so callers can fall back to plain PID liveness
 * rather than mis-report a running host as dead.
 */
export function processStartTimeMs(pid: number): number | undefined {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync(
        'wmic',
        ['process', 'where', `processid=${pid}`, 'get', 'CreationDate'],
        { encoding: 'utf8', windowsHide: true },
      )
      const m = out.match(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.\d+([+-]\d{4})/)
      if (m === null) return undefined
      const [, y, mo, d, h, mi, s] = m
      const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s))
      return Number.isFinite(ms) ? ms : undefined
    }
    const out = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } },
    ).trim()
    if (out === '') return undefined
    const ms = Date.parse(out)
    return Number.isFinite(ms) ? ms : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether the heartbeat's PID is still alive *and* still the same process
 * that registered it. A stale heartbeat (host crashed without clearing the
 * file) is distinguished from a live host by two checks:
 *
 * 1. `process.kill(pid, 0)` — the PID exists (signal 0 tests existence).
 * 2. The process holding that PID started at or before `registeredAt`. A
 *    host that registered the heartbeat must have been started before
 *    writing it, so `start <= registeredAt`; a recycled PID belongs to an
 *    unrelated process started after the host died, so `start >
 *    registeredAt` correctly reads dead.
 *
 * PID-only detection is not enough: after a crash the OS may hand the same
 * PID to an unrelated process, and the un-cleared stale heartbeat would
 * otherwise produce a false "Host running". When the process start time
 * cannot be read (e.g. unsupported platform) the check degrades to plain
 * PID liveness.
 */
export function isHeartbeatProcessAlive(heartbeat: HostHeartbeat): boolean {
  try {
    process.kill(heartbeat.pid, 0)
  } catch {
    return false
  }
  const startAtMs = processStartTimeMs(heartbeat.pid)
  if (startAtMs === undefined) return true // platform cannot read start time; PID alive is the best signal
  return startAtMs <= heartbeat.registeredAt
}
