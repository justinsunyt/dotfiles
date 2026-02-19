#!/usr/bin/env bun
/**
 * Unified entry point for pi-introspect.
 *
 * Usage:
 *   bun pi-introspect.ts sessions [flags]         # list/search sessions
 *   bun pi-introspect.ts costs [flags]             # cost breakdown
 *   bun pi-introspect.ts diagnose [flags]          # detect failures/mistakes
 *   bun pi-introspect.ts turboread [flags]         # turboread benchmark
 *   bun pi-introspect.ts dump <id|--latest> [flags]# dump conversation
 *   bun pi-introspect.ts timing [flags]            # time analysis
 *   bun pi-introspect.ts help                      # this message
 */

import { resolve, dirname } from "path";

const SCRIPTS_DIR = dirname(new URL(import.meta.url).pathname);
const command = process.argv[2];
const rest = process.argv.slice(3);

const COMMANDS: Record<string, string> = {
  sessions: "sessions.ts",
  costs: "costs.ts",
  diagnose: "diagnose.ts",
  turboread: "turboread-bench.ts",
  dump: "dump.ts",
  timing: "timing.ts",
  query: "query.ts",
};

function help() {
  console.log(`
  pi-introspect — analyse pi sessions, costs, and performance

  Commands:
    sessions   List/search/inspect sessions        --since 7d --cwd <path> --grep <term> --verbose
    costs      Cost breakdown by model              --since 30d --daily --cwd <path> --model opus
    diagnose   Detect failures, mistakes, patterns  --since 7d --tool turboread --failures
    turboread  Turboread benchmark stats            --since 14d --failures
    dump       Dump session conversation            <id> | --latest [--cwd <path>] [--tools]
    timing     Time analysis & tool usage           --since 7d --hourly --tools
    query      JSONL data dump for piping           --since 7d --group day --model opus --fields id,totalCost

  Common flags:
    --since <date|Nd|Nh>   Filter to sessions after date (default 7d)
    --cwd <path>           Filter to sessions from this directory
    --model <str>          Filter to sessions using this model (substring match)
    --json                 Output JSON instead of table
    --limit <n>            Max sessions to process

  Examples:
    bun pi-introspect.ts costs --model opus --since 7d --daily
    bun pi-introspect.ts query --since 7d --group day | jq -r '"\(.key) $\(.cost)"'
    bun pi-introspect.ts query --model opus --group day --since 7d
    bun pi-introspect.ts sessions --since 7d --verbose
    bun pi-introspect.ts diagnose --tool turboread --failures
    bun pi-introspect.ts dump --latest --cwd ~/Dev/scout --tools
`);
}

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    help();
    return;
  }

  const script = COMMANDS[command];
  if (!script) {
    console.error(`Unknown command: ${command}\n`);
    help();
    process.exit(1);
  }

  const scriptPath = resolve(SCRIPTS_DIR, script);

  // Re-exec with bun, passing remaining args
  const proc = Bun.spawn(["bun", scriptPath, ...rest], {
    stdio: ["inherit", "inherit", "inherit"],
    env: process.env,
  });
  const exitCode = await proc.exited;
  process.exit(exitCode);
}

main();
