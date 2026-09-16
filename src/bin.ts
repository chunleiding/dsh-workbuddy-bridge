#!/usr/bin/env node
/**
 * Standalone status/diagnostics CLI for dsh-llm-bridge.
 *
 * Usage:
 *   dsh-llm-bridge [workbuddy|loomy|qoder] <doctor|status|logout> [--json]
 *
 * With no driver argument, doctor/status report across every shipped driver;
 * logout is destructive-adjacent and always requires an explicit driver.
 */

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BRIDGE_VERSION } from './core/version.ts'
import { isHeartbeatProcessAlive } from './core/heartbeat.ts'
import { workbuddyCli, type DriverCli } from './drivers/workbuddy/cli.ts'
import { loomyCli } from './drivers/loomy/cli.ts'
import { qoderCli } from './drivers/qoder/cli.ts'

type Action = 'doctor' | 'logout' | 'status'

const JSON_SCHEMA_VERSION = 1
const DRIVERS: readonly DriverCli[] = [workbuddyCli, loomyCli, qoderCli]

/** Remove token-like strings from an unexpected diagnostic message. */
function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message
    .replace(/\b[0-9a-f]{32}\b/gu, '[redacted session]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, '[redacted token]')
    .replace(/(\b(?:code|token|refresh_token|access_token)=)[^&\s]+/giu, '$1[redacted]')
    .slice(0, 500)
}

function printHelp(): void {
  process.stdout.write([
    'Usage: dsh-llm-bridge [workbuddy|loomy|qoder] <doctor|status|logout> [--json]',
    '',
    '  doctor   secret-free sign-in and environment diagnostics',
    '  status   sign-in state, remaining quota, and host-bundle health',
    '  logout   remove plugin-owned credentials (desktop app sign-in is untouched)',
    '  --json   emit one secret-free JSON document (doctor/status only)',
    '',
    `Drivers: ${DRIVERS.map(driver => driver.id).join(', ')}`,
    '',
  ].join('\n'))
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}

async function doctorOne(driver: DriverCli): Promise<{ report: Record<string, unknown>; exit: number }> {
  const { view } = driver.makeStore()
  const status = await view.status()
  const filePresent = await view.filePresent()
  const heartbeat = await driver.heartbeat.read()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const report: Record<string, unknown> = {
    provider: driver.id,
    version: BRIDGE_VERSION,
    node: process.version,
    credentialFile: {
      path: view.filePath() ?? '(no platform default for this driver)',
      present: filePresent,
    },
    ...view.ownPath() === undefined ? {} : { ownCredentialFile: view.ownPath() },
    hostHeartbeat: {
      path: driver.heartbeat.path(),
      present: heartbeat !== undefined,
      ...heartbeat === undefined ? {} : { registeredAt: heartbeat.registeredAt, pid: heartbeat.pid },
      processAlive: hostAlive,
    },
    signIn: status.state,
    fallbackModels: driver.fallbackModelCount,
    hints: [
      ...status.state === 'signed-in' ? [] : [driver.signedOutHint],
      ...filePresent ? [] : [`No ${driver.displayName} credential file at the expected path.`],
      ...hostAlive ? [] : ['Host bundle not running in this DSH profile (or the process exited).'],
    ],
  }
  return { report, exit: status.state === 'signed-in' && filePresent ? 0 : 1 }
}

async function statusOne(driver: DriverCli): Promise<{ report: Record<string, unknown>; exit: number }> {
  const made = driver.makeStore()
  const authStatus = await made.view.status()
  const heartbeat = await driver.heartbeat.read()
  const hostAlive = heartbeat !== undefined && isHeartbeatProcessAlive(heartbeat)
  const hostState = hostAlive ? 'running' : heartbeat !== undefined ? 'stale' : 'not-started'
  if (authStatus.state !== 'signed-in') {
    return {
      report: { provider: driver.id, version: BRIDGE_VERSION, status: 'signed-out', hostBundle: hostState },
      exit: 1,
    }
  }
  const report: Record<string, unknown> = {
    provider: driver.id,
    version: BRIDGE_VERSION,
    status: 'signed-in',
    ...authStatus.expiresAtMs === undefined ? {} : { accessTokenExpires: new Date(authStatus.expiresAtMs).toISOString() },
    ...authStatus.updatedAtMs === undefined ? {} : { sessionUpdatedAt: new Date(authStatus.updatedAtMs).toISOString() },
    ...authStatus.nickname === undefined ? {} : { nickname: authStatus.nickname },
    hostBundle: hostState,
  }
  if (made.fetchCreditsTotal !== undefined) {
    try {
      report['credits'] = await made.fetchCreditsTotal()
    } catch (error: unknown) {
      report['creditsError'] = safeMessage(error)
    }
  }
  return { report, exit: 0 }
}

function printDoctorText(driver: DriverCli, report: Record<string, unknown>): void {
  const file = report['credentialFile'] as { present: boolean; path: string }
  const hb = report['hostHeartbeat'] as { present: boolean; processAlive: boolean; pid?: number }
  process.stdout.write([
    `[${driver.id}] DSH LLM Bridge ${BRIDGE_VERSION} on ${process.version}`,
    `${driver.credentialFileLabel}: ${file.present ? 'present' : 'missing'} (${file.path})`,
    `Host bundle: ${hb.processAlive ? 'running' + (hb.pid === undefined ? '' : ` (pid ${String(hb.pid)})`) : hb.present ? 'stale heartbeat (process exited)' : 'not started'}`,
    `Sign-in state: ${String(report['signIn'])}`,
    `Static fallback models: ${String(report['fallbackModels'])}`,
    ...((report['hints'] as string[] | undefined) ?? []).map(hint => `Hint: ${hint}`),
    '',
  ].join('\n'))
}

function printStatusText(driver: DriverCli, report: Record<string, unknown>): void {
  const lines = [`[${driver.id}] ${driver.displayName}: ${String(report['status'])}`]
  if (typeof report['nickname'] === 'string') lines[0] += ` as ${report['nickname']}`
  if (typeof report['accessTokenExpires'] === 'string') lines.push(`Access token expires ${report['accessTokenExpires']} (refresh is automatic)`)
  if (typeof report['sessionUpdatedAt'] === 'string') lines.push(`Session last updated ${report['sessionUpdatedAt']}`)
  if (typeof report['credits'] === 'number') lines.push(`Remaining credit: ${report['credits']}`)
  if (typeof report['creditsError'] === 'string') lines.push(`Remaining credit: unavailable (${report['creditsError']})`)
  lines.push(`Host bundle: ${String(report['hostBundle'])}`)
  process.stdout.write(`${lines.join('\n')}\n`)
}

/** Execute one boot-free command for one driver (or all when `driver` is undefined). */
export async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    printHelp()
    return 0
  }

  let selected: DriverCli | undefined
  let rest = argv
  const firstAsDriver = DRIVERS.find(driver => driver.id === argv[0])
  if (firstAsDriver !== undefined) {
    selected = firstAsDriver
    rest = argv.slice(1)
  }

  const [rawAction, ...flags] = rest
  const actions: readonly Action[] = ['doctor', 'logout', 'status']
  if (rawAction === undefined || !actions.includes(rawAction as Action)) {
    process.stderr.write(`dsh-llm-bridge: expected doctor, logout, or status${selected === undefined ? ` or a driver (${DRIVERS.map(d => d.id).join('|')})` : ''}; got ${JSON.stringify(rawAction)}\n`)
    return 1
  }
  const action = rawAction as Action
  const jsonOutput = flags.includes('--json')
  if (flags.some(flag => flag !== '--json') || (jsonOutput && action === 'logout')) {
    process.stderr.write(`dsh-llm-bridge: invalid options for ${action}: ${flags.join(' ')}\n`)
    return 1
  }
  if (action === 'logout' && selected === undefined) {
    process.stderr.write('dsh-llm-bridge: specify a driver for logout, e.g. `dsh-llm-bridge workbuddy logout`\n')
    return 1
  }

  const targets = selected !== undefined ? [selected] : DRIVERS
  try {
    if (action === 'logout') {
      const { view } = targets[0]!.makeStore()
      await view.logout()
      const own = view.ownPath()
      process.stdout.write(own === undefined
        ? `dsh-llm-bridge (${targets[0]!.id}): no plugin-owned credential to remove; the desktop app's sign-in is untouched\n`
        : `dsh-llm-bridge (${targets[0]!.id}): removed ${own}; the desktop app's sign-in is untouched\n`)
      return 0
    }

    const runOne = action === 'doctor' ? doctorOne : statusOne
    const results = await Promise.all(targets.map(driver => runOne(driver)))
    let exit = 0
    if (jsonOutput) {
      if (selected !== undefined) {
        printJson({ schemaVersion: JSON_SCHEMA_VERSION, package: 'dsh-llm-bridge', ...results[0]!.report })
      } else {
        printJson({
          schemaVersion: JSON_SCHEMA_VERSION,
          package: 'dsh-llm-bridge',
          version: BRIDGE_VERSION,
          results: results.map(result => result.report),
        })
      }
    } else {
      targets.forEach((driver, index) => {
        if (action === 'doctor') printDoctorText(driver, results[index]!.report as Record<string, unknown>)
        else printStatusText(driver, results[index]!.report as Record<string, unknown>)
      })
    }
    for (const result of results) if (result.exit !== 0) exit = 1
    return exit
  } catch (error: unknown) {
    process.stderr.write(`dsh-llm-bridge: ${action} failed: ${safeMessage(error)}\n`)
    return 1
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await run(process.argv.slice(2))
}
