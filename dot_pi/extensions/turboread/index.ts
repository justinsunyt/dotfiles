/**
 * Turboread - Fast parallel codebase context gathering
 *
 * Runs multiple mini-agents in parallel to explore different aspects of the codebase,
 * then returns combined code chunks to the main model.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { complete, getModel } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Text } from "@mariozechner/pi-tui";
import { join, basename } from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

import type { FileSelection, FileSelectionMeta, ToolExecution, UsageStats, MiniAgentResult, SelectionConfidence } from "./types";
import { formatTokens, formatToolCall, minimalPaths, estimateTokens } from "./format";
import { runRipgrepMulti, executeTool, coerceArray } from "./tools";
import { createLspContext, type LspContext } from "./lsp-context";
import { getSmartTree } from "./smart-tree";

// =============================================================================
// Debug session logging
// =============================================================================

const TURBOREAD_SESSIONS_DIR = join(homedir(), ".pi", "turboread", "sessions");

interface DebugSession {
  id: string;
  cwd: string;
  query: string;
  hints?: string;
  startTime: number;
  endTime?: number;
  model: string;
  smartTree: { tree: string; files: string[]; patterns: string[] };
  messages: any[];
  toolCalls: ToolExecution[];
  result?: {
    summary: string[];
    files: any[];
    notFound?: string[];
  };
  error?: string;
  usage: UsageStats;
  iterations: number;
}

function saveDebugSession(session: DebugSession): void {
  try {
    if (!existsSync(TURBOREAD_SESSIONS_DIR)) {
      mkdirSync(TURBOREAD_SESSIONS_DIR, { recursive: true });
    }
    const cwdName = basename(session.cwd).replace(/[^a-zA-Z0-9-_]/g, "-");
    const filename = `${cwdName}-${session.id}.json`;
    const filepath = join(TURBOREAD_SESSIONS_DIR, filename);
    writeFileSync(filepath, JSON.stringify(session, null, 2));
  } catch (err) {
    console.error("[turboread] Failed to save debug session:", err);
  }
}

const MAX_ITERATIONS = 15;

const HOME_CWD_ERROR = "[turboread disabled at HOME cwd] Run turboread from a project directory (e.g. ~/dotfiles), not from ~/.";

function normalizePathForCompare(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

function isHomeCwd(cwd: string): boolean {
  return normalizePathForCompare(cwd) === normalizePathForCompare(homedir());
}

// Output surfacing budget + compression knobs
const OUTPUT_SOFT_TOKEN_BUDGET = 45_000;
const OUTPUT_HARD_TOKEN_BUDGET = 60_000;
const OUTPUT_BASE_BUDGET = 18_000;
const OUTPUT_PER_QUERY_BUDGET = 9_000;

const DEFAULT_FALLBACK_LINES = 60;
const MAX_LINES_PER_RANGE = 160;
const MAX_LINES_PER_FILE = 260;
const RANGE_MERGE_GAP = 2;

const CONFIDENCE_RANK: Record<SelectionConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

// =============================================================================
// Types for parallel execution
// =============================================================================

interface QuerySpec {
  query: string;
  hints?: string;
}

interface AgentState {
  query: string;
  hints?: string;
  iterations: number;
  toolCalls: ToolExecution[];
  usage: UsageStats;
  status: "running" | "done" | "error";
  startTime?: number;
  endTime?: number;
}

interface ParallelDetails {
  agents: AgentState[];
  totalUsage: UsageStats;
  status: "running" | "done" | "error";
  rangeCount?: number;
  fileCount?: number;
  candidateFileCount?: number;
  symbolCount?: number;
  locCount?: number;
  tokenCount?: number;
  tokenBudgetSoft?: number;
  tokenBudgetHard?: number;
  omittedFileCount?: number;
  fileSelections?: FileSelectionMeta[];
}

// =============================================================================
// Mini-agent tools schema
// =============================================================================

const miniAgentTools = [
  {
    name: "rg",
    description: "Search for patterns in codebase. Returns file paths.",
    parameters: Type.Object({
      patterns: Type.Array(Type.String(), { description: "Search patterns" }),
    }),
  },
  {
    name: "read",
    description: "Read files with line numbers (800 lines max).",
    parameters: Type.Object({
      files: Type.Array(Type.Object({
        file: Type.String(),
        start_line: Type.Optional(Type.Integer()),
      })),
    }),
  },
  {
    name: "lsp_symbols",
    description: "Get symbols from files via LSP.",
    parameters: Type.Object({
      files: Type.Array(Type.String()),
    }),
  },
  {
    name: "lsp_references",
    description: "Find references via LSP textDocument/references.",
    parameters: Type.Object({
      file: Type.String({ description: "File path for symbol lookup" }),
      symbol: Type.Optional(Type.String({ description: "Symbol name in file (preferred)" })),
      line: Type.Optional(Type.Integer({ description: "1-based line if symbol omitted" })),
      column: Type.Optional(Type.Integer({ description: "1-based column if symbol omitted" })),
      include_declaration: Type.Optional(Type.Boolean({ description: "Include declaration in refs (default: true)" })),
      limit: Type.Optional(Type.Integer({ description: "Max refs to return (default: 80)" })),
    }),
  },
  {
    name: "finish",
    description: "Done. Provide summary and file selections.",
    parameters: Type.Object({
      summary: Type.Array(Type.String(), { description: "3-8 lines" }),
      files: Type.Array(Type.Object({
        file: Type.String(),
        ranges: Type.Optional(Type.Array(Type.Object({
          start: Type.Integer(),
          end: Type.Integer(),
        }), { description: "Line ranges within file" })),
        symbols: Type.Optional(Type.Array(Type.String(), { description: "Symbol names to extract (resolved via LSP)" })),
        reason: Type.String(),
        confidence: Type.Optional(Type.Union([
          Type.Literal("high"),
          Type.Literal("medium"),
          Type.Literal("low"),
        ], { description: "Confidence this file is needed in caller context" })),
      }), { description: "Minimum sufficient files with ranges or symbols (often 3-12, up to 20 for broad architecture queries)" }),
      not_found: Type.Optional(Type.Array(Type.String())),
    }),
  },
];

const systemPrompt = `You are a code exploration assistant. You MUST always call a tool.

Strategy:
1. Run rg for lexical matches
2. Use lsp_symbols on key files to get exact function/class names
3. Use lsp_references on 1-3 anchor symbols to expand related files
4. Read sections to verify relevance
5. finish with files - MUST include symbols OR ranges for each file

CRITICAL - finish call REQUIREMENTS:
- Every file MUST have either "symbols" array OR "ranges" array (NOT optional!)
- Use symbols for functions/classes: {file: "a.ts", symbols: ["funcA", "ClassB"], reason: "...", confidence: "high"}
- Use ranges for config/data: {file: "b.ts", ranges: [{start: 50, end: 100}], reason: "...", confidence: "medium"}
- Copy symbol names EXACTLY from lsp_symbols output
- confidence must be one of: high | medium | low

SELECTION BEHAVIOUR:
- Return the MINIMUM SUFFICIENT set of files for the query.
- Do NOT pad file count.
- If answerable in 1-5 files, return 1-5.
- For focused implementation questions, aim ~3-8 files.
- For feature/system questions, aim ~6-12 files.
- For broad architecture/deep-dive questions, up to 20 files.

Example finish call:
{
  files: [
    {file: "auth.ts", symbols: ["handleLogin", "validateToken"], reason: "auth logic", confidence: "high"},
    {file: "config.ts", ranges: [{start: 1, end: 50}], reason: "env config", confidence: "medium"}
  ]
}`;

// =============================================================================
// LLM argument coercion helpers
// =============================================================================

/** Coerce summary from LLM: could be string[], a stringified array, or a bare string. */
function coerceSummary(raw: any): string[] {
  if (Array.isArray(raw)) return raw.filter(s => typeof s === "string" && s.length > 0);
  if (typeof raw === "string" && raw.length > 0) {
    // Try parsing as stringified array first
    const arr = coerceArray<string>(raw);
    if (arr.length > 0) return arr.filter(s => typeof s === "string" && s.length > 0);
    // Bare string — wrap it
    return [raw];
  }
  return [];
}

function coerceConfidence(raw: any): SelectionConfidence | undefined {
  if (typeof raw !== "string") return undefined;
  const v = raw.trim().toLowerCase();
  if (v === "high" || v === "medium" || v === "low") return v;
  return undefined;
}

function normalizeRanges(raw: any): { start: number; end: number }[] {
  const ranges = coerceArray<{ start: number; end: number }>(raw);
  return ranges
    .map((r) => ({
      start: Math.max(1, Math.trunc(Number((r as any)?.start))),
      end: Math.max(1, Math.trunc(Number((r as any)?.end))),
    }))
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start);
}

function normalizeSelection(raw: any): FileSelection | null {
  if (!raw || typeof raw !== "object") return null;
  const file = typeof raw.file === "string" ? raw.file.trim() : "";
  if (!file) return null;

  const ranges = normalizeRanges(raw.ranges);
  const symbols = coerceArray<string>(raw.symbols)
    .filter((s) => typeof s === "string")
    .map((s) => s.trim())
    .filter(Boolean);

  const reason = typeof raw.reason === "string" && raw.reason.trim()
    ? raw.reason.trim()
    : "Relevant to query";

  return {
    file,
    ranges: ranges.length > 0 ? ranges : undefined,
    symbols: symbols.length > 0 ? [...new Set(symbols)] : undefined,
    reason,
    confidence: coerceConfidence((raw as any).confidence),
  };
}

function betterConfidence(
  current: SelectionConfidence | undefined,
  incoming: SelectionConfidence | undefined,
): SelectionConfidence | undefined {
  if (!current) return incoming;
  if (!incoming) return current;
  return CONFIDENCE_RANK[incoming] > CONFIDENCE_RANK[current] ? incoming : current;
}

function dedupeRanges(ranges: { start: number; end: number }[]): { start: number; end: number }[] {
  const seen = new Set<string>();
  const out: { start: number; end: number }[] = [];
  for (const r of ranges) {
    const key = `${r.start}:${r.end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function getQueryScaledBudgets(queryCount: number): { soft: number; hard: number } {
  const scaledHard = Math.min(
    OUTPUT_HARD_TOKEN_BUDGET,
    OUTPUT_BASE_BUDGET + OUTPUT_PER_QUERY_BUDGET * Math.max(0, queryCount - 1),
  );
  return {
    soft: Math.min(OUTPUT_SOFT_TOKEN_BUDGET, scaledHard),
    hard: scaledHard,
  };
}

function isLspToolName(toolName: string): boolean {
  return toolName === "lsp_symbols" || toolName === "lsp_references";
}

function isLspInitTimeoutResult(result: string): boolean {
  const lower = result.toLowerCase();
  return lower.includes("initialize timed out") || lower.includes("lsp request initialize timed out");
}

function isLspUnavailableResult(result: string): boolean {
  const lower = result.toLowerCase();
  return lower.includes("[no lsp server]") || lower.includes("lsp unavailable") || isLspInitTimeoutResult(result);
}

// =============================================================================
// Single mini-agent
// =============================================================================

async function runMiniAgent(
  cwd: string,
  query: string,
  hints: string | undefined,
  ctx: ExtensionContext,
  onUpdate: (state: AgentState) => void,
  signal?: AbortSignal,
  lspContext?: LspContext
): Promise<MiniAgentResult> {
  const model = getModel("cerebras", "zai-glm-4.7");
  if (!model) {
    return { summary: ["No turboread mini-agent model"], files: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, iterations: 0, toolCalls: [] };
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    return { summary: ["No API key"], files: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, iterations: 0, toolCalls: [] };
  }

  // Build patterns from hints + query
  const patterns: string[] = [];
  if (hints) {
    for (const h of hints.split(",")) {
      const clean = h.trim();
      if (clean) patterns.push(clean);
    }
  }
  for (const word of query.split(/\s+/)) {
    const clean = word.replace(/[^a-zA-Z0-9]/g, "");
    if (clean.length >= 4 && !patterns.includes(clean.toLowerCase())) {
      patterns.push(clean.toLowerCase());
    }
  }

  // Generate smart tree (query-specific relevance scoring)
  let smartTree: { tree: string; files: string[]; patterns: string[] } = {
    tree: "(smart tree unavailable)",
    files: [],
    patterns: [],
  };
  try {
    smartTree = getSmartTree(cwd, query, { maxFiles: 80, extraPatterns: patterns });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[turboread] smart-tree failed: ${msg}`);
    smartTree = {
      tree: `(smart tree failed: ${msg})`,
      files: [],
      patterns,
    };
  }

  // Prefill rg
  const prefillPatterns = patterns.slice(0, 6);
  const prefillStart = Date.now();
  let prefillResult = "";
  try {
    prefillResult = runRipgrepMulti(cwd, prefillPatterns);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[turboread] prefill rg failed: ${msg}`);
    prefillResult = `[prefill rg error: ${msg}]`;
  }
  const prefillDurationMs = Date.now() - prefillStart;
  const prefillToolCall = { type: "toolCall", id: "prefill_rg", name: "rg", arguments: { patterns: prefillPatterns } };

  // Build user message with smart tree context
  const userMessage = `Query: ${query}${hints ? `\nHints: ${hints}` : ""}

<file_tree description="Relevant files scored by query relevance. ★ = high score. Siblings included.">
${smartTree.tree}
</file_tree>`;

  const messages: any[] = [
    { role: "user", content: [{ type: "text", text: userMessage }], timestamp: Date.now() },
    { role: "assistant", content: [prefillToolCall], timestamp: Date.now() },
    { role: "toolResult", toolCallId: "prefill_rg", toolName: "rg", content: [{ type: "text", text: prefillResult }], isError: false, timestamp: Date.now() },
  ];

  const usage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const allToolCalls: ToolExecution[] = [{ name: "rg", args: { patterns: prefillPatterns }, durationMs: prefillDurationMs }];
  let iterations = 0;
  const startTime = Date.now();

  // Debug session for logging
  const debugSession: DebugSession = {
    id: randomUUID().slice(0, 8),
    cwd,
    query,
    hints,
    startTime,
    model: `${model.provider}/${model.id}`,
    smartTree,
    messages: JSON.parse(JSON.stringify(messages)), // Deep copy initial messages
    toolCalls: allToolCalls,
    usage,
    iterations: 0,
  };

  const emit = (status: "running" | "done" | "error") => {
    onUpdate({
      query, hints, iterations, toolCalls: allToolCalls, usage, status,
      startTime,
      endTime: status !== "running" ? Date.now() : undefined,
    });
  };

  // Helper to save debug session and return result
  const finishWithResult = (result: MiniAgentResult, error?: string): MiniAgentResult => {
    debugSession.endTime = Date.now();
    debugSession.messages = messages;
    debugSession.toolCalls = allToolCalls;
    debugSession.iterations = iterations;
    debugSession.usage = usage;
    debugSession.result = { summary: result.summary, files: result.files, notFound: result.notFound };
    if (error) debugSession.error = error;
    saveDebugSession(debugSession);
    return result;
  };

  // Transient API error retry: exponential backoff up to 30s wall time
  const RETRY_WALL_TIME_MS = 30_000;
  const INITIAL_BACKOFF_MS = 500;
  let transientRetryCount = 0;
  let transientRetryStart = 0; // wall-clock start of first transient error

  // Empty response (no tool calls) nudges — separate budget, no backoff needed
  const MAX_EMPTY_RETRIES = 2;
  let emptyResponseRetries = 0;

  // LSP guardrail: if initialization keeps timing out, avoid repeated 10-30s stalls
  let lspUnavailable = false;
  let lspUnavailableReason = "";
  let lspUnavailableNotified = false;

  /** Returns backoff ms if we should retry, or -1 if wall time exceeded. */
  const getTransientBackoff = (): number => {
    const now = Date.now();
    if (transientRetryCount === 0) transientRetryStart = now;
    const elapsed = now - transientRetryStart;
    if (elapsed >= RETRY_WALL_TIME_MS) return -1;
    transientRetryCount++;
    const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, transientRetryCount - 1), RETRY_WALL_TIME_MS - elapsed);
    return delay;
  };

  try {
  while (iterations < MAX_ITERATIONS) {
    if (signal?.aborted) break;
    iterations++;
    emit("running");

    let response;
    try {
      response = await complete(model, { systemPrompt, messages, tools: miniAgentTools }, { apiKey, maxTokens: 16384, signal });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // Retry on rate limit or transient errors with exp backoff
      if (errMsg.includes("rate") || errMsg.includes("429") || errMsg.includes("503") || errMsg.includes("502") || errMsg.includes("500")) {
        const backoffMs = getTransientBackoff();
        if (backoffMs >= 0) {
          iterations--; // Don't count this as an iteration
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
      }
      console.error(`[turboread] LLM call failed: ${errMsg}`);
      emit("error");
      return finishWithResult({ summary: [`LLM error: ${errMsg}`], files: [], usage, iterations, toolCalls: allToolCalls }, errMsg);
    }

    // Detect error responses (complete() doesn't throw on API errors — it resolves
    // with stopReason: "error" and errorMessage set, content empty, usage zero)
    if ((response as any).stopReason === "error" || (response as any).stopReason === "aborted") {
      const errMsg = (response as any).errorMessage || "Unknown API error";
      const backoffMs = getTransientBackoff();
      if (backoffMs >= 0) {
        iterations--; // Don't consume an iteration for API errors
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      emit("error");
      return finishWithResult({ summary: [`API error: ${errMsg}`], files: [], usage, iterations, toolCalls: allToolCalls }, errMsg);
    }

    // Successful LLM call — reset transient retry state
    transientRetryCount = 0;

    if (response.usage) {
      usage.input += response.usage.input || 0;
      usage.output += response.usage.output || 0;
      usage.cacheRead += response.usage.cacheRead || 0;
      usage.cacheWrite += response.usage.cacheWrite || 0;
      usage.cost += response.usage.cost?.total || 0;
    }

    const toolCalls = response.content.filter((c): c is { type: "toolCall"; id: string; name: string; arguments: any } => c.type === "toolCall");

    // Handle empty response - retry with a nudge (no delay needed, just prompt the model)
    if (toolCalls.length === 0) {
      if (emptyResponseRetries < MAX_EMPTY_RETRIES) {
        emptyResponseRetries++;
        // Add a nudge message to get the model back on track
        const textContent = response.content.find(c => c.type === "text") as { type: "text"; text: string } | undefined;
        if (textContent?.text) {
          messages.push({ role: "assistant", content: [textContent], timestamp: Date.now() });
        }
        messages.push({ role: "user", content: [{ type: "text", text: "You must call a tool. Use rg, read, lsp_symbols, lsp_references, or finish." }], timestamp: Date.now() });
        continue;
      }
      emit("error");
      return finishWithResult({ summary: ["No tool calls after retries"], files: [], usage, iterations, toolCalls: allToolCalls }, "No tool calls after retries");
    }
    
    // Reset empty response counter on successful tool call
    emptyResponseRetries = 0;

    messages.push({ role: "assistant", content: response.content, timestamp: Date.now() });

    // If model already chose finish, return immediately (ignore any extra calls in same turn)
    const finishCall = toolCalls.find((tc) => tc.name === "finish");
    if (finishCall) {
      const input = finishCall.arguments as any;
      allToolCalls.push({ name: finishCall.name, args: finishCall.arguments, durationMs: 0 });
      emit("done");
      const summary = coerceSummary(input.summary);
      return finishWithResult({
        summary,
        files: coerceArray(input.files).map(normalizeSelection).filter((s): s is FileSelection => s !== null),
        notFound: input.not_found,
        usage,
        iterations,
        toolCalls: allToolCalls,
      });
    }

    // Execute independent tool calls in parallel (same-turn calls cannot depend on each other)
    const executed = await Promise.all(
      toolCalls.map(async (tc) => {
        const toolStart = Date.now();
        emit("running");

        let result: string;
        if (isLspToolName(tc.name) && lspUnavailable) {
          result = `[LSP unavailable: ${lspUnavailableReason || "initialization failed"}]`;
        } else {
          result = await executeTool(cwd, tc.name, tc.arguments, lspContext);
        }

        return {
          tc,
          result,
          durationMs: Date.now() - toolStart,
        };
      }),
    );

    let sawLspUnavailable = false;
    for (const exec of executed) {
      allToolCalls.push({ name: exec.tc.name, args: exec.tc.arguments, durationMs: exec.durationMs });
      messages.push({
        role: "toolResult",
        toolCallId: exec.tc.id,
        toolName: exec.tc.name,
        content: [{ type: "text", text: exec.result }],
        isError: false,
        timestamp: Date.now(),
      });

      if (isLspToolName(exec.tc.name) && isLspUnavailableResult(exec.result)) {
        sawLspUnavailable = true;
      }
    }

    if (sawLspUnavailable && !lspUnavailable) {
      lspUnavailable = true;
      lspUnavailableReason = "initialize timeout";
    }

    if (lspUnavailable && !lspUnavailableNotified) {
      lspUnavailableNotified = true;
      messages.push({
        role: "user",
        content: [{ type: "text", text: "LSP is unavailable in this run (initialization timed out). Do not call lsp_* tools again; continue with rg/read and finish." }],
        timestamp: Date.now(),
      });
    }

    if (iterations >= 6 && iterations < MAX_ITERATIONS - 1) {
      messages.push({ role: "user", content: [{ type: "text", text: "You have enough context. Call finish on your next turn." }], timestamp: Date.now() });
    }

    if (iterations === MAX_ITERATIONS - 1) {
      messages.push({ role: "user", content: [{ type: "text", text: "⚠️ Last iteration! Call finish now." }], timestamp: Date.now() });
    }
  }

  // Force finish with exp backoff retries (fresh 30s wall-time budget)
  emit("running");
  messages.push({ role: "user", content: [{ type: "text", text: "Max iterations. Call finish NOW with your findings so far." }], timestamp: Date.now() });

  let finishRetryCount = 0;
  const finishRetryStart = Date.now();
  const MAX_FINISH_NUDGES = 2; // for non-transient "no finish call" retries

  while (true) {
    try {
      const finalResponse = await complete(model, { systemPrompt, messages, tools: miniAgentTools }, { apiKey, maxTokens: 16384, signal, toolChoice: { type: "function", function: { name: "finish" } } as any });

      // Detect API error on forced finish — exp backoff
      if ((finalResponse as any).stopReason === "error" || (finalResponse as any).stopReason === "aborted") {
        const elapsed = Date.now() - finishRetryStart;
        if (elapsed < RETRY_WALL_TIME_MS) {
          finishRetryCount++;
          const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, finishRetryCount - 1), RETRY_WALL_TIME_MS - elapsed);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        break;
      }

      if (finalResponse.usage) {
        usage.input += finalResponse.usage.input || 0;
        usage.output += finalResponse.usage.output || 0;
        usage.cacheRead += finalResponse.usage.cacheRead || 0;
        usage.cacheWrite += finalResponse.usage.cacheWrite || 0;
        usage.cost += finalResponse.usage.cost?.total || 0;
      }

      const finishCall = finalResponse.content.find((c): c is { type: "toolCall"; id: string; name: string; arguments: any } => c.type === "toolCall" && c.name === "finish");
      if (finishCall) {
        allToolCalls.push({ name: "finish", args: finishCall.arguments, durationMs: 0 });
        const input = finishCall.arguments as any;
        emit("done");
        const summary = coerceSummary(input.summary);
        return finishWithResult({
          summary,
          files: coerceArray(input.files).map(normalizeSelection).filter((s): s is FileSelection => s !== null),
          notFound: input.not_found,
          usage,
          iterations,
          toolCalls: allToolCalls,
        });
      }
      
      // No finish call despite toolChoice — limited nudge retries
      if (finishRetryCount < MAX_FINISH_NUDGES) {
        finishRetryCount++;
        continue;
      }
      break;
    } catch (err) {
      const elapsed = Date.now() - finishRetryStart;
      if (elapsed < RETRY_WALL_TIME_MS) {
        finishRetryCount++;
        const delay = Math.min(INITIAL_BACKOFF_MS * Math.pow(2, finishRetryCount - 1), RETRY_WALL_TIME_MS - elapsed);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[turboread] Force finish failed: ${errMsg}`);
      break;
    }
  }

  emit("error");
  return finishWithResult({ summary: ["Failed to get finish call"], files: [], usage, iterations, toolCalls: allToolCalls }, "Failed to get finish call");
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[turboread] Mini-agent crashed: ${errMsg}`);
    emit("error");
    return finishWithResult({ summary: [`Agent error: ${errMsg}`], files: [], usage, iterations, toolCalls: allToolCalls }, errMsg);
  }
}

// =============================================================================
// Read file selections (ranges or symbols)
// =============================================================================

interface ReadSelectionChunk {
  selection: FileSelection;
  content: string;
  loc: number;
  meta: FileSelectionMeta;
}

async function readFileSelections(
  cwd: string,
  selections: FileSelection[],
  lspContext?: LspContext,
  queryInfoByFile?: Map<string, { queryCount: number; shared: boolean }>,
): Promise<ReadSelectionChunk[]> {
  const entries: ReadSelectionChunk[] = [];

  for (const sel of selections) {
    const fullPath = join(cwd, sel.file);
    if (!existsSync(fullPath)) continue;

    try {
      const content = readFileSync(fullPath, "utf-8");
      const lines = content.split("\n");
      const totalLines = lines.length;

      // Collect all ranges (from explicit ranges + resolved symbols)
      let ranges = dedupeRanges([...(sel.ranges || [])]);

      // Resolve symbols to ranges via LSP
      if (sel.symbols && sel.symbols.length > 0) {
        const symbolRanges = lspContext
          ? await lspContext.resolveSymbolRanges(sel.file, sel.symbols)
          : []; // Skip symbol resolution if no LSP context
        ranges = dedupeRanges([...ranges, ...symbolRanges]);
      }

      // Default fallback if no ranges specified
      let fallbackUsed = false;
      if (ranges.length === 0) {
        fallbackUsed = true;
        ranges = [{ start: 1, end: Math.min(DEFAULT_FALLBACK_LINES, lines.length) }];
      }

      // Normalize + sort
      ranges = ranges
        .map((r) => ({
          start: Math.max(1, Math.min(totalLines, Math.trunc(r.start))),
          end: Math.max(1, Math.min(totalLines, Math.trunc(r.end))),
        }))
        .filter((r) => r.end >= r.start)
        .sort((a, b) => a.start - b.start);

      // Merge overlapping / near-touching ranges
      const merged: { start: number; end: number }[] = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r.start <= last.end + RANGE_MERGE_GAP) {
          last.end = Math.max(last.end, r.end);
        } else {
          merged.push({ ...r });
        }
      }

      // Clamp very large ranges
      const clamped = merged.map((r) => {
        const len = r.end - r.start + 1;
        if (len <= MAX_LINES_PER_RANGE) return r;
        return { start: r.start, end: r.start + MAX_LINES_PER_RANGE - 1 };
      });

      // Enforce per-file surfaced line cap
      const limited: { start: number; end: number }[] = [];
      let remaining = MAX_LINES_PER_FILE;
      for (const r of clamped) {
        if (remaining <= 0) break;
        const len = r.end - r.start + 1;
        const take = Math.min(len, remaining);
        limited.push({ start: r.start, end: r.start + take - 1 });
        remaining -= take;
      }
      if (limited.length === 0) continue;

      // Read each range, count LOC, collect text for token estimation
      const rangeChunks: string[] = [];
      const rawChunks: string[] = [];
      let selectedLines = 0;

      for (const r of limited) {
        const start = Math.max(0, r.start - 1);
        const end = Math.min(lines.length, r.end);
        const slice = lines.slice(start, end);
        selectedLines += slice.length;

        const raw = slice.join("\n");
        rawChunks.push(raw);

        if (limited.length > 1) {
          rangeChunks.push(`// L${r.start}-${r.end}\n${raw}`);
        } else {
          rangeChunks.push(raw);
        }
      }

      const metaInfo = queryInfoByFile?.get(sel.file);
      const isFullFile =
        limited.length === 1 &&
        limited[0].start <= 1 &&
        limited[0].end >= totalLines;

      const headerParts: string[] = [];
      if (sel.reason) headerParts.push(sel.reason);
      if (sel.confidence) headerParts.push(`confidence:${sel.confidence}`);
      if (metaInfo?.queryCount && metaInfo.queryCount > 1) headerParts.push(`shared:${metaInfo.queryCount}q`);
      const header = headerParts.length > 0
        ? `## ${sel.file} (${headerParts.join(" | ")})`
        : `## ${sel.file}`;

      const chunk = `${header}\n\`\`\`\n${rangeChunks.join("\n\n// ...\n\n")}\n\`\`\``;

      entries.push({
        selection: sel,
        content: chunk,
        loc: selectedLines,
        meta: {
          file: sel.file,
          totalLines,
          selectedLines,
          estimatedTokens: estimateTokens(rawChunks.join("\n")),
          ranges: limited,
          symbols: sel.symbols,
          reason: sel.reason,
          confidence: sel.confidence,
          queryCount: metaInfo?.queryCount,
          shared: metaInfo?.shared,
          fallbackUsed,
          fullFile: isFullFile,
        },
      });
    } catch {
      // ignore malformed/unreadable file
    }
  }

  return entries;
}

function scoreSelectionMeta(meta: FileSelectionMeta): number {
  let score = 1;

  // Model confidence (hint, not source of truth)
  if (meta.confidence === "high") score += 2.2;
  else if (meta.confidence === "medium") score += 1.0;
  else if (meta.confidence === "low") score -= 0.4;

  // Deterministic signals
  if ((meta.queryCount || 0) > 1) score += 1.3 + 0.4 * ((meta.queryCount || 1) - 1);
  if ((meta.symbols?.length || 0) > 0) score += 1.4;
  if ((meta.ranges?.length || 0) > 0) score += 0.6;

  const selected = meta.selectedLines || 0;
  if (selected > 0 && selected <= 120) score += 0.8;
  else if (selected <= 240) score += 0.4;
  else if (selected > 420) score -= 0.5;

  if (meta.fallbackUsed) score -= 0.9;
  if (meta.fullFile && selected > 220) score -= 1.2;

  return score;
}

function canExceedSoftBudget(meta: FileSelectionMeta): boolean {
  return meta.confidence === "high"
    || ((meta.queryCount || 0) > 1 && (meta.symbols?.length || 0) > 0)
    || ((meta.symbols?.length || 0) >= 2 && !meta.fallbackUsed);
}

function packSelectionChunks(
  entries: ReadSelectionChunk[],
  budgets: { soft: number; hard: number },
): {
  included: ReadSelectionChunk[];
  omitted: ReadSelectionChunk[];
  usedTokens: number;
  usedLoc: number;
} {
  const ranked = [...entries]
    .map((entry) => {
      const value = scoreSelectionMeta(entry.meta);
      const tokens = Math.max(1, entry.meta.estimatedTokens || 1);
      const density = value / tokens;
      return { entry, value, tokens, density };
    })
    .sort((a, b) => {
      if (b.density !== a.density) return b.density - a.density;
      if (b.value !== a.value) return b.value - a.value;
      return a.tokens - b.tokens;
    });

  const included: ReadSelectionChunk[] = [];
  const omitted: ReadSelectionChunk[] = [];
  let usedTokens = 0;
  let usedLoc = 0;

  for (const item of ranked) {
    const tok = item.tokens;
    const next = usedTokens + tok;

    if (next <= budgets.soft) {
      included.push(item.entry);
      usedTokens = next;
      usedLoc += item.entry.loc;
      continue;
    }

    if (next <= budgets.hard && canExceedSoftBudget(item.entry.meta)) {
      included.push(item.entry);
      usedTokens = next;
      usedLoc += item.entry.loc;
      continue;
    }

    omitted.push(item.entry);
  }

  return { included, omitted, usedTokens, usedLoc };
}

// =============================================================================
// Extension
// =============================================================================

export default function turboreadExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "turboread",
    label: "Turboread",
    description: `Fast parallel codebase exploration. Runs multiple mini-agents simultaneously.

Use for understanding features, finding related code, getting context before changes.

Example: turboread queries=[{query: "how does auth work", hints: "login,session"}, {query: "database schema", hints: "schema,table"}]`,

    parameters: Type.Object({
      queries: Type.Array(Type.Object({
        query: Type.String({ description: "What to find" }),
        hints: Type.Optional(Type.String({ description: "Comma-separated keywords" })),
      }), { description: "Parallel queries to run", minItems: 1, maxItems: 5 }),
    }),

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
      const { queries } = params as { queries: QuerySpec[] };
      const cwd = ctx.cwd;

      if (isHomeCwd(cwd)) {
        const emptyUsage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        return {
          content: [{ type: "text", text: HOME_CWD_ERROR }],
          details: {
            agents: [],
            totalUsage: emptyUsage,
            status: "error",
          } as ParallelDetails,
        };
      }

      // Start shared LSP context loading immediately (runs in background)
      // By the time mini-agents need LSP, config should be ready.
      const lspContext = createLspContext(cwd);

      // Track state for each agent
      const agentStates: AgentState[] = queries.map(q => ({
        query: q.query,
        hints: q.hints,
        iterations: 0,
        toolCalls: [],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
        status: "running" as const,
        startTime: Date.now(),
      }));

      const emitUpdate = () => {
        const totalUsage = agentStates.reduce((acc, s) => ({
          input: acc.input + s.usage.input,
          output: acc.output + s.usage.output,
          cacheRead: acc.cacheRead + s.usage.cacheRead,
          cacheWrite: acc.cacheWrite + s.usage.cacheWrite,
          cost: acc.cost + s.usage.cost,
        }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

        const allDone = agentStates.every(s => s.status !== "running");
        const anyError = agentStates.some(s => s.status === "error");

        onUpdate?.({
          content: [{ type: "text", text: `Running ${queries.length} agents...` }],
          details: {
            agents: agentStates,
            totalUsage,
            status: allDone ? (anyError ? "error" : "done") : "running",
          } as ParallelDetails,
        });
      };

      // Run agents in parallel (LSP context loads in background)
      const promises = queries.map((q, i) =>
        runMiniAgent(cwd, q.query, q.hints, ctx, (state) => {
          agentStates[i] = state;
          emitUpdate();
        }, signal, lspContext)
      );

      const results = await Promise.all(promises);

      // Merge results with file grouping and query attribution
      const allSummaries: string[] = [];
      const allNotFound: string[] = [];
      let totalUsage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

      // Track file selections with query attribution
      const fileMap: Map<string, { sel: FileSelection; queries: Set<string> }> = new Map();

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const q = queries[i];
        allSummaries.push(`### ${q.query}\n${r.summary.join("\n")}`);

        for (const rawSel of r.files) {
          const sel = normalizeSelection(rawSel);
          if (!sel) continue;

          if (!fileMap.has(sel.file)) {
            fileMap.set(sel.file, {
              sel: {
                file: sel.file,
                ranges: [],
                symbols: [],
                reason: sel.reason,
                confidence: sel.confidence,
              },
              queries: new Set(),
            });
          }

          const entry = fileMap.get(sel.file)!;
          entry.queries.add(q.query);

          // Merge ranges and symbols with de-dup
          if (sel.ranges && sel.ranges.length > 0) {
            entry.sel.ranges = dedupeRanges([...(entry.sel.ranges || []), ...sel.ranges]);
          }
          if (sel.symbols && sel.symbols.length > 0) {
            entry.sel.symbols = [...new Set([...(entry.sel.symbols || []), ...sel.symbols])];
          }

          entry.sel.confidence = betterConfidence(entry.sel.confidence, sel.confidence);

          if (sel.reason && !(entry.sel.reason && entry.sel.reason.includes(sel.reason))) {
            entry.sel.reason = entry.sel.reason ? `${entry.sel.reason}; ${sel.reason}` : sel.reason;
          }
        }

        if (r.notFound) allNotFound.push(...r.notFound);
        totalUsage.input += r.usage.input;
        totalUsage.output += r.usage.output;
        totalUsage.cacheRead += r.usage.cacheRead;
        totalUsage.cacheWrite += r.usage.cacheWrite;
        totalUsage.cost += r.usage.cost;
      }

      if (fileMap.size === 0) {
        return {
          content: [{ type: "text", text: `No relevant code found.\n\n${allSummaries.join("\n\n")}` }],
          details: { agents: agentStates, totalUsage, status: "error" } as ParallelDetails,
        };
      }

      // Build merged selection list + query attribution lookup
      const candidateSelections: FileSelection[] = [];
      const queryInfoByFile = new Map<string, { queryCount: number; shared: boolean }>();
      for (const [file, entry] of fileMap.entries()) {
        candidateSelections.push(entry.sel);
        queryInfoByFile.set(file, {
          queryCount: entry.queries.size,
          shared: entry.queries.size > 1,
        });
      }

      // Read concrete code for all candidates (auto-read preserved)
      const allEntries = await readFileSelections(cwd, candidateSelections, lspContext, queryInfoByFile);
      if (allEntries.length === 0) {
        return {
          content: [{ type: "text", text: `No readable code surfaced.\n\n${allSummaries.join("\n\n")}` }],
          details: { agents: agentStates, totalUsage, status: "error" } as ParallelDetails,
        };
      }

      // Global weighted output budget (sublinear scaling by query count)
      const budgets = getQueryScaledBudgets(queries.length);
      const packed = packSelectionChunks(allEntries, budgets);

      // Always surface at least one concrete chunk (avoid refs-only payload)
      if (packed.included.length === 0 && packed.omitted.length > 0) {
        packed.included.push(packed.omitted[0]);
      }

      const includedEntries = packed.included;
      const omittedEntries = packed.omitted.filter((e) => !includedEntries.includes(e));

      const codeContent = includedEntries.map((e) => e.content).join("\n\n");
      const includedMetas = includedEntries.map((e) => e.meta);
      const totalLoc = includedEntries.reduce((acc, e) => acc + e.loc, 0);
      const totalTokens = includedMetas.reduce((acc, meta) => acc + (meta.estimatedTokens || 0), 0);

      // Count surfaced symbols and ranges
      let totalSymbols = 0;
      let totalRanges = 0;
      for (const meta of includedMetas) {
        totalSymbols += meta.symbols?.length || 0;
        totalRanges += meta.ranges?.length || 0;
      }

      const candidateFileCount = fileMap.size;
      const surfacedFileCount = includedEntries.length;
      const omittedFileCount = Math.max(0, candidateFileCount - surfacedFileCount);

      const notFoundText = allNotFound.length ? `\n\n**Not found:** ${[...new Set(allNotFound)].join(", ")}` : "";
      const budgetLine = `_Surfaced ${surfacedFileCount}/${candidateFileCount} files · ~${formatTokens(totalTokens)} tokens (budget soft ${formatTokens(budgets.soft)}, hard ${formatTokens(budgets.hard)})_`;

      const omittedPreview = omittedEntries
        .slice(0, 40)
        .map((e) => {
          const conf = e.meta.confidence ? ` · ${e.meta.confidence}` : "";
          return `- ${e.meta.file}${conf} · ${e.meta.reason}`;
        })
        .join("\n");

      const omittedSection = omittedEntries.length > 0
        ? `\n\n---\n## Additional relevant files (not inlined due budget)\n${omittedPreview}${omittedEntries.length > 40 ? `\n- ... +${omittedEntries.length - 40} more` : ""}`
        : "";

      const outputText = `## Summary\n${allSummaries.join("\n\n")}${notFoundText}\n\n---\n${budgetLine}\n\n${codeContent}${omittedSection}`;

      return {
        content: [{ type: "text", text: outputText }],
        details: {
          agents: agentStates,
          totalUsage,
          status: "done",
          fileCount: surfacedFileCount,
          candidateFileCount,
          omittedFileCount,
          symbolCount: totalSymbols,
          rangeCount: totalRanges,
          locCount: totalLoc,
          tokenCount: totalTokens,
          tokenBudgetSoft: budgets.soft,
          tokenBudgetHard: budgets.hard,
          fileSelections: includedMetas,
        } as ParallelDetails,
      };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[turboread] execute crashed: ${message}`);
        const emptyUsage: UsageStats = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        return {
          content: [{ type: "text", text: `[turboread fatal error] ${message}` }],
          details: {
            agents: [],
            totalUsage: emptyUsage,
            status: "error",
          } as ParallelDetails,
        };
      }
    },

    renderCall(args, theme) {
      const p = args as { queries: QuerySpec[] };
      let text = theme.fg("toolTitle", theme.bold("turboread "));
      text += theme.fg("accent", `[${p.queries.length} queries]`);
      // for (const q of p.queries.slice(0, 3)) {
      //   text += `\n  ${theme.fg("dim", "•")} ${theme.fg("accent", q.query)}`;
      // }
      // if (p.queries.length > 3) {
      //   text += `\n  ${theme.fg("dim", `... +${p.queries.length - 3} more`)}`;
      // }
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as ParallelDetails | undefined;
      if (!details) return new Text(theme.fg("dim", "No results"), 0, 0);

      const isRunning = details.status === "running";
      let text = "";

      // Show each agent
      for (const agent of details.agents) {
        const agentIcon = agent.status === "running" ? "→" : agent.status === "error" ? "✗" : "✓";
        const statusColor = agent.status === "running" ? "warning" : agent.status === "error" ? "error" : "success";

        // Agent header: icon + query + iterations (if done)
        text += `${theme.fg(statusColor, agentIcon)} ${theme.fg("accent", agent.query.slice(0, 50))}`;
        if (agent.status !== "running" && agent.iterations > 0) {
          text += theme.fg("dim", ` (${agent.iterations})`);
        }

        // Always show tool calls
        if (agent.toolCalls.length > 0) {
          // Filter out finish call from tool display
          const toolsToShow = agent.toolCalls.filter(tc => tc.name !== "finish");
          for (const tc of toolsToShow) {
            text += `\n    ${theme.fg("muted", "→")} ${formatToolCall(tc.name, tc.args, theme.fg.bind(theme))}`;
          }
        }

        // Agent usage line (always show)
        const elapsed = agent.startTime && agent.endTime
          ? Math.round((agent.endTime - agent.startTime) / 1000)
          : undefined;
        const usageParts: string[] = [];
        if (agent.usage.input) usageParts.push(`↑${formatTokens(agent.usage.input)}`);
        if (agent.usage.output) usageParts.push(`↓${formatTokens(agent.usage.output)}`);
        if (agent.usage.cacheRead) usageParts.push(`R${formatTokens(agent.usage.cacheRead)}`);
        if (agent.usage.cacheWrite) usageParts.push(`W${formatTokens(agent.usage.cacheWrite)}`);
        if (agent.usage.cost > 0) usageParts.push(`$${agent.usage.cost.toFixed(3)}`);
        if (elapsed !== undefined) usageParts.push(`in ${elapsed}s`);
        if (usageParts.length > 0) {
          text += `\n    ${theme.fg("dim", usageParts.join(" "))}`;
        }

        text += "\n";
      }

      // Total summary (only when done)
      if (!isRunning) {
        // Blank line before total
        text += "\n";

        // Total usage line
        const totalParts: string[] = [];
        if (details.totalUsage.input) totalParts.push(`↑${formatTokens(details.totalUsage.input)}`);
        if (details.totalUsage.output) totalParts.push(`↓${formatTokens(details.totalUsage.output)}`);
        if (details.totalUsage.cacheRead) totalParts.push(`R${formatTokens(details.totalUsage.cacheRead)}`);
        if (details.totalUsage.cacheWrite) totalParts.push(`W${formatTokens(details.totalUsage.cacheWrite)}`);
        if (details.totalUsage.cost > 0) totalParts.push(`$${details.totalUsage.cost.toFixed(3)}`);
        text += theme.fg("dim", totalParts.join(" "));

        // Deliverables line
        const fileCount = details.fileCount || 0;
        const candidateFileCount = details.candidateFileCount || fileCount;
        const omittedFileCount = details.omittedFileCount || 0;
        const rangeCount = details.rangeCount || 0;
        const locCount = details.locCount || 0;
        const symCount = details.symbolCount || 0;
        const locStr = locCount >= 1000 ? `${(locCount / 1000).toFixed(1)}k` : locCount.toString();
        const tokenStr = details.tokenCount ? `${formatTokens(details.tokenCount)} tokens` : "";
        const budgetStr = details.tokenBudgetHard ? `≤${formatTokens(details.tokenBudgetHard)}` : "";
        const summaryParts = [`${rangeCount} ranges`, `${locStr} lines`, `${symCount} sym`];
        if (tokenStr) summaryParts.push(tokenStr);
        if (budgetStr) summaryParts.push(`budget ${budgetStr}`);
        const fileLabel = candidateFileCount > fileCount
          ? `${fileCount}/${candidateFileCount} files`
          : `${fileCount} files`;
        text += `\n${theme.fg("success", fileLabel)} ${theme.fg("dim", `(${summaryParts.join(", ")})`)}`;
        if (omittedFileCount > 0) {
          text += ` ${theme.fg("dim", `+${omittedFileCount} omitted`)}`;
        }

        // Expanded: show per-file breakdown with token estimates
        if (expanded && details.fileSelections && details.fileSelections.length > 0) {
          const sels = details.fileSelections;
          const paths = sels.map(s => s.file);
          const shortPaths = minimalPaths(paths);
          const maxPathLen = Math.max(...shortPaths.map(p => p.length));
          const padLen = Math.min(maxPathLen, 30);
          // Right-align token column: find max width
          const tokStrs = sels.map(s => `~${formatTokens(s.estimatedTokens)}`);
          const maxTokLen = Math.max(...tokStrs.map(t => t.length));

          for (let i = 0; i < sels.length; i++) {
            const sel = sels[i];
            const name = shortPaths[i];
            const padded = name.length > padLen ? name.slice(0, padLen - 1) + "…" : name.padEnd(padLen);
            const tokStr = tokStrs[i].padStart(maxTokLen);

            // Build range/symbol description
            const parts: string[] = [];
            if (sel.symbols && sel.symbols.length > 0) {
              parts.push(sel.symbols.join(", "));
            }
            if (sel.ranges && sel.ranges.length > 0) {
              const totalLines = sel.totalLines;
              // Full file: single range from start to end
              const isFullFile = sel.ranges.length === 1
                && sel.ranges[0].start <= 1
                && sel.ranges[0].end >= totalLines;
              if (isFullFile) {
                parts.push(`Full (${totalLines}L)`);
              } else {
                const rangeStrs = sel.ranges.map(r => {
                  const atEnd = r.end >= totalLines;
                  return atEnd ? `L${r.start}–${r.end} (End)` : `L${r.start}–${r.end}`;
                });
                parts.push(rangeStrs.join(", "));
              }
            }
            const conf = sel.confidence ? `${sel.confidence.toUpperCase()} · ` : "";
            const detail = conf + (parts.join("  ") || "Full");
            text += `\n    ${theme.fg("accent", padded)}  ${theme.fg("muted", tokStr)}  ${theme.fg("dim", detail)}`;
          }
        }
      }

      return new Text(text.trimEnd(), 0, 0);
    },
  });

  // Add guidance to system prompt about when to use turboread
  pi.on("before_agent_start", async (event) => {
    const turboreadGuidance = `
Turboread tool guidance:
- Use turboread for broad codebase exploration before making changes
- Prefer turboread over sequential grep/read when understanding how something works
- Use 1 query for single topics, 2-3 only for truly distinct concepts (e.g. "slack" + "linear" = 2 different integrations)
- Do NOT split one concept into multiple queries (e.g. "jam lifecycle" is 1 query, not 4 for create/update/process/cleanup)
- Use grep/read directly for targeted lookups when you already know what you need
Example: turboread queries=[{query: "authentication flow", hints: "login,session,token"}]`;

    return {
      systemPrompt: event.systemPrompt + turboreadGuidance,
    };
  });
}
