import * as os from "node:os";
import { basename, dirname } from "node:path";
import type { UsageStats } from "./types";

export function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
  const parts: string[] = [];
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (model) parts.push(model);
  return parts.join(" ");
}

export function shortenPath(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/**
 * Given a list of paths, return minimal unique representations.
 * Start with basename, add parent dirs until unique.
 */
export function minimalPaths(paths: string[]): string[] {
  if (paths.length === 0) return [];
  if (paths.length === 1) return [basename(paths[0])];

  // Start with basenames
  const results = paths.map(p => basename(p));
  
  // Track which indices need more context
  const needsMore = new Set<number>();
  for (let i = 0; i < results.length; i++) {
    for (let j = i + 1; j < results.length; j++) {
      if (results[i] === results[j]) {
        needsMore.add(i);
        needsMore.add(j);
      }
    }
  }

  // Add parent dirs until unique (max 3 levels)
  for (let level = 1; level <= 3 && needsMore.size > 0; level++) {
    for (const idx of needsMore) {
      const parts = paths[idx].split("/").filter(Boolean);
      if (parts.length > level) {
        results[idx] = parts.slice(-level - 1).join("/");
      }
    }
    // Recheck uniqueness
    const stillDupe = new Set<number>();
    for (const i of needsMore) {
      for (const j of needsMore) {
        if (i < j && results[i] === results[j]) {
          stillDupe.add(i);
          stillDupe.add(j);
        }
      }
    }
    needsMore.clear();
    for (const i of stillDupe) needsMore.add(i);
  }

  return results;
}

/**
 * Format file list compactly for single-line display.
 * Shows count + minimal unique names, truncated to maxLen.
 */
function formatFileList(files: string[], maxLen: number = 50): string {
  if (files.length === 0) return "[]";
  
  const minimal = minimalPaths(files);
  const count = files.length;
  
  // Build preview, fitting within maxLen
  let preview = "";
  let shown = 0;
  for (const name of minimal) {
    const addition = shown === 0 ? name : `, ${name}`;
    if (preview.length + addition.length > maxLen - 10) break; // leave room for count + ellipsis
    preview += addition;
    shown++;
  }
  
  const remaining = count - shown;
  if (remaining > 0) {
    preview += `… +${remaining}`;
  }
  
  return `[${count}] ${preview}`;
}

/**
 * Estimate token count for text. More accurate than chars/4 for code
 * by understanding punctuation, identifiers, and whitespace patterns.
 *
 * Heuristic based on cl100k_base / o200k_base tokenizer behaviour:
 * - Single punctuation chars are each ~1 token
 * - Short words (≤4 chars) are ~1 token (common in vocab)
 * - Medium words (5-10 chars) are ~1 token (most keywords/identifiers)
 * - Long identifiers (11+) split by camelCase humps, ~length/6
 * - String contents ~length/4
 * - Indentation: ~1 token per 4 spaces
 * - Newlines: ~0.5 tokens (often merged with indent)
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  let tokens = 0;
  const lines = text.split("\n");

  for (const line of lines) {
    // Newline token (~0.5, often merged with indent)
    tokens += 0.5;

    // Leading whitespace: ~1 token per 4 spaces
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;
    tokens += Math.ceil(indent / 4);

    const content = line.slice(indent);
    if (!content) continue;

    // Split into chunks: words vs punctuation vs strings
    // Matches: quoted strings, word chars, or single non-space chars
    const chunks = content.match(/"[^"]*"|'[^']*'|`[^`]*`|[a-zA-Z_$][a-zA-Z0-9_$]*|[0-9]+\.?[0-9]*|[^\s]/g);
    if (!chunks) continue;

    for (const chunk of chunks) {
      // String literals: ~length/4 (content is less predictable)
      if ((chunk.startsWith('"') || chunk.startsWith("'") || chunk.startsWith("`")) && chunk.length > 2) {
        tokens += Math.max(2, Math.ceil(chunk.length / 4));
        continue;
      }

      // Numbers
      if (/^[0-9]/.test(chunk)) {
        tokens += chunk.length <= 4 ? 1 : Math.ceil(chunk.length / 3);
        continue;
      }

      // Single punctuation character
      if (chunk.length === 1 && /[^a-zA-Z0-9]/.test(chunk)) {
        tokens += 1;
        continue;
      }

      // Word/identifier
      if (chunk.length <= 4) {
        tokens += 1;
      } else if (chunk.length <= 10) {
        // Most common keywords and short identifiers are single tokens
        tokens += 1;
      } else {
        // Long identifiers: count camelCase humps as a proxy
        const humps = chunk.match(/[A-Z][a-z]+|[a-z]+|[A-Z]+(?=[A-Z][a-z]|\b)/g);
        tokens += humps ? Math.max(2, humps.length) : Math.ceil(chunk.length / 6);
      }
    }
  }

  return Math.round(tokens);
}

function coerceArrayArg(raw: any): any[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return [];
}

export function formatToolCall(name: string, args: any, themeFg: (color: any, text: string) => string): string {
  switch (name) {
    case "rg": {
      const patternsRaw = coerceArrayArg(args?.patterns);
      const patterns = patternsRaw.map((p) => String(p));
      const count = patterns.length;
      const preview = patterns.slice(0, 4).join(" ");
      const truncated = preview.length > 40 ? preview.slice(0, 37) + "…" : preview;
      return themeFg("muted", "rg ") + themeFg("toolOutput", `[${count}] ${truncated}`);
    }
    case "read": {
      const files = coerceArrayArg(args?.files)
        .map((f: any) => (typeof f === "string" ? f : f?.file))
        .filter((f): f is string => typeof f === "string" && f.length > 0);
      return themeFg("muted", "read ") + themeFg("accent", formatFileList(files));
    }
    case "lsp_symbols": {
      const files = coerceArrayArg(args?.files)
        .map((f: any) => String(f))
        .filter((f) => f.length > 0);
      return themeFg("muted", "lsp ") + themeFg("accent", formatFileList(files));
    }
    case "lsp_references": {
      const file = args?.file || "?";
      const symbol = args?.symbol ? `#${args.symbol}` : args?.line && args?.column ? `:${args.line}:${args.column}` : "";
      return themeFg("muted", "lsp/refs ") + themeFg("accent", `${file}${symbol}`);
    }
    case "finish": {
      const files = coerceArrayArg(args?.files);
      const fileCount = files.length;
      let rangeCount = 0;
      for (const f of files) {
        rangeCount += (f?.ranges?.length || 0) + (f?.symbols?.length || 0);
      }
      const timeStr = args?._elapsed ? ` in ${args._elapsed}s` : "";
      return themeFg("success", "✓ ") + themeFg("dim", `${fileCount} files, ${rangeCount} ranges${timeStr}`);
    }
    default:
      return themeFg("accent", name) + themeFg("dim", ` ${JSON.stringify(args).slice(0, 40)}`);
  }
}
