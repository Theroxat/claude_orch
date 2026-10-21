#!/usr/bin/env node
/** `orch` CLI entry. Runs inside the agent container and talks to the daemon over the unix socket. */
import { runCli } from './run';

const code = await runCli(process.argv.slice(2), {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
});
process.exitCode = code;
