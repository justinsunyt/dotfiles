#!/usr/bin/env bun
/**
 * Diagnose a session or recent sessions for mistakes, failures, patterns.
 *
 * Usage:
 *   bun diagnose.ts                           # diagnose last 7d
 *   bun diagnose.ts --id <uuid>               # diagnose one session
 *   bun diagnose.ts --cwd ~/Dev/scout         # filter by project
 *   bun diagnose.ts --since 14d               # last 14 days
 *   bun diagnose.ts --tool turboread          # focus on specific tool
 *   bun diagnose.ts --failures                # only show failures
 *   bun diagnose.ts --json                    # JSON output
 *   bun diagnose.ts --fancy                   # unicode/emoji formatting
 */

import {
  loadSessions,
  summariseSession,
  formatCost,
  formatDuration,
  truncate,
  parseArgs,
  parseDateArg,
  type ParsedSession,
  type SessionSummary,
} from "./lib";

// ── Diagnosis types ────────────────────────────────────────────────────

interface Finding {
  type: string;
  severity: "critical" | "high" | "medium" | "low";
  message: string;
  evidence: string;
  sessionId: string;
}

// ── Detectors ──────────────────────────────────────────────────────────

function detectUserCorrections(summary: SessionSummary): Finding[] {
  const findings: Finding[] = [];
  const patterns: Array<{ re: RegExp; type: string }> = [
    { re: /no[,.]?\s+(that'?s?\s+)?(not|wrong)/i, type: "direct-rejection" },
    { re: /you\s+(missed|forgot|didn'?t|broke|messed)/i, type: "missed-requirement" },
    { re: /I\s+(said|asked|meant|wanted)\s+/i, type: "clarification-needed" },
    { re: /that'?s?\s+not\s+what/i, type: "misunderstanding" },
    { re: /try\s+again/i, type: "retry-request" },
    { re: /undo|revert|go\s+back/i, type: "undo-request" },
    { re: /bruh|why\s+(the\s+)?(fuck|hell)/i, type: "frustration" },
    { re: /you'?re?\s+rewriting/i, type: "unwanted-rewrite" },
    { re: /i\s+think\s+u\s+broke/i, type: "broke-something" },
    { re: /it\s+(just|keeps)\s+fail/i, type: "persistent-failure" },
    { re: /dont?\s+(do\s+that|use|add|rewrite)/i, type: "wrong-approach" },
  ];

  for (const um of summary.userMessages) {
    for (const { re, type } of patterns) {
      if (re.test(um.text)) {
        findings.push({
          type,
          severity: type === "frustration" || type === "broke-something" ? "critical" : "high",
          message: `User: ${type}`,
          evidence: truncate(um.text.replace(/\n/g, " "), 200),
          sessionId: summary.id,
        });
        break;
      }
    }
  }
  return findings;
}

function detectRepeatedRequests(summary: SessionSummary): Finding[] {
  const findings: Finding[] = [];
  for (let i = 1; i < summary.userMessages.length; i++) {
    const curr = summary.userMessages[i].text.toLowerCase().split(/\s+/);
    const prev = summary.userMessages[i - 1].text.toLowerCase().split(/\s+/);
    if (curr.length < 5 || prev.length < 5) continue;

    const overlap = curr.filter((w) => prev.includes(w)).length;
    const similarity = overlap / Math.max(curr.length, prev.length);
    if (similarity > 0.65) {
      findings.push({
        type: "repeated-request",
        severity: "high",
        message: "User had to repeat/rephrase request",
        evidence: `"${truncate(summary.userMessages[i - 1].text.replace(/\n/g, " "), 100)}" -> "${truncate(summary.userMessages[i].text.replace(/\n/g, " "), 100)}"`,
        sessionId: summary.id,
      });
    }
  }
  return findings;
}

function detectToolFailures(summary: SessionSummary): Finding[] {
  const findings: Finding[] = [];
  const errorsByTool = new Map<string, number>();
  for (const tr of summary.toolResults) {
    if (tr.isError) {
      const name = tr.toolName ?? "unknown";
      errorsByTool.set(name, (errorsByTool.get(name) || 0) + 1);
    }
  }

  for (const [tool, count] of errorsByTool) {
    if (count >= 3) {
      findings.push({
        type: "tool-failures",
        severity: count >= 5 ? "high" : "medium",
        message: `${tool} failed ${count} times`,
        evidence: `Tool "${tool}" had ${count} errors in session`,
        sessionId: summary.id,
      });
    }
  }
  return findings;
}

function detectHighCost(summary: SessionSummary): Finding[] {
  if (summary.totalCost > 2) {
    return [{
      type: "high-cost",
      severity: summary.totalCost > 10 ? "critical" : "medium",
      message: `Session cost ${formatCost(summary.totalCost)}`,
      evidence: `${summary.messageCount} messages, ${summary.toolCalls.length} tool calls, ${formatDuration(summary.durationMs)}`,
      sessionId: summary.id,
    }];
  }
  return [];
}

function detectTurboreadIssues(summary: SessionSummary): Finding[] {
  const findings: Finding[] = [];
  const trResults = summary.toolResults.filter((tr) => tr.toolName === "turboread");

  const failures = trResults.filter((r) => r.isError);
  if (failures.length > 0) {
    findings.push({
      type: "turboread-failure",
      severity: "high",
      message: `${failures.length}/${trResults.length} turboread calls failed`,
      evidence: failures.map((f) => JSON.stringify(f.details ?? {}).slice(0, 80)).join("; "),
      sessionId: summary.id,
    });
  }

  for (const tr of trResults) {
    if (!tr.isError && tr.details) {
      const rangeCount = tr.details.rangeCount ?? tr.details.agents?.[0]?.rangeCount ?? 0;
      if (rangeCount === 0) {
        findings.push({
          type: "turboread-empty",
          severity: "medium",
          message: "Turboread returned 0 ranges",
          evidence: JSON.stringify(tr.details).slice(0, 120),
          sessionId: summary.id,
        });
      }
    }
  }

  return findings;
}

function detectLongSession(summary: SessionSummary): Finding[] {
  if (summary.userMessages.length > 20) {
    return [{
      type: "long-session",
      severity: "low",
      message: `${summary.userMessages.length} user messages -- long session`,
      evidence: `First: "${truncate(summary.userMessages[0]?.text.replace(/\n/g, " ") ?? "", 100)}"`,
      sessionId: summary.id,
    }];
  }
  return [];
}

// ── Main ───────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 7 * 86400000);
  const until = args.until ? parseDateArg(args.until as string) : undefined;
  const cwd = args.cwd as string | undefined;
  const targetId = args.id as string | undefined;
  const toolFilter = args.tool as string | undefined;
  const failuresOnly = !!args.failures;
  const json = !!args.json;
  const fancy = !!args.fancy;

  const sessions = await loadSessions({ cwd, since, until });
  let summaries = sessions.map(summariseSession);

  if (targetId) {
    summaries = summaries.filter((s) => s.id === targetId || s.id.startsWith(targetId));
  }

  // Run all detectors
  const allFindings: Finding[] = [];
  for (const s of summaries) {
    allFindings.push(
      ...detectUserCorrections(s),
      ...detectRepeatedRequests(s),
      ...detectToolFailures(s),
      ...detectHighCost(s),
      ...detectTurboreadIssues(s),
      ...detectLongSession(s),
    );
  }

  // Filter
  let findings = allFindings;
  if (toolFilter) {
    findings = findings.filter((f) => f.type.includes(toolFilter) || f.evidence.includes(toolFilter));
  }
  if (failuresOnly) {
    findings = findings.filter((f) => f.severity === "critical" || f.severity === "high");
  }

  if (json) {
    console.log(JSON.stringify({ findings, stats: { total: findings.length, sessions: summaries.length } }, null, 2));
    return;
  }

  // Summary
  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of findings) bySeverity[f.severity]++;

  const sevLabel = (sev: string, count: number) => {
    if (fancy) {
      const icons: Record<string, string> = { critical: "!!!", high: "!!", medium: "!", low: "." };
      return `${icons[sev] ?? sev} ${count} ${sev}`;
    }
    return `${count} ${sev}`;
  };

  console.log(`\nDiagnosis: ${summaries.length} sessions, ${findings.length} findings`);
  console.log(`${sevLabel("critical", bySeverity.critical)}  ${sevLabel("high", bySeverity.high)}  ${sevLabel("medium", bySeverity.medium)}  ${sevLabel("low", bySeverity.low)}\n`);

  // Group by type
  const byType = new Map<string, Finding[]>();
  for (const f of findings) {
    const arr = byType.get(f.type) || [];
    arr.push(f);
    byType.set(f.type, arr);
  }

  const sortedTypes = [...byType.entries()].sort((a, b) => {
    const sevOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    const aSev = Math.min(...a[1].map((f) => sevOrder[f.severity]));
    const bSev = Math.min(...b[1].map((f) => sevOrder[f.severity]));
    return aSev - bSev || b[1].length - a[1].length;
  });

  for (const [type, items] of sortedTypes) {
    const sev = items[0].severity;
    const prefix = fancy
      ? (sev === "critical" ? "!!!" : sev === "high" ? "!!" : sev === "medium" ? "!" : ".")
      : `[${sev}]`;
    console.log(`${prefix} ${type} (${items.length}x)`);
    for (const f of items.slice(0, 5)) {
      console.log(`  ${f.message}`);
      console.log(`  \\_ ${truncate(f.evidence, 120)}`);
    }
    if (items.length > 5) console.log(`  ... and ${items.length - 5} more`);
    console.log();
  }
}

main().catch(console.error);
