#!/usr/bin/env bun
/**
 * Lightweight turboread CLI for programmatic testing.
 *
 * Examples:
 *   bun cli.ts --query "auth flow" --hints "login,session"
 *   bun cli.ts --queries '[{"query":"auth flow"},{"query":"db schema","hints":"drizzle,migrations"}]'
 *   bun cli.ts --queries-file ./queries.json --cwd ~/Development/Projects/scout
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

interface QuerySpec {
  query: string;
  hints?: string;
}

interface CliOptions {
  cwd: string;
  model: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high";
  timeoutSec: number;
  includeText: boolean;
  stream: boolean;
  outFile?: string;
  queries: QuerySpec[];
}

interface TurboreadRunResult {
  ok: boolean;
  cwd: string;
  queries: QuerySpec[];
  streamed?: boolean;
  sessionPath?: string;
  toolResultText?: string;
  details?: any;
  stdout?: string;
  stderr?: string;
  error?: string;
  durationMs: number;
  timestamp: string;
}

const SESSIONS_DIR = join(homedir(), ".pi", "agent", "sessions");

function usage(): string {
  return [
    "Usage:",
    "  bun cli.ts --query <text> [--hints <comma,separated>] [--cwd <path>]",
    "  bun cli.ts --queries <json-array> [--cwd <path>]",
    "  bun cli.ts --queries-file <file.json> [--cwd <path>]",
    "",
    "Options:",
    "  --cwd <path>            Repo path (default: process.cwd())",
    "  --query <text>          Single turboread query",
    "  --hints <csv>           Hints for --query",
    "  --queries <json>        JSON array: [{query,hints?}, ...]",
    "  --queries-file <path>   JSON file containing query array",
    "  --model <id>            Root model for invoking pi (default: claude-haiku-4-5)",
    "  --thinking <level>      off|minimal|low|medium|high (default: off)",
    "  --timeout <seconds>     Process timeout (default: 240)",
    "  --out <file>            Write JSON output to file",
    "  --no-text               Omit giant turboread text from JSON",
    "  --stream                Stream pi stdout/stderr live while running",
    "  --help                  Show this help",
    "",
    "Examples:",
    "  bun cli.ts --query \"how does auth work\" --hints \"login,session\" --stream",
    "  bun cli.ts --queries '[{\"query\":\"db schema\"}]'",
  ].join("\n");
}

function expandPath(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function getArg(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args[i + 1];
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function parseQueries(args: string[]): QuerySpec[] {
  const query = getArg(args, "--query");
  const hints = getArg(args, "--hints");
  const queriesJson = getArg(args, "--queries");
  const queriesFile = getArg(args, "--queries-file");

  if (queriesJson) {
    const parsed = JSON.parse(queriesJson);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("--queries must be a non-empty JSON array");
    }
    return parsed.map((q) => {
      if (!q || typeof q.query !== "string" || !q.query.trim()) {
        throw new Error("Each query in --queries must contain non-empty string 'query'");
      }
      return {
        query: q.query.trim(),
        hints: typeof q.hints === "string" && q.hints.trim() ? q.hints.trim() : undefined,
      } as QuerySpec;
    });
  }

  if (queriesFile) {
    const file = expandPath(queriesFile);
    if (!existsSync(file)) {
      throw new Error(`--queries-file not found: ${file}`);
    }
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("--queries-file must contain a non-empty JSON array");
    }
    return parsed.map((q) => {
      if (!q || typeof q.query !== "string" || !q.query.trim()) {
        throw new Error("Each query in --queries-file must contain non-empty string 'query'");
      }
      return {
        query: q.query.trim(),
        hints: typeof q.hints === "string" && q.hints.trim() ? q.hints.trim() : undefined,
      } as QuerySpec;
    });
  }

  if (!query || !query.trim()) {
    throw new Error("Provide either --query, --queries, or --queries-file");
  }

  return [{ query: query.trim(), hints: hints?.trim() || undefined }];
}

function parseOptions(argv: string[]): CliOptions {
  if (hasFlag(argv, "--help") || hasFlag(argv, "-h")) {
    console.log(usage());
    process.exit(0);
  }

  const cwd = expandPath(getArg(argv, "--cwd") || process.cwd());
  const model = getArg(argv, "--model") || "claude-haiku-4-5";
  const thinking = (getArg(argv, "--thinking") || "off") as CliOptions["thinking"];
  const timeoutSec = Number.parseInt(getArg(argv, "--timeout") || "240", 10);
  const includeText = !hasFlag(argv, "--no-text");
  const stream = hasFlag(argv, "--stream");
  const outFile = getArg(argv, "--out");

  const queries = parseQueries(argv);

  if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error("--timeout must be a positive integer");
  if (!["off", "minimal", "low", "medium", "high"].includes(thinking)) {
    throw new Error("--thinking must be one of: off|minimal|low|medium|high");
  }

  return { cwd, model, thinking, timeoutSec, includeText, stream, outFile, queries };
}

function getSessionDir(cwd: string): string | null {
  const normalized = cwd.replace(/\//g, "-").replace(/^-/, "");
  const dir = `--${normalized}--`;
  const full = join(SESSIONS_DIR, dir);
  return existsSync(full) ? full : null;
}

function listSessionFiles(sessionDir: string): string[] {
  return readdirSync(sessionDir).filter((f) => f.endsWith(".jsonl")).sort();
}

function findNewSessionFile(sessionDir: string, before: Set<string>): string | null {
  const after = listSessionFiles(sessionDir);
  const fresh = after.filter((f) => !before.has(f));
  if (fresh.length > 0) return join(sessionDir, fresh[fresh.length - 1]);
  if (after.length > 0) return join(sessionDir, after[after.length - 1]);
  return null;
}

function extractTurboreadFromSession(sessionPath: string): { text?: string; details?: any } {
  const raw = readFileSync(sessionPath, "utf-8");
  const lines = raw.split("\n").filter(Boolean);

  let latestText: string | undefined;
  let latestDetails: any = undefined;

  for (const line of lines) {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type !== "message") continue;
    const msg = obj.message;
    if (msg?.role !== "toolResult") continue;

    const toolName = msg.toolName || msg.tool_name;
    if (toolName !== "turboread") continue;

    const text = msg?.content?.[0]?.text;
    if (typeof text === "string") latestText = text;
    latestDetails = msg?.details;
  }

  return { text: latestText, details: latestDetails };
}

async function runTurboread(options: CliOptions): Promise<TurboreadRunResult> {
  const startedAt = Date.now();
  const sessionDir = getSessionDir(options.cwd);
  const before = new Set<string>(sessionDir ? listSessionFiles(sessionDir) : []);

  const turboreadArg = `turboread queries=${JSON.stringify(options.queries)}`;

  const args = [
    "--print",
    "--model", options.model,
    "--thinking", options.thinking,
    "--append-system-prompt", "After turboread completes, say exactly 'Done'.",
    turboreadArg,
  ];

  return await new Promise((resolve) => {
    const proc = spawn("pi", args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const timeout = setTimeout(() => {
      killed = true;
      proc.kill("SIGTERM");
    }, options.timeoutSec * 1000);

    proc.stdout?.on("data", (d) => {
      const chunk = d.toString();
      stdout += chunk;
      if (options.stream) process.stdout.write(chunk);
    });
    proc.stderr?.on("data", (d) => {
      const chunk = d.toString();
      stderr += chunk;
      if (options.stream) process.stderr.write(chunk);
    });

    proc.on("close", () => {
      clearTimeout(timeout);

      let sessionPath: string | undefined;
      let toolResultText: string | undefined;
      let details: any;

      if (sessionDir) {
        const maybe = findNewSessionFile(sessionDir, before);
        if (maybe) {
          sessionPath = maybe;
          const extracted = extractTurboreadFromSession(maybe);
          toolResultText = extracted.text;
          details = extracted.details;
        }
      }

      const durationMs = Date.now() - startedAt;
      resolve({
        ok: !killed,
        cwd: options.cwd,
        queries: options.queries,
        streamed: options.stream,
        sessionPath,
        toolResultText: options.includeText ? toolResultText : undefined,
        details,
        stdout,
        stderr,
        error: killed ? `Timed out after ${options.timeoutSec}s` : undefined,
        durationMs,
        timestamp: new Date().toISOString(),
      });
    });

    proc.on("error", (err) => {
      clearTimeout(timeout);
      resolve({
        ok: false,
        cwd: options.cwd,
        queries: options.queries,
        streamed: options.stream,
        error: err.message,
        durationMs: Date.now() - startedAt,
        timestamp: new Date().toISOString(),
      });
    });
  });
}

async function main() {
  try {
    const options = parseOptions(process.argv.slice(2));
    const result = await runTurboread(options);

    const output = JSON.stringify(result, null, 2);

    if (options.outFile) {
      const out = expandPath(options.outFile);
      writeFileSync(out, output);
      console.log(`Wrote: ${out}`);
    }

    console.log(output);
    process.exit(result.ok ? 0 : 1);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    console.error();
    console.error(usage());
    process.exit(1);
  }
}

main();
