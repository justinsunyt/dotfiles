#!/usr/bin/env bun
/**
 * Dump a session's conversation in readable format.
 * Great for reviewing what happened, sharing, or feeding to another model.
 *
 * Usage:
 *   bun dump.ts <session-id>                   # by ID (prefix match)
 *   bun dump.ts --latest                       # most recent session
 *   bun dump.ts --latest --cwd ~/Dev/scout     # most recent in project
 *   bun dump.ts --latest --tools               # include tool call details
 *   bun dump.ts --latest --raw                 # full JSON entries
 *   bun dump.ts --latest --fancy               # unicode/emoji formatting
 */

import {
  loadSessions,
  summariseSession,
  formatDuration,
  formatCost,
  formatTokens,
  truncate,
  shortPath,
  parseArgs,
  parseDateArg,
  type ParsedSession,
} from "./lib";

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const targetId = (args._0 as string) || (args.id as string);
  const latest = !!args.latest;
  const cwd = args.cwd as string | undefined;
  const showTools = !!args.tools;
  const raw = !!args.raw;
  const fancy = !!args.fancy;
  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 30 * 86400000);

  const sessions = await loadSessions({ cwd, since, limit: latest ? 1 : undefined });

  let session: ParsedSession | undefined;

  if (latest) {
    session = sessions[0];
  } else if (targetId) {
    session = sessions.find((s) => s.header.id === targetId || s.header.id.startsWith(targetId));
  } else {
    console.error("Usage: bun dump.ts <session-id> | --latest [--cwd <path>] [--tools] [--raw]");
    process.exit(1);
  }

  if (!session) {
    console.error("No matching session found.");
    process.exit(1);
  }

  if (raw) {
    for (const entry of session.entries) {
      console.log(JSON.stringify(entry));
    }
    return;
  }

  const summary = summariseSession(session);
  const sep = fancy ? "─" : "-";

  // Header
  console.log(`\n${sep.repeat(70)}`);
  console.log(`Session: ${summary.id}`);
  console.log(`CWD:     ${summary.cwd}`);
  console.log(`File:    ${shortPath(summary.file)}`);
  console.log(`Date:    ${summary.startTime.toISOString()} (${formatDuration(summary.durationMs)})`);
  console.log(`Cost:    ${formatCost(summary.totalCost)}  Tokens: ${formatTokens(summary.inputTokens)} in / ${formatTokens(summary.outputTokens)} out`);
  console.log(`Models:  ${summary.models.join(", ")}`);
  console.log(`${sep.repeat(70)}\n`);

  // Conversation
  for (const msg of session.messages) {
    const m = msg.message;
    const ts = new Date(msg.timestamp).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

    if (m.role === "user") {
      for (const block of m.content ?? []) {
        if ("text" in block && block.text) {
          console.log(`[${ts}] USER:`);
          console.log(block.text);
          console.log();
        }
      }
    } else if (m.role === "assistant") {
      let hasText = false;
      for (const block of m.content ?? []) {
        if ("text" in block && block.type === "text" && block.text?.trim()) {
          if (!hasText) {
            console.log(`[${ts}] ASSISTANT:`);
            hasText = true;
          }
          console.log(block.text);
        }
        if (showTools && (block.type === "toolCall" || block.type === "tool_use")) {
          const name = "name" in block ? block.name : "?";
          const toolArgs = "arguments" in block ? block.arguments : "input" in block ? (block as any).input : {};
          console.log(`  > ${name}(${truncate(JSON.stringify(toolArgs), 120)})`);
        }
      }
      if (hasText || (showTools && (m.content ?? []).some((b) => b.type === "toolCall" || b.type === "tool_use"))) {
        if (m.usage?.cost?.total) {
          console.log(`  [${formatCost(m.usage.cost.total)} | ${formatTokens(m.usage.input ?? 0)} in, ${formatTokens(m.usage.output ?? 0)} out]`);
        }
        console.log();
      }
    } else if (m.role === "toolResult" || m.toolName) {
      if (showTools) {
        const status = m.isError ? "ERROR" : "ok";
        console.log(`  ${status}: ${m.toolName ?? "?"}${m.isError ? " (ERROR)" : ""}`);
        if (m.details) {
          const det = JSON.stringify(m.details).slice(0, 200);
          console.log(`    ${det}`);
        }
        console.log();
      }
    }
  }

  console.log(`${sep.repeat(70)}\n`);
}

main().catch(console.error);
