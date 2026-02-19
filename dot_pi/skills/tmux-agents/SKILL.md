---
name: tmux-agents
description: Spawn and control multiple pi agent instances using tmux. Use for parallel task execution, long-horizon orchestration, and managing multiple autonomous agents.
---

# Tmux Agents

Orchestrate multiple pi instances via tmux for parallel tasks and long-horizon control.

Sessions are prefixed with `[agent]` to distinguish them from personal tmux sessions (e.g., `[agent] workers`). A Bun-based broker daemon provides instant completion signaling via Unix domain sockets — no more polling/scraping.

## Architecture

```
spawn.sh
  ├── starts Bun broker daemon (UDS at /tmp/pi-agents/<name>.sock)
  ├── creates tmux session "[agent] <name>"
  └── spawns pi instances with PI_AGENT_BROKER_SOCK, PI_AGENT_NUM, PI_AGENT_SESSION env vars

subagent (pi)
  └── ~/.pi/agent/extensions/tmux-agent-signal.ts (auto-loaded)
      ├── on agent_end: connects to broker socket, writes {"type":"done","agent":N}
      └── writes transcript to /tmp/pi-agents/<session>/agent-<N>.transcript

wait.sh
  └── connects to broker, sends {"type":"wait","agent":N}
      └── broker responds immediately if done, or holds connection until done

output.sh
  └── reads transcript file (default) or raw tmux pane (--pane)
```

## Transcripts

Subagents write transcripts in a lean sigil format to `/tmp/pi-agents/<name>/agent-<N>.transcript`:

```
> user prompt here

< assistant response here
< continuation lines

@ Read src/index.ts
@ Edit src/index.ts
@ Bash ls -la
@ ! read: ENOENT: file not found

< assistant's next response
```

- `>` user message, `<` assistant response, `@` tool call (one-liner), `@ !` tool error
- Tool outputs are **stripped** — only the tool name + key args are kept
- Accumulates across multiple prompts in the same session
- `output.sh` reads transcript by default; use `--pane` for raw tmux capture

## Scripts

All scripts in `./scripts/` relative to this skill directory. The `<name>` argument is the pool name (without the `[agent]` prefix — scripts add it automatically).

| Script | Usage | Description |
|--------|-------|-------------|
| `spawn.sh` | `<name> <count> [pi-args...]` | Create agent pool + broker |
| `send.sh` | `<name> <agent-num> <task>` | Send task to agent |
| `output.sh` | `<name> <agent-num> [--pane] [--lines N] [--full]` | Get agent transcript (or raw pane with --pane) |
| `status.sh` | `<name>` | Show all agents' status (queries broker) |
| `wait.sh` | `<name> <agent-num> [--timeout N]` | Block until agent completes (via broker) |
| `list.sh` | | List all agent pools |
| `kill.sh` | `<name> [agent-num]` | Kill agent(s), pool, and broker |
| `broadcast.sh` | `<name> <task>` | Send task to all agents |

## Requirements

- `bun` — used for the broker daemon and socket clients
- `tmux` — session management
- `~/.pi/agent/extensions/tmux-agent-signal.ts` — auto-loaded extension that signals broker on agent_end + writes transcripts

## Examples

```bash
# Spawn 3 agents with Sonnet
./scripts/spawn.sh workers 3 --model claude-sonnet-4-5 --thinking medium

# Spawn with codex subscription model
./scripts/spawn.sh codex-pool 2 --provider openai-codex --model gpt-5.2-codex --thinking low

# Distribute tasks
./scripts/send.sh workers 1 "implement feature A"
./scripts/send.sh workers 2 "implement feature B"
./scripts/send.sh workers 3 "write tests"

# Check status (queries broker for real completion data)
./scripts/status.sh workers

# Wait for completion — instant callback via broker, no polling
./scripts/wait.sh workers 1 --timeout 300

# Read transcript (clean sigil format, no TUI noise)
./scripts/output.sh workers 1

# Read raw tmux pane if needed
./scripts/output.sh workers 1 --pane

# Pipe transcript to file
./scripts/output.sh workers 1 --full > result.txt

# Wait for all in parallel
./scripts/wait.sh workers 1 & ./scripts/wait.sh workers 2 & ./scripts/wait.sh workers 3 & wait

# Broadcast same task to all
./scripts/broadcast.sh workers "run pnpm check and fix any errors"

# Cleanup (kills agents + broker + cleans socket)
./scripts/kill.sh workers
```

## Workflow Patterns

**Parallel execution**: Spawn N agents, distribute tasks, `wait.sh` on each (background with `&`), collect outputs.
**Pipeline**: Agent 1 creates → `wait.sh` → feed output to Agent 2 for review → iterate.
**Coordinator**: Agent 1 plans/decomposes task → parse its output → distribute subtasks to Agents 2-N.
**Specialist pool**: Spawn agents with different system prompts or models for different roles (reviewer, implementer, tester).
**Long-horizon**: Keep pool alive, send incremental tasks, monitor with `status.sh`, agents retain context across tasks.

## Direct tmux

Session names contain brackets, so use `=` prefix for exact matching in tmux targets:

```bash
tmux attach -t '=[agent] workers'                            # Attach to session
tmux list-windows -t '=[agent] workers'                      # List windows
tmux send-keys -t '=[agent] workers:agent-1' "msg" C-m       # Send raw input
tmux capture-pane -t '=[agent] workers:agent-1' -p           # Capture output
```
