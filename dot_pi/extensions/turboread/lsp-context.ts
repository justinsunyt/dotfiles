/**
 * Shared LSP context for turboread
 *
 * Loads LSP config once and reuses it across all mini-agents,
 * avoiding repeated loadConfig calls.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { loadConfig, getServersForFile, type LspConfig } from "../lsp/config";
import { ensureFileOpen, getOrCreateClient, sendRequest } from "../lsp/client";
import { fileToUri, symbolKindToIcon, uriToFile } from "../lsp/utils";

const TURBOREAD_LSP_INIT_TIMEOUT_MS = 10_000;
const LSP_SYMBOL_FALLBACK_LINES = 120;

type SymbolKind = Parameters<typeof symbolKindToIcon>[0];

interface DocumentSymbolLike {
  name: string;
  kind: number;
  selectionRange?: { start?: { line?: number; character?: number } };
  range?: {
    start?: { line?: number; character?: number };
    end?: { line?: number; character?: number };
  };
  children?: DocumentSymbolLike[];
}

interface LocationLike {
  uri?: string;
  range?: {
    start?: { line?: number; character?: number };
  };
}

export interface LspContext {
  cwd: string;
  /** Get symbols for a single file - uses cached config */
  getSymbols(file: string): Promise<string>;
  /** Get symbols for multiple files in parallel */
  getSymbolsMulti(files: string[]): Promise<string>;
  /** Find references for a symbol or cursor position */
  findReferences(params: {
    file: string;
    symbol?: string;
    line?: number;
    column?: number;
    includeDeclaration?: boolean;
    limit?: number;
  }): Promise<string>;
  /** Resolve symbol names to line ranges */
  resolveSymbolRanges(file: string, symbolNames: string[]): Promise<{ start: number; end: number }[]>;
  /** Check if config is ready (for debugging/timing) */
  isReady(): boolean;
  /** Wait for config to be ready (usually not needed - methods auto-await) */
  waitReady(): Promise<void>;
}

/**
 * Create a shared LSP context for a turboread session.
 * Config loading starts immediately in the background.
 */
export function createLspContext(cwd: string): LspContext {
  let config: LspConfig | null = null;
  let loadError: Error | null = null;

  const configPromise = loadConfig(cwd)
    .then((loadedConfig) => {
      config = loadedConfig;
      return loadedConfig;
    })
    .catch((err) => {
      loadError = err;
      throw err;
    });

  const getConfig = async (): Promise<LspConfig> => {
    if (config) return config;
    if (loadError) throw loadError;
    return configPromise;
  };

  return {
    cwd,

    isReady(): boolean {
      return config !== null;
    },

    async waitReady(): Promise<void> {
      await getConfig();
    },

    async getSymbols(file: string): Promise<string> {
      const cfg = await getConfig();
      return getSymbolsSingle(cwd, file, cfg);
    },

    async getSymbolsMulti(files: string[]): Promise<string> {
      const cfg = await getConfig();
      const results = await Promise.all(
        files.map(async (file) => {
          const symbols = await getSymbolsSingle(cwd, file, cfg);
          return `### ${file}\n${symbols}`;
        }),
      );
      return results.join("\n\n");
    },

    async findReferences(params): Promise<string> {
      const cfg = await getConfig();
      return findReferencesWithConfig(cwd, params, cfg);
    },

    async resolveSymbolRanges(file: string, symbolNames: string[]): Promise<{ start: number; end: number }[]> {
      const cfg = await getConfig();
      return resolveSymbolRangesWithConfig(cwd, file, symbolNames, cfg);
    },
  };
}

function formatFallbackRead(file: string, fullPath: string, reason: string): string {
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

async function getDocumentSymbols(
  cwd: string,
  file: string,
  config: LspConfig,
): Promise<{ fullPath: string; symbols: DocumentSymbolLike[] } | null> {
  const fullPath = join(cwd, file);
  if (!existsSync(fullPath)) return null;

  const servers = getServersForFile(config, fullPath);
  if (servers.length === 0) return null;

  const [, serverConfig] = servers[0];
  const client = await getOrCreateClient(serverConfig, cwd, TURBOREAD_LSP_INIT_TIMEOUT_MS);
  await ensureFileOpen(client, fullPath);

  const uri = fileToUri(fullPath);
  const result = (await sendRequest(
    client,
    "textDocument/documentSymbol",
    { textDocument: { uri } },
    undefined,
    8000,
  )) as DocumentSymbolLike[] | null;

  if (!result || result.length === 0) {
    return { fullPath, symbols: [] };
  }

  return { fullPath, symbols: result };
}

/**
 * Get symbols for a single file using pre-loaded config.
 */
async function getSymbolsSingle(cwd: string, file: string, config: LspConfig): Promise<string> {
  const fullPath = join(cwd, file);
  try {
    const resolved = await getDocumentSymbols(cwd, file, config);
    if (!resolved) {
      if (!existsSync(fullPath)) return `[File not found: ${file}]`;
      return formatFallbackRead(file, fullPath, "No LSP server");
    }

    const { symbols } = resolved;
    if (symbols.length === 0) {
      return formatFallbackRead(file, fullPath, "No symbols from LSP");
    }

    const lines: string[] = [];
    function extract(items: DocumentSymbolLike[], indent = 0): void {
      for (const item of items) {
        const prefix = "  ".repeat(indent);
        const line = (item.selectionRange?.start?.line ?? item.range?.start?.line ?? 0) + 1;
        const icon = symbolKindToIcon(item.kind as SymbolKind);
        lines.push(`${prefix}${icon} ${item.name} (line ${line})`);
        if (item.children) extract(item.children, indent + 1);
      }
    }
    extract(symbols);
    return lines.slice(0, 60).join("\n");
  } catch (err) {
    if (existsSync(fullPath)) {
      return formatFallbackRead(file, fullPath, `LSP error: ${String(err)}`);
    }
    return `[LSP error: ${err}]`;
  }
}

function findSymbolPosition(
  symbols: DocumentSymbolLike[],
  symbolName: string,
): { line: number; character: number } | null {
  const target = symbolName.trim().toLowerCase();
  if (!target) return null;

  const stack: DocumentSymbolLike[] = [...symbols];
  while (stack.length > 0) {
    const item = stack.shift();
    if (!item) continue;

    if (item.name.toLowerCase() === target) {
      const line = item.selectionRange?.start?.line ?? item.range?.start?.line;
      const character = item.selectionRange?.start?.character ?? item.range?.start?.character;
      if (line !== undefined && character !== undefined) {
        return { line, character };
      }
    }

    if (item.children && item.children.length > 0) {
      stack.push(...item.children);
    }
  }

  return null;
}

async function findReferencesWithConfig(
  cwd: string,
  params: {
    file: string;
    symbol?: string;
    line?: number;
    column?: number;
    includeDeclaration?: boolean;
    limit?: number;
  },
  config: LspConfig,
): Promise<string> {
  try {
    const fullPath = join(cwd, params.file);
    if (!existsSync(fullPath)) {
      return `[File not found: ${params.file}]`;
    }

    const servers = getServersForFile(config, fullPath);
    if (servers.length === 0) {
      return "[No LSP server]";
    }

    const [, serverConfig] = servers[0];
    const client = await getOrCreateClient(serverConfig, cwd, TURBOREAD_LSP_INIT_TIMEOUT_MS);
    await ensureFileOpen(client, fullPath);

    const uri = fileToUri(fullPath);
    let position: { line: number; character: number } | null = null;

    if (typeof params.line === "number" && typeof params.column === "number") {
      position = {
        line: Math.max(0, params.line - 1),
        character: Math.max(0, params.column - 1),
      };
    } else if (params.symbol) {
      const symbolsResult = await getDocumentSymbols(cwd, params.file, config);
      if (!symbolsResult || symbolsResult.symbols.length === 0) {
        return `[No symbols in ${params.file}]`;
      }

      position = findSymbolPosition(symbolsResult.symbols, params.symbol);
      if (!position) {
        return `[Symbol not found in ${params.file}: ${params.symbol}]`;
      }
    }

    if (!position) {
      return "[lsp_references requires either file+symbol or file+line+column]";
    }

    const includeDeclaration = params.includeDeclaration ?? true;
    const result = (await sendRequest(
      client,
      "textDocument/references",
      {
        textDocument: { uri },
        position,
        context: { includeDeclaration },
      },
      undefined,
      8000,
    )) as LocationLike[] | null;

    if (!result || result.length === 0) {
      return "[No references]";
    }

    const limit = Math.max(1, Math.min(200, params.limit ?? 80));
    const deduped = new Set<string>();
    const lines: string[] = [];

    for (const ref of result) {
      const refUri = ref.uri;
      const start = ref.range?.start;
      if (!refUri || start?.line === undefined || start.character === undefined) continue;

      const key = `${refUri}:${start.line}:${start.character}`;
      if (deduped.has(key)) continue;
      deduped.add(key);

      const relFile = relative(cwd, uriToFile(refUri));
      lines.push(`${relFile}:${start.line + 1}:${start.character + 1}`);
      if (lines.length >= limit) break;
    }

    if (lines.length === 0) {
      return "[No references]";
    }

    const more = result.length > lines.length ? `\n[...${result.length - lines.length} more references]` : "";
    return `References (${result.length} total):\n${lines.join("\n")}${more}`;
  } catch (err) {
    return `[LSP error: ${err}]`;
  }
}

/**
 * Resolve symbol names to line ranges using pre-loaded config.
 */
async function resolveSymbolRangesWithConfig(
  cwd: string,
  file: string,
  symbolNames: string[],
  config: LspConfig,
): Promise<{ start: number; end: number }[]> {
  try {
    const resolved = await getDocumentSymbols(cwd, file, config);
    if (!resolved || resolved.symbols.length === 0) return [];

    const ranges: { start: number; end: number }[] = [];
    const nameSet = new Set(symbolNames.map((name) => name.toLowerCase()));

    function findSymbols(items: DocumentSymbolLike[]): void {
      for (const item of items) {
        if (nameSet.has(item.name.toLowerCase())) {
          const start = (item.range?.start?.line ?? 0) + 1;
          const end = (item.range?.end?.line ?? start) + 1;
          ranges.push({ start, end });
        }
        if (item.children) findSymbols(item.children);
      }
    }

    findSymbols(resolved.symbols);
    return ranges;
  } catch {
    return [];
  }
}
