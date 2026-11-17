#!/usr/bin/env node
import { main } from '../src/cli.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch {
  // Exception text can contain user arguments or connection details.
  process.stderr.write('[CronRadar] The CLI could not finish the request.\n');
  process.exitCode = 1;
}
