---
name: pi-introspect
description: Analyse pi sessions — costs, timing, failures, turboread benchmarks, conversation dumps. Use when the user asks about pi session history, spending, debugging agent failures, reviewing past conversations, benchmarking turboread, or any meta-analysis of pi usage. Also use when asked "what happened in session X", "how much have I spent", "why did turboread fail", "analyse my sessions", or similar.
---

# pi-introspect

Toolkit for introspecting pi agent sessions. All scripts share a common library and read from `~/.pi/agent/sessions/`.

## Quick Reference

All scripts are in this skill's `scripts/` directory. Run with `bun`:

```bash
SCRIPTS="<path to this skill>/scripts"
```

### List sessions
```bash
bun $SCRIPTS/sessions.ts                          # last 7 days
bun $SCRIPTS/sessions.ts --since 14d --verbose     # with user messages
bun $SCRIPTS/sessions.ts --cwd ~/Dev/scout         # filter by project
bun $SCRIPTS/sessions.ts --grep "turboread"        # search user messages
bun $SCRIPTS/sessions.ts --id <uuid-prefix>        # detail view
```

### Cost report
```bash
bun $SCRIPTS/costs.ts                                # last 7 days, plain ASCII (default, agent-friendly)
bun $SCRIPTS/costs.ts --model opus --since 7d --daily # filter by model
bun $SCRIPTS/costs.ts --cwd ~/Dev/scout              # filter by project
```

### Diagnose failures
```bash
bun $SCRIPTS/diagnose.ts                           # last 7 days
bun $SCRIPTS/diagnose.ts --tool turboread          # focus on turboread
bun $SCRIPTS/diagnose.ts --failures                # only critical/high
bun $SCRIPTS/diagnose.ts --id <uuid-prefix>        # single session
```

### Turboread benchmark
```bash
bun $SCRIPTS/turboread-bench.ts                    # last 14 days
bun $SCRIPTS/turboread-bench.ts --since 30d        # longer window
bun $SCRIPTS/turboread-bench.ts --failures         # only failures
```

### Dump conversation
```bash
bun $SCRIPTS/dump.ts --latest                      # most recent session
bun $SCRIPTS/dump.ts --latest --cwd ~/Dev/scout    # most recent in project
bun $SCRIPTS/dump.ts --latest --tools              # include tool calls
bun $SCRIPTS/dump.ts <session-id-prefix>           # specific session
```

### Time analysis
```bash
bun $SCRIPTS/timing.ts                             # last 7 days
bun $SCRIPTS/timing.ts --since 30d --hourly --tools # full breakdown
```

### Query (JSONL data for piping/scripting)
```bash
bun $SCRIPTS/query.ts --since 7d                     # one JSON line per session
bun $SCRIPTS/query.ts --group day                    # aggregate by day
bun $SCRIPTS/query.ts --group model --since 30d      # aggregate by model
bun $SCRIPTS/query.ts --group week --model opus      # weekly opus spend
bun $SCRIPTS/query.ts --fields id,totalCost,models   # pick specific fields
```

Agent pipe examples:
```bash
# total cost last 7d
bun $SCRIPTS/query.ts --since 7d | jq -s 'map(.totalCost) | add'
# daily opus breakdown
bun $SCRIPTS/query.ts --model opus --group day --since 7d | jq -r '"\(.key)\t$\(.cost)"'
# most expensive sessions
bun $SCRIPTS/query.ts --since 7d | jq -s 'sort_by(-.totalCost)[:5] | .[] | "\(.totalCost)\t\(.firstMessage[:60])"' -r
# sessions with errors
bun $SCRIPTS/query.ts --since 7d | jq 'select(.errorCount > 0)'
```

For custom analysis, write a short inline script importing lib:
```bash
bun -e 'import {loadSessions,summariseSession} from "/path/to/scripts/lib";
const s = (await loadSessions({since:new Date(Date.now()-7*86400000)})).map(summariseSession);
console.log(s.filter(x=>x.totalCost>5).map(x=>({id:x.id,cost:x.totalCost})))'
```

## Common flags

| Flag | Description |
|------|-------------|
| `--since <date\|Nd\|Nh>` | Filter sessions after date. Accepts ISO dates (`2026-01-05`), relative days (`7d`), hours (`24h`). Default: `7d` |
| `--until <date>` | Filter sessions before date |
| `--cwd <path>` | Only sessions from this working directory (prefix match) |
| `--limit <n>` | Max sessions to process |
| `--model <str>` | Filter to sessions using this model (substring match, e.g. `opus`, `haiku`, `glm`) |
| `--json` | Machine-readable JSON output (for formatted scripts; query.ts is JSONL by default) |
| `--fancy` | Unicode/emoji/bar-chart formatting (human-friendly). Default is plain ASCII. |

## Unified CLI

```bash
bun $SCRIPTS/pi-introspect.ts sessions --since 7d
bun $SCRIPTS/pi-introspect.ts costs --since 30d --daily
bun $SCRIPTS/pi-introspect.ts diagnose --tool turboread
bun $SCRIPTS/pi-introspect.ts dump --latest --tools
bun $SCRIPTS/pi-introspect.ts turboread --since 14d
bun $SCRIPTS/pi-introspect.ts timing --hourly --tools
```

## How it works

- `scripts/lib.ts` — shared parsing, loading, formatting. All scripts import from here.
- Session data lives in `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl`
- Each JSONL file is one session. Lines are typed entries: `session`, `model_change`, `message`, etc.
- Messages have `role` (user/assistant/toolResult), `content` blocks, `usage` with cost/tokens.
- Turboread sessions also dump to `~/.pi/turboread/sessions/` for debugging mini-agent internals.

## Extending

To add a new analysis, create a new `scripts/foo.ts` that imports from `./lib`:

```typescript
import { loadSessions, summariseSession, parseArgs, parseDateArg } from "./lib";

const args = parseArgs(process.argv.slice(2));
const since = args.since ? parseDateArg(args.since as string) : new Date(Date.now() - 7 * 86400000);
const sessions = await loadSessions({ since });
const summaries = sessions.map(summariseSession);

// Your analysis here
```

The `SessionSummary` type gives you: id, cwd, timestamps, userMessages, models, toolCalls, toolResults, cost, tokens, errorCount.
