import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { jsonrepair } from "jsonrepair";
import { getOrCreateClient, ensureFileOpen, sendRequest } from "../lsp/client";
import { loadConfig, getServersForFile } from "../lsp/config";
import { fileToUri, symbolKindToIcon, uriToFile } from "../lsp/utils";
import type { LspContext } from "./lsp-context";
import { getHomeIgnoreGlobs, resolveRgBinary, shouldRetryWithPathRg } from "./rg";

const TURBOREAD_LSP_INIT_TIMEOUT_MS = 10_000;
const LSP_SYMBOL_FALLBACK_LINES = 120;

function formatLspSymbolFallback(file: string, fullPath: string, reason: string): string {
  try {
    const content = readFileSync(fullPath, "utf-8");
    const lines = content.split("\n");
    const end = Math.min(lines.length, LSP_SYMBOL_FALLBACK_LINES);
    const numbered = lines.slice(0, end).map((line, i) => `${i + 1}: ${line}`);
    const more = end < lines.length ? `\n[...${lines.length - end} more lines]` : "";
    return `[LSP symbols unavailable: ${reason}]\nFallback read (${file}, first ${end} lines):\n${numbered.join("\n")}${more}`;
  } catch (err) {
    return `[LSP symbols unavailable: ${reason}; fallback read failed: ${err}]`;
  }
}

function formatRgFailure(result: ReturnType<typeof spawnSync>): string {
  const error = result.error ? String(result.error.message || result.error) : "";
  const status = result.status;
  const signal = result.signal;
  const stderr = result.stderr?.toString().trim().slice(0, 400) || "";
  const detail = [error, typeof status === "number" ? `exit ${status}` : "", signal ? `signal ${signal}` : "", stderr].filter(Boolean).join("; ");

  return `[rg error: ${detail || "unknown failure"}]`;
}

function isRgErrorOutput(output: string): boolean {
  return output.startsWith("[rg error:");
}

export function runRipgrepSingle(cwd: string, pattern: string): string {
  const homeIgnoreArgs = getHomeIgnoreGlobs(cwd).flatMap((glob) => ["-g", glob]);
  const args = [
    "-l", "-i", "--no-messages",
    "-g", "!node_modules", "-g", "!*.lock", "-g", "!dist", "-g", "!build", "-g", "!.git",
    "-g", "!*.min.js", "-g", "!*.map",
    ...homeIgnoreArgs,
    "-m", "15",
    pattern,
    ".",
  ];

  let rgBin = resolveRgBinary();
  let result = spawnSync(rgBin, args, {
    cwd,
    encoding: "utf-8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 8000,
  });

  // If bundled binary is missing/non-executable, retry PATH rg.
  const shouldRetryWithPath = result.error && rgBin !== "rg" && shouldRetryWithPathRg(result.error);
  if (shouldRetryWithPath) {
    rgBin = "rg";
    result = spawnSync(rgBin, args, {
      cwd,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 8000,
    });
  }

  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    return formatRgFailure(result);
  }

  return result.stdout?.trim() || "";
}

export function runRipgrepMulti(cwd: string, patterns: string[], maxChars: number = 30000): string {
  const results: string[] = [];
  const allFiles = new Set<string>();
  let totalChars = 0;
  
  for (const pattern of patterns) {
    const output = runRipgrepSingle(cwd, pattern);

    if (!output) {
      results.push(`### ${pattern}\nNo matches`);
      continue;
    }

    if (isRgErrorOutput(output)) {
      results.push(`### ${pattern}\n${output}`);
      continue;
    }

    const allowedChars = maxChars - totalChars;
    if (allowedChars <= 0) {
      results.push(`### ${pattern}\n[skipped - context budget reached]`);
      continue;
    }

    const lines = output.split("\n");
    let truncatedOutput = "";
    let fileCount = 0;
    for (const line of lines) {
      if (truncatedOutput.length + line.length + 1 > allowedChars) {
        truncatedOutput += `\n[...${lines.length - fileCount} more files]`;
        break;
      }
      truncatedOutput += (truncatedOutput ? "\n" : "") + line;
      fileCount++;
      if (line.trim()) allFiles.add(line.trim());
    }
    results.push(`### ${pattern}\n${truncatedOutput}`);
    totalChars += truncatedOutput.length;
  }
  
  return results.join("\n\n") + `\n\n**Total: ${allFiles.size} unique files**`;
}

export function runReadSingle(cwd: string, file: string, startLine?: number): string {
  const fullPath = join(cwd, file);
  if (!existsSync(fullPath)) return `[File not found: ${file}]`;

  const content = readFileSync(fullPath, "utf-8");
  const lines = content.split("\n");

  const start = Math.max(0, (startLine ?? 1) - 1);
  const end = Math.min(lines.length, start + 800);

  const slice = lines.slice(start, end);
  const numbered = slice.map((l, i) => `${start + i + 1}: ${l}`);
  let output = numbered.join("\n");

  if (end < lines.length) {
    output += `\n[...${lines.length - end} more lines]`;
  }
  return output;
}

export function runReadMulti(cwd: string, files: { file: string; start_line?: number }[]): string {
  const results: string[] = [];
  
  for (const { file, start_line } of files) {
    const content = runReadSingle(cwd, file, start_line);
    results.push(`### ${file}${start_line ? `:${start_line}` : ""}\n\`\`\`\n${content}\n\`\`\``);
  }
  
  return results.join("\n\n");
}

// Legacy function - kept for backwards compatibility
export async function runLspSymbolsSingle(cwd: string, file: string): Promise<string> {
  const fullPath = join(cwd, file);
  try {
    if (!existsSync(fullPath)) return `[File not found: ${file}]`;
    
    const config = await loadConfig(cwd);
    const servers = getServersForFile(config, fullPath);
    if (servers.length === 0) return formatLspSymbolFallback(file, fullPath, "No LSP server");
    
    const [, serverConfig] = servers[0];
    const client = await getOrCreateClient(serverConfig, cwd, TURBOREAD_LSP_INIT_TIMEOUT_MS);
    await ensureFileOpen(client, fullPath);
    
    const uri = fileToUri(fullPath);
    const result = await sendRequest(client, "textDocument/documentSymbol", {
      textDocument: { uri },
    }, undefined, 8000) as any[] | null;
    
    if (!result || result.length === 0) return formatLspSymbolFallback(file, fullPath, "No symbols from LSP");
    
    const lines: string[] = [];
    function extract(items: any[], indent = 0) {
      for (const item of items) {
        const prefix = "  ".repeat(indent);
        const line = (item.selectionRange?.start?.line ?? item.range?.start?.line ?? 0) + 1;
        const icon = symbolKindToIcon(item.kind);
        lines.push(`${prefix}${icon} ${item.name} (line ${line})`);
        if (item.children) extract(item.children, indent + 1);
      }
    }
    extract(result);
    return lines.slice(0, 50).join("\n");
  } catch (err) {
    if (existsSync(fullPath)) {
      return formatLspSymbolFallback(file, fullPath, `LSP error: ${String(err)}`);
    }
    return `[LSP error: ${err}]`;
  }
}

// Legacy function - kept for backwards compatibility
export async function runLspSymbolsMulti(cwd: string, files: string[]): Promise<string> {
  const results = await Promise.all(files.map(async (file) => {
    const symbols = await runLspSymbolsSingle(cwd, file);
    return `### ${file}\n${symbols}`;
  }));
  return results.join("\n\n");
}

/** Find references (legacy - loads config each time). */
export async function runLspReferences(
  cwd: string,
  params: {
    file: string;
    symbol?: string;
    line?: number;
    column?: number;
    include_declaration?: boolean;
    limit?: number;
  },
): Promise<string> {
  try {
    const fullPath = join(cwd, params.file);
    if (!existsSync(fullPath)) return `[File not found: ${params.file}]`;

    const config = await loadConfig(cwd);
    const servers = getServersForFile(config, fullPath);
    if (servers.length === 0) return "[No LSP server]";

    const [, serverConfig] = servers[0];
    const client = await getOrCreateClient(serverConfig, cwd, TURBOREAD_LSP_INIT_TIMEOUT_MS);
    await ensureFileOpen(client, fullPath);

    let line = params.line;
    let column = params.column;

    if ((line === undefined || column === undefined) && params.symbol) {
      const uriForSymbols = fileToUri(fullPath);
      const symbols = await sendRequest(client, "textDocument/documentSymbol", { textDocument: { uri: uriForSymbols } }, undefined, 8000) as any[] | null;
      if (!symbols || symbols.length === 0) return `[No symbols in ${params.file}]`;

      const target = params.symbol.toLowerCase();
      const stack = [...symbols];
      while (stack.length > 0) {
        const item = stack.shift();
        if (!item) continue;

        if (typeof item.name === "string" && item.name.toLowerCase() === target) {
          line = (item.selectionRange?.start?.line ?? item.range?.start?.line ?? 0) + 1;
          column = (item.selectionRange?.start?.character ?? item.range?.start?.character ?? 0) + 1;
          break;
        }

        if (Array.isArray(item.children)) {
          stack.push(...item.children);
        }
      }

      if (line === undefined || column === undefined) {
        return `[Symbol not found in ${params.file}: ${params.symbol}]`;
      }
    }

    if (line === undefined || column === undefined) {
      return "[lsp_references requires either file+symbol or file+line+column]";
    }

    const uri = fileToUri(fullPath);
    const references = await sendRequest(
      client,
      "textDocument/references",
      {
        textDocument: { uri },
        position: { line: Math.max(0, line - 1), character: Math.max(0, column - 1) },
        context: { includeDeclaration: params.include_declaration ?? true },
      },
      undefined,
      8000,
    ) as any[] | null;

    if (!references || references.length === 0) {
      return "[No references]";
    }

    const limit = Math.max(1, Math.min(200, params.limit ?? 80));
    const seen = new Set<string>();
    const lines: string[] = [];

    for (const ref of references) {
      const refUri = ref?.uri;
      const start = ref?.range?.start;
      if (!refUri || start?.line === undefined || start.character === undefined) continue;

      const key = `${refUri}:${start.line}:${start.character}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const relFile = uriToFile(refUri).replace(`${cwd}/`, "");
      lines.push(`${relFile}:${start.line + 1}:${start.character + 1}`);
      if (lines.length >= limit) break;
    }

    if (lines.length === 0) {
      return "[No references]";
    }

    const more = references.length > lines.length ? `\n[...${references.length - lines.length} more references]` : "";
    return `References (${references.length} total):\n${lines.join("\n")}${more}`;
  } catch (err) {
    return `[LSP error: ${err}]`;
  }
}

/** Resolve symbol names to line ranges via LSP (legacy - loads config each time) */
export async function resolveSymbolRanges(
  cwd: string,
  file: string,
  symbolNames: string[]
): Promise<{ start: number; end: number }[]> {
  try {
    const fullPath = join(cwd, file);
    if (!existsSync(fullPath)) return [];

    const config = await loadConfig(cwd);
    const servers = getServersForFile(config, fullPath);
    if (servers.length === 0) return [];

    const [, serverConfig] = servers[0];
    const client = await getOrCreateClient(serverConfig, cwd, TURBOREAD_LSP_INIT_TIMEOUT_MS);
    await ensureFileOpen(client, fullPath);

    const uri = fileToUri(fullPath);
    const result = await sendRequest(client, "textDocument/documentSymbol", {
      textDocument: { uri },
    }, undefined, 8000) as any[] | null;

    if (!result) return [];

    const ranges: { start: number; end: number }[] = [];
    const nameSet = new Set(symbolNames.map(n => n.toLowerCase()));

    function findSymbols(items: any[]) {
      for (const item of items) {
        if (nameSet.has(item.name.toLowerCase())) {
          const start = (item.range?.start?.line ?? 0) + 1;
          const end = (item.range?.end?.line ?? start) + 1;
          ranges.push({ start, end });
        }
        if (item.children) findSymbols(item.children);
      }
    }
    findSymbols(result);
    return ranges;
  } catch {
    return [];
  }
}

/**
 * Pre-process malformed JSON from Cerebras GLM before attempting repair.
 * Handles model-specific quirks that jsonrepair can't fix:
 * 1. JavaScript expressions like "string".split(",")
 * 2. Missing values like {"start", "end": 29}
 * 3. Mangled keys like "end:" or "end:}"
 * 4. Garbled number values like "33,": or "": "150"
 * 5. Corrupted object structure like {"file": "script": "path"}
 */
function preprocessMalformedJson(input: string): string {
  let result = input;

  // Fix 1: Replace "string".split(",") with actual array
  // Pattern: "value1,value2,...".split(",") or '.split(",")
  result = result.replace(/"([^"]+)"\.split\s*\(\s*["'][,;|]?["']\s*\)/g, (match, content) => {
    const parts = content.split(/[,;|]/).map((s: string) => s.trim()).filter(Boolean);
    return JSON.stringify(parts);
  });

  // Fix 2: Replace missing values like {"start", "end": 29} with {"start": 1, "end": 29}
  // Pattern: {"key", or {key, (key without value before comma)
  result = result.replace(/\{(\s*"?\w+"?\s*),/g, '{$1: 1,');
  
  // Fix 3: Fix mangled keys like "end:" or "end:}" -> "end"
  result = result.replace(/"(\w+):+"(\s*[},:\]])/g, '"$1"$2');
  // Also handle "key:}: value" -> "key": value
  result = result.replace(/"(\w+):+\}+:?\s*/g, '"$1": ');

  // Fix 4: Fix garbled number values like "start": "33,": "end" -> "start": 33, "end"
  // Pattern: "key": "NUMBER,": "nextKey" -> "key": NUMBER, "nextKey"
  result = result.replace(/"(\w+)":\s*"(\d+),?":\s*"(\w+)"/g, '"$1": $2, "$3"');
  
  // Fix 4b: Fix "start": "96,": {"end": 108} -> "start": 96, "end": 108
  result = result.replace(/"(start|end)":\s*"(\d+),?":\s*\{"(end|start)":\s*(\d+)\}/g, '"$1": $2, "$3": $4');
  
  // Fix 5: Fix empty string values followed by numbers: "": "150" -> 150
  result = result.replace(/"":\s*"(\d+)"/g, '$1');
  
  // Fix 5b: Fix "start": "": "150" -> "start": 150
  result = result.replace(/"(start|end)":\s*"":\s*"?(\d+)"?/g, '"$1": $2');
  
  // Fix 6: Fix "file": "script": "path" -> "file": "path" (remove duplicate keys)
  result = result.replace(/"file":\s*"script":\s*"/g, '"file": "');
  // Also fix {"file": "script": "path", ... -> {"file": "path", ...
  result = result.replace(/\{"file":\s*"script":\s*"/g, '{"file": "');
  
  // Fix 7: Fix [{NUMBER", {"end": ... -> [{"start": NUMBER, "end": ...
  result = result.replace(/\[\{(\d+)",\s*\{"end"/g, '[{"start": $1, "end"');
  result = result.replace(/\{\{(\d+)"\},\s*\{"end":\s*"(\d+)"\}\}/g, '{"start": $1, "end": $2}');
  
  // Fix 8: Fix ranges like [{68", "end": "157}]} -> [{"start": 68, "end": 157}]
  result = result.replace(/\[\{(\d+)",\s*"end":\s*"(\d+)\}?\]/g, '[{"start": $1, "end": $2}]');
  
  // Fix 9: Fix "end": "58}] -> "end": 58}]
  result = result.replace(/"(start|end)":\s*"(\d+)(\}?\])/g, '"$1": $2$3');
  
  // Fix 10: Fix trailing garbage like "}}]}]" at end
  result = result.replace(/"\}\}\]\}?\]$/g, '"}]');
  
  // Fix 11: Fix {"ranges": [{1, "end": 143}]} -> {"ranges": [{"start": 1, "end": 143}]}
  result = result.replace(/\[\{(\d+),\s*"end":\s*(\d+)\}\]/g, '[{"start": $1, "end": $2}]');
  
  // Fix 12: Fix {"ranges": [{1}, {"end": 80}]} -> {"ranges": [{"start": 1, "end": 80}]}
  result = result.replace(/\[\{(\d+)\},\s*\{"end":\s*(\d+)\}\]/g, '[{"start": $1, "end": $2}]');
  
  // Fix 13: Fix "end": "67}]} -> "end": 67}]  (number inside string with trailing brace)
  result = result.replace(/"end":\s*"(\d+)\}?\]?\}?"/g, '"end": $1');
  
  // Fix 14: Fix {"start": "1}, {"end": "203}" -> {"start": 1, "end": 203}
  result = result.replace(/\{"start":\s*"?(\d+)\}?,\s*\{"end":\s*"?(\d+)\}?"\}/g, '{"start": $1, "end": $2}');
  
  // Fix 15: Fix dangling commas before ] or }
  result = result.replace(/,\s*([\]\}])/g, '$1');

  return result;
}

/**
 * Coerce a possibly-stringified array from an LLM tool call into a real array.
 * Cerebras GLM stringifies array arguments ~13% of the time, and occasionally
 * produces malformed JSON (missing quotes on keys, trailing commas, etc.).
 *
 * Layers: plain JSON.parse → preprocess + jsonrepair → empty fallback.
 */
export function coerceArray<T = any>(raw: any): T[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];

  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) return [];

  // Layer 1: plain JSON.parse
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // Layer 2: jsonrepair (handles unquoted keys, trailing commas, single quotes, etc.)
  try {
    const parsed = JSON.parse(jsonrepair(trimmed));
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  // Layer 3: preprocess model-specific malformations + jsonrepair
  try {
    const preprocessed = preprocessMalformedJson(trimmed);
    const parsed = JSON.parse(jsonrepair(preprocessed));
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  return [];
}

/**
 * Coerce a stringified string from an LLM tool call.
 * Some models double-quote string values or wrap them in JSON.
 */
export function coerceString(raw: any): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.join("\n");
  return String(raw ?? "");
}

function coerceInteger(raw: any): number | undefined {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }

  if (typeof raw === "string") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

/** Specialised coercion for read tool file args (adds missing "file:" key fixup). */
function coerceFilesArg(raw: any): { file: string; start_line?: number }[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== "string") return [];

  // Try generic coercion first
  const generic = coerceArray<{ file: string; start_line?: number }>(raw);
  if (generic.length > 0) return generic;

  // Extra layer: regex fix for missing "file:" key on path-like values
  try {
    const fixed = raw.replace(/\{"([^"]+\/[^"]+)"/g, '{"file": "$1"');
    const parsed = JSON.parse(jsonrepair(fixed));
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  return [];
}

/**
 * Execute a tool with optional shared LSP context.
 * When lspContext is provided, LSP operations use the cached config.
 */
export async function executeTool(
  cwd: string,
  toolName: string,
  args: any,
  lspContext?: LspContext
): Promise<string> {
  switch (toolName) {
    case "rg": {
      const patterns = coerceArray<string>(args.patterns);
      return runRipgrepMulti(cwd, patterns);
    }
    case "read": {
      let files = coerceFilesArg(args.files);
      files = files.filter((f: any) => typeof f?.file === "string");
      if (files.length === 0) return "[No valid file paths in request]";
      return runReadMulti(cwd, files);
    }
    case "lsp_symbols": {
      const files = coerceArray<string>(args.files);
      // Use shared context if available, otherwise fall back to legacy
      if (lspContext) {
        return await lspContext.getSymbolsMulti(files);
      }
      return await runLspSymbolsMulti(cwd, files);
    }
    case "lsp_references": {
      const file = coerceString(args.file).trim();
      const symbol = coerceString(args.symbol).trim();
      const line = coerceInteger(args.line);
      const column = coerceInteger(args.column);
      const includeDeclaration = typeof args.include_declaration === "boolean" ? args.include_declaration : undefined;
      const limit = coerceInteger(args.limit);

      if (!file) {
        return "[lsp_references requires file]";
      }

      const params = {
        file,
        symbol: symbol || undefined,
        line,
        column,
        include_declaration: includeDeclaration,
        limit,
      };

      if (lspContext) {
        return await lspContext.findReferences({
          file,
          symbol: symbol || undefined,
          line,
          column,
          includeDeclaration,
          limit,
        });
      }

      return await runLspReferences(cwd, params);
    }
    case "finish":
      return "FINISH";
    default:
      return `Unknown tool: ${toolName}`;
  }
}
