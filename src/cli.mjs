import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { constants as osConstants } from 'node:os'

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)))
const TIMEOUT_MS = 3000
const MAX_RESPONSE_BYTES = 512 * 1024
// The CronRadar monitor key column holds 100 characters; the ingestion API rejects longer keys.
const MAX_JOB_KEY_LENGTH = 100
const HELP = `CronRadar CLI ${VERSION}

Usage:
  cronradar run --job KEY [--schedule CRON] [--grace-period SECONDS] -- executable args
  cronradar ping --job KEY --state heartbeat|start|complete|fail [options]
  cronradar doctor [--job KEY] [--json]
  cronradar help [run|ping|doctor]
  cronradar --version

Set CRONRADAR_API_KEY in your environment. CRONRADAR_BASE_URL defaults to https://cron.life.
The run command preserves the job's output and exit code. Monitoring failures never stop the job.
Doctor checks authentication and optional job health without changing a monitor.
Use cronradar COMMAND --help for options and examples. Requires Node.js 20 or later.
`

const COMMAND_HELP = {
  run: `Usage: cronradar run --job KEY [options] -- executable args

Run a command once, reporting start and completion or failure. Use your existing scheduler.

  --job KEY                Stable monitor key (required, 1–${MAX_JOB_KEY_LENGTH} characters)
  --schedule CRON          Five-field cron or @daily-style shortcut; self-registers a missing monitor
  --grace-period SECONDS   Late-run allowance, at least 60 seconds
  -h, --help               Show this help
  -v, --version            Show the CLI version

Example:
  cronradar run --job daily-backup --schedule "0 2 * * *" -- node backup.js

Set CRONRADAR_API_KEY in the environment, never in command arguments.
The command inherits stdin, stdout, stderr, environment, and working directory.
No shell is started. Invoke a shell explicitly if your job needs shell syntax.
Monitoring uses a fresh run ID, a 3-second deadline per report, and no retries.
Job exit codes are preserved even if monitoring fails; CLI usage errors exit 2.
`,
  ping: `Usage: cronradar ping --job KEY --state STATE [options]

Report a scheduled job without executing it.

  --job KEY                Stable monitor key (required, 1–${MAX_JOB_KEY_LENGTH} characters)
  --state STATE            heartbeat, start, complete, or fail (required)
  --schedule CRON          Five-field cron or @daily-style shortcut; self-registers a missing monitor
  --grace-period SECONDS   Late-run allowance, at least 60 seconds
  --run-id ID              Opaque execution ID, at most 128 characters
  --json                   Write one sanitized JSON result to stdout
  -h, --help               Show this help
  -v, --version            Show the CLI version

Examples:
  cronradar ping --job daily-backup --state heartbeat --schedule "0 2 * * *"
  cronradar ping --job daily-backup --state start --run-id run-123
  cronradar ping --job daily-backup --state complete --run-id run-123 --json

Set CRONRADAR_API_KEY in the environment. Reuse the run ID only within one execution.
Heartbeat reports success without duration tracking. Outcome values are not supported.
Exit codes: 0 accepted, 1 monitoring/configuration problem, 2 invalid CLI usage.
Acceptance does not verify alert delivery. A protection warning exits 1.
`,
  doctor: `Usage: cronradar doctor [--job KEY] [--json]

Check ingestion connectivity and API-key authentication with one read-only request.
No monitor is created or changed, no heartbeat is sent, and no alert is triggered.

  --job KEY                Also check one job's health and last recorded check-in
  --json                   Write one sanitized JSON result to stdout
  -h, --help               Show this help
  -v, --version            Show the CLI version

Set CRONRADAR_API_KEY in the environment. CRONRADAR_BASE_URL defaults to https://cron.life.
Examples:
  cronradar doctor
  cronradar doctor --job daily-backup --json

Without --job, success verifies an authenticated API response only.
With --job, exit 0 also requires healthy status and a recorded check-in.
The timestamp may be old; compare it with your scheduler's expected run.
This snapshot does not prove completion, plan capacity, or alert delivery.
Exit codes: 0 checks passed, 1 connection or job needs attention, 2 invalid CLI usage.
`,
}

class UsageError extends Error {}
class ResponseError extends Error {}

function parse(argv) {
  if (argv.length === 0) return { command: 'help' }
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'help' }
  if (argv.length === 1 && ['--version', '-v'].includes(argv[0])) return { command: 'version' }
  if (argv[0] === 'help') {
    if (argv.length === 1) return { command: 'help' }
    if (argv.length === 2 && Object.hasOwn(COMMAND_HELP, argv[1]))
      return { command: 'help', topic: argv[1] }
    throw new UsageError('Choose run, ping, or doctor. Use --help for examples.')
  }
  const command = argv[0]
  const allowed = {
    run: ['--job', '--schedule', '--grace-period'],
    ping: ['--job', '--state', '--run-id', '--schedule', '--grace-period', '--json'],
    doctor: ['--job', '--json'],
  }[command]
  if (!Array.isArray(allowed))
    throw new UsageError('Choose run, ping, or doctor. Use --help for examples.')
  const options = { command }
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index]
    if (command === 'run' && argument === '--') {
      options.executable = argv[index + 1]
      options.arguments = argv.slice(index + 2)
      break
    }
    if (['--help', '-h'].includes(argument)) return { command: 'help', topic: command }
    if (['--version', '-v'].includes(argument)) return { command: 'version' }
    const equals = argument.indexOf('=')
    const flag = equals === -1 ? argument : argument.slice(0, equals)
    if (!allowed.includes(flag))
      throw new UsageError(
        `Unknown option. Use cronradar ${command} --help for the supported syntax.`,
      )
    if (options[flag] !== undefined) throw new UsageError('Supply each option only once.')
    if (flag === '--json') {
      if (equals !== -1) throw new UsageError('--json does not take a value.')
      options[flag] = true
      continue
    }
    const value = equals === -1 ? argv[++index] : argument.slice(equals + 1)
    if (!value || value.startsWith('--')) throw new UsageError(`${flag} is missing its value.`)
    options[flag] = value
  }
  if (
    (command !== 'doctor' || options['--job'] !== undefined) &&
    (!validIdentifier(options['--job'], MAX_JOB_KEY_LENGTH) ||
      ['.', '..'].includes(options['--job']))
  ) {
    throw new UsageError(
      `--job requires a nonempty key of at most ${MAX_JOB_KEY_LENGTH} characters, not a credential or dot path.`,
    )
  }
  if (command === 'run' && !options.executable)
    throw new UsageError('Place the executable and its arguments after --.')
  if (options['--schedule'] !== undefined && !validSchedule(options['--schedule'])) {
    throw new UsageError(
      '--schedule requires a five-field cron expression such as "0 2 * * *" or a shortcut such as @daily (not @reboot). Use cronradar run --help.',
    )
  }
  if (options['--grace-period'] !== undefined) {
    const grace = Number(options['--grace-period'])
    if (
      !/^\d+$/.test(options['--grace-period']) ||
      !Number.isInteger(grace) ||
      grace < 60 ||
      grace > 2147483647
    ) {
      throw new UsageError('--grace-period requires whole seconds between 60 and 2147483647.')
    }
  }
  if (
    command === 'ping' &&
    !['heartbeat', 'start', 'complete', 'fail'].includes(options['--state'])
  ) {
    throw new UsageError('--state must be heartbeat, start, complete, or fail.')
  }
  if (options['--run-id'] !== undefined && !validIdentifier(options['--run-id'], 128)) {
    throw new UsageError(
      '--run-id requires a nonempty identifier of at most 128 characters, not a credential.',
    )
  }
  return options
}

function validText(value, maximum) {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= maximum &&
    !/[\x00-\x1f\x7f]/.test(value)
  )
}

function validIdentifier(value, maximum) {
  return (
    validText(value, maximum) &&
    !/(?:ck_app_|cr_agent_|[sp]k_(?:live|test)_|github_pat_)/i.test(value)
  )
}

// The server expands these shortcuts (case-insensitive) and rejects @reboot.
const SCHEDULE_SHORTCUTS = [
  '@yearly',
  '@annually',
  '@monthly',
  '@weekly',
  '@daily',
  '@midnight',
  '@hourly',
]

function validSchedule(value) {
  if (!validText(value, 200)) return false
  if (SCHEDULE_SHORTCUTS.includes(value.trim().toLowerCase())) return true
  const fields = value.trim().split(/ +/)
  const limits = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ]
  const aliases = {
    3: [
      'JANUARY',
      'FEBRUARY',
      'MARCH',
      'APRIL',
      'MAY',
      'JUNE',
      'JULY',
      'AUGUST',
      'SEPTEMBER',
      'OCTOBER',
      'NOVEMBER',
      'DECEMBER',
    ],
    4: ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'],
  }
  // NCrontab also accepts name prefixes and reversed ranges. Validation must not
  // reinterpret the schedule or reject those server-supported forms.
  return (
    fields.length === 5 &&
    fields.every((field, index) => {
      const [minimum, maximum] = limits[index]
      const number = (token) => {
        if (/^\d+$/.test(token)) return Number(token)
        const named = token
          ? aliases[index]?.findIndex((name) => name.startsWith(token.toUpperCase()))
          : -1
        return named !== undefined && named >= 0 ? named + minimum : NaN
      }
      return field.split(',').every((part) => {
        const [range, step, ...extra] = part.split('/')
        if (
          extra.length ||
          (step !== undefined &&
            (!/^[+-]?\d+$/.test(step) || Number(step) < -2147483648 || Number(step) > 2147483647))
        )
          return false
        if (range === '*') return true
        const ends = range.split('-').map(number)
        return (
          ends.length <= 2 &&
          ends.every((end) => Number.isInteger(end) && end >= minimum && end <= maximum)
        )
      })
    })
  )
}

function configuration(env) {
  const apiKey = env.CRONRADAR_API_KEY?.trim()
  if (!apiKey)
    return {
      code: 'missing_api_key',
      problem:
        'Monitoring skipped: set CRONRADAR_API_KEY in the process environment or deployment secret manager.',
    }
  if (!validText(apiKey, 512) || !/^ck_app_[A-Za-z0-9_-]+$/.test(apiKey))
    return {
      code: 'invalid_api_key',
      problem:
        'Monitoring skipped: CRONRADAR_API_KEY is malformed. Use an application ingestion key beginning with ck_app_, not a management token.',
    }
  try {
    const base = new URL(env.CRONRADAR_BASE_URL || 'https://cron.life')
    const loopback =
      base.hostname === 'localhost' ||
      base.hostname === '[::1]' ||
      /^127\.\d+\.\d+\.\d+$/.test(base.hostname)
    if (
      (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      base.pathname !== '/'
    ) {
      return {
        code: 'invalid_base_url',
        problem:
          'Monitoring skipped: CRONRADAR_BASE_URL must be an HTTPS origin without credentials, a path, or query parameters.',
      }
    }
    return { base, authorization: `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}` }
  } catch {
    return {
      code: 'invalid_base_url',
      problem:
        'Monitoring skipped: CRONRADAR_BASE_URL is invalid. Set an HTTPS origin such as https://cron.life.',
    }
  }
}

function diagnostic(message) {
  // Never print request URLs, authorization, response bodies, or exception text.
  process.stderr.write(`[CronRadar] ${message}\n`)
}

function failureForStatus(status) {
  if (status >= 300 && status < 400)
    return {
      code: 'redirect_refused',
      problem:
        'The service redirected the request; credentials were not forwarded. Check CRONRADAR_BASE_URL.',
    }
  if (status === 401)
    return {
      code: 'authentication_failed',
      problem:
        'Authentication failed. Check or rotate CRONRADAR_API_KEY in your application settings.',
    }
  if (status === 402)
    return {
      code: 'capacity_required',
      problem:
        'The plan cannot activate this job. Free capacity or ask the workspace owner to review billing; no automatic upgrade was made.',
    }
  if (status === 403)
    return {
      code: 'request_blocked',
      problem:
        'The service blocked this request. Check the ingestion origin and its firewall rules; do not put your key in command arguments.',
    }
  if (status === 404)
    return {
      code: 'not_found',
      problem:
        'The monitor or application was not found. Check the application key and add --schedule when creating a job with run or ping.',
    }
  if (status === 400)
    return {
      code: 'invalid_report',
      problem:
        'The service rejected the monitoring configuration. Check the job key, schedule, and grace period.',
    }
  if (status === 429)
    return {
      code: 'rate_limited',
      problem:
        'The service rate limit was reached. Reduce check-in frequency or review the application key limits. No retry was sent.',
    }
  return {
    code: 'http_error',
    problem: `The monitoring request failed (HTTP ${status}). Check service availability and try doctor later.`,
  }
}

async function readJson(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new ResponseError()
  const chunks = []
  let bytes = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) throw new ResponseError()
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function validResponse(data, expected) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  if (expected.command === 'doctor') {
    return (
      typeof data.applicationId === 'string' &&
      data.applicationId.length > 0 &&
      Number.isInteger(data.totalMonitors) &&
      data.totalMonitors >= 0 &&
      Array.isArray(data.monitors) &&
      data.monitors.length === data.totalMonitors
    )
  }
  return (
    data.status === (expected.state === 'fail' ? 'failure_recorded' : 'ok') &&
    data.monitor === expected.job
  )
}

function diagnoseJob(data, key) {
  // Only allowlisted health and normalized timestamps may leave this boundary.
  // Do not print monitor keys, names, schedules, other inventory, or raw fields.
  if (data.monitors.some((monitor) => !monitor || typeof monitor.monitorKey !== 'string'))
    throw new ResponseError()
  const matches = data.monitors.filter((monitor) => monitor.monitorKey === key)
  if (matches.length === 0)
    return {
      ok: false,
      code: 'job_not_found',
      problem:
        'The selected job was not found. Check --job and the application ingestion key; include --schedule when wrapping a missing job.',
    }
  if (matches.length !== 1) throw new ResponseError()
  const monitor = matches[0]
  if (!['pending', 'healthy', 'warning', 'critical', 'paused'].includes(monitor.status))
    throw new ResponseError()
  for (const flag of ['isPaused', 'isPlanLimited']) {
    if (monitor[flag] !== undefined && typeof monitor[flag] !== 'boolean') throw new ResponseError()
  }
  let lastPingAt = null
  if (monitor.lastPingAt !== null) {
    if (
      typeof monitor.lastPingAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/.test(
        monitor.lastPingAt,
      ) ||
      !Number.isFinite(Date.parse(monitor.lastPingAt))
    )
      throw new ResponseError()
    lastPingAt = new Date(monitor.lastPingAt).toISOString()
  }
  const health = monitor.isPaused ? 'paused' : monitor.status
  const job = {
    health,
    lastPingAt,
    ...(monitor.isPaused !== undefined && { isPaused: monitor.isPaused }),
    ...(monitor.isPlanLimited !== undefined && { isPlanLimited: monitor.isPlanLimited }),
  }
  if (monitor.isPlanLimited)
    return {
      ok: false,
      code: 'job_plan_limited',
      problem:
        'The selected job is recorded but not protected because of plan capacity. Pause another job or review billing in the dashboard; no plan change was made.',
      job,
    }
  const problems = {
    paused:
      'The selected job is paused and is not being monitored. Review its pause reason and plan capacity in the dashboard.',
    critical:
      'The selected job is critical. Review its latest execution and incident in the dashboard before considering setup verified.',
    warning:
      'The selected job is late but within its grace period. Check the scheduler and expected execution time.',
    pending:
      'The selected job has no verified check-in yet. Let the real scheduled command run, then check again.',
  }
  const issue = health === 'healthy' && lastPingAt === null ? 'pending' : health
  if (Object.hasOwn(problems, issue))
    return { ok: false, code: `job_${issue}`, problem: problems[issue], job }
  return {
    ok: true,
    code: 'job_reporting',
    message:
      `The selected job reports healthy; a check-in was recorded at ${lastPingAt}. ` +
      'Compare this timestamp with the expected run. Completion, capacity, and alert delivery are not verified.',
    job,
  }
}

async function request(config, path, parameters, method, expected, signal) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timeout = setTimeout(abort, TIMEOUT_MS)
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    const url = new URL(path, config.base)
    url.search = parameters.toString()
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: config.authorization,
        'User-Agent': `CronRadarCLI/${VERSION}`,
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: controller.signal,
    })
    const status = response.status
    if (status < 200 || status >= 300) {
      await response.body?.cancel()
      return { ok: false, status, ...failureForStatus(status) }
    }
    const json =
      response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ===
      'application/json'
    if (!json) {
      await response.body?.cancel()
      throw new ResponseError()
    }
    const data = await readJson(response)
    if (!validResponse(data, expected)) throw new ResponseError()
    if (expected.command === 'doctor' && expected.job)
      return { status, ...diagnoseJob(data, expected.job) }
    if (expected.command !== 'doctor' && data.warning != null && data.warning !== '')
      return {
        ok: false,
        accepted: true,
        status,
        code: 'protection_warning',
        problem:
          'The check-in was recorded with a monitoring warning. Review job protection and plan capacity in the dashboard before relying on alerts.',
      }
    return { ok: true, status }
  } catch (error) {
    if (error instanceof ResponseError || error instanceof SyntaxError)
      return {
        ok: false,
        code: 'invalid_response',
        problem:
          'The service returned an unexpected response; connection or check-in could not be verified. Check CRONRADAR_BASE_URL and try doctor.',
      }
    return {
      ok: false,
      code: signal?.aborted
        ? 'interrupted'
        : controller.signal.aborted
          ? 'timeout'
          : 'connection_failed',
      problem: controller.signal.aborted
        ? 'The monitoring request timed out or was interrupted.'
        : 'The monitoring service could not be reached.',
    }
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  }
}

async function report(config, options, state, runId, message, signal) {
  if (config.problem) return { ok: false, code: config.code, problem: config.problem }
  try {
    const parameters = new URLSearchParams()
    if (runId) parameters.set('run_id', runId)
    if (options['--schedule']) parameters.set('schedule', options['--schedule'])
    if (options['--grace-period']) parameters.set('gracePeriod', options['--grace-period'])
    if (message) parameters.set('message', message)
    return await request(
      config,
      `/api/v1/ping/${encodeURIComponent(options['--job'])}${state === 'heartbeat' ? '' : `/${state}`}`,
      parameters,
      'POST',
      { state, job: options['--job'] },
      signal,
    )
  } catch {
    return {
      ok: false,
      code: 'report_failed',
      problem:
        'The monitoring report could not be prepared. Check the job options with cronradar help.',
    }
  }
}

function signalExitCode(signal) {
  return 128 + (osConstants.signals[signal] || 1)
}

async function run(config, options) {
  const runId = randomUUID()
  let activeRequest = new AbortController()
  let child
  let interrupted
  const handlers = new Map(
    ['SIGINT', 'SIGTERM'].map((signal) => [
      signal,
      () => {
        interrupted = signal
        activeRequest.abort()
        if (child) {
          try {
            child.kill(signal)
          } catch {
            /* The child may already have exited. */
          }
        }
      },
    ]),
  )
  for (const [signal, handler] of handlers) process.on(signal, handler)
  try {
    if (config.problem) diagnostic(config.problem)
    else {
      const initial = await report(config, options, 'start', runId, undefined, activeRequest.signal)
      if (!initial.ok && !interrupted) diagnostic(initial.problem)
    }
    if (interrupted) return signalExitCode(interrupted)

    const result = await new Promise((resolve) => {
      try {
        child = spawn(options.executable, options.arguments, {
          stdio: 'inherit',
          shell: false,
          windowsHide: true,
        })
      } catch {
        diagnostic('The requested executable could not be started.')
        resolve({ code: 126 })
        return
      }
      child.once('error', (error) => {
        diagnostic('The requested executable could not be started.')
        resolve({ code: ['EACCES', 'EPERM'].includes(error.code) ? 126 : 127 })
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const exitCode = result.signal ? signalExitCode(result.signal) : (result.code ?? 1)
    if (!config.problem) {
      activeRequest = new AbortController()
      const message = result.signal
        ? `Job terminated by ${result.signal}.`
        : `Job exited with code ${exitCode}.`
      const terminal = await report(
        config,
        options,
        exitCode === 0 ? 'complete' : 'fail',
        runId,
        exitCode === 0 ? undefined : message,
        activeRequest.signal,
      )
      if (!terminal.ok) diagnostic(terminal.problem)
    }
    return exitCode
  } finally {
    for (const [signal, handler] of handlers) process.removeListener(signal, handler)
  }
}

export async function main(argv, env = process.env) {
  let options
  try {
    options = parse(argv)
  } catch (error) {
    const problem =
      error instanceof UsageError ? error.message : 'Invalid command. Use --help for examples.'
    const json = ['ping', 'doctor'].includes(argv[0]) && argv.includes('--json')
    outputResult(argv[0], { ok: false, code: 'invalid_usage', problem }, json)
    return 2
  }
  if (options.command === 'help') {
    process.stdout.write(options.topic ? COMMAND_HELP[options.topic] : HELP)
    return 0
  }
  if (options.command === 'version') {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  const config = configuration(env)
  if (options.command === 'run') return run(config, options)
  if (config.problem) {
    outputResult(
      options.command,
      { ok: false, code: config.code, problem: config.problem },
      options['--json'],
    )
    return 1
  }
  const result =
    options.command === 'doctor'
      ? await request(config, '/api/v1/sync/status', new URLSearchParams(), 'GET', {
          command: 'doctor',
          job: options['--job'],
        })
      : await report(config, options, options['--state'], options['--run-id'])
  outputResult(options.command, result, options['--json'])
  return result.ok ? 0 : 1
}

function outputResult(command, result, json) {
  const message =
    result.message ??
    (result.ok
      ? command === 'doctor'
        ? 'CronRadar connection is ready. No monitor was changed. Job execution, capacity, and alert delivery are not verified.'
        : 'CronRadar check-in accepted. Alert delivery is not verified.'
      : result.problem)
  if (json) {
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: 1,
        command,
        ok: result.ok,
        code: result.code ?? (command === 'doctor' ? 'connection_ready' : 'check_in_accepted'),
        message,
        ...(result.status !== undefined && { httpStatus: result.status }),
        ...(result.accepted !== undefined && { accepted: result.accepted }),
        ...(result.job !== undefined && { job: result.job }),
      })}\n`,
    )
  } else if (!result.ok) diagnostic(message)
  else process.stdout.write(`${message}\n`)
}
