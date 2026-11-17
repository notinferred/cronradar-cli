# Changelog

All notable changes to the CronRadar CLI will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - Unreleased

First public release, moved from the CronRadar monorepo's `cli/` directory.

### Added

- `cronradar run` wraps a command, reporting start and then completion or failure with the exit code; output, input and exit code are preserved, and the job runs even when CronRadar is unreachable.
- `cronradar ping` reports a heartbeat or a lifecycle state for a job the scheduler already runs.
- `cronradar doctor` checks the connection and, with `--job`, one job's health, with one read-only request.
- `--schedule` accepts five-field cron expressions and the `@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight` and `@hourly` shortcuts; `@reboot` is rejected.
- MIT license.
