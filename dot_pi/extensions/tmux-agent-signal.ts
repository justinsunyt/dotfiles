import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { connect } from "net";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Extension for pi subagents spawned by tmux-agents.
// 1. On agent_start: signals broker to start a new turn
// 2. On agent_end: signals broker done + writes transcript
//
// Env vars set by spawn.sh: PI_AGENT_BROKER_SOCK, PI_AGENT_NUM, PI_AGENT_SESSION

const TRANSCRIPT_DIR = "/tmp/pi-agents";

function signalBroker(socketPath: string, msg: Record<string, any>): Promise<void> {
    return new Promise((resolve) => {
        const timeout = setTimeout(resolve, 3000);
        try {
            const sock = connect(socketPath, () => {
                sock.write(JSON.stringify(msg) + "\n");
                sock.once("data", () => {
                    clearTimeout(timeout);
                    sock.end();
                    resolve();
                });
            });
            sock.on("error", () => { clearTimeout(timeout); resolve(); });
        } catch {
            clearTimeout(timeout);
            resolve();
        }
    });
}

function formatTranscript(messages: any[]): string {
    const lines: string[] = [];

    for (const msg of messages) {
        if (msg.role === "user") {
            const text = typeof msg.content === "string"
                ? msg.content
                : msg.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n") || "";
            if (text.trim()) {
                lines.push("");
                for (const line of text.split("\n")) {
                    lines.push(`> ${line}`);
                }
            }
        } else if (msg.role === "assistant") {
            const content = msg.content || [];
            for (const block of content) {
                if (block.type === "text" && block.text?.trim()) {
                    lines.push("");
                    for (const line of block.text.split("\n")) {
                        lines.push(`< ${line}`);
                    }
                } else if (block.type === "tool_use" || block.type === "toolCall") {
                    const name = block.name || block.toolName || "unknown";
                    const args = block.arguments || block.input || {};
                    const summary = formatToolCall(name, args);
                    lines.push(`@ ${summary}`);
                }
            }
        } else if (msg.role === "toolResult") {
            const name = msg.toolName || "unknown";
            if (msg.isError) {
                const errText = msg.content
                    ?.filter((c: any) => c.type === "text")
                    .map((c: any) => c.text)
                    .join(" ")
                    .slice(0, 200) || "unknown error";
                lines.push(`@ ! ${name}: ${errText}`);
            }
        }
    }

    return lines.join("\n").trim() + "\n";
}

function formatToolCall(name: string, args: Record<string, any>): string {
    switch (name) {
        case "Read":
        case "read":
            return `Read ${args.path || "?"}${args.offset ? ` +${args.offset}` : ""}`;
        case "Write":
        case "write":
            return `Write ${args.path || "?"}`;
        case "Edit":
        case "edit":
            return `Edit ${args.path || "?"}`;
        case "Bash":
        case "bash": {
            const cmd = args.command || "?";
            const short = cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd;
            return `Bash ${short}`;
        }
        case "lsp":
            return `LSP ${args.action || "?"} ${args.file || ""}`.trim();
        case "subagent":
            return `Subagent${args.agent ? " " + args.agent : ""}`;
        case "turboread":
            return `Turboread${args.queries ? " (" + args.queries.length + " queries)" : ""}`;
        default: {
            const argStr = Object.entries(args)
                .filter(([_, v]) => typeof v === "string" && v.length < 60)
                .map(([k, v]) => `${k}=${v}`)
                .join(" ")
                .slice(0, 100);
            return `${name}${argStr ? " " + argStr : ""}`;
        }
    }
}

export default function (pi: ExtensionAPI) {
    const socketPath = process.env.PI_AGENT_BROKER_SOCK;
    const agentNum = parseInt(process.env.PI_AGENT_NUM || "0", 10);
    const sessionName = process.env.PI_AGENT_SESSION || "unknown";

    if (!socketPath || !agentNum) return; // Not a managed subagent

    const startTime = Date.now();
    const transcriptDir = join(TRANSCRIPT_DIR, sessionName);
    const transcriptPath = join(transcriptDir, `agent-${agentNum}.transcript`);

    let allMessages: any[] = [];

    pi.on("agent_start", async (_event: any, _ctx) => {
        await signalBroker(socketPath, { type: "start", agent: agentNum });
    });

    pi.on("agent_end", async (event: any, ctx) => {
        const duration = Math.round((Date.now() - startTime) / 1000);

        const newMessages = event.messages || [];
        allMessages = allMessages.concat(newMessages);

        try {
            mkdirSync(transcriptDir, { recursive: true });
            writeFileSync(transcriptPath, formatTranscript(allMessages));
        } catch {}

        await signalBroker(socketPath, { type: "done", agent: agentNum, duration });
    });
}
