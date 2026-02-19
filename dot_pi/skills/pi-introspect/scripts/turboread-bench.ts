#!/usr/bin/env bun
/**
 * Benchmark turboread performance from session data.
 *
 * Usage:
 *   bun turboread-bench.ts                    # all turboread calls, last 14d
 *   bun turboread-bench.ts --since 30d        # last 30 days
 *   bun turboread-bench.ts --cwd ~/Dev/scout  # filter by project
 *   bun turboread-bench.ts --failures         # only failures
 *   bun turboread-bench.ts --json             # JSON output
 *   bun turboread-bench.ts --fancy            # unicode/box formatting
 */

import {
  loadSessions,
  formatDuration,
  formatCost,
  parseArgs,
  parseDateArg,
  truncate,
  type ParsedSession,
} from "./lib";

interface TurboreadCall {
  sessionId: string;
  sessionCwd: string;
  queries: Array<{ query: string; hints?: string }>;
  invokeTime: Date;
  completeTime: Date;
  durationMs: number;
  iterations?: number;
  cost?: number;
  rangeCount?: number;
  symbolCount?: number;
  fileCount?: number;
  isError: boolean;
  status?: string;
  agentDetails?: any[];
}

function extractTurboreadCalls(session: ParsedSession): TurboreadCall[] {
  const calls: TurboreadCall[] = [];
  const pending = new Map<string, { queries: any[]; timestamp: string }>();

  for (const entry of session.messages) {
    const msg = entry.message;

    if (msg.role === "assistant") {
      for (const block of msg.content ?? []) {
        if ((block.type === "toolCall" || block.type === "tool_use") && "name" in block && block.name === "turboread") {
          const args = "arguments" in block ? block.arguments : "input" in block ? block.input : {};
          const id = "id" in block ? block.id : undefined;
          if (id) {
            pending.set(id, { queries: args?.queries ?? [], timestamp: entry.timestamp });
          }
        }
      }
    }

    if (msg.toolName === "turboread" && msg.toolCallId) {
      const invoke = pending.get(msg.toolCallId);
      if (invoke) {
        const invokeTime = new Date(invoke.timestamp);
        const completeTime = new Date(entry.timestamp);
        const details = msg.details ?? {};

        calls.push({
          sessionId: session.header.id,
          sessionCwd: session.header.cwd,
          queries: invoke.queries,
          invokeTime,
          completeTime,
          durationMs: completeTime.getTime() - invokeTime.getTime(),
          iterations: details.agents?.[0]?.iterations,
          cost: details.totalUsage?.cost,
          rangeCount: details.rangeCount,
          symbolCount: details.symbolCount,
          fileCount: details.fileCount,
          isError: msg.isError ?? false,
          status: details.status,
          agentDetails: details.agents,
        });
        pending.delete(msg.toolCallId);
      }
    }
  }

  return calls;
}

function percentile(arr: number[], p: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 14 * 86400000);
  const cwd = args.cwd as string | undefined;
  const failuresOnly = !!args.failures;
  const json = !!args.json;
  const fancy = !!args.fancy;

  const sessions = await loadSessions({ cwd, since });
  const allCalls = sessions.flatMap(extractTurboreadCalls);

  if (json) {
    console.log(JSON.stringify(allCalls, null, 2));
    return;
  }

  let calls = allCalls;
  if (failuresOnly) calls = calls.filter((c) => c.isError);

  const successful = calls.filter((c) => !c.isError && c.status === "done");
  const failed = calls.filter((c) => c.isError || (c.status && c.status !== "done"));

  console.log(`\nTURBOREAD PERFORMANCE BENCHMARK\n`);

  console.log(`Total calls:   ${calls.length}`);
  console.log(`Successful:    ${successful.length}`);
  console.log(`Failed:        ${failed.length}`);
  console.log(`Success rate:  ${calls.length > 0 ? ((successful.length / calls.length) * 100).toFixed(1) : 0}%\n`);

  if (successful.length > 0) {
    const durations = successful.map((c) => c.durationMs);
    const costs = successful.filter((c) => c.cost).map((c) => c.cost!);
    const iters = successful.filter((c) => c.iterations).map((c) => c.iterations!);
    const ranges = successful.filter((c) => c.rangeCount).map((c) => c.rangeCount!);

    const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;

    console.log("Duration");
    console.log(`  Average:  ${formatDuration(avg(durations))}`);
    console.log(`  Median:   ${formatDuration(percentile(durations, 0.5))}`);
    console.log(`  P90:      ${formatDuration(percentile(durations, 0.9))}`);
    console.log(`  Min:      ${formatDuration(Math.min(...durations))}`);
    console.log(`  Max:      ${formatDuration(Math.max(...durations))}\n`);

    if (costs.length > 0) {
      console.log("Cost");
      console.log(`  Average:  ${formatCost(avg(costs))}`);
      console.log(`  Total:    ${formatCost(costs.reduce((a, b) => a + b, 0))}`);
      console.log(`  Min:      ${formatCost(Math.min(...costs))}`);
      console.log(`  Max:      ${formatCost(Math.max(...costs))}\n`);
    }

    if (iters.length > 0) {
      console.log("Iterations");
      console.log(`  Average:  ${avg(iters).toFixed(1)}`);
      console.log(`  Min:      ${Math.min(...iters)}`);
      console.log(`  Max:      ${Math.max(...iters)}\n`);
    }

    if (ranges.length > 0) {
      console.log("Output");
      console.log(`  Avg ranges:  ${avg(ranges).toFixed(1)}`);
      const files = successful.filter((c) => c.fileCount).map((c) => c.fileCount!);
      if (files.length > 0) console.log(`  Avg files:   ${avg(files).toFixed(1)}`);
      const symbols = successful.filter((c) => c.symbolCount).map((c) => c.symbolCount!);
      if (symbols.length > 0) console.log(`  Avg symbols: ${avg(symbols).toFixed(1)}`);
      console.log();
    }

    // Duration histogram
    console.log("Duration Distribution");
    const buckets = [
      { label: "< 5s", min: 0, max: 5000 },
      { label: "5-10s", min: 5000, max: 10000 },
      { label: "10-20s", min: 10000, max: 20000 },
      { label: "20-30s", min: 20000, max: 30000 },
      { label: "30-60s", min: 30000, max: 60000 },
      { label: "60s+", min: 60000, max: Infinity },
    ];
    for (const b of buckets) {
      const count = durations.filter((d) => d >= b.min && d < b.max).length;
      const pct = ((count / durations.length) * 100).toFixed(0);
      if (fancy) {
        const bar = "#".repeat(Math.max(0, Math.round((count / durations.length) * 30)));
        console.log(`  ${b.label.padEnd(8)} ${bar.padEnd(32)} ${count} (${pct}%)`);
      } else {
        console.log(`  ${b.label.padEnd(8)} ${count} (${pct}%)`);
      }
    }
    console.log();
  }

  // Recent calls
  console.log("Recent Calls (last 15)");
  const recent = [...calls].sort((a, b) => b.invokeTime.getTime() - a.invokeTime.getTime()).slice(0, 15);
  for (const c of recent) {
    const icon = c.isError ? "FAIL" : "ok  ";
    const queryStr = c.queries.map((q) => q.query).join(", ");
    const date = c.invokeTime.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    console.log(
      `  ${icon} ${date} ${formatDuration(c.durationMs).padEnd(8)} ${String(c.iterations ?? "?").padEnd(3)} iters  ${formatCost(c.cost ?? 0).padEnd(8)} "${truncate(queryStr, 50)}"`
    );
  }
  console.log();
}

main().catch(console.error);
