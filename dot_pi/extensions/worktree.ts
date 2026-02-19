/**
 * Worktree Extension
 *
 * Adds commands for managing git worktrees:
 * - wt:ls - List worktrees with TUI, select to spawn pi in that folder
 * - wt:new - Create a new worktree and jump into it
 *
 * Commands appear when:
 * - In ~/Development/Projects or ~/Development/Temporary with a git repo
 * - In ~/Development/Worktrees if the main repo is in Projects or Temporary
 */

import { exec, execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { Container, SelectList, Text, type SelectItem, matchesKey, parseKey, visibleWidth, fuzzyFilter } from "@mariozechner/pi-tui";

const execAsync = promisify(exec);

const HOME = homedir();

const DEVELOPMENT_PATHS = [
  join(HOME, "Development", "Projects"),
  join(HOME, "Development", "Temporary"),
];
const WORKTREES_PATH = join(HOME, "Development", "Worktrees");

/**
 * Shorten path for display.
 * ~/Development/Projects/x → ~/D/P/x
 * ~/Development/Worktrees/x → ~/D/W/x
 * ~/Development/Temporary/x → ~/D/T/x
 */
function displayPath(path: string): string {
  if (!path.startsWith(HOME)) return path;
  
  let short = "~" + path.slice(HOME.length);
  
  // Only shorten the known prefixes, not arbitrary folders
  const devPrefix = "~/Development";
  if (short.startsWith(devPrefix + "/") || short === devPrefix) {
    short = "~/D" + short.slice(devPrefix.length);
  }
  
  // Now shorten Projects/Worktrees/Temporary only if they follow ~/D/
  short = short.replace(/^~\/D\/Projects(\/|$)/, "~/D/P$1");
  short = short.replace(/^~\/D\/Worktrees(\/|$)/, "~/D/W$1");
  short = short.replace(/^~\/D\/Temporary(\/|$)/, "~/D/T$1");
  
  return short;
}

interface WorktreeInfo {
  path: string;
  branch: string;
  commit: string;
  isMain: boolean;
  aheadBehind: { ahead: number; behind: number; aheadDiff?: { added: number; removed: number } } | null;
  changes: { staged: number; unstaged: number } | null;
}

/**
 * Check if a path is under an allowed development path.
 */
function isInDevPath(path: string): boolean {
  return DEVELOPMENT_PATHS.some((devPath) => path.startsWith(devPath + "/") || path === devPath);
}

/**
 * Check if the current directory is a valid worktree context.
 * Valid if:
 * - In ~/Development/Projects or ~/Development/Temporary with a git repo
 * - In ~/Development/Worktrees but the main repo is in Projects or Temporary
 */
function isValidWorktreeContext(cwd: string): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", { cwd, stdio: "pipe" });
  } catch {
    return false;
  }

  // Check if cwd itself is in dev paths
  if (isInDevPath(cwd)) return true;

  // Check if in Worktrees folder - if so, check if main repo is in dev paths
  if (cwd.startsWith(WORKTREES_PATH + "/") || cwd === WORKTREES_PATH) {
    try {
      const mainRoot = getMainRepoRoot(cwd);
      return isInDevPath(mainRoot);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Get the git root directory.
 */
function getGitRoot(cwd: string): string {
  return execSync("git rev-parse --show-toplevel", { cwd, encoding: "utf-8" }).trim();
}

/**
 * Get the main repository root (the actual .git directory location).
 */
function getMainRepoRoot(cwd: string): string {
  try {
    const gitDir = execSync("git rev-parse --git-dir", { cwd, encoding: "utf-8" }).trim();
    // If it's a worktree, gitDir will be like /path/to/main/.git/worktrees/name
    if (gitDir.includes(".git/worktrees/")) {
      const mainGitDir = gitDir.split(".git/worktrees/")[0] + ".git";
      return dirname(mainGitDir);
    }
    // If it's the main repo, gitDir is just ".git" or an absolute path to .git
    if (gitDir === ".git") {
      return getGitRoot(cwd);
    }
    return dirname(gitDir);
  } catch {
    return getGitRoot(cwd);
  }
}

/**
 * Get ahead/behind counts for a branch (async).
 * - ahead: commits since merge-base with develop/main (handles PRs off PRs)
 * - behind: commits upstream has that we don't
 * - aheadDiff: lines added/removed in ahead commits
 */
async function getAheadBehind(cwd: string, branch: string): Promise<{ ahead: number; behind: number; aheadDiff?: { added: number; removed: number } } | null> {
  try {
    let ahead = 0;
    let behind = 0;
    let aheadDiff: { added: number; removed: number } | undefined;
    let mergeBaseRef = "";

    // Find base branch (develop, main, or master)
    const { stdout: baseBranch } = await execAsync(
      `if git rev-parse --verify develop >/dev/null 2>&1; then echo develop; ` +
      `elif git rev-parse --verify main >/dev/null 2>&1; then echo main; ` +
      `elif git rev-parse --verify master >/dev/null 2>&1; then echo master; fi`,
      { cwd }
    );
    const base = baseBranch.trim();

    // Commits ahead of merge-base
    if (base) {
      const { stdout: mergeBase } = await execAsync(
        `git merge-base HEAD ${base} 2>/dev/null || echo ""`,
        { cwd }
      );
      mergeBaseRef = mergeBase.trim();
      if (mergeBaseRef) {
        const { stdout: aheadCount } = await execAsync(
          `git rev-list --count ${mergeBaseRef}..HEAD`,
          { cwd }
        );
        ahead = parseInt(aheadCount.trim(), 10) || 0;
        
        // Get diff stats for ahead commits
        if (ahead > 0) {
          try {
            const { stdout: diffStat } = await execAsync(
              `git diff --numstat ${mergeBaseRef}..HEAD | awk '{a+=$1; r+=$2} END {print a, r}'`,
              { cwd }
            );
            const [added, removed] = diffStat.trim().split(/\s+/).map(n => parseInt(n, 10) || 0);
            if (added > 0 || removed > 0) {
              aheadDiff = { added, removed };
            }
          } catch {
            // Ignore diff stat errors
          }
        }
      }
    }

    // Commits behind upstream
    const { stdout: upstream } = await execAsync(
      `git rev-parse --abbrev-ref ${branch}@{upstream} 2>/dev/null || echo ""`,
      { cwd }
    );
    if (upstream.trim()) {
      const { stdout: behindCount } = await execAsync(
        `git rev-list --count HEAD..${upstream.trim()}`,
        { cwd }
      );
      behind = parseInt(behindCount.trim(), 10) || 0;
    }

    if (ahead === 0 && behind === 0) return null;
    return { ahead, behind, aheadDiff };
  } catch {
    return null;
  }
}

/**
 * Get staged/unstaged changes count for a worktree (async).
 */
async function getChanges(worktreePath: string): Promise<{ staged: number; unstaged: number } | null> {
  try {
    // Use maxBuffer to handle repos with many changes
    const { stdout: status } = await execAsync("git status --porcelain", { 
      cwd: worktreePath,
      maxBuffer: 10 * 1024 * 1024, // 10MB
    });
    let staged = 0;
    let unstaged = 0;
    for (const line of status.split("\n").filter(Boolean)) {
      const index = line[0];
      const workTree = line[1];
      if (index && index !== " " && index !== "?") staged++;
      if (workTree && workTree !== " " && workTree !== "?") unstaged++;
      if (index === "?" && workTree === "?") unstaged++; // Untracked files
    }
    return { staged, unstaged };
  } catch {
    return null;
  }
}

/**
 * List all worktrees for the repository (async, fetches status in parallel).
 */
async function listWorktrees(cwd: string): Promise<WorktreeInfo[]> {
  const mainRoot = getMainRepoRoot(cwd);

  const output = execSync("git worktree list --porcelain", {
    cwd: mainRoot,
    encoding: "utf-8",
  });

  const worktrees: WorktreeInfo[] = [];
  let current: Partial<WorktreeInfo> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) {
        worktrees.push(current as WorktreeInfo);
      }
      current = { path: line.slice(9), isMain: false };
    } else if (line.startsWith("HEAD ")) {
      current.commit = line.slice(5, 12); // Short hash
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.branch = "(bare)";
    } else if (line.startsWith("detached")) {
      current.branch = `(detached @ ${current.commit})`;
    }
  }

  if (current.path) {
    worktrees.push(current as WorktreeInfo);
  }

  // Mark main worktree
  if (worktrees.length > 0) {
    worktrees[0].isMain = true;
  }

  // Fetch status info in parallel for all worktrees
  await Promise.all(
    worktrees.map(async (wt) => {
      try {
        const [aheadBehind, changes] = await Promise.all([
          wt.branch && !wt.branch.startsWith("(") ? getAheadBehind(wt.path, wt.branch) : null,
          getChanges(wt.path),
        ]);
        wt.aheadBehind = aheadBehind;
        wt.changes = changes;
      } catch {
        // Ignore errors for individual worktrees
      }
    })
  );

  // Sort worktrees: main first, then by worktree number (natural sort)
  worktrees.sort((a, b) => {
    // Main worktree always first
    if (a.isMain) return -1;
    if (b.isMain) return 1;

    // Extract worktree numbers for natural sorting (e.g., wt2 before wt10)
    const aName = basename(a.path);
    const bName = basename(b.path);
    const aMatch = aName.match(/-wt(\d+)$/);
    const bMatch = bName.match(/-wt(\d+)$/);

    // If both match the pattern, sort by number
    if (aMatch && bMatch) {
      const aNum = parseInt(aMatch[1], 10);
      const bNum = parseInt(bMatch[1], 10);
      return aNum - bNum;
    }

    // If only one matches, prioritize the one with -wtN pattern
    if (aMatch) return -1;
    if (bMatch) return 1;

    // Fall back to alphabetical
    return aName.localeCompare(bName);
  });

  return worktrees;
}

/**
 * Get the next worktree number for a given folder name.
 */
function getNextWorktreeNumber(folderName: string): number {
  if (!existsSync(WORKTREES_PATH)) {
    return 1;
  }

  const entries = readdirSync(WORKTREES_PATH);
  const pattern = new RegExp(`^${folderName}-wt(\\d+)$`);
  let maxNum = 0;

  for (const entry of entries) {
    const match = entry.match(pattern);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num > maxNum) maxNum = num;
    }
  }

  return maxNum + 1;
}

/**
 * Format worktree info for display.
 */
function formatWorktreeLabel(wt: WorktreeInfo, theme: any, isCurrent: boolean, maxWidth: number): string {
  const folderName = basename(wt.path);
  
  // Build status suffix first to know remaining space
  let suffix = "";
  
  // Ahead/behind remote (pastel colors, not green/red)
  if (wt.aheadBehind) {
    const { ahead, behind, aheadDiff } = wt.aheadBehind;
    if (ahead > 0) {
      suffix += theme.fg("accent", ` ↑${ahead}`);
      if (aheadDiff) {
        suffix += theme.fg("dim", "(") + 
                  theme.fg("success", `+${aheadDiff.added}`) + 
                  theme.fg("dim", "/") + 
                  theme.fg("error", `-${aheadDiff.removed}`) + 
                  theme.fg("dim", ")");
      }
    }
    if (behind > 0) suffix += theme.fg("warning", ` ↓${behind}`);
  }

  // Changes (staged/unstaged)
  if (wt.changes) {
    const { staged, unstaged } = wt.changes;
    if (typeof staged === "number" && staged > 0) suffix += theme.fg("success", ` +${staged}`);
    if (typeof unstaged === "number" && unstaged > 0) suffix += theme.fg("error", ` ~${unstaged}`);
  }

  // Tags
  if (isCurrent) suffix += theme.fg("dim", " (current)");
  if (wt.isMain) suffix += theme.fg("dim", " (main)");

  // Calculate available space for branch name
  // Format: "  > folderName [branch] suffix" where "> " is select prefix
  const prefixWidth = 4; // "  > " select prefix
  const folderWidth = visibleWidth(folderName);
  const bracketsWidth = 3; // " []"
  const suffixWidth = visibleWidth(suffix);
  const usedWidth = prefixWidth + folderWidth + bracketsWidth + suffixWidth;
  const availableForBranch = maxWidth - usedWidth;
  
  // Only truncate if branch doesn't fit
  let branchDisplay = wt.branch;
  const branchWidth = visibleWidth(branchDisplay);
  if (branchWidth > availableForBranch && availableForBranch >= 10) {
    branchDisplay = branchDisplay.slice(0, availableForBranch - 1) + "…";
  }

  // Build label
  let label = "";
  if (isCurrent) {
    label += theme.fg("accent", theme.bold(folderName));
  } else {
    label += theme.bold(folderName);
  }
  label += " " + theme.fg("muted", "[") + theme.fg("accent", branchDisplay) + theme.fg("muted", "]");
  label += suffix;

  return label;
}

/**
 * Spawn a detached process to delete a worktree.
 * Survives parent process death, notifies via tmux when done.
 */
function spawnDeleteWorktree(worktreePath: string, mainRoot: string): void {
  const wtName = basename(worktreePath);
  
  // Build command that deletes and notifies via tmux
  const cmd = `
    if git worktree remove "${worktreePath}" --force 2>/dev/null; then
      tmux display-message "✓ Deleted: ${wtName}" 2>/dev/null || true
    else
      tmux display-message "⚠️ Failed to delete: ${wtName}" 2>/dev/null || true
    fi
  `;
  
  const child = spawn("bash", ["-c", cmd], {
    detached: true,
    stdio: "ignore",
    cwd: mainRoot,
  });
  child.unref();
}

/**
 * Check if we're running inside tmux.
 */
function isInTmux(): boolean {
  return !!process.env.TMUX;
}

/**
 * Spawn a new pi session in the given directory.
 * If in tmux, creates a new window and switches to it.
 * Otherwise, shows a message with the path.
 */
function spawnPiSession(targetDir: string, ctx: ExtensionContext): void {
  if (!isInTmux()) {
    ctx.ui.notify(`Not in tmux. Run: cd ${displayPath(targetDir)} && pi`, "warning");
    return;
  }

  const windowName = basename(targetDir);
  
  // Create new tmux window with pi in target directory and switch to it
  execSync(`tmux new-window -n "${windowName}" -c "${targetDir}" "pi"`, {
    stdio: "pipe",
  });

  ctx.ui.notify(`✓ Opened ${windowName} in new tmux window`, "info");
}

export default function worktreeExtension(pi: ExtensionAPI) {
  // Check context immediately - commands won't be registered if not valid
  // Note: We use process.cwd() since ctx isn't available at registration time
  const cwd = process.cwd();
  if (!isValidWorktreeContext(cwd)) {
    return; // Don't register any commands
  }

  // wt:ls command
  pi.registerCommand("wt:ls", {
    description: "List git worktrees and switch to one",
    handler: async (_args, ctx) => {
      const currentPath = getGitRoot(ctx.cwd);
      const mainRoot = getMainRepoRoot(ctx.cwd);

      // Loop to return to list after delete
      let worktrees = await listWorktrees(ctx.cwd);
      while (true) {

        if (worktrees.length === 0) {
          ctx.ui.notify("No worktrees found", "info");
          return;
        }

        type Action = { type: "switch"; path: string } | { type: "delete"; path: string } | null;

        const result = await ctx.ui.custom<Action>((tui, theme, _kb, done) => {
          let lastWidth = 80;
          let filter = "";
          const mainName = basename(mainRoot);

          // Build searchable text for fuzzy matching (folder name + branch)
          function getSearchText(wt: WorktreeInfo): string {
            return `${basename(wt.path)} ${wt.branch}`;
          }

          function buildItems(filteredWorktrees: WorktreeInfo[]): SelectItem[] {
            return filteredWorktrees.map((wt) => {
              const isCurrent = wt.path === currentPath;
              const wtName = basename(wt.path);
              // Only show path if not in expected location (~/Development/Worktrees/<main>-wtN)
              const expectedPattern = new RegExp(`^${mainName}-wt\\d+$`);
              const isExpectedLocation = wt.path.startsWith(WORKTREES_PATH + "/") && expectedPattern.test(wtName);
              return {
                value: wt.path,
                label: formatWorktreeLabel(wt, theme, isCurrent, lastWidth),
                description: isExpectedLocation ? undefined : displayPath(wt.path),
              };
            });
          }

          function getFilteredWorktrees(): WorktreeInfo[] {
            if (!filter) return worktrees;
            return fuzzyFilter(worktrees, filter, getSearchText);
          }

          function updateHeader(): void {
            if (filter) {
              header.setText(theme.fg("accent", theme.bold("  Git Worktrees")) + theme.fg("muted", " › ") + theme.fg("accent", filter) + theme.fg("accent", "▌"));
            } else {
              header.setText(theme.fg("accent", theme.bold("  Git Worktrees")));
            }
          }

          let filteredWorktrees = getFilteredWorktrees();
          let items = buildItems(filteredWorktrees);

          const container = new Container();
          const topBorder = new DynamicBorder((s: string) => theme.fg("accent", s));
          const header = new Text(theme.fg("accent", theme.bold("  Git Worktrees")), 0, 0);
          const spacer1 = new Text("", 0, 0);

          const selectList = new SelectList(items, Math.min(items.length + 2, 15), {
            selectedPrefix: (text) => theme.fg("accent", text),
            selectedText: (text) => text,
            description: (text) => theme.fg("dim", text),
            scrollInfo: (text) => theme.fg("dim", text),
            noMatch: (text) => theme.fg("warning", text),
          });

          const spacer2 = new Text("", 0, 0);
          const helpText = new Text(
            theme.fg("dim", "  type to filter • ↑↓ navigate • enter switch • ^x delete • esc cancel"),
            0, 0
          );
          const bottomBorder = new DynamicBorder((s: string) => theme.fg("accent", s));

          container.addChild(topBorder);
          container.addChild(header);
          container.addChild(spacer1);
          container.addChild(selectList);
          container.addChild(spacer2);
          container.addChild(helpText);
          container.addChild(bottomBorder);

          selectList.onSelect = (item) => done({ type: "switch", path: item.value });
          selectList.onCancel = () => done(null);

          return {
            render: (w) => {
              lastWidth = w;
              // Rebuild items with correct width (using already filtered worktrees)
              items = buildItems(filteredWorktrees);
              (selectList as any).items = items;
              (selectList as any).filteredItems = items;
              return container.render(w);
            },
            invalidate: () => container.invalidate(),
            handleInput: (data) => {
              // Handle Ctrl-x for delete
              if (matchesKey(data, "ctrl+x")) {
                const selectedItem = selectList.getSelectedItem();
                if (!selectedItem) return;

                const wtPath = selectedItem.value;
                const wt = filteredWorktrees.find((w) => w.path === wtPath);

                if (wt?.isMain) {
                  ctx.ui.notify("Cannot delete the main worktree", "warning");
                  return;
                }

                done({ type: "delete", path: wtPath });
                return;
              }

              // Handle escape - clear filter first, then cancel
              if (matchesKey(data, "escape")) {
                if (filter.length > 0) {
                  filter = "";
                  filteredWorktrees = getFilteredWorktrees();
                  items = buildItems(filteredWorktrees);
                  (selectList as any).items = items;
                  (selectList as any).filteredItems = items;
                  (selectList as any).selectedIndex = 0;
                  updateHeader();
                  tui.requestRender();
                  return;
                }
                // No filter, let SelectList handle cancel
              }

              // Handle backspace for filter
              if (matchesKey(data, "backspace")) {
                if (filter.length > 0) {
                  filter = filter.slice(0, -1);
                  filteredWorktrees = getFilteredWorktrees();
                  items = buildItems(filteredWorktrees);
                  (selectList as any).items = items;
                  (selectList as any).filteredItems = items;
                  (selectList as any).selectedIndex = 0;
                  updateHeader();
                  tui.requestRender();
                  return;
                }
              }

              // Handle printable characters for filter
              const key = parseKey(data);
              if (key && key.length === 1 && !key.startsWith("ctrl+") && !key.startsWith("alt+")) {
                filter += key;
                filteredWorktrees = getFilteredWorktrees();
                items = buildItems(filteredWorktrees);
                (selectList as any).items = items;
                (selectList as any).filteredItems = items;
                (selectList as any).selectedIndex = 0;
                updateHeader();
                tui.requestRender();
                return;
              }

              // Let SelectList handle navigation (arrows, enter, esc)
              selectList.handleInput(data);
              tui.requestRender();
            },
          };
        });

        if (!result) return;

        if (result.type === "delete") {
          const wtPath = result.path;
          const wt = worktrees.find((w) => w.path === wtPath);
          const isCurrent = wtPath === currentPath;

          // Confirm deletion
          const confirmed = await ctx.ui.confirm(
            "Delete Worktree",
            `Delete worktree "${basename(wtPath)}"${wt?.branch ? ` (branch: ${wt.branch})` : ""}?\n\nThis will remove the worktree directory but keep the branch.`
          );

          if (!confirmed) {
            continue; // Return to list
          }

          if (isCurrent) {
            // Deleting current worktree - spawn detached delete and switch away
            if (isInTmux()) {
              const windowName = basename(mainRoot);
              try {
                const currentWindow = execSync("tmux display-message -p '#I'", { 
                  encoding: "utf-8", 
                  cwd: HOME 
                }).trim();
                
                // Spawn detached delete (survives pi death)
                spawnDeleteWorktree(wtPath, mainRoot);
                
                // Create new window and switch to it
                execSync(
                  `tmux new-window -n "${windowName}" -c "${mainRoot}" "pi"`,
                  { stdio: "pipe", cwd: HOME }
                );
                
                // Kill the old window
                execSync(`tmux kill-window -t ${currentWindow}`, { stdio: "pipe", cwd: HOME });
              } catch {
                // Might fail if window already closed
              }
            }
            ctx.shutdown();
            return;
          }

          // Not current worktree - spawn detached delete and continue
          spawnDeleteWorktree(wtPath, mainRoot);
          
          // Optimistically remove from list so it doesn't show while delete is pending
          worktrees = worktrees.filter((w) => w.path !== wtPath);
          if (worktrees.length === 0) {
            ctx.ui.notify("No worktrees remaining", "info");
            return;
          }
          continue; // Return to list immediately
        }

        // Switch action
        if (result.path === currentPath) {
          ctx.ui.notify("Already in this worktree", "info");
          return;
        }

        ctx.ui.notify(`Switching to ${basename(result.path)}...`, "info");
        spawnPiSession(result.path, ctx);
        return;
      }
    },
  });

  // wt:new command
  pi.registerCommand("wt:new", {
    description: "Create a new git worktree",
    handler: async (args, ctx) => {
      const mainRoot = getMainRepoRoot(ctx.cwd);
      const folderName = basename(mainRoot);
      const nextNum = getNextWorktreeNumber(folderName);
      const newWorktreeName = `${folderName}-wt${nextNum}`;
      const newWorktreePath = join(WORKTREES_PATH, newWorktreeName);

      // Ensure Worktrees directory exists
      if (!existsSync(WORKTREES_PATH)) {
        mkdirSync(WORKTREES_PATH, { recursive: true });
      }

      // Find base branch (develop/main/master) to branch from
      let baseBranch = "develop";
      try {
        const result = execSync(
          `if git rev-parse --verify develop >/dev/null 2>&1; then echo develop; ` +
          `elif git rev-parse --verify main >/dev/null 2>&1; then echo main; ` +
          `elif git rev-parse --verify master >/dev/null 2>&1; then echo master; fi`,
          { cwd: mainRoot, encoding: "utf-8" }
        ).trim();
        if (result) baseBranch = result;
      } catch {
        // Fall back to develop
      }

      // Determine branch name
      let branchName = args?.trim();
      if (!branchName) {
        // Generate a branch name based on worktree name
        branchName = newWorktreeName;
      }

      try {
        // Create the worktree with a new branch based off the base branch
        execSync(`git worktree add -b "${branchName}" "${newWorktreePath}" "${baseBranch}"`, {
          cwd: mainRoot,
          stdio: "pipe",
        });

        ctx.ui.notify(`✓ Created worktree: ${newWorktreeName} (branch: ${branchName} from ${baseBranch})`, "info");

        // Run setup script async while spawning pi
        runWorktreeSetupAsync(mainRoot, newWorktreePath, branchName);

        // Spawn new pi session in the new worktree
        spawnPiSession(newWorktreePath, ctx);
      } catch (error: any) {
        // Try without creating a new branch (branch might already exist)
        try {
          execSync(`git worktree add "${newWorktreePath}" "${branchName}"`, {
            cwd: mainRoot,
            stdio: "pipe",
          });

          ctx.ui.notify(`✓ Created worktree: ${newWorktreeName} (branch: ${branchName})`, "info");

          // Run setup script async while spawning pi
          runWorktreeSetupAsync(mainRoot, newWorktreePath, branchName);

          spawnPiSession(newWorktreePath, ctx);
        } catch (innerError: any) {
          ctx.ui.notify(`Failed to create worktree: ${innerError.message}`, "error");
        }
      }
    },
  });
}

/**
 * Run worktree setup script asynchronously with tmux notification.
 * Runs in background so pi can start immediately.
 */
function runWorktreeSetupAsync(
  mainRoot: string,
  targetPath: string,
  branchName: string,
): void {
  const setupScript = join(mainRoot, ".worktree-setup.sh");
  
  if (!existsSync(setupScript)) {
    return;
  }

  const env = {
    ...process.env,
    WORKTREE_SOURCE: mainRoot,
    WORKTREE_TARGET: targetPath,
    WORKTREE_BRANCH: branchName,
    WORKTREE_NAME: basename(targetPath),
  };

  // Run setup script in background, show tmux notification when done
  const tmuxNotify = (msg: string) => {
    if (isInTmux()) {
      try {
        execSync(`tmux display-message "${msg.replace(/"/g, '\\"')}"`, { stdio: "pipe", cwd: HOME });
      } catch {}
    }
  };

  // Use exec (async) to run in background
  exec(`bash "${setupScript}"`, { cwd: targetPath, env }, (error, stdout, stderr) => {
    if (error) {
      tmuxNotify(`⚠️ Worktree setup failed: ${error.message}`);
    } else {
      const lines = stdout.trim().split("\n").filter(Boolean);
      const linked = lines.filter(l => l.includes("Linked:")).length;
      if (linked > 0) {
        tmuxNotify(`✓ Worktree setup: linked ${linked} file${linked > 1 ? "s" : ""}`);
      } else {
        tmuxNotify(`✓ Worktree setup complete`);
      }
    }
  });
}
