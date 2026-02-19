import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RETRYABLE_EXEC_ERROR_CODES = new Set(["ENOENT", "EACCES", "ENOTDIR", "EPERM"]);
const HOME_IGNORE_GLOBS = [
  "!Library/**",
  "!Downloads/**",
  "!Pictures/**",
  "!Movies/**",
  "!Music/**",
  "!Applications/**",
  "!.Trash/**",
  "!.cache/**",
];

export function getBundledRgPath(): string {
  return join(homedir(), ".pi", "agent", "bin", "rg");
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefer bundled rg if present + executable, otherwise fall back to PATH. */
export function resolveRgBinary(): string {
  const bundled = getBundledRgPath();
  if (existsSync(bundled) && isExecutable(bundled)) {
    return bundled;
  }
  return "rg";
}

export function shouldRetryWithPathRg(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return RETRYABLE_EXEC_ERROR_CODES.has(String(code));
}

/** Extra ignores when scanning directly from $HOME to avoid giant/system trees. */
export function getHomeIgnoreGlobs(cwd: string): string[] {
  if (cwd !== homedir()) return [];
  return HOME_IGNORE_GLOBS;
}
