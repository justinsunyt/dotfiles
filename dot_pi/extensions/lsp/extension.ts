/**
 * LSP Extension for pi
 *
 * Provides LSP operations as a tool: definition, references, hover, symbols, diagnostics, etc.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { readFile } from "node:fs/promises";
import { join, relative } from "node:path";

import {
  getOrCreateClient,
  ensureFileOpen,
  sendNotification,
  sendRequest,
  shutdownAll,
} from "./client";
import { loadConfig, getServersForFile } from "./config";
import { applyWorkspaceEdit } from "./edits";
import type {
  LspClient,
  ServerConfig,
  Location,
  LocationLink,
  DocumentSymbol,
  SymbolInformation,
  Hover,
  Diagnostic,
  WorkspaceEdit,
} from "./types";
import {
  fileToUri,
  uriToFile,
  extractHoverText,
  formatDiagnostic,
  formatDiagnosticsSummary,
  symbolKindToIcon,
} from "./utils";

// Tool parameter schema
const lspSchema = Type.Object({
  action: StringEnum([
    "definition",
    "references",
    "hover",
    "symbols",
    "diagnostics",
    "rename",
    "reload",
    "status",
  ] as const, { description: "LSP action to perform" }),
  file: Type.Optional(Type.String({ description: "File path for file-specific actions" })),
  line: Type.Optional(Type.Number({ description: "1-based line number" })),
  column: Type.Optional(Type.Number({ description: "1-based column number" })),
  query: Type.Optional(Type.String({ description: "Search query for workspace symbols" })),
  new_name: Type.Optional(Type.String({ description: "New name for rename action" })),
  include_declaration: Type.Optional(
    Type.Boolean({ description: "Include declaration in references (default: true)" }),
  ),
});

type LspParams = {
  action: string;
  file?: string;
  line?: number;
  column?: number;
  query?: string;
  new_name?: string;
  include_declaration?: boolean;
};

// Helper to resolve path relative to cwd
function resolvePath(file: string, cwd: string): string {
  if (file.startsWith("/")) return file;
  return join(cwd, file);
}

// Format a location for display
function formatLocation(loc: Location, cwd: string): string {
  const file = relative(cwd, uriToFile(loc.uri));
  const line = loc.range.start.line + 1;
  const col = loc.range.start.character + 1;
  return `${file}:${line}:${col}`;
}

// Format document symbol with hierarchy
function formatDocumentSymbol(sym: DocumentSymbol, indent = 0): string[] {
  const lines: string[] = [];
  const prefix = "  ".repeat(indent);
  const icon = symbolKindToIcon(sym.kind);
  const line = sym.range.start.line + 1;
  lines.push(`${prefix}${icon} ${sym.name} (line ${line})`);
  if (sym.children) {
    for (const child of sym.children) {
      lines.push(...formatDocumentSymbol(child, indent + 1));
    }
  }
  return lines;
}

function getAnyServer(config: { servers: Record<string, ServerConfig> }): [string, ServerConfig] | null {
  const entries = Object.entries(config.servers) as Array<[string, ServerConfig]>;
  return entries.length > 0 ? entries[0] : null;
}

async function waitForDiagnostics(client: LspClient, uri: string, timeoutMs = 3000): Promise<Diagnostic[]> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const diagnostics = client.diagnostics.get(uri);
    if (diagnostics !== undefined) {
      return diagnostics;
    }
    await Bun.sleep(100);
  }

  return client.diagnostics.get(uri) || [];
}

export default function lspExtension(pi: ExtensionAPI) {
  let configCache: Map<string, any> = new Map();

  async function getConfig(cwd: string) {
    if (!configCache.has(cwd)) {
      configCache.set(cwd, await loadConfig(cwd));
    }
    return configCache.get(cwd);
  }

  async function getServerForFile(cwd: string, file: string): Promise<[string, ServerConfig] | null> {
    const config = await getConfig(cwd);
    const servers = getServersForFile(config, file);
    return servers.length > 0 ? servers[0] : null;
  }

  pi.registerTool({
    name: "lsp",
    label: "LSP",
    description: `Language Server Protocol tool for code intelligence.

Actions:
- definition: Go to definition of symbol at position
- references: Find all references to symbol at position
- hover: Get type/documentation info at position
- symbols: List symbols in a file or search workspace (with query)
- diagnostics: Get errors/warnings for a file
- rename: Rename symbol at position and apply edits
- reload: Reload/restart LSP server
- status: Show active LSP servers

Examples:
- lsp action=definition file=src/index.ts line=10 column=5
- lsp action=references file=src/utils.ts line=25 column=10
- lsp action=symbols file=src/types.ts
- lsp action=symbols query=createUser
- lsp action=diagnostics file=src/broken.ts
- lsp action=rename file=src/user.ts line=15 column=7 new_name=accountId
- lsp action=reload`,

    parameters: lspSchema,

    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const { action, file, line, column, query, new_name, include_declaration } = params as LspParams;
      const cwd = ctx.cwd;

      try {
        const config = await getConfig(cwd);

        // Status action
        if (action === "status") {
          const servers = Object.keys(config.servers);
          const output = servers.length > 0
            ? `Active LSP servers: ${servers.join(", ")}`
            : "No LSP servers configured. Create lsp.json in project or ~/.pi/agent/";
          return {
            content: [{ type: "text", text: output }],
            details: { action, success: true },
          };
        }

        let serverInfo: [string, ServerConfig] | null = null;
        let resolvedFile: string | null = null;

        if (file) {
          resolvedFile = resolvePath(file, cwd);
          serverInfo = await getServerForFile(cwd, resolvedFile);
        } else if (action === "symbols" || action === "reload") {
          serverInfo = getAnyServer(config);
        }

        // Validate action-specific requirements
        if ((action === "definition" || action === "references" || action === "hover" || action === "rename" || action === "diagnostics") && !resolvedFile) {
          return {
            content: [{ type: "text", text: `Error: file parameter required for ${action}` }],
            details: { action, success: false },
          };
        }

        if (action === "symbols" && !resolvedFile && !query) {
          return {
            content: [{ type: "text", text: "Error: file or query parameter required for symbols" }],
            details: { action, success: false },
          };
        }

        if (!serverInfo) {
          return {
            content: [{ type: "text", text: file ? `No LSP server configured for ${file}` : "No LSP server configured" }],
            details: { action, success: false },
          };
        }

        const [serverName, serverConfig] = serverInfo;
        const client = await getOrCreateClient(serverConfig, cwd);

        if (resolvedFile) {
          await ensureFileOpen(client, resolvedFile);
        }

        const uri = resolvedFile ? fileToUri(resolvedFile) : "";
        const position = { line: (line || 1) - 1, character: (column || 1) - 1 };

        let output: string;

        switch (action) {
          case "definition": {
            const result = await sendRequest(client, "textDocument/definition", {
              textDocument: { uri },
              position,
            }, signal) as Location | Location[] | LocationLink[] | null;

            if (!result) {
              output = "No definition found";
            } else {
              const locs = Array.isArray(result) ? result : [result];
              const locations = locs.map(loc => {
                if ("uri" in loc) return loc as Location;
                if ("targetUri" in loc) {
                  const link = loc as LocationLink;
                  return { uri: link.targetUri, range: link.targetSelectionRange ?? link.targetRange };
                }
                return null;
              }).filter(Boolean) as Location[];

              if (locations.length === 0) {
                output = "No definition found";
              } else {
                output = `Found ${locations.length} definition(s):\n${locations.map(l => `  ${formatLocation(l, cwd)}`).join("\n")}`;
              }
            }
            break;
          }

          case "references": {
            const result = await sendRequest(client, "textDocument/references", {
              textDocument: { uri },
              position,
              context: { includeDeclaration: include_declaration ?? true },
            }, signal) as Location[] | null;

            if (!result || result.length === 0) {
              output = "No references found";
            } else {
              output = `Found ${result.length} reference(s):\n${result.map(l => `  ${formatLocation(l, cwd)}`).join("\n")}`;
            }
            break;
          }

          case "hover": {
            const result = await sendRequest(client, "textDocument/hover", {
              textDocument: { uri },
              position,
            }, signal) as Hover | null;

            if (!result || !result.contents) {
              output = "No hover information";
            } else {
              output = extractHoverText(result.contents);
            }
            break;
          }

          case "symbols": {
            if (!resolvedFile) {
              const result = await sendRequest(client, "workspace/symbol", { query }, signal) as SymbolInformation[] | null;

              if (!result || result.length === 0) {
                output = `No symbols matching "${query}"`;
              } else {
                const lines = result.map(s => {
                  const icon = symbolKindToIcon(s.kind);
                  const loc = formatLocation(s.location, cwd);
                  return `  ${icon} ${s.name} @ ${loc}`;
                });
                output = `Found ${result.length} symbol(s) matching "${query}":\n${lines.join("\n")}`;
              }
              break;
            }

            const result = await sendRequest(client, "textDocument/documentSymbol", {
              textDocument: { uri },
            }, signal) as (DocumentSymbol | SymbolInformation)[] | null;

            if (!result || result.length === 0) {
              output = "No symbols found";
            } else {
              const relPath = relative(cwd, resolvedFile);
              if ("selectionRange" in result[0]) {
                // Hierarchical DocumentSymbol
                const lines = (result as DocumentSymbol[]).flatMap(s => formatDocumentSymbol(s));
                output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
              } else {
                // Flat SymbolInformation
                const lines = (result as SymbolInformation[]).map(s => {
                  const icon = symbolKindToIcon(s.kind);
                  const symbolLine = s.location.range.start.line + 1;
                  return `${icon} ${s.name} (line ${symbolLine})`;
                });
                output = `Symbols in ${relPath}:\n${lines.join("\n")}`;
              }
            }
            break;
          }

          case "diagnostics": {
            if (!resolvedFile) {
              return {
                content: [{ type: "text", text: "Error: file parameter required for diagnostics" }],
                details: { action, success: false },
              };
            }

            // Refresh file to get latest diagnostics
            const content = await readFile(resolvedFile, "utf-8");
            const openFile = client.openFiles.get(uri);
            const version = openFile ? ++openFile.version : Date.now();

            await sendNotification(client, "textDocument/didChange", {
              textDocument: { uri, version },
              contentChanges: [{ text: content }],
            });

            await sendNotification(client, "textDocument/didSave", {
              textDocument: { uri },
              text: content,
            });

            const diagnostics = await waitForDiagnostics(client, uri);
            const relPath = relative(cwd, resolvedFile);

            if (diagnostics.length === 0) {
              output = `No diagnostics for ${relPath}`;
            } else {
              const summary = formatDiagnosticsSummary(diagnostics);
              const formatted = diagnostics.map(d => formatDiagnostic(d, relPath));
              output = `${summary}:\n${formatted.map(f => `  ${f}`).join("\n")}`;
            }
            break;
          }

          case "rename": {
            if (!resolvedFile) {
              return {
                content: [{ type: "text", text: "Error: file parameter required for rename" }],
                details: { action, success: false },
              };
            }

            if (!new_name) {
              return {
                content: [{ type: "text", text: "Error: new_name parameter required for rename" }],
                details: { action, success: false },
              };
            }

            const result = await sendRequest(client, "textDocument/rename", {
              textDocument: { uri },
              position,
              newName: new_name,
            }, signal) as WorkspaceEdit | null;

            if (!result) {
              output = "Rename returned no edits";
            } else {
              const applied = await applyWorkspaceEdit(result, cwd);
              output = `Applied rename:\n${applied.map(a => `  ${a}`).join("\n")}`;
            }
            break;
          }

          case "reload": {
            let reloaded = false;

            try {
              await sendRequest(client, "rust-analyzer/reloadWorkspace", null, signal, 5000);
              reloaded = true;
            } catch {}

            if (!reloaded) {
              try {
                await sendRequest(client, "workspace/didChangeConfiguration", { settings: {} }, signal, 5000);
                reloaded = true;
              } catch {}
            }

            if (reloaded) {
              output = `Reloaded ${serverName}`;
            } else {
              client.process.kill();
              await Promise.race([client.process.exitPromise, Bun.sleep(1000)]);
              await getOrCreateClient(serverConfig, cwd);
              output = `Restarted ${serverName}`;
            }
            break;
          }

          default:
            output = `Unknown action: ${action}`;
        }

        return {
          content: [{ type: "text", text: output }],
          details: { action, serverName, success: true },
        };

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `LSP error: ${msg}` }],
          details: { action, success: false },
        };
      }
    },

    // Simple rendering
    renderCall(args, theme) {
      const p = args as LspParams;
      let text = theme.fg("toolTitle", "LSP");
      text += ` ${theme.fg("accent", p.action || "?")}`;
      if (p.file) text += ` ${theme.fg("dim", p.file)}`;
      if (p.line) text += `:${p.line}`;
      return new Text(text, 0, 0);
    },
  });

  // Cleanup on shutdown
  pi.on("session_shutdown", async () => {
    shutdownAll();
  });
}
