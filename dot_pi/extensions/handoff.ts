import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

type WarningLevel = "none" | "info" | "warn" | "critical";

type HandoffInput = {
	primary_request: string;
	reason: string;
	key_topics: string;
	files_and_resources: string;
	errors_and_fixes?: string;
	problem_solving: string;
	current_task: string;
	next_step: string;
};

const HANDOFF_COMPACT_MARKER = "__handoff_extension_compact__";

type PendingHandoff = {
	summaryText: string;
	reason: string;
	primaryRequest: string;
	currentTask: string;
	nextStep: string;
};

let pendingHandoff: PendingHandoff | null = null;
let handoffCompactionQueued = false;
let lastWarningLevel: WarningLevel = "none";

const levelRank: Record<WarningLevel, number> = {
	none: 0,
	info: 1,
	warn: 2,
	critical: 3,
};

function resetState() {
	pendingHandoff = null;
	handoffCompactionQueued = false;
	lastWarningLevel = "none";
}

function computeLimits(contextWindow: number) {
	return {
		info: Math.floor(contextWindow * 0.7),
		warn: Math.floor(contextWindow * 0.82),
		force: Math.floor(contextWindow * 0.9),
	};
}

function computeWarning(ctx: ExtensionContext): {
	level: WarningLevel;
	message?: string;
	limits?: { info: number; warn: number; force: number };
	tokens?: number;
} {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.contextWindow <= 0) {
		return { level: "none" };
	}

	const limits = computeLimits(usage.contextWindow);
	const tokens = usage.tokens;

	if (tokens > limits.force) {
		return {
			level: "critical",
			limits,
			tokens,
			message: `CRITICAL: Your context has exceeded ${limits.force.toLocaleString()} tokens and is approaching the model limit. You MUST use the handoff tool immediately on your next turn to avoid losing context.`,
		};
	}

	if (tokens > limits.warn) {
		return {
			level: "warn",
			limits,
			tokens,
			message: `WARNING: Your context is very large (over ${limits.warn.toLocaleString()} tokens). You should use the handoff tool very soon to maintain performance. Context resets help you work more efficiently.`,
		};
	}

	if (tokens > limits.info) {
		return {
			level: "info",
			limits,
			tokens,
			message: `Your context is getting large (over ${limits.info.toLocaleString()} tokens). Consider using the handoff tool soon to maintain performance.`,
		};
	}

	return { level: "none", limits, tokens };
}

function buildSummary(params: HandoffInput): string {
	const sections: string[] = [
		`## Primary Request\n${params.primary_request}`,
		`\n## Reason for Handoff\n${params.reason}`,
		`\n## Key Topics\n${params.key_topics}`,
		`\n## Files and Resources\n${params.files_and_resources}`,
	];

	if (params.errors_and_fixes) {
		sections.push(`\n## Errors and Fixes\n${params.errors_and_fixes}`);
	}

	sections.push(
		`\n## Problem Solving Approach\n${params.problem_solving}`,
		`\n## Current Task\n${params.current_task}`,
		`\n## Next Step\n${params.next_step}`,
	);

	return sections.join("\n");
}

function buildResumePrompt(pending: PendingHandoff): string {
	return [
		"Handoff compaction complete. Resume execution now.",
		"",
		`Primary request: ${pending.primaryRequest}`,
		`Current task before handoff: ${pending.currentTask}`,
		`Next step: ${pending.nextStep}`,
		"",
		"Continue directly from the next step. Do not run another handoff unless context is critical again.",
	].join("\n");
}

export default function handoffExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "handoff",
		label: "Handoff",
		description:
			"Reset context by summarizing progress and handing off to a fresh context. Use after major milestones, when context gets large, or when switching task phases.",
		parameters: Type.Object({
			primary_request: Type.String({
				description: "The main request or goal the user is trying to achieve",
			}),
			reason: Type.String({
				description:
					"Why you are handing off (e.g. completed major section, context getting large, stuck on error)",
			}),
			key_topics: Type.String({
				description: "Important topics, technologies, or concepts discussed",
			}),
			files_and_resources: Type.String({
				description:
					"Key files modified with detailed summaries, important snippets, and resources used",
			}),
			errors_and_fixes: Type.Optional(
				Type.String({
					description: "Errors encountered and how they were resolved",
				}),
			),
			problem_solving: Type.String({
				description: "Key problem-solving approaches or decisions made",
			}),
			current_task: Type.String({
				description: "What you were working on just before handoff",
			}),
			next_step: Type.String({
				description: "What should be done next",
			}),
		}),
		async execute(_toolCallId, params) {
			const typedParams = params as HandoffInput;
			const summaryText = buildSummary(typedParams);

			pendingHandoff = {
				summaryText,
				reason: typedParams.reason,
				primaryRequest: typedParams.primary_request,
				currentTask: typedParams.current_task,
				nextStep: typedParams.next_step,
			};

			return {
				content: [
					{
						type: "text",
						text: `## Handoff Summary\n\n${summaryText}`,
					},
				],
				details: {
					success: true,
					reason: typedParams.reason,
					summaryText,
				},
			};
		},
	});

	pi.registerCommand("handoff", {
		description: "Trigger a structured handoff and compaction",
		handler: async (_args, ctx) => {
			const prompt = `Use the handoff tool now to compact context.\n\nRequirements:\n- Fill all handoff fields with concrete, high-signal details from this thread.\n- Set primary_request to the user's main objective in this conversation.\n- After calling handoff, do not call additional tools in this turn.`;

			if (ctx.isIdle()) {
				pi.sendUserMessage(prompt);
			} else {
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			}

			ctx.ui.notify("Queued handoff request to the agent.", "info");
		},
	});

	pi.on("session_start", async () => {
		resetState();

		// Keep handoff active even if tool sets were customized previously.
		const active = new Set(pi.getActiveTools());
		if (!active.has("handoff")) {
			active.add("handoff");
			pi.setActiveTools([...active]);
		}
	});

	pi.on("session_switch", async () => resetState());
	pi.on("session_fork", async () => resetState());

	pi.on("before_agent_start", async (event, ctx) => {
		const warning = computeWarning(ctx);

		if (warning.level === "none") {
			lastWarningLevel = "none";
			return;
		}

		if (levelRank[warning.level] > levelRank[lastWarningLevel] && ctx.hasUI && warning.message) {
			ctx.ui.notify(warning.message, warning.level === "info" ? "info" : "warning");
		}
		lastWarningLevel = warning.level;

		const systemPrompt = `${event.systemPrompt}\n\n<context_management>\nUse the handoff tool proactively when context grows, after major milestones, or when switching task phases.\n</context_management>\n\n<token_limits>\n- Info threshold: ${warning.limits?.info.toLocaleString()} tokens\n- Warning threshold: ${warning.limits?.warn.toLocaleString()} tokens\n- Force handoff: ${warning.limits?.force.toLocaleString()} tokens\nCurrent estimated context: ${warning.tokens?.toLocaleString()} tokens\n\n${warning.message}\n</token_limits>`;

		return { systemPrompt };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName === "handoff") return;

		const warning = computeWarning(ctx);
		if (warning.level !== "critical") return;

		return {
			block: true,
			reason:
				"Context is critically large. Call the handoff tool immediately before using other tools.",
		};
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (!pendingHandoff || handoffCompactionQueued) return;

		handoffCompactionQueued = true;
		ctx.compact({
			customInstructions: HANDOFF_COMPACT_MARKER,
			onComplete: () => {
				const completedHandoff = pendingHandoff;
				handoffCompactionQueued = false;
				pendingHandoff = null;
				if (ctx.hasUI) ctx.ui.notify("Handoff summary applied via compaction.", "info");

				if (!completedHandoff) return;
				const resumePrompt = buildResumePrompt(completedHandoff);
				if (ctx.isIdle()) {
					pi.sendUserMessage(resumePrompt);
				} else {
					pi.sendUserMessage(resumePrompt, { deliverAs: "followUp" });
				}
				if (ctx.hasUI) ctx.ui.notify("Queued automatic resume after handoff.", "info");
			},
			onError: (error) => {
				handoffCompactionQueued = false;
				if (ctx.hasUI) ctx.ui.notify(`Handoff compaction failed: ${error.message}`, "error");
			},
		});
	});

	pi.on("session_before_compact", async (event) => {
		if (!pendingHandoff) return;

		const shouldUseHandoffSummary =
			handoffCompactionQueued || event.customInstructions === HANDOFF_COMPACT_MARKER;
		if (!shouldUseHandoffSummary) return;

		return {
			compaction: {
				summary: pendingHandoff.summaryText,
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: {
					source: "handoff-tool",
					reason: pendingHandoff.reason,
				},
			},
		};
	});
}
