#!/usr/bin/env bun
/**
 * List / search / inspect pi sessions.
 *
 * Usage:
 *   bun sessions.ts                          # list recent sessions (last 7d)
 *   bun sessions.ts --cwd ~/Dev/scout        # filter by project
 *   bun sessions.ts --since 14d              # last 14 days
 *   bun sessions.ts --since 2026-01-05       # since date
 *   bun sessions.ts --grep "turboread"       # grep user messages
 *   bun sessions.ts --id <uuid>              # show single session detail
 *   bun sessions.ts --verbose                # show user messages inline
 *   bun sessions.ts --json                   # JSON output
 *   bun sessions.ts --fancy                  # unicode/emoji formatting
 */

import {
  loadSessions,
  summariseSession,
  formatDuration,
  formatCost,
  formatTokens,
  shortPath,
  truncate,
  parseArgs,
  parseDateArg,
  type SessionSummary,
} from "./lib";

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 7 * 86400000);
  const until = args.until ? parseDateArg(args.until as string) : undefined;
  const cwd = args.cwd as string | undefined;
  const grep = args.grep as string | undefined;
  const targetId = args.id as string | undefined;
  const verbose = !!args.verbose;
  const json = !!args.json;
  const fancy = !!args.fancy;
  const limit = args.limit ? parseInt(args.limit as string) : undefined;

  const model = args.model as string | undefined;
  const sessions = await loadSessions({ cwd, since, until, limit, model });
  const summaries = sessions.map(summariseSession);

  // Single session detail
  if (targetId) {
    const match = summaries.find((s) => s.id === targetId || s.id.startsWith(targetId));
    if (!match) {
      console.error(`No session found matching: ${targetId}`);
      process.exit(1);
    }
    printDetail(match, fancy);
    return;
  }

  // Grep filter
  let filtered = summaries;
  if (grep) {
    const re = new RegExp(grep, "i");
    filtered = summaries.filter((s) =>
      s.userMessages.some((m) => re.test(m.text))
    );
  }

  if (json) {
    console.log(JSON.stringify(filtered, null, 2));
    return;
  }

  const sep = fancy ? "─" : "-";

  // Table output
  console.log(`\nSessions: ${filtered.length} (since ${since.toLocaleDateString()})\n`);

  const header = `${"Date".padEnd(12)} ${"Duration".padEnd(10)} ${"Cost".padEnd(8)} ${"Msgs".padEnd(6)} ${"Tools".padEnd(7)} ${"Errs".padEnd(5)} ${"Model".padEnd(28)} ${"First message"}`;
  console.log(header);
  console.log(sep.repeat(header.length));

  for (const s of filtered) {
    const date = s.startTime.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    const time = s.startTime.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const firstMsg = s.userMessages[0]?.text.replace(/\n/g, " ") ?? "";
    const model = s.models[0] ?? "?";

    console.log(
      `${(date + " " + time).padEnd(12)} ${formatDuration(s.durationMs).padEnd(10)} ${formatCost(s.totalCost).padEnd(8)} ${String(s.messageCount).padEnd(6)} ${String(s.toolCalls.length).padEnd(7)} ${String(s.errorCount).padEnd(5)} ${truncate(model, 27).padEnd(28)} ${truncate(firstMsg, 60)}`
    );

    if (verbose) {
      for (const um of s.userMessages) {
        console.log(`  > ${truncate(um.text.replace(/\n/g, " "), 100)}`);
      }
    }
  }

  console.log();

  // Quick stats
  const totalCost = filtered.reduce((s, x) => s + x.totalCost, 0);
  const totalTokensIn = filtered.reduce((s, x) => s + x.inputTokens, 0);
  const totalTokensOut = filtered.reduce((s, x) => s + x.outputTokens, 0);
  console.log(`Total cost: ${formatCost(totalCost)}  |  In: ${formatTokens(totalTokensIn)}  |  Out: ${formatTokens(totalTokensOut)}  |  Sessions: ${filtered.length}`);
  console.log();
}

function printDetail(s: SessionSummary, fancy: boolean) {
  const sep = fancy ? "─" : "-";

  console.log(`\nSession: ${s.id}`);
  console.log(`CWD:      ${s.cwd}`);
  console.log(`File:     ${shortPath(s.file)}`);
  console.log(`Start:    ${s.startTime.toISOString()}`);
  console.log(`End:      ${s.endTime.toISOString()}`);
  console.log(`Duration: ${formatDuration(s.durationMs)}`);
  console.log(`Cost:     ${formatCost(s.totalCost)}`);
  console.log(`Models:   ${s.models.join(", ")}`);
  console.log(`Messages: ${s.messageCount}  Tools: ${s.toolCalls.length}  Errors: ${s.errorCount}`);
  console.log(`Tokens:   In ${formatTokens(s.inputTokens)} / Out ${formatTokens(s.outputTokens)} / Cache ${formatTokens(s.cacheRead)}`);

  console.log(`\n${fancy ? "── User Messages ──" : "User Messages"}`);
  for (const um of s.userMessages) {
    const ts = um.timestamp.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    console.log(`[${ts}] ${truncate(um.text.replace(/\n/g, " "), 120)}`);
  }

  // Tool breakdown
  const toolCounts = new Map<string, number>();
  for (const tc of s.toolCalls) {
    toolCounts.set(tc.name, (toolCounts.get(tc.name) || 0) + 1);
  }
  if (toolCounts.size > 0) {
    console.log(`\n${fancy ? "── Tool Usage ──" : "Tool Usage"}`);
    const sorted = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
    for (const [name, count] of sorted) {
      console.log(`${name.padEnd(20)} ${count}`);
    }
  }

  // Errors
  const errors = s.toolResults.filter((r) => r.isError);
  if (errors.length > 0) {
    console.log(`\n${fancy ? `── Errors (${errors.length}) ──` : `Errors (${errors.length})`}`);
    for (const e of errors.slice(0, 5)) {
      console.log(`${e.toolName ?? "?"}: ${JSON.stringify(e.details ?? {}).slice(0, 100)}`);
    }
  }

  console.log();
}

main().catch(console.error);
