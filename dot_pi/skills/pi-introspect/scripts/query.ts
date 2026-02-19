#!/usr/bin/env bun
/**
 * Query session data as JSONL — one JSON object per session.
 * Designed for piping: jq, inline bun scripts, or further processing.
 *
 * Usage:
 *   bun query.ts                                    # all sessions, last 7d, JSONL
 *   bun query.ts --since 30d                        # last 30 days
 *   bun query.ts --cwd ~/Dev/scout                  # filter by project
 *   bun query.ts --model opus                       # filter by model (substring)
 *   bun query.ts --fields id,cwd,totalCost,models   # pick fields
 *   bun query.ts --group day                        # group by day, output aggregates
 *   bun query.ts --group model                      # group by model
 *   bun query.ts --group cwd                        # group by project
 *
 * Pipe examples:
 *   bun query.ts --since 7d | jq '.totalCost'
 *   bun query.ts --since 7d | jq -s 'map(.totalCost) | add'
 *   bun query.ts --model opus --group day | jq -r '"\(.key)\t\(.cost)"'
 *   bun query.ts --since 7d --fields id,totalCost,firstMessage
 */

import {
  loadSessions,
  summariseSession,
  parseArgs,
  parseDateArg,
  type SessionSummary,
} from "./lib";

interface FlatSummary {
  id: string;
  cwd: string;
  file: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  durationMin: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  messageCount: number;
  toolCallCount: number;
  errorCount: number;
  userMessageCount: number;
  models: string[];
  firstMessage: string;
  toolNames: string[];
}

function flatten(s: SessionSummary): FlatSummary {
  const toolNames = [...new Set(s.toolCalls.map((t) => t.name))];
  return {
    id: s.id,
    cwd: s.cwd,
    file: s.file,
    startTime: s.startTime.toISOString(),
    endTime: s.endTime.toISOString(),
    durationMs: s.durationMs,
    durationMin: Math.round(s.durationMs / 60000 * 10) / 10,
    totalCost: Math.round(s.totalCost * 10000) / 10000,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cacheRead: s.cacheRead,
    messageCount: s.messageCount,
    toolCallCount: s.toolCalls.length,
    errorCount: s.errorCount,
    userMessageCount: s.userMessages.length,
    models: s.models,
    firstMessage: s.userMessages[0]?.text.replace(/\n/g, " ").slice(0, 200) ?? "",
    toolNames,
  };
}

interface GroupRow {
  key: string;
  sessions: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  durationMin: number;
  toolCalls: number;
  errors: number;
}

function groupBy(items: FlatSummary[], groupKey: string): GroupRow[] {
  const buckets = new Map<string, GroupRow>();

  for (const s of items) {
    let keys: string[];
    if (groupKey === "day") {
      keys = [s.startTime.slice(0, 10)];
    } else if (groupKey === "week") {
      const d = new Date(s.startTime);
      const dayOfWeek = d.getUTCDay();
      const monday = new Date(d);
      monday.setUTCDate(d.getUTCDate() - ((dayOfWeek + 6) % 7));
      keys = [monday.toISOString().slice(0, 10)];
    } else if (groupKey === "model") {
      keys = s.models.length > 0 ? s.models : ["unknown"];
    } else if (groupKey === "cwd" || groupKey === "project") {
      keys = [s.cwd];
    } else if (groupKey === "hour") {
      keys = [new Date(s.startTime).getHours().toString().padStart(2, "0") + ":00"];
    } else {
      keys = ["all"];
    }

    for (const key of keys) {
      const row = buckets.get(key) || { key, sessions: 0, cost: 0, inputTokens: 0, outputTokens: 0, durationMin: 0, toolCalls: 0, errors: 0 };
      row.sessions++;
      // When grouping by model and session has multiple models, split cost evenly
      const split = groupKey === "model" ? s.models.length || 1 : 1;
      row.cost += s.totalCost / split;
      row.inputTokens += s.inputTokens / split;
      row.outputTokens += s.outputTokens / split;
      row.durationMin += s.durationMin / split;
      row.toolCalls += s.toolCallCount / split;
      row.errors += s.errorCount;
      buckets.set(key, row);
    }
  }

  // Round
  for (const row of buckets.values()) {
    row.cost = Math.round(row.cost * 100) / 100;
    row.inputTokens = Math.round(row.inputTokens);
    row.outputTokens = Math.round(row.outputTokens);
    row.durationMin = Math.round(row.durationMin * 10) / 10;
    row.toolCalls = Math.round(row.toolCalls);
  }

  return [...buckets.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 7 * 86400000);
  const until = args.until ? parseDateArg(args.until as string) : undefined;
  const cwd = args.cwd as string | undefined;
  const model = args.model as string | undefined;
  const limit = args.limit ? parseInt(args.limit as string) : undefined;
  const group = args.group as string | undefined;
  const fields = args.fields ? (args.fields as string).split(",") : undefined;

  const sessions = await loadSessions({ cwd, since, until, limit, model });
  const summaries = sessions.map(summariseSession);
  const flat = summaries.map(flatten);

  if (group) {
    const rows = groupBy(flat, group);
    for (const row of rows) {
      console.log(JSON.stringify(row));
    }
    return;
  }

  for (const s of flat) {
    if (fields) {
      const picked: Record<string, any> = {};
      for (const f of fields) {
        if (f in s) picked[f] = (s as any)[f];
      }
      console.log(JSON.stringify(picked));
    } else {
      console.log(JSON.stringify(s));
    }
  }
}

main().catch(console.error);
