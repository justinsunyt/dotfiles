/**
 * Smart file tree - Scoring-based file discovery with indented output
 * 
 * FAST: Uses ripgrep (respects .gitignore natively), parallel operations
 * Clean importable module - no logging, no disk I/O
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { getHomeIgnoreGlobs, resolveRgBinary, shouldRetryWithPathRg } from "./rg";

// =============================================================================
// Stemming & Pattern Extraction
// =============================================================================

function stem(word: string): string {
  let w = word.toLowerCase();
  const suffixes = [
    "ational", "ization", "fulness", "iveness", "ousness",
    "ation", "ement", "ment", "ness", "ence", "ance", "able", "ible", "ling",
    "ing", "ion", "ity", "ous", "ive", "ful", "ess", "ist", "ism",
    "ed", "er", "ly", "al", "en", "es", "s"
  ];
  for (const suf of suffixes) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      return w.slice(0, -suf.length);
    }
  }
  return w;
}

const STOPWORDS = new Set([
  // Common English
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "as", "is", "was", "are", "were", "been",
  "be", "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "must", "shall", "can", "need", "dare", "ought",
  "used", "using", "use", "uses", "get", "gets", "got", "go", "goes", "gone",
  "make", "makes", "made", "take", "takes", "took", "come", "comes", "came",
  "want", "wants", "wanted", "look", "looks", "looked", "give", "gives", "gave",
  "think", "thinks", "thought", "know", "knows", "knew", "see", "sees", "saw",
  "find", "finds", "found", "tell", "tells", "told", "ask", "asks", "asked",
  "work", "works", "worked", "working", "seem", "seems", "seemed", "feel",
  "try", "tries", "tried", "leave", "leaves", "left", "call", "calls", "called",
  "it", "its", "this", "that", "these", "those", "what", "which", "who", "whom",
  "how", "when", "where", "why", "all", "each", "every", "both", "few", "more",
  "most", "other", "some", "such", "no", "not", "only", "same", "so", "than",
  "too", "very", "just", "also", "now", "here", "there", "then", "once",
  // Code-specific
  "function", "class", "const", "let", "var", "type", "interface",
  "export", "import", "return", "async", "await", "new",
  "file", "files", "code", "data", "value", "values", "list", "item",
  "create", "update", "delete", "run", "runs", "running",
  "exist", "exists", "available", "different", "specific", "actually",
]);

const HOT_DIRS = new Set([
  "src", "lib", "core", "pkg", "internal", "cmd", "app",
  "services", "components", "hooks", "utils", "api", "routes",
  "handlers", "controllers", "models", "views", "templates",
]);

const COLD_DIRS = new Set([
  "test", "tests", "__tests__", "spec", "specs", "testing",
  "fixtures", "mocks", "__mocks__", "e2e", "integration",
  "testdata", "vendor", "third_party", "examples", "docs",
]);

const KEY_FILE_BASES = new Set([
  "index", "main", "mod", "lib", "init", "__init__",
  "types", "schema", "config", "constants", "utils", "helpers",
  "common", "base", "core", "app", "server", "client",
]);

const SOURCE_EXTS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyx", ".pyi",
  ".go", ".rs",
  ".java", ".kt", ".scala",
  ".c", ".cpp", ".cc", ".h", ".hpp",
  ".rb", ".php", ".swift", ".cs",
  ".ex", ".exs", ".hs", ".lua",
  ".sh", ".bash", ".zsh",
]);

const SKIP_EXTENSIONS = new Set([".lock", ".map", ".min.js", ".d.ts", ".pyc", ".o", ".a", ".so", ".dylib"]);
const SKIP_FILES = new Set([".DS_Store", "thumbs.db", ".gitkeep"]);

// =============================================================================
// Types
// =============================================================================

interface FileScore {
  file: string;
  score: number;
  matchCount: number;
  patternMatches: string[];
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  score?: number;
  children?: TreeNode[];
  hiddenFiles?: number;
  hiddenDirs?: number;
}

export interface SmartTreeOptions {
  maxFiles?: number;
  /** Additional patterns to include (from hints) */
  extraPatterns?: string[];
}

export interface SmartTreeResult {
  tree: string;
  files: string[];
  patterns: string[];
}

// =============================================================================
// Core Functions
// =============================================================================

function extractPatterns(query: string, extraPatterns?: string[]): string[] {
  const patterns: string[] = [];
  const seen = new Set<string>();

  // Add extra patterns first (from hints)
  if (extraPatterns) {
    for (const p of extraPatterns) {
      const clean = p.trim().toLowerCase();
      if (clean.length >= 3 && !seen.has(clean)) {
        seen.add(clean);
        patterns.push(clean);
      }
    }
  }

  // Extract from query
  for (const word of query.toLowerCase().split(/\s+/)) {
    const clean = word.replace(/[^a-z0-9]/gi, "");
    if (clean.length < 3) continue;
    if (STOPWORDS.has(clean)) continue;
    if (seen.has(clean)) continue;

    seen.add(clean);
    patterns.push(clean);

    // Add stemmed version if different
    const stemmed = stem(clean);
    if (stemmed !== clean && stemmed.length >= 3 && !seen.has(stemmed)) {
      seen.add(stemmed);
      patterns.push(stemmed);
    }
  }

  return patterns;
}

function ripgrepWithCounts(cwd: string, pattern: string): Map<string, number> {
  const homeIgnoreArgs = getHomeIgnoreGlobs(cwd).flatMap((glob) => ["-g", glob]);
  const args = [
    "-c", "-i", "--no-heading", "--no-messages",
    "-g", "!*.lock",
    "-g", "!*.min.js",
    "-g", "!*.map",
    "-g", "!*.d.ts",
    ...homeIgnoreArgs,
    pattern, "."
  ];

  let rgBin = resolveRgBinary();
  let result = spawnSync(rgBin, args, { cwd, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024, timeout: 8000 });

  // If bundled rg is missing/non-executable, retry PATH rg.
  const shouldRetryWithPath = result.error && rgBin !== "rg" && shouldRetryWithPathRg(result.error);
  if (shouldRetryWithPath) {
    rgBin = "rg";
    result = spawnSync(rgBin, args, { cwd, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024, timeout: 8000 });
  }

  // 0 = matches, 1 = no matches. Anything else is an execution failure.
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    return new Map<string, number>();
  }

  const counts = new Map<string, number>();
  if (result.stdout) {
    for (const line of result.stdout.trim().split("\n")) {
      if (!line) continue;
      const idx = line.lastIndexOf(":");
      if (idx > 0) {
        const file = line.slice(0, idx).replace(/^\.\//, "");
        const count = parseInt(line.slice(idx + 1), 10) || 1;
        counts.set(file, count);
      }
    }
  }
  return counts;
}

function scoreFiles(cwd: string, patterns: string[], maxFiles: number): FileScore[] {
  const fileScores = new Map<string, FileScore>();

  const initScore = (file: string): FileScore => {
    if (!fileScores.has(file)) {
      fileScores.set(file, { file, score: 0, matchCount: 0, patternMatches: [] });
    }
    return fileScores.get(file)!;
  };

  // Run ripgrep for each pattern
  for (const pattern of patterns) {
    const counts = ripgrepWithCounts(cwd, pattern);

    // Skip if pattern is too generic (>500 matches)
    if (counts.size > 500) continue;

    for (const [file, count] of counts) {
      const s = initScore(file);
      s.matchCount += count;
      s.patternMatches.push(pattern);

      // Content match score (log scale)
      s.score += Math.min(50, Math.log2(count + 1) * 10);

      // Pattern in path bonus
      if (file.toLowerCase().includes(pattern)) {
        s.score += 50;
      }

      // Pattern in filename bonus (stronger)
      if (basename(file).toLowerCase().includes(pattern)) {
        s.score += 80;
      }
    }
  }

  // Apply structural bonuses
  for (const [file, s] of fileScores) {
    const parts = file.split("/");
    const fileName = basename(file);
    const ext = extname(file);

    // Multiple patterns bonus
    if (s.patternMatches.length > 1) {
      s.score += 30 * (s.patternMatches.length - 1);
    }

    // Key file bonus
    const fileBase = fileName.replace(/\.[^.]+$/, "").toLowerCase();
    if (KEY_FILE_BASES.has(fileBase)) {
      s.score += 25;
    }

    // Hot directory bonus
    for (const part of parts) {
      if (HOT_DIRS.has(part)) {
        s.score += 15;
        break;
      }
    }

    // Cold directory penalty
    for (const part of parts) {
      if (COLD_DIRS.has(part)) {
        s.score -= 20;
        break;
      }
    }

    // Shallow depth bonus
    s.score += Math.max(0, 10 - parts.length * 2);

    // Source code bonus
    if (SOURCE_EXTS.has(ext)) s.score += 3;
  }

  // Sort by score and take top N
  const sorted = [...fileScores.values()].sort((a, b) => b.score - a.score);
  const topFiles = sorted.slice(0, maxFiles);

  // Add siblings of top-scoring files
  const topDirs = new Set<string>();
  for (const f of topFiles.slice(0, 30)) {
    topDirs.add(dirname(f.file));
  }

  const siblings: FileScore[] = [];
  for (const dir of topDirs) {
    const fullDir = join(cwd, dir);
    if (!existsSync(fullDir)) continue;

    try {
      for (const entry of readdirSync(fullDir)) {
        const filePath = dir ? `${dir}/${entry}` : entry;
        if (fileScores.has(filePath)) continue;

        const ext = extname(entry).toLowerCase();
        if (SKIP_EXTENSIONS.has(ext)) continue;
        if (SKIP_FILES.has(entry.toLowerCase())) continue;
        if (entry.startsWith(".")) continue;

        const fullPath = join(fullDir, entry);
        try {
          if (!statSync(fullPath).isFile()) continue;
        } catch { continue; }

        siblings.push({
          file: filePath,
          score: 5,
          matchCount: 0,
          patternMatches: [],
        });
      }
    } catch {}
  }

  // Merge and re-sort
  const allFiles = [...topFiles, ...siblings];
  allFiles.sort((a, b) => b.score - a.score);

  return allFiles.slice(0, maxFiles);
}

function buildTree(cwd: string, files: FileScore[]): TreeNode[] {
  const fileSet = new Set(files.map(f => f.file));
  const scoreMap = new Map(files.map(f => [f.file, f]));

  // Build directory structure
  const dirs = new Set<string>();
  for (const f of files) {
    let dir = dirname(f.file);
    while (dir && dir !== ".") {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }

  // Count directory contents for hidden counts
  const dirCounts = new Map<string, { files: number; dirs: number }>();

  function countDirContents(dirPath: string): { files: number; dirs: number } {
    if (dirCounts.has(dirPath)) return dirCounts.get(dirPath)!;

    const fullPath = join(cwd, dirPath);
    let files = 0, subdirs = 0;

    try {
      for (const entry of readdirSync(fullPath)) {
        if (entry.startsWith(".")) continue;
        const entryPath = join(fullPath, entry);
        try {
          if (statSync(entryPath).isDirectory()) subdirs++;
          else files++;
        } catch {}
      }
    } catch {}

    const counts = { files, dirs: subdirs };
    dirCounts.set(dirPath, counts);
    return counts;
  }

  function buildLevel(parentPath: string): TreeNode[] {
    const nodes: TreeNode[] = [];
    const prefix = parentPath ? parentPath + "/" : "";

    // Find direct children
    const includedChildren = new Set<string>();
    for (const f of files) {
      if (parentPath === "") {
        includedChildren.add(f.file.split("/")[0]);
      } else if (f.file.startsWith(prefix)) {
        const rest = f.file.slice(prefix.length);
        includedChildren.add(rest.split("/")[0]);
      }
    }
    for (const d of dirs) {
      if (parentPath === "") {
        includedChildren.add(d.split("/")[0]);
      } else if (d.startsWith(prefix)) {
        const rest = d.slice(prefix.length);
        if (rest && !rest.includes("/")) includedChildren.add(rest);
      }
    }

    const sortedChildren = [...includedChildren].sort();
    let shownFiles = 0, shownDirs = 0;

    for (const name of sortedChildren) {
      const path = parentPath ? `${parentPath}/${name}` : name;

      if (fileSet.has(path)) {
        shownFiles++;
        const info = scoreMap.get(path)!;
        nodes.push({
          name,
          path,
          isDir: false,
          score: info.score,
        });
      } else if (dirs.has(path)) {
        shownDirs++;
        nodes.push({
          name,
          path,
          isDir: true,
          children: buildLevel(path),
        });
      }
    }

    // Add hidden count
    if (parentPath) {
      const total = countDirContents(parentPath);
      const hiddenFiles = total.files - shownFiles;
      const hiddenDirs = total.dirs - shownDirs;

      if (hiddenFiles > 0 || hiddenDirs > 0) {
        nodes.push({
          name: "",
          path: "",
          isDir: false,
          hiddenFiles,
          hiddenDirs,
        });
      }
    }

    return nodes;
  }

  return buildLevel("");
}

function renderIndented(nodes: TreeNode[], depth: number = 0): string {
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  for (const node of nodes) {
    // Hidden count
    if (node.hiddenFiles !== undefined || node.hiddenDirs !== undefined) {
      const parts: string[] = [];
      if (node.hiddenFiles && node.hiddenFiles > 0) {
        parts.push(`${node.hiddenFiles} file${node.hiddenFiles > 1 ? "s" : ""}`);
      }
      if (node.hiddenDirs && node.hiddenDirs > 0) {
        parts.push(`${node.hiddenDirs} folder${node.hiddenDirs > 1 ? "s" : ""}`);
      }
      lines.push(`${indent}...${parts.join(", ")}`);
      continue;
    }

    let name = node.name;
    if (node.isDir) {
      name += "/";
    } else if (node.score && node.score > 50) {
      name += " ★";
    }

    lines.push(`${indent}${name}`);

    if (node.children && node.children.length > 0) {
      lines.push(renderIndented(node.children, depth + 1));
    }
  }

  return lines.join("\n");
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Generate a smart file tree for a query.
 * Returns indented tree string and list of relevant files.
 */
export function getSmartTree(
  cwd: string,
  query: string,
  options: SmartTreeOptions = {}
): SmartTreeResult {
  const { maxFiles = 100, extraPatterns } = options;

  const patterns = extractPatterns(query, extraPatterns);
  if (patterns.length === 0) {
    return { tree: "(no patterns extracted)", files: [], patterns: [] };
  }

  const scoredFiles = scoreFiles(cwd, patterns, maxFiles);
  if (scoredFiles.length === 0) {
    return { tree: "(no files found)", files: [], patterns };
  }

  const tree = buildTree(cwd, scoredFiles);
  const treeStr = renderIndented(tree);
  const files = scoredFiles.map(f => f.file);

  return { tree: treeStr, files, patterns };
}
