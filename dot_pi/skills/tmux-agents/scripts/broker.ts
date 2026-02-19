#!/usr/bin/env bun
// Broker daemon for pi tmux-agents
// Manages agent completion signaling via Unix domain socket
// Tracks turns per agent so wait.sh always blocks until the current turn completes
// Usage: bun broker.ts <session-name> <socket-path>

import { unlinkSync, existsSync } from "fs";

const sessionName = process.argv[2];
const socketPath = process.argv[3];

if (!sessionName || !socketPath) {
  console.error("Usage: bun broker.ts <session-name> <socket-path>");
  process.exit(1);
}

if (existsSync(socketPath)) {
  unlinkSync(socketPath);
}

interface AgentState {
  turn: number;
  status: "idle" | "working" | "done" | "error";
  cancelled: boolean; // true if current turn was cancelled, ignore next done
  result?: AgentEvent;
}

interface AgentEvent {
  type: "done" | "error";
  agent: number;
  turn: number;
  status: string;
  cost?: string;
  duration?: number;
  error?: string;
  timestamp: number;
}

const agents = new Map<number, AgentState>();
const waiters = new Map<number, import("bun").Socket[]>();

function getAgent(id: number): AgentState {
  if (!agents.has(id)) {
    agents.set(id, { turn: 0, status: "idle", cancelled: false });
  }
  return agents.get(id)!;
}

const server = Bun.listen({
  unix: socketPath,
  socket: {
    data(socket, raw) {
      const lines = raw.toString().split("\n").filter(Boolean);
      for (const line of lines) {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          socket.write(JSON.stringify({ error: "invalid JSON" }) + "\n");
          continue;
        }

        switch (msg.type) {
          case "start": {
            // Extension signals agent_start — new turn begins
            const agent = getAgent(msg.agent);
            agent.turn++;
            agent.status = "working";
            agent.cancelled = false;
            agent.result = undefined;
            console.log(`[broker] Agent ${msg.agent} started turn ${agent.turn}`);
            socket.write(JSON.stringify({ ok: true, turn: agent.turn }) + "\n");
            break;
          }

          case "done":
          case "error": {
            const agent = getAgent(msg.agent);

            // Ignore stale signal from a cancelled turn
            if (agent.cancelled) {
              console.log(`[broker] Agent ${msg.agent} ${msg.type} (stale, cancelled turn — ignored)`);
              agent.cancelled = false;
              socket.write(JSON.stringify({ ok: true, stale: true }) + "\n");
              break;
            }

            const event: AgentEvent = {
              type: msg.type,
              agent: msg.agent,
              turn: agent.turn,
              status: msg.type,
              cost: msg.cost,
              duration: msg.duration,
              error: msg.error,
              timestamp: Date.now(),
            };
            agent.status = msg.type;
            agent.result = event;
            console.log(`[broker] Agent ${msg.agent} ${msg.type} turn ${agent.turn}${msg.cost ? ` (${msg.cost})` : ""}`);

            // Notify any waiters
            const waiting = waiters.get(msg.agent) || [];
            for (const w of waiting) {
              try {
                w.write(JSON.stringify(event) + "\n");
                w.end();
              } catch {}
            }
            waiters.delete(msg.agent);
            socket.write(JSON.stringify({ ok: true }) + "\n");
            break;
          }

          case "cancel": {
            // send.sh signals cancellation before interrupting the agent
            const agent = getAgent(msg.agent);
            const prevTurn = agent.turn;
            agent.status = "idle";
            agent.cancelled = true;
            agent.result = undefined;
            console.log(`[broker] Agent ${msg.agent} cancelled (was turn ${prevTurn})`);

            // Notify any waiters that the task was cancelled
            const cancelWaiters = waiters.get(msg.agent) || [];
            for (const w of cancelWaiters) {
              try {
                w.write(JSON.stringify({
                  type: "cancelled",
                  agent: msg.agent,
                  turn: prevTurn,
                  timestamp: Date.now(),
                }) + "\n");
                w.end();
              } catch {}
            }
            waiters.delete(msg.agent);
            socket.write(JSON.stringify({ ok: true }) + "\n");
            break;
          }

          case "wait": {
            const agent = getAgent(msg.agent);

            if (agent.status === "done" || agent.status === "error") {
              // Current turn already finished, respond immediately
              socket.write(JSON.stringify(agent.result!) + "\n");
              socket.end();
            } else {
              // Agent is working or idle — queue waiter until next done/error
              const list = waiters.get(msg.agent) || [];
              list.push(socket);
              waiters.set(msg.agent, list);
            }
            break;
          }

          case "status": {
            const status: Record<string, any> = {};
            for (const [k, v] of agents) {
              status[`agent-${k}`] = {
                turn: v.turn,
                status: v.status,
                ...(v.result ? { cost: v.result.cost, duration: v.result.duration } : {}),
              };
            }
            socket.write(JSON.stringify({
              agents: status,
              waiting: [...waiters.keys()].map(k => `agent-${k}`),
            }) + "\n");
            socket.end();
            break;
          }

          case "shutdown": {
            console.log("[broker] Shutdown requested");
            socket.write(JSON.stringify({ ok: true }) + "\n");
            socket.end();
            setTimeout(() => {
              try { unlinkSync(socketPath); } catch {}
              process.exit(0);
            }, 100);
            break;
          }

          default:
            socket.write(JSON.stringify({ error: `unknown type: ${msg.type}` }) + "\n");
        }
      }
    },
    error(socket, err) {
      for (const [agent, sockets] of waiters) {
        waiters.set(agent, sockets.filter(s => s !== socket));
      }
    },
    close(socket) {
      for (const [agent, sockets] of waiters) {
        waiters.set(agent, sockets.filter(s => s !== socket));
      }
    },
  },
});

console.log(`[broker] Listening on ${socketPath} for session "${sessionName}"`);

process.on("SIGTERM", () => {
  try { unlinkSync(socketPath); } catch {}
  process.exit(0);
});
process.on("SIGINT", () => {
  try { unlinkSync(socketPath); } catch {}
  process.exit(0);
});
