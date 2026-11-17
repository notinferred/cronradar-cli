import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))

async function command(executable, args, options) {
  const { expectedExit = 0, ...spawnOptions } = options
  const child = spawn(executable, args, {
    ...spawnOptions,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (data) => {
    stdout += data
  })
  child.stderr.on('data', (data) => {
    stderr += data
  })
  return await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === expectedExit) resolve(stdout)
      else reject(new Error(`Package smoke command failed (${code}): ${stderr}`))
    })
  })
}

test(
  'npm tarball installs offline and exposes a working cronradar command',
  { timeout: 60000 },
  async (t) => {
    const temporary = await mkdtemp(path.join(tmpdir(), 'cronradar-cli-package-'))
    t.after(async () => {
      // Validate the exact temporary root before recursive cleanup on every platform.
      assert.equal(path.dirname(path.resolve(temporary)), path.resolve(tmpdir()))
      assert.ok(path.basename(temporary).startsWith('cronradar-cli-package-'))
      await rm(temporary, { recursive: true, force: true })
    })
    const npmCli =
      process.env.npm_execpath ||
      path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')
    const npm =
      process.platform === 'win32' || process.env.npm_execpath
        ? [process.execPath, npmCli]
        : ['npm']
    const userConfig = path.join(temporary, 'empty.npmrc')
    await writeFile(userConfig, '')
    const env = {
      ...process.env,
      CRONRADAR_API_KEY: '',
      npm_config_cache: path.join(temporary, 'cache'),
      npm_config_userconfig: userConfig,
      npm_config_offline: 'true',
      npm_config_ignore_scripts: 'true',
      npm_config_update_notifier: 'false',
    }
    const options = { cwd: temporary, env }
    const packed = JSON.parse(
      await command(
        npm[0],
        [...npm.slice(1), 'pack', packageRoot, '--json', '--ignore-scripts', '--offline'],
        options,
      ),
    )[0]
    assert.equal(packed.name, '@cronradar/cli')
    assert.ok(packed.files.some((file) => file.path === 'bin/cronradar.mjs'))
    assert.ok(packed.files.some((file) => file.path === 'src/cli.mjs'))
    assert.ok(packed.files.some((file) => file.path === 'LICENSE'))
    assert.ok(
      packed.files.every((file) =>
        /^(?:bin\/|src\/|README\.md$|CHANGELOG\.md$|LICENSE$|package\.json$)/.test(file.path),
      ),
    )

    const prefix = path.join(temporary, 'installed')
    await command(
      npm[0],
      [
        ...npm.slice(1),
        'install',
        '--global',
        '--prefix',
        prefix,
        path.join(temporary, packed.filename),
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      options,
    )
    const installedRoot =
      process.platform === 'win32'
        ? path.join(prefix, 'node_modules/@cronradar/cli')
        : path.join(prefix, 'lib/node_modules/@cronradar/cli')
    const manifest = JSON.parse(await readFile(path.join(installedRoot, 'package.json'), 'utf8'))
    assert.equal(manifest.bin.cronradar, 'bin/cronradar.mjs')
    assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0)
    const shim =
      process.platform === 'win32'
        ? path.join(prefix, 'cronradar.cmd')
        : path.join(prefix, 'bin/cronradar')
    await access(shim)

    // Exercise npm's generated command, not only the original checkout entrypoint.
    const invoke = (args) =>
      process.platform === 'win32'
        ? command(
            process.env.ComSpec || 'cmd.exe',
            ['/d', '/s', '/c', `""${shim}" ${args.join(' ')}"`],
            { ...options, windowsVerbatimArguments: true },
          )
        : command(shim, args, options)
    assert.equal((await invoke(['--version'])).trim(), manifest.version)
    assert.match(await invoke(['doctor', '--help']), /one read-only request/)
    assert.match(
      await command(
        process.execPath,
        [path.join(installedRoot, 'bin/cronradar.mjs'), 'help', 'run'],
        options,
      ),
      /cronradar run/,
    )

    const requests = []
    const api = createServer((request, response) => {
      requests.push({ url: request.url, method: request.method })
      const path = new URL(request.url, 'http://localhost').pathname
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify(
          path.endsWith('/sync/status')
            ? {
                applicationId: 'fixture-app',
                totalMonitors: 1,
                monitors: [
                  {
                    monitorKey: 'package-smoke',
                    status: 'healthy',
                    lastPingAt: '2026-09-22T13:00:00Z',
                  },
                ],
              }
            : {
                status: path.endsWith('/fail') ? 'failure_recorded' : 'ok',
                monitor: 'package-smoke',
              },
        ),
      )
    })
    await new Promise((resolve) => api.listen(0, '127.0.0.1', resolve))
    t.after(
      () =>
        new Promise((resolve) => {
          api.closeAllConnections()
          api.close(resolve)
        }),
    )
    const installedOptions = {
      ...options,
      env: {
        ...env,
        CRONRADAR_API_KEY: 'ck_app_package_fixture_only',
        CRONRADAR_BASE_URL: `http://127.0.0.1:${api.address().port}`,
      },
    }
    const installed = path.join(installedRoot, 'bin/cronradar.mjs')
    const doctor = JSON.parse(
      await command(process.execPath, [installed, 'doctor', '--json'], installedOptions),
    )
    assert.equal(doctor.code, 'connection_ready')
    const job = JSON.parse(
      await command(
        process.execPath,
        [installed, 'doctor', '--job', 'package-smoke', '--json'],
        installedOptions,
      ),
    )
    assert.equal(job.code, 'job_reporting')
    assert.equal(job.job.health, 'healthy')
    const ping = JSON.parse(
      await command(
        process.execPath,
        [
          installed,
          'ping',
          '--job',
          'package-smoke',
          '--state',
          'heartbeat',
          '--schedule',
          '0 2 * * *',
          '--json',
        ],
        installedOptions,
      ),
    )
    assert.equal(ping.code, 'check_in_accepted')
    assert.equal(
      await command(
        process.execPath,
        [
          installed,
          'run',
          '--job',
          'package-smoke',
          '--',
          process.execPath,
          '-e',
          "process.stdout.write('installed-job'); process.exit(7)",
        ],
        { ...installedOptions, expectedExit: 7 },
      ),
      'installed-job',
    )
    assert.equal(requests.length, 5)
    assert.match(requests[3].url, /\/start\?run_id=/)
    assert.match(requests[4].url, /\/fail\?run_id=/)
  },
)
