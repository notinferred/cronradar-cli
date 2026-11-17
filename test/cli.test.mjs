import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const entrypoint = fileURLToPath(new URL('../bin/cronradar.mjs', import.meta.url))
const KEY = 'ck_app_test_fixture_not_a_real_key'

async function endpoint(t, handler) {
  const requests = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({ method: request.method, url: request.url, headers: request.headers, body })
    if (handler) return handler(request, response, requests.length)
    response.writeHead(200, { 'Content-Type': 'application/json' })
    const path = new URL(request.url, 'http://localhost').pathname
    response.end(
      JSON.stringify(
        path === '/api/v1/sync/status'
          ? { applicationId: 'test-app', totalMonitors: 0, monitors: [] }
          : {
              status: path.endsWith('/fail') ? 'failure_recorded' : 'ok',
              monitor: decodeURIComponent(path.split('/')[4]),
            },
      ),
    )
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections()
        server.close(resolve)
      }),
  )
  return { url: `http://127.0.0.1:${server.address().port}`, requests, server }
}

function launch(args, overrides = {}) {
  const env = { ...process.env, CRONRADAR_API_KEY: KEY, ...overrides }
  if (overrides.CRONRADAR_API_KEY === null) delete env.CRONRADAR_API_KEY
  const child = spawn(process.execPath, [entrypoint, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })
  const result = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }))
  })
  return { child, result }
}

function runArguments(source, extra = [], jobOptions = []) {
  return [
    'run',
    '--job',
    'sample-job',
    ...jobOptions,
    '--',
    process.execPath,
    '-e',
    source,
    ...extra,
  ]
}

test('successful run preserves arguments and output, with one correlated lifecycle', async (t) => {
  const api = await endpoint(t)
  const literals = [
    'space in value',
    '"quoted"',
    '; echo shell-injection',
    '$(echo command)',
    '& whoami',
    '',
  ]
  const { child, result } = launch(
    runArguments(
      "console.log(JSON.stringify(process.argv.slice(1))); process.stderr.write('job-stderr\\n')",
      literals,
      ['--schedule', '0 2 * * *', '--grace-period', '300'],
    ),
    { CRONRADAR_BASE_URL: api.url },
  )
  child.stdin.end()
  const outcome = await result
  assert.equal(outcome.code, 0)
  assert.deepEqual(JSON.parse(outcome.stdout), literals)
  assert.equal(outcome.stderr, 'job-stderr\n')
  assert.equal(api.requests.length, 2)
  const start = new URL(api.requests[0].url, api.url)
  const complete = new URL(api.requests[1].url, api.url)
  assert.equal(start.pathname, '/api/v1/ping/sample-job/start')
  assert.equal(complete.pathname, '/api/v1/ping/sample-job/complete')
  assert.match(start.searchParams.get('run_id'), /^[0-9a-f-]{36}$/)
  assert.equal(complete.searchParams.get('run_id'), start.searchParams.get('run_id'))
  assert.equal(start.searchParams.get('schedule'), '0 2 * * *')
  assert.equal(start.searchParams.get('gracePeriod'), '300')
  for (const request of api.requests) {
    assert.equal(request.method, 'POST')
    assert.equal(
      request.headers.authorization,
      `Basic ${Buffer.from(`${KEY}:`).toString('base64')}`,
    )
    assert.equal(request.headers['user-agent'], 'CronRadarCLI/0.1.0')
    assert.equal(request.body, '')
    assert.equal(request.url.includes(KEY), false)
    assert.equal(request.url.includes('job-stderr'), false)
    assert.equal(request.url.includes('shell-injection'), false)
  }
})

test('stdin and a nonzero job exit are preserved without uploading its output', async (t) => {
  const api = await endpoint(t)
  const { child, result } = launch(
    runArguments(
      "process.stdin.on('data', data => process.stdout.write(data)); process.stdin.on('end', () => process.exit(7));",
    ),
    { CRONRADAR_BASE_URL: api.url },
  )
  child.stdin.end('private-job-output')
  const outcome = await result
  assert.equal(outcome.code, 7)
  assert.equal(outcome.stdout, 'private-job-output')
  assert.equal(api.requests.length, 2)
  const failure = new URL(api.requests[1].url, api.url)
  assert.equal(failure.pathname, '/api/v1/ping/sample-job/fail')
  assert.equal(failure.searchParams.get('message'), 'Job exited with code 7.')
  assert.equal(
    api.requests.some((request) => request.url.includes('private-job-output') || request.body),
    false,
  )
})

test('missing key still executes the job without any monitoring requests', async (t) => {
  const api = await endpoint(t)
  const { result } = launch(runArguments("process.stdout.write('ran'); process.exit(9)"), {
    CRONRADAR_API_KEY: null,
    CRONRADAR_BASE_URL: api.url,
  })
  const outcome = await result
  assert.equal(outcome.code, 9)
  assert.equal(outcome.stdout, 'ran')
  assert.match(outcome.stderr, /set CRONRADAR_API_KEY/)
  assert.equal(api.requests.length, 0)
})

test('unsafe connection settings do not stop the job or expose embedded secrets', async () => {
  for (const base of [
    'http://example.invalid',
    'https://user:never-print-this@example.invalid/',
    'not a URL',
  ]) {
    const { result } = launch(runArguments("process.stdout.write('ran')"), {
      CRONRADAR_BASE_URL: base,
    })
    const outcome = await result
    assert.equal(outcome.code, 0)
    assert.equal(outcome.stdout, 'ran')
    assert.match(outcome.stderr, /Monitoring skipped/)
    assert.equal(outcome.stderr.includes('never-print-this'), false)
    assert.equal(outcome.stderr.includes(KEY), false)
  }
})

test('an unreachable service does not change the job output or exit code', async (t) => {
  const api = await endpoint(t)
  await new Promise((resolve) => api.server.close(resolve))
  const { result } = launch(
    runArguments(
      "process.stdout.write('ran'); process.stderr.write('job-error\\n'); process.exit(4)",
    ),
    { CRONRADAR_BASE_URL: api.url },
  )
  const outcome = await result
  assert.equal(outcome.code, 4)
  assert.equal(outcome.stdout, 'ran')
  assert.match(outcome.stderr, /^(?:\[CronRadar\].*\n)*job-error\n/)
  assert.match(outcome.stderr, /could not be reached/)
  assert.equal(outcome.stderr.includes(KEY), false)
})

test(
  'a stalled start request times out and the requested job still runs',
  { timeout: 10000 },
  async (t) => {
    const api = await endpoint(t, (_request, response, count) => {
      if (count === 1) return
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('{"status":"ok","monitor":"sample-job"}')
    })
    const began = Date.now()
    const { result } = launch(runArguments("process.stdout.write('after-timeout')"), {
      CRONRADAR_BASE_URL: api.url,
    })
    const outcome = await result
    assert.equal(outcome.code, 0)
    assert.equal(outcome.stdout, 'after-timeout')
    assert.match(outcome.stderr, /timed out/)
    assert.ok(Date.now() - began < 7000)
    assert.equal(api.requests.length, 2)
  },
)

test('doctor makes exactly one read-only request and does not disclose the inventory', async (t) => {
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      '{"applicationId":"test-app","totalMonitors":1,"monitors":[{"name":"private-customer-job"}]}',
    )
  })
  const outcome = await launch(['doctor'], { CRONRADAR_BASE_URL: api.url }).result
  assert.equal(outcome.code, 0)
  assert.match(outcome.stdout, /No monitor was changed/)
  assert.equal(outcome.stdout.includes('private-customer-job'), false)
  assert.deepEqual(
    api.requests.map((request) => [request.method, request.url]),
    [['GET', '/api/v1/sync/status']],
  )
})

test('manual ping uses the selected state and run ID', async (t) => {
  const api = await endpoint(t)
  const outcome = await launch(
    ['ping', '--job', 'space job', '--state', 'complete', '--run-id', 'opaque-run'],
    { CRONRADAR_BASE_URL: api.url },
  ).result
  assert.equal(outcome.code, 0)
  assert.equal(api.requests.length, 1)
  const url = new URL(api.requests[0].url, api.url)
  assert.equal(url.pathname, '/api/v1/ping/space%20job/complete')
  assert.equal(url.searchParams.get('run_id'), 'opaque-run')
})

test('a job key of exactly 100 characters is accepted', async (t) => {
  const api = await endpoint(t)
  const key = 'k'.repeat(100)
  const outcome = await launch(['ping', '--job', key, '--state', 'heartbeat'], {
    CRONRADAR_BASE_URL: api.url,
  }).result
  assert.equal(outcome.code, 0)
  assert.equal(new URL(api.requests[0].url, api.url).pathname, `/api/v1/ping/${key}`)
})

test('redirects are not followed and never disclose credentials to another origin', async (t) => {
  const destination = await endpoint(t)
  const redirect = await endpoint(t, (_request, response) => {
    response.writeHead(302, { Location: `${destination.url}/capture?private=never-print-this` })
    response.end('sensitive-response-body')
  })
  const outcome = await launch(['doctor'], { CRONRADAR_BASE_URL: redirect.url }).result
  assert.equal(outcome.code, 1)
  assert.equal(destination.requests.length, 0)
  assert.match(outcome.stderr, /credentials were not forwarded/)
  for (const secret of [KEY, 'never-print-this', 'sensitive-response-body']) {
    assert.equal((outcome.stdout + outcome.stderr).includes(secret), false)
  }
})

test('service errors stay sanitized and preserve the requested job exit', async (t) => {
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' })
    response.end('{"secret":"never-print-this"}')
  })
  const outcome = await launch(runArguments('process.exit(6)'), { CRONRADAR_BASE_URL: api.url })
    .result
  assert.equal(outcome.code, 6)
  assert.match(outcome.stderr, /Authentication failed/)
  assert.equal(outcome.stderr.includes('never-print-this'), false)
  assert.equal(outcome.stderr.includes(KEY), false)
})

test('invalid arguments exit 2 before executing a job or making a request', async (t) => {
  const api = await endpoint(t)
  for (const args of [
    ['unknown'],
    ['doctor', '--api-key', 'never-print-this'],
    ['ping', '--job', 'job', '--state', 'invalid'],
    ['run', '--job', 'job'],
    [
      'run',
      '--job',
      'job',
      '--job',
      'another',
      '--',
      process.execPath,
      '-e',
      "console.log('should-not-run')",
    ],
    [
      'run',
      '--job',
      'job',
      '--grace-period',
      '59',
      '--',
      process.execPath,
      '-e',
      "console.log('should-not-run')",
    ],
  ]) {
    const outcome = await launch(args, { CRONRADAR_BASE_URL: api.url }).result
    assert.equal(outcome.code, 2)
    assert.equal(outcome.stdout, '')
    assert.equal(outcome.stderr.includes('never-print-this'), false)
  }
  assert.equal(api.requests.length, 0)
})

test('help and version work globally and per command without credentials or requests', async (t) => {
  const api = await endpoint(t)
  for (const args of [
    [],
    ['--help'],
    ['help'],
    ['run', '--help'],
    ['help', 'ping'],
    ['doctor', '-h'],
  ]) {
    const result = await launch(args, { CRONRADAR_API_KEY: null, CRONRADAR_BASE_URL: api.url })
      .result
    assert.equal(result.code, 0)
    assert.match(result.stdout, /Usage:/)
    assert.equal(result.stderr, '')
  }
  for (const args of [['--version'], ['-v'], ['run', '--version'], ['ping', '-v']]) {
    const result = await launch(args, { CRONRADAR_API_KEY: null, CRONRADAR_BASE_URL: api.url })
      .result
    assert.equal(result.code, 0)
    assert.equal(result.stdout, '0.1.0\n')
  }
  assert.equal(api.requests.length, 0)
})

test('command options after the separator belong to the child', async (t) => {
  const api = await endpoint(t)
  const result = await launch(
    ['run', '--job', 'node-version', '--', process.execPath, '--version'],
    {
      CRONRADAR_BASE_URL: api.url,
    },
  ).result
  assert.equal(result.code, 0)
  assert.equal(result.stdout.trim(), process.version)
  assert.equal(api.requests.length, 2)
})

test('heartbeat can self-register with schedule and grace using equals syntax', async (t) => {
  const api = await endpoint(t)
  const result = await launch(
    [
      'ping',
      '--job=daily-backup',
      '--state=heartbeat',
      '--schedule=0 2 * JAN-MAR MON-FRI',
      '--grace-period=300',
      '--json',
    ],
    { CRONRADAR_BASE_URL: api.url },
  ).result
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    command: 'ping',
    ok: true,
    code: 'check_in_accepted',
    message: 'CronRadar check-in accepted. Alert delivery is not verified.',
    httpStatus: 200,
  })
  const url = new URL(api.requests[0].url, api.url)
  assert.equal(url.pathname, '/api/v1/ping/daily-backup')
  assert.equal(url.searchParams.get('schedule'), '0 2 * JAN-MAR MON-FRI')
  assert.equal(url.searchParams.get('gracePeriod'), '300')
  assert.equal(api.requests[0].method, 'POST')
})

test('doctor JSON results omit inventory, keys, and connection details', async (t) => {
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(
      JSON.stringify({
        applicationId: 'private-app',
        totalMonitors: 1,
        monitors: [{ name: 'private-job' }],
        extra: KEY,
      }),
    )
  })
  const result = await launch(['doctor', '--json'], { CRONRADAR_BASE_URL: api.url }).result
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).code, 'connection_ready')
  for (const secret of [KEY, 'private-app', 'private-job', api.url])
    assert.equal(result.stdout.includes(secret), false)
})

test('doctor can check one recorded job without exposing its inventory or changing anything', async (t) => {
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({
        applicationId: 'private-app',
        totalMonitors: 2,
        monitors: [
          { monitorKey: 'private-other-job', name: KEY, status: 'critical', lastPingAt: null },
          {
            monitorKey: 'selected-job',
            name: 'private-customer-name',
            status: 'healthy',
            lastPingAt: '2026-09-22T09:00:00.1234567-04:00',
            isPaused: false,
            isPlanLimited: false,
            schedule: 'private-schedule',
            failureMessage: KEY,
          },
        ],
        unexpectedSecret: KEY,
      }),
    )
  })
  for (const format of [[], ['--json']]) {
    const result = await launch(['doctor', '--job=selected-job', ...format], {
      CRONRADAR_BASE_URL: api.url,
    }).result
    assert.equal(result.code, 0)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /2026-09-22T13:00:00.123Z/)
    assert.match(result.stdout, /Completion, capacity, and alert delivery are not verified/)
    for (const secret of [
      KEY,
      'private-app',
      'selected-job',
      'private-other-job',
      'private-customer-name',
      'private-schedule',
      api.url,
    ])
      assert.equal(result.stdout.includes(secret), false)
    if (format.length) {
      const json = JSON.parse(result.stdout)
      assert.equal(json.code, 'job_reporting')
      assert.equal(json.httpStatus, 200)
      assert.deepEqual(json.job, {
        health: 'healthy',
        lastPingAt: '2026-09-22T13:00:00.123Z',
        isPaused: false,
        isPlanLimited: false,
      })
    }
  }
  assert.deepEqual(
    api.requests.map(({ method, url }) => [method, url]),
    [
      ['GET', '/api/v1/sync/status'],
      ['GET', '/api/v1/sync/status'],
    ],
  )
})

test('doctor reports missing, pending, paused, capacity-blocked and unhealthy jobs as actionable failures', async (t) => {
  let monitors = []
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({ applicationId: 'test-app', totalMonitors: monitors.length, monitors }),
    )
  })
  const base = { monitorKey: 'selected-job', status: 'healthy', lastPingAt: '2026-09-22T13:00:00Z' }
  for (const [snapshot, expectedCode] of [
    [[], 'job_not_found'],
    [[{ ...base, status: 'pending', lastPingAt: null }], 'job_pending'],
    [[{ ...base, lastPingAt: null }], 'job_pending'],
    [[{ ...base, status: 'paused' }], 'job_paused'],
    [[{ ...base, isPaused: true }], 'job_paused'],
    [[{ ...base, isPaused: true, isPlanLimited: true }], 'job_plan_limited'],
    [[{ ...base, status: 'warning' }], 'job_warning'],
    [[{ ...base, status: 'critical' }], 'job_critical'],
  ]) {
    monitors = snapshot
    const result = await launch(['doctor', '--job', 'selected-job', '--json'], {
      CRONRADAR_BASE_URL: api.url,
    }).result
    assert.equal(result.code, 1, expectedCode)
    assert.equal(result.stderr, '')
    const json = JSON.parse(result.stdout)
    assert.equal(json.ok, false)
    assert.equal(json.code, expectedCode)
    assert.equal(json.httpStatus, 200)
    assert.ok(json.message.length > 30)
  }
  // Plain doctor remains a connection check, independent of job health.
  const connection = await launch(['doctor', '--json'], { CRONRADAR_BASE_URL: api.url }).result
  assert.equal(connection.code, 0)
  assert.equal(JSON.parse(connection.stdout).code, 'connection_ready')
  assert.ok(api.requests.every((request) => request.method === 'GET'))
})

test('doctor rejects malformed selected-job snapshots without echoing raw fields', async (t) => {
  let monitors = []
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(
      JSON.stringify({ applicationId: 'test-app', totalMonitors: monitors.length, monitors }),
    )
  })
  const base = { monitorKey: 'selected-job', status: 'healthy', lastPingAt: '2026-09-22T13:00:00Z' }
  for (const snapshot of [
    [null],
    [{ status: 'healthy' }],
    [base, base],
    [{ ...base, status: KEY }],
    [{ ...base, lastPingAt: KEY }],
    [{ ...base, lastPingAt: '2026-99-99T13:00:00Z' }],
    [{ ...base, lastPingAt: undefined }],
    [{ ...base, isPaused: 'false' }],
    [{ ...base, isPlanLimited: KEY }],
  ]) {
    monitors = snapshot
    const result = await launch(['doctor', '--job', 'selected-job', '--json'], {
      CRONRADAR_BASE_URL: api.url,
    }).result
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).code, 'invalid_response')
    assert.equal(result.stdout.includes(KEY), false)
  }
})

test('doctor validates the optional job before requesting the service', async (t) => {
  const api = await endpoint(t)
  for (const job of ['', '.', '..', KEY, 'bad\nkey', 'x'.repeat(101)]) {
    const result = await launch(['doctor', `--job=${job}`, '--json'], {
      CRONRADAR_BASE_URL: api.url,
    }).result
    assert.equal(result.code, 2)
    assert.equal(JSON.parse(result.stdout).code, 'invalid_usage')
    assert.equal(result.stdout.includes(KEY), false)
  }
  assert.equal(api.requests.length, 0)
})

test('JSON mode reports configuration, usage and HTTP failures with stable sanitized codes', async (t) => {
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(402, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ secret: KEY, message: 'never-print-this' }))
  })
  for (const [args, env, exitCode, expected] of [
    [['doctor', '--json'], { CRONRADAR_API_KEY: null }, 1, 'missing_api_key'],
    [
      ['doctor', '--json'],
      { CRONRADAR_API_KEY: 'cr_agent_not_an_ingestion_key' },
      1,
      'invalid_api_key',
    ],
    [
      ['doctor', '--json'],
      { CRONRADAR_BASE_URL: 'https://private-user:private-password@example.invalid' },
      1,
      'invalid_base_url',
    ],
    [['ping', '--json', '--job', 'test', '--state', 'incorrect'], {}, 2, 'invalid_usage'],
    [['ping', '--json', '--job', 'test', '--state', 'start'], {}, 1, 'capacity_required'],
  ]) {
    const result = await launch(args, { CRONRADAR_BASE_URL: api.url, ...env }).result
    assert.equal(result.code, exitCode)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.code, expected)
    assert.equal(result.stderr, '')
    for (const secret of [
      KEY,
      'never-print-this',
      'private-password',
      'private-user',
      'cr_agent_not_an_ingestion_key',
    ])
      assert.equal(result.stdout.includes(secret), false)
  }
  assert.equal(api.requests.length, 1)
})

test('invalid cron, identifiers and duplicate options fail before a job or HTTP request starts', async (t) => {
  const api = await endpoint(t)
  const invalidOptions = [
    ['--schedule', '* * * *'],
    ['--schedule', '0 0 0 * * *'],
    ['--schedule', '61 * * * *'],
    ['--schedule', '* 24 * * *'],
    ['--schedule', '* * 0 * *'],
    ['--schedule', '* * * 13 *'],
    ['--schedule', '* * * * 7'],
    ['--schedule', '*/x * * * *'],
    ['--schedule', '* * * * MON-NEVER'],
    ['--grace-period', '1e3'],
    ['--grace-period', '2147483648'],
    ['--schedule', '0 2 * * *', '--schedule=0 3 * * *'],
    ['--json'],
  ]
  for (const options of invalidOptions) {
    const result = await launch(
      runArguments("process.stdout.write('should-not-run')", [], options),
      { CRONRADAR_BASE_URL: api.url },
    ).result
    assert.equal(result.code, 2, options.join(' '))
    assert.equal(result.stdout, '')
  }
  for (const key of ['.', '..', KEY, 'bad\nkey', 'x'.repeat(101)]) {
    const result = await launch(['ping', '--job', key, '--state', 'start'], {
      CRONRADAR_BASE_URL: api.url,
    }).result
    assert.equal(result.code, 2)
    assert.equal(result.stderr.includes(KEY), false)
  }
  assert.equal(api.requests.length, 0)
})

test('schedule shortcuts the service expands are accepted and sent unchanged', async (t) => {
  const api = await endpoint(t)
  const shortcuts = [
    '@yearly',
    '@annually',
    '@monthly',
    '@weekly',
    '@daily',
    '@midnight',
    '@hourly',
    '@DAILY',
  ]
  for (const schedule of shortcuts) {
    const result = await launch(
      runArguments("process.stdout.write('ran')", [], ['--schedule', schedule]),
      { CRONRADAR_BASE_URL: api.url },
    ).result
    assert.equal(result.code, 0, schedule)
    assert.equal(result.stdout, 'ran')
  }
  const starts = api.requests.filter((request) => request.url.includes('/start?'))
  assert.deepEqual(
    starts.map((request) => new URL(request.url, api.url).searchParams.get('schedule')),
    shortcuts,
  )
})

test('@reboot and unknown shortcuts fail before a job or HTTP request starts', async (t) => {
  const api = await endpoint(t)
  for (const schedule of ['@reboot', '@every', '@daily * * * * *', '@']) {
    const result = await launch(
      runArguments("process.stdout.write('should-not-run')", [], ['--schedule', schedule]),
      { CRONRADAR_BASE_URL: api.url },
    ).result
    assert.equal(result.code, 2, schedule)
    assert.equal(result.stdout, '')
    assert.match(result.stderr, /@daily/)
  }
  assert.equal(api.requests.length, 0)
})

test('valid schedules include numeric lists, ranges, steps and month/day abbreviations', async (t) => {
  const api = await endpoint(t)
  for (const schedule of [
    '*/5 * * * *',
    '0,15,30,45 9-17/2 * * 1-5',
    '0 0 1 JAN,JUN MON',
    '0 2 * * *',
    '0 2 * January Monday-Friday',
    '4-2 * * * *',
    '*/0 * * * *',
    '*/-1 * * * *',
    '*/+1 * * * *',
  ]) {
    const result = await launch(
      ['ping', '--job', 'scheduled', '--state', 'complete', '--schedule', schedule],
      { CRONRADAR_BASE_URL: api.url },
    ).result
    assert.equal(result.code, 0, schedule)
  }
  assert.equal(api.requests.length, 9)
})

test('a successful HTTP status alone cannot verify doctor or a check-in', async (t) => {
  let payload = ''
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(payload)
  })
  for (const response of [
    'not-json',
    '{}',
    'null',
    '[]',
    '{"error":"never-print-this"}',
    JSON.stringify({ applicationId: 'private-app', totalMonitors: 2, monitors: [] }),
  ]) {
    payload = response
    const result = await launch(['doctor', '--json'], { CRONRADAR_BASE_URL: api.url }).result
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).code, 'invalid_response')
    assert.equal(result.stdout.includes('never-print-this'), false)
  }
  payload = '{"status":"ok","monitor":"wrong-job"}'
  const result = await launch(['ping', '--job', 'correct-job', '--state', 'complete', '--json'], {
    CRONRADAR_BASE_URL: api.url,
  }).result
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).code, 'invalid_response')
})

test('warnings are sanitized and fail manual verification while preserving command exit', async (t) => {
  const api = await endpoint(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ status: 'ok', monitor: 'sample-job', warning: KEY }))
  })
  const result = await launch(['ping', '--job', 'sample-job', '--state', 'complete', '--json'], {
    CRONRADAR_BASE_URL: api.url,
  }).result
  assert.equal(result.code, 1)
  assert.equal(JSON.parse(result.stdout).code, 'protection_warning')
  assert.equal(JSON.parse(result.stdout).accepted, true)
  assert.equal(result.stdout.includes(KEY), false)
  const run = await launch(runArguments('process.exit(0)'), { CRONRADAR_BASE_URL: api.url }).result
  assert.equal(run.code, 0)
  assert.match(run.stderr, /monitoring warning/)
  assert.equal(run.stderr.includes(KEY), false)
})

test(
  'oversized and stalled JSON bodies stay bounded and never expose their contents',
  { timeout: 10000 },
  async (t) => {
    const huge = await endpoint(t, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ secret: KEY, payload: 'x'.repeat(600 * 1024) }))
    })
    const oversized = await launch(['doctor', '--json'], { CRONRADAR_BASE_URL: huge.url }).result
    assert.equal(oversized.code, 1)
    assert.equal(JSON.parse(oversized.stdout).code, 'invalid_response')
    assert.equal(oversized.stdout.includes(KEY), false)

    const stalled = await endpoint(t, (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.write('{"never-finished":')
    })
    const began = Date.now()
    const result = await launch(['doctor', '--json'], { CRONRADAR_BASE_URL: stalled.url }).result
    assert.equal(result.code, 1)
    assert.equal(JSON.parse(result.stdout).code, 'timeout')
    assert.ok(Date.now() - began < 7000)
  },
)

test('missing executable reports failure and exits 127 without echoing arguments', async (t) => {
  const api = await endpoint(t)
  const outcome = await launch(
    ['run', '--job', 'job', '--', 'cronradar-nonexistent-test-executable', 'never-print-this'],
    { CRONRADAR_BASE_URL: api.url },
  ).result
  assert.equal(outcome.code, 127)
  assert.equal(outcome.stderr.includes('never-print-this'), false)
  assert.match(api.requests[1].url, /\/fail\?/)
})

test(
  'SIGTERM reaches the child and its handled exit code is preserved',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const api = await endpoint(t)
    const { child, result } = launch(
      runArguments(
        "process.on('SIGTERM', () => { process.stdout.write('terminated'); process.exit(23); }); process.stdout.write('ready'); setInterval(() => {}, 1000);",
      ),
      { CRONRADAR_BASE_URL: api.url },
    )
    t.after(() => child.kill('SIGKILL'))
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child did not become ready')), 5000)
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    child.kill('SIGTERM')
    const outcome = await result
    assert.equal(outcome.code, 23)
    assert.equal(outcome.stdout, 'readyterminated')
    assert.match(api.requests[1].url, /\/fail\?/)
  },
)

test(
  'SIGINT reaches the child and returns the conventional signal exit code',
  { skip: process.platform === 'win32', timeout: 10000 },
  async (t) => {
    const api = await endpoint(t)
    const { child, result } = launch(
      runArguments("process.stdout.write('ready'); setInterval(() => {}, 1000);"),
      { CRONRADAR_BASE_URL: api.url },
    )
    t.after(() => child.kill('SIGKILL'))
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Child did not become ready')), 5000)
      child.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('ready')) {
          clearTimeout(timeout)
          resolve()
        }
      })
    })
    child.kill('SIGINT')
    const outcome = await result
    assert.equal(outcome.code, 130)
    assert.match(api.requests[1].url, /\/fail\?/)
  },
)
