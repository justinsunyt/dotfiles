/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentModelOption {
	name?: string;
	provider?: string;
	model: string;
	thinking?: string;
}

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	modelOptions?: Record<string, AgentModelOption>;
	defaultModelOption?: string;
	thinking?: string;
	defaultTask?: string;
	systemPrompt: string;
	source: "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function parseTools(value: unknown): string[] | undefined {
	if (typeof value === "string") {
		const tools = value
			.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}

	if (Array.isArray(value)) {
		const tools = value
			.map((item) => (typeof item === "string" ? item.trim() : ""))
			.filter(Boolean);
		return tools.length > 0 ? tools : undefined;
	}

	return undefined;
}

function parseModelOptions(value: unknown): Record<string, AgentModelOption> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

	const options: Record<string, AgentModelOption> = {};
	for (const [key, rawOption] of Object.entries(value as Record<string, unknown>)) {
		if (!rawOption || typeof rawOption !== "object" || Array.isArray(rawOption)) continue;
		const optionRecord = rawOption as Record<string, unknown>;
		const model = asNonEmptyString(optionRecord.model);
		if (!model) continue;

		const parsed: AgentModelOption = { model };
		const name = asNonEmptyString(optionRecord.name);
		if (name) parsed.name = name;
		const provider = asNonEmptyString(optionRecord.provider);
		if (provider) parsed.provider = provider;
		const thinking = asNonEmptyString(optionRecord.thinking);
		if (thinking) parsed.thinking = thinking;

		options[key] = parsed;
	}

	return Object.keys(options).length > 0 ? options : undefined;
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);

		const name = asNonEmptyString(frontmatter.name);
		const description = asNonEmptyString(frontmatter.description);
		if (!name || !description) {
			continue;
		}

		const tools = parseTools(frontmatter.tools);
		const model = asNonEmptyString(frontmatter.model);
		const thinking = asNonEmptyString(frontmatter.thinking);
		const defaultTask = asNonEmptyString(frontmatter["default-task"]);
		const modelOptions = parseModelOptions(frontmatter["model-options"]);
		const defaultModelOptionRaw = asNonEmptyString(frontmatter["default-model-option"]);
		const defaultModelOption =
			defaultModelOptionRaw && modelOptions && modelOptions[defaultModelOptionRaw]
				? defaultModelOptionRaw
				: undefined;

		agents.push({
			name,
			description,
			tools,
			model,
			modelOptions,
			defaultModelOption,
			thinking,
			defaultTask,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, ".pi", "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(os.homedir(), ".pi", "agent", "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	if (scope === "both") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	} else if (scope === "user") {
		for (const agent of userAgents) agentMap.set(agent.name, agent);
	} else {
		for (const agent of projectAgents) agentMap.set(agent.name, agent);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
