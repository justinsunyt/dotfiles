/**
 * SwiftLint CLI-based linter client.
 * Parses SwiftLint JSON output into LSP diagnostics.
 */

import type { Diagnostic, DiagnosticSeverity, LinterClient, ServerConfig } from "../types";

interface SwiftLintViolation {
  character: number;
  line: number;
  reason: string;
  rule_id: string;
  severity: "Error" | "Warning";
}

function parseSeverity(severity: string): DiagnosticSeverity {
  switch (severity) {
    case "Error":
      return 1;
    case "Warning":
      return 2;
    default:
      return 2;
  }
}

async function runSwiftLint(
  args: string[],
  cwd: string,
  resolvedCommand?: string,
): Promise<{ stdout: string; stderr: string; success: boolean }> {
  const command = resolvedCommand ?? "swiftlint";

  try {
    const proc = Bun.spawn([command, ...args], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;

    // SwiftLint exits non-zero when violations are found.
    return { stdout, stderr, success: stdout.length > 0 };
  } catch (err) {
    return { stdout: "", stderr: String(err), success: false };
  }
}

export class SwiftLintClient implements LinterClient {
  config: ServerConfig;
  cwd: string;

  constructor(config: ServerConfig, cwd: string) {
    this.config = config;
    this.cwd = cwd;
  }

  async format(_filePath: string, content: string): Promise<string> {
    // SwiftLint doesn't provide formatting in this mode.
    return content;
  }

  async lint(filePath: string): Promise<Diagnostic[]> {
    const result = await runSwiftLint(
      ["lint", "--quiet", "--reporter", "json", filePath],
      this.cwd,
      this.config.resolvedCommand,
    );

    if (!result.success) {
      return [];
    }

    return this.parseJsonOutput(result.stdout);
  }

  parseJsonOutput(jsonOutput: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [];

    try {
      const violations = JSON.parse(jsonOutput) as SwiftLintViolation[];

      for (const violation of violations) {
        const line = Math.max(0, violation.line - 1);
        const character = Math.max(0, violation.character - 1);

        diagnostics.push({
          range: {
            start: { line, character },
            end: { line, character },
          },
          severity: parseSeverity(violation.severity),
          message: violation.reason,
          source: "swiftlint",
          code: violation.rule_id,
        });
      }
    } catch {
      // Invalid JSON output.
    }

    return diagnostics;
  }

  dispose(): void {
    // No resources to dispose for CLI client.
  }
}

export function createSwiftLintClient(config: ServerConfig, cwd: string): LinterClient {
  return new SwiftLintClient(config, cwd);
}
