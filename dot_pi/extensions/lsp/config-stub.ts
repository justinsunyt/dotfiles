import { homedir } from "node:os";
import { join } from "node:path";

// Stub for getConfigDirPaths
export function getConfigDirPaths(
  subpath: string,
  options: { user?: boolean; project?: boolean; cwd?: string } = {}
): string[] {
  const paths: string[] = [];
  
  if (options.project && options.cwd) {
    paths.push(join(options.cwd, ".pi", subpath));
  }
  
  if (options.user) {
    paths.push(join(homedir(), ".pi", "agent", subpath));
  }
  
  return paths;
}
