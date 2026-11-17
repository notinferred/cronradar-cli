# CronRadar CLI

Wrap any scheduled command — a crontab line, a systemd timer, a Kubernetes CronJob — so [CronRadar](https://cronradar.com) hears when it starts, finishes, fails, or never runs. The command's output and exit code stay exactly as they were, and the job still runs when CronRadar is unreachable.

The `cronradar` command requires Node.js 20 or later and has no dependencies. Use it for jobs that don't run inside a framework CronRadar already integrates with; framework jobs are better served by the [SDKs](https://docs.cronradar.com/sdks), which discover them automatically.

## Install

The package is named `@cronradar/cli`. It has not been published to the npm registry yet, so install it from source:

```sh
git clone https://github.com/notinferred/cronradar-cli.git
npm install --global ./cronradar-cli --ignore-scripts --no-audit --no-fund
cronradar --version
```

To build a portable package for another machine or a container image:

```sh
npm pack ./cronradar-cli --ignore-scripts
npm install --global ./cronradar-cli-0.1.0.tgz --offline --ignore-scripts --no-audit --no-fund
```

If you cannot install a global command, the same interface works from the checkout: `node cronradar-cli/bin/cronradar.mjs --help`. `npm uninstall --global @cronradar/cli` removes it.

Use `cronradar help run`, `cronradar ping --help`, or `cronradar doctor --help` for command-specific help. `--version` and `-v` report the package version.

## Setup

Create an application at [app.cronradar.com](https://app.cronradar.com) and supply `CRONRADAR_API_KEY` through your scheduler's environment or deployment secret manager. Use an ingestion key beginning with `ck_app_`, not a temporary agent management token. The CLI never accepts a key in command arguments, prints it, or saves it to disk. Use a separate application and key for each environment.

Then check the connection:

```sh
cronradar doctor
```

## Quickstart: run a job

```sh
cronradar run --job daily-backup --schedule "0 2 * * *" --grace-period 300 -- node -e "console.log('Job finished')"
```

`run` reports a start, executes the command after `--`, then reports completion, or failure with the exit code. Replace the executable and arguments after `--` with your command. The CLI does not start a shell or edit your schedule. Keep using cron, your deployment platform, or another scheduler to decide when the command runs. The schedule describes when CronRadar should expect a report; include it to create a missing monitor automatically.

Write `--schedule` in the application's time zone, which is UTC unless set: CronRadar evaluates every schedule there ([schedule syntax](https://docs.cronradar.com/schedules)). `--schedule` does not schedule the command: the example runs immediately. In a scheduler with a restricted `PATH` or a different working directory, use absolute executable and script paths.

Pipes, redirects, and wildcards are passed as literal arguments. If a job needs shell syntax, invoke a shell explicitly:

```sh
cronradar run --job nightly-report --schedule "0 1 * * *" -- sh -c 'node report.js > report.txt'
```

On Windows, use an executable such as `node.exe` or `powershell.exe`. For `.cmd` or `.bat` jobs, explicitly invoke `cmd.exe /d /c` after `--` and follow that shell's quoting rules. The CLI does not reconstruct a shell command from the job's arguments.

The command's arguments, working directory, input, output, and numeric exit code are preserved. Start and terminal reports share a fresh execution ID. A nonzero exit records failure; command output is never uploaded. SIGINT and SIGTERM are forwarded to the immediate child. A child terminated by a signal returns the conventional `128 + signal number` exit code. The CLI does not manage detached grandchildren or process trees.

The child inherits the environment. CLI diagnostics go to stderr, prefixed with `[CronRadar]`. Only lifecycle metadata and a generic failure message containing the exit code or signal are sent. `--json` is unavailable on `run` so the job's stdout stays unchanged. Signal behavior depends on the operating system; Unix forwarding tests are separate from Windows behavior.

## Crontab

Cron starts jobs with a minimal environment and `PATH`, so give the absolute path of `cronradar` (find it with `command -v cronradar`) and of your script. Keep the key in a file only the job's user can read, rather than in the crontab itself:

```sh
# /etc/cronradar.env, mode 600, owned by the job's user
CRONRADAR_API_KEY=ck_app_your_key
```

```crontab
# m h dom mon dow  command
0 2 * * *    set -a; . /etc/cronradar.env; set +a; /usr/local/bin/cronradar run --job daily-backup --schedule "0 2 * * *" -- /usr/local/bin/backup.sh
*/15 * * * * set -a; . /etc/cronradar.env; set +a; /usr/local/bin/cronradar run --job sync-orders --schedule "*/15 * * * *" --grace-period 120 -- /opt/app/bin/sync-orders
@daily       set -a; . /etc/cronradar.env; set +a; /usr/local/bin/cronradar run --job rotate-logs --schedule @daily -- /usr/sbin/logrotate /etc/logrotate.conf
```

`set -a` exports the variables the file defines, so the same file also works as a systemd `EnvironmentFile`.

Copy the crontab's own schedule into `--schedule`. Cron reads it in the host's time zone and CronRadar reads it in the application's, so set the application's time zone to match the host, or both to UTC. `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, and `@hourly` are accepted; `@reboot` is not, because it has no recurring schedule to monitor. Escape a literal `%` in a crontab command as `\%`.

Cron mails or discards output as before: the CLI passes it through untouched. To keep it, redirect inside an explicit shell, as in the `sh -c` example above.

## systemd timer

The service runs the wrapped command; the timer decides when.

```ini
# /etc/systemd/system/daily-backup.service
[Unit]
Description=Daily backup

[Service]
Type=oneshot
User=backup
# The same /etc/cronradar.env as the crontab example
EnvironmentFile=/etc/cronradar.env
ExecStart=/usr/local/bin/cronradar run --job daily-backup --schedule "0 2 * * *" -- /usr/local/bin/backup.sh
```

```ini
# /etc/systemd/system/daily-backup.timer
[Unit]
Description=Run daily backup at 02:00 UTC

[Timer]
OnCalendar=*-*-* 02:00:00 UTC
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now daily-backup.timer
systemctl list-timers daily-backup.timer
```

`OnCalendar` uses the host's local time unless it names a zone, so write the time zone in it and use the matching five-field expression in `--schedule`. The service's exit status is the wrapped command's, so `systemctl status` and `journalctl -u daily-backup` report the job's own result. `systemctl stop` sends SIGTERM, which the CLI forwards to the job.

## Kubernetes CronJob

Install the CLI into the job's image and make it the container's command. The image needs Node.js 20 or later; build it from the package created by `npm pack` above:

```dockerfile
FROM node:20-slim
COPY cronradar-cli-0.1.0.tgz /tmp/
RUN npm install --global /tmp/cronradar-cli-0.1.0.tgz --offline --ignore-scripts --no-audit --no-fund && rm /tmp/cronradar-cli-0.1.0.tgz
COPY report.js /app/report.js
```

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-report
spec:
  schedule: '0 2 * * *'
  timeZone: 'Etc/UTC'
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      backoffLimit: 0
      template:
        spec:
          restartPolicy: Never
          containers:
            - name: report
              image: registry.example.com/nightly-report:1.0.0
              command:
                - cronradar
                - run
                - --job
                - nightly-report
                - --schedule
                - '0 2 * * *'
                - --
                - node
                - /app/report.js
              env:
                - name: CRONRADAR_API_KEY
                  valueFrom:
                    secretKeyRef:
                      name: cronradar
                      key: api-key
```

Create the secret from a file, so the key stays out of shell history:

```sh
kubectl create secret generic cronradar --from-file=api-key=./cronradar-api-key
```

The container exits with the job's own code, so Kubernetes marks the Job failed exactly as it would without the wrapper. Each retry is a new execution with its own start and terminal report; with `backoffLimit: 0` there is one report per scheduled run. Pod termination sends SIGTERM to the CLI, which forwards it to the job. Keep `timeZone` and the application's time zone the same.

## Check the connection

```sh
cronradar doctor
cronradar doctor --json
```

This reads sync status and verifies the HTTP result, JSON body, and expected response shape without printing the returned inventory. It verifies the connection, not job execution, plan capacity, or alert delivery. It sends no heartbeat, creates no monitor, and sends no test alert. A successful connection exits 0; a configuration or connection problem exits 1.

After your real scheduled command runs, check the intended job:

```sh
cronradar doctor --job daily-backup
cronradar doctor --job daily-backup --json
```

The optional job check uses the same read-only request. It exits 1 if the job is missing, pending, paused, limited by plan capacity, late, or critical. It exits 0 only when the selected job reports healthy and has a recorded check-in. Output includes only its health, a normalized last check-in timestamp, and pause/capacity flags when the service supplies them; it never prints job names, keys, schedules, or the rest of the inventory.

Compare the timestamp with your scheduler's expected run. It may describe an old check-in, and the API does not distinguish a start from a completed execution here. Confirm completion and alert delivery in the dashboard. Older services that omit the pause/capacity flags cannot support those additional checks.

## Manual lifecycle reporting

Record a heartbeat and create a missing monitor:

```sh
cronradar ping --job daily-backup --state heartbeat --schedule "0 2 * * *" --grace-period 300
```

Report a lifecycle when your scheduler already executes the command:

```sh
cronradar ping --job daily-backup --state start --run-id scheduled-run-1 --schedule "0 2 * * *"
cronradar ping --job daily-backup --state complete --run-id scheduled-run-1 --json
```

Use `--state fail` instead of `complete` after a failed execution. Reuse one run ID across an execution's start and terminal report, and choose a new ID for the next execution. Without `--schedule`, `ping` expects an existing monitor. Successful acceptance exits 0; a configuration error, rejected report, monitoring warning, or connection failure exits 1; invalid arguments exit 2.

A heartbeat reports success without duration tracking. The CLI does not send outcome values: jobs with outcome expectations need the completion HTTP API or a supporting SDK. Check-in acceptance does not verify alert delivery or protection of every job.

## Options reference

| Option                   | Commands                | Meaning                                                                                                                                                                                                                                                                                                 |
| ------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--job KEY`              | `run`, `ping`, `doctor` | Stable key, 1–100 characters; required for `run` and `ping`, optional for `doctor`. No control characters, dot paths, or known credential formats.                                                                                                                                                      |
| `--schedule CRON`        | `run`, `ping`           | Five fields: minute, hour, day of month, month, day of week. Numbers, wildcards, lists, ranges, steps, and English month/day names are supported. Sunday is 0; Saturday is 6. Or one of `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`. No seconds field or `@reboot`. |
| `--grace-period SECONDS` | `run`, `ping`           | Whole seconds from 60 to 2147483647. Omit to use the service/application default.                                                                                                                                                                                                                       |
| `--state STATE`          | `ping`                  | Required: `heartbeat`, `start`, `complete`, or `fail`.                                                                                                                                                                                                                                                  |
| `--run-id ID`            | `ping`                  | Optional opaque execution identifier, up to 128 characters.                                                                                                                                                                                                                                             |
| `--json`                 | `doctor`, `ping`        | One sanitized JSON result on stdout, including configuration and usage failures.                                                                                                                                                                                                                        |
| `--help`, `-h`           | All                     | Help without a network request.                                                                                                                                                                                                                                                                         |
| `--version`, `-v`        | All                     | Package version without a network request.                                                                                                                                                                                                                                                              |
| `--`                     | `run`                   | Required boundary before the executable; everything afterward belongs to the job.                                                                                                                                                                                                                       |

Value options accept both `--job daily-backup` and `--job=daily-backup`. Duplicate options are rejected. The server remains authoritative for schedule and monitor configuration; validation does not change the supplied expression, and a shortcut is sent as written for the server to expand.

For compatibility with the service's NCrontab parser, reversed ranges and nonpositive steps are accepted: the server sorts reversed endpoints and treats steps of zero or less as one. Prefer ascending ranges and positive steps so the intended schedule is clear.

## Environment variables

| Variable             | Required | Meaning                                                                                                                                                       |
| -------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CRONRADAR_API_KEY`  | yes      | Application ingestion key beginning with `ck_app_`. Without it, `run` still executes the job and prints one diagnostic; `ping` and `doctor` exit 1.           |
| `CRONRADAR_BASE_URL` | no       | Ingestion origin, default `https://cron.life`. Must be HTTPS without credentials, a path, a query, or a fragment. HTTP is accepted only for loopback testing. |

Authentication is sent in a Basic authorization header. Redirects are not followed, responses are bounded to 512 KiB, and raw responses and exception text are never printed.

## Error handling

Monitoring never stops or changes the job. Missing keys, invalid connection settings, and monitoring outages still allow the requested job to run. Each monitoring request has a three-second deadline, with no retry. Reporting can delay the command's start by up to three seconds and keep the CLI running for up to three seconds after the command finishes: six seconds total. Invalid CLI syntax exits with code 2 before a command starts. An executable that cannot be found returns 127; permission failures return 126.

## Structured output

`doctor --json` and `ping --json` produce one object, with no raw responses, inventory, request URL, job arguments, or credentials:

```json
{
  "schemaVersion": 1,
  "command": "doctor",
  "ok": true,
  "code": "connection_ready",
  "message": "CronRadar connection is ready. No monitor was changed. Job execution, capacity, and alert delivery are not verified.",
  "httpStatus": 200
}
```

Use `code` and the process exit status for automation rather than parsing the human message. `httpStatus` is present when an HTTP rejection or accepted response supplies it. A recorded check-in with a monitoring warning has `ok: false`, `code: "protection_warning"`, and `accepted: true`; review protection before depending on alerts.

With `doctor --job`, `code: "job_reporting"` indicates the selected job is healthy with a recorded check-in. The additional `job` object contains `health`, `lastPingAt` (UTC timestamp or `null`), and optional `isPaused`/`isPlanLimited` booleans. Missing or malformed job data never produces a successful job check.

## Troubleshooting

| Symptom or result code                       | Next step                                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `cronradar: not found` under cron or systemd | Use the absolute path from `command -v cronradar`; the scheduler's `PATH` is not your shell's.                                |
| Job runs but nothing appears in CronRadar    | Look for `[CronRadar]` lines in the job's stderr (cron mail, `journalctl`, `kubectl logs`); each names its result code below. |
| `missing_api_key`, `invalid_api_key`         | Make the ingestion key available to the scheduled process, not just your interactive shell.                                   |
| `invalid_base_url`                           | Use an HTTPS origin such as `https://cron.life` without a path or embedded credentials.                                       |
| `authentication_failed`                      | Check the application/environment, or rotate an expired or revoked key.                                                       |
| `request_blocked`                            | Check the ingestion hostname, firewall, or proxy configuration.                                                               |
| `not_found`                                  | Check the application key and include `--schedule` for a missing monitor.                                                     |
| `capacity_required`, `protection_warning`    | Free capacity or ask the workspace owner to review billing; no automatic upgrade is made.                                     |
| `invalid_report`, `invalid_usage`            | Review command help, job key, schedule, and grace period.                                                                     |
| `rate_limited`                               | Reduce reporting frequency or review the application's key limits. No retry is sent.                                          |
| `redirect_refused`, `invalid_response`       | Check the ingestion origin. A login page or generic JSON object is not successful authentication.                             |
| `connection_failed`, `timeout`, `http_error` | Check connectivity or service availability, then rerun `doctor`. The job itself already ran with its own result.              |
| Job reported late although it ran on time    | The scheduler and the application read the schedule in different time zones; align them.                                      |
| `job_not_found`                              | Confirm the job key and application; include `--schedule` when wrapping a missing job.                                        |
| `job_pending`                                | Let the real scheduled command run, then check again.                                                                         |
| `job_paused`, `job_plan_limited`             | Review the pause reason and available plan capacity in the dashboard.                                                         |
| `job_warning`, `job_critical`                | Check the scheduler, latest execution, and incident before considering setup verified.                                        |

## Verification and migration

1. Run `doctor` to verify credentials and connectivity.
2. Wrap one real command and let it execute through its normal scheduler.
3. Run `doctor --job YOUR_JOB_KEY` to check for a recorded job and its current health. Confirm the expected schedule, protection status, and interpreted result in the dashboard. A start report alone does not verify completion.
4. Configure the application's alert destination and verify delivery through alert settings. `doctor` is not an alert test.
5. Keep an existing monitoring service active until reporting and alerts are verified. Then deliberately remove its instrumentation. Preserve the CronRadar job key when changing wrappers.

The CLI does not import another provider's inventory, modify crontab, retry commands, or configure alert destinations. Removing the wrapper restores the original executable and arguments; pause its monitor if the job should no longer be watched.

## Development

```sh
npm test
```

Tests use local HTTP servers, real child processes, and an offline package/install smoke test in a temporary prefix. They send no production check-ins or alerts and do not change the user's global installation. Unix-specific signal tests are skipped on Windows. Pushes and pull requests run them on Node.js 20, 22, and 24 (`.github/workflows/ci.yml`); a `v*` tag matching `package.json` publishes to npm with provenance (`.github/workflows/publish.yml`). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Links

- [CronRadar](https://cronradar.com)
- [Documentation](https://docs.cronradar.com), including [this guide](https://docs.cronradar.com/cli)
- [Dashboard](https://app.cronradar.com)
- [HTTP API reference](https://docs.cronradar.com/api-reference)
- [Machine-readable ingestion contract](https://docs.cronradar.com/openapi.json)

## License

MIT. See [LICENSE](LICENSE).
