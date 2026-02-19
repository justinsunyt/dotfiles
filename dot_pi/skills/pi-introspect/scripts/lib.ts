/**
 * Shared library for pi session introspection.
 * All scripts import from here for parsing, filtering, formatting.
 */

import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────

export interface SessionHeader {
  type: "session";
  version: number;
  id: string;
  timestamp: string;
  cwd: string;
}

export interface SessionMessage {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: {
    role: string;
    content: ContentBlock[];
    model?: string;
    provider?: string;
    usage?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total: number };
    };
    toolName?: string;
    toolCallId?: string;
    isError?: boolean;
    details?: Record<string, any>;
  };
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: any }
  | { type: "toolResult"; toolCallId: string; result: string; isError?: boolean }
  | { type: "tool_use"; id: string; name: string; input: any }
  | { type: "tool_result"; content: string };

export interface ModelChange {
  type: "model_change";
  id: string;
  timestamp: string;
  provider: string;
  modelId: string;
}

export type SessionEntry = SessionHeader | SessionMessage | ModelChange | { type: string; [k: string]: any };

export interface ParsedSession {
  header: SessionHeader;
  entries: SessionEntry[];
  messages: SessionMessage[];
  file: string;
  folder: string; // decoded cwd from folder name
}

export interface UserMessage {
  text: string;
  timestamp: Date;
}

export interface ToolCall {
  name: string;
  id?: string;
  args?: any;
  timestamp: string;
}

export interface ToolResult {
  toolName?: string;
  toolCallId?: string;
  isError: boolean;
  details?: Record<string, any>;
  timestamp: string;
}

export interface SessionSummary {
  id: string;
  file: string;
  cwd: string;
  startTime: Date;
  endTime: Date;
  durationMs: number;
  userMessages: UserMessage[];
  models: string[];
  toolCalls: ToolCall[];
  toolResults: ToolResult[];
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  messageCount: number;
  errorCount: number;
}

// ── Constants ──────────────────────────────────────────────────────────

export const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");
export const TURBOREAD_SESSIONS_DIR = join(homedir(), ".pi", "turboread", "sessions");

// ── Parsing ────────────────────────────────────────────────────────────

export function parseJsonlLines(content: string): SessionEntry[] {
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean) as SessionEntry[];
}

export async function parseSessionFile(filePath: string): Promise<ParsedSession | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const entries = parseJsonlLines(content);
    const header = entries.find((e) => e.type === "session") as SessionHeader | undefined;
    if (!header) return null;

    const messages = entries.filter((e) => e.type === "message") as SessionMessage[];
    const folder = decodeFolderName(basename(join(filePath, "..")));

    return { header, entries, messages, file: filePath, folder };
  } catch {
    return null;
  }
}

// NOTE: decodeFolderName is lossy (dashes in path segments become slashes).
// Use header.cwd for accurate cwd matching, not decoded folder names.
export function decodeFolderName(folderName: string): string {
  return folderName.replace(/^--/, "/").replace(/--$/, "").replace(/-/g, "/");
}

export function encodeFolderName(cwd: string): string {
  return "--" + cwd.replace(/\//g, "-").replace(/^-/, "") + "--";
}

// ── Loading ────────────────────────────────────────────────────────────

export interface LoadOptions {
  cwd?: string; // filter to sessions from this directory (matches header.cwd)
  since?: Date; // filter to sessions after this date
  until?: Date; // filter to sessions before this date
  limit?: number; // max sessions to return (newest first)
  model?: string; // filter to sessions using this model (substring match)
}

export async function loadSessions(opts: LoadOptions = {}): Promise<ParsedSession[]> {
  const sessions: ParsedSession[] = [];

  let dirs: string[];
  try {
    dirs = await readdir(SESSIONS_DIR);
  } catch {
    return [];
  }

  for (const dir of dirs) {
    if (dir.startsWith(".")) continue;
    const dirPath = join(SESSIONS_DIR, dir);
    let files: string[];
    try {
      files = await readdir(dirPath);
    } catch {
      continue;
    }

    for (const file of files.filter((f) => f.endsWith(".jsonl"))) {
      const session = await parseSessionFile(join(dirPath, file));
      if (!session) continue;

      // Filter by cwd using the accurate header.cwd field
      if (opts.cwd) {
        const sessionCwd = session.header.cwd;
        if (sessionCwd !== opts.cwd && !sessionCwd.startsWith(opts.cwd + "/")) continue;
      }

      const ts = new Date(session.header.timestamp);
      if (opts.since && ts < opts.since) continue;
      if (opts.until && ts > opts.until) continue;

      // Filter by model (check model_change entries and message model fields)
      if (opts.model) {
        const needle = opts.model.toLowerCase();
        const hasModel = session.entries.some((e) => {
          if (e.type === "model_change") return (e as ModelChange).modelId?.toLowerCase().includes(needle);
          if (e.type === "message") {
            const msg = (e as SessionMessage).message;
            return msg.model?.toLowerCase().includes(needle) || msg.provider?.toLowerCase().includes(needle);
          }
          return false;
        });
        if (!hasModel) continue;
      }

      sessions.push(session);
    }
  }

  // Sort newest first
  sessions.sort((a, b) => new Date(b.header.timestamp).getTime() - new Date(a.header.timestamp).getTime());

  if (opts.limit) return sessions.slice(0, opts.limit);
  return sessions;
}

// ── Summarisation ──────────────────────────────────────────────────────

export function summariseSession(session: ParsedSession): SessionSummary {
  const userMessages: UserMessage[] = [];
  const models = new Set<string>();
  const toolCalls: ToolCall[] = [];
  const toolResults: ToolResult[] = [];
  let totalCost = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let errorCount = 0;

  // Collect model changes
  for (const entry of session.entries) {
    if (entry.type === "model_change") {
      const mc = entry as ModelChange;
      models.add(`${mc.provider}/${mc.modelId}`);
    }
  }

  for (const msg of session.messages) {
    const m = msg.message;

    // Usage
    if (m.usage) {
      totalCost += m.usage.cost?.total ?? 0;
      inputTokens += m.usage.input ?? 0;
      outputTokens += m.usage.output ?? 0;
      cacheRead += m.usage.cacheRead ?? 0;
    }
    if (m.model) models.add(`${m.provider ?? "?"}/${m.model}`);

    // User messages
    if (m.role === "user") {
      for (const block of m.content ?? []) {
        if ("text" in block && block.text) {
          userMessages.push({ text: block.text, timestamp: new Date(msg.timestamp) });
        }
      }
    }

    // Tool calls (assistant)
    if (m.role === "assistant") {
      for (const block of m.content ?? []) {
        if (block.type === "toolCall") {
          toolCalls.push({ name: block.name, id: block.id, args: block.arguments, timestamp: msg.timestamp });
        }
        if (block.type === "tool_use") {
          toolCalls.push({ name: block.name, id: block.id, args: block.input, timestamp: msg.timestamp });
        }
      }
    }

    // Tool results
    if (m.role === "toolResult" || m.toolName) {
      const isError = m.isError ?? false;
      if (isError) errorCount++;
      toolResults.push({
        toolName: m.toolName,
        toolCallId: m.toolCallId,
        isError,
        details: m.details,
        timestamp: msg.timestamp,
      });
    }
  }

  const timestamps = session.messages.map((m) => new Date(m.timestamp).getTime()).filter((t) => !isNaN(t));
  const startTime = new Date(Math.min(...timestamps, new Date(session.header.timestamp).getTime()));
  const endTime = new Date(Math.max(...timestamps));

  return {
    id: session.header.id,
    file: session.file,
    cwd: session.header.cwd,
    startTime,
    endTime,
    durationMs: endTime.getTime() - startTime.getTime(),
    userMessages,
    models: [...models],
    toolCalls,
    toolResults,
    totalCost,
    inputTokens,
    outputTokens,
    cacheRead,
    messageCount: session.messages.length,
    errorCount,
  };
}

// ── Formatting helpers ─────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  if (ms < 0) return "0s";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

export function formatCost(cost: number): string {
  if (cost >= 1) return `$${cost.toFixed(2)}`;
  if (cost >= 0.01) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(4)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

export function shortPath(path: string): string {
  return path.replace(homedir(), "~");
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

// ── Filtering helpers ──────────────────────────────────────────────────

export function parseDateArg(s: string): Date {
  // Accept: "7d" (7 days ago), "24h" (24 hours ago), "2026-01-05", "last monday"
  const relative = s.match(/^(\d+)([dhm])$/);
  if (relative) {
    const n = parseInt(relative[1]);
    const unit = relative[2];
    const now = Date.now();
    if (unit === "d") return new Date(now - n * 86400000);
    if (unit === "h") return new Date(now - n * 3600000);
    if (unit === "m") return new Date(now - n * 60000);
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  throw new Error(`Cannot parse date: ${s}`);
}

export function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      // positional
      args[`_${Object.keys(args).filter((k) => k.startsWith("_")).length}`] = arg;
    }
  }
  return args;
}
