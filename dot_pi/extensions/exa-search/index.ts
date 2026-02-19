import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateHead, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";

const SearchParams = Type.Object({
	query: Type.String({ description: "The search query" }),
	numResults: Type.Optional(
		Type.Number({ description: "Number of results to return (default: 5, max: 20)", minimum: 1, maximum: 20 })
	),
	type: Type.Optional(
		StringEnum(["auto", "keyword", "neural"] as const, {
			description: "Search type: auto (default), keyword (exact match), or neural (semantic)",
		})
	),
	category: Type.Optional(
		StringEnum(
			[
				"company",
				"research paper",
				"news",
				"github",
				"tweet",
				"movie",
				"song",
				"personal site",
				"pdf",
			] as const,
			{ description: "Filter results to a specific category" }
		)
	),
	includeContents: Type.Optional(
		Type.Boolean({ description: "Include page text content in results (default: true)" })
	),
	includeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Only include results from these domains" })
	),
	excludeDomains: Type.Optional(
		Type.Array(Type.String(), { description: "Exclude results from these domains" })
	),
	startPublishedDate: Type.Optional(
		Type.String({ description: "Only results published after this date (ISO 8601, e.g. 2024-01-01T00:00:00.000Z)" })
	),
	endPublishedDate: Type.Optional(
		Type.String({ description: "Only results published before this date (ISO 8601)" })
	),
});

type SearchParamsType = Static<typeof SearchParams>;

interface ExaResult {
	title: string;
	url: string;
	publishedDate?: string;
	author?: string;
	score?: number;
	text?: string;
	highlights?: string[];
	summary?: string;
}

interface ExaResponse {
	requestId: string;
	results: ExaResult[];
	autopromptString?: string;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "exa_search",
		label: "Exa Search",
		description:
			"Search the web using Exa AI. Returns relevant web pages with optional text content. " +
			"Use for finding current information, research, documentation, news, code examples, and more.",
		parameters: SearchParams,

		async execute(toolCallId, params: SearchParamsType, signal, onUpdate, ctx) {
			const apiKey = process.env.EXA_API_KEY;
			if (!apiKey) {
				return {
					content: [
						{
							type: "text",
							text: "Error: EXA_API_KEY environment variable is not set. Get an API key at https://exa.ai",
						},
					],
					details: { error: "missing_api_key" },
					isError: true,
				};
			}

			const numResults = params.numResults ?? 5;
			const includeContents = params.includeContents !== false;

			const body: Record<string, unknown> = {
				query: params.query,
				numResults,
				type: params.type ?? "auto",
			};

			if (includeContents) {
				body.contents = {
					text: true,
				};
			}

			if (params.category) body.category = params.category;
			if (params.includeDomains?.length) body.includeDomains = params.includeDomains;
			if (params.excludeDomains?.length) body.excludeDomains = params.excludeDomains;
			if (params.startPublishedDate) body.startPublishedDate = params.startPublishedDate;
			if (params.endPublishedDate) body.endPublishedDate = params.endPublishedDate;

			try {
				onUpdate?.({
					content: [{ type: "text", text: `Searching: "${params.query}"...` }],
				});

				const response = await fetch("https://api.exa.ai/search", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-api-key": apiKey,
						Accept: "application/json",
					},
					body: JSON.stringify(body),
					signal,
				});

				if (!response.ok) {
					const errorText = await response.text().catch(() => "Unknown error");
					return {
						content: [{ type: "text", text: `Exa API error (${response.status}): ${errorText}` }],
						details: { error: response.status, errorText },
						isError: true,
					};
				}

				const data = (await response.json()) as ExaResponse;

				if (!data.results?.length) {
					return {
						content: [{ type: "text", text: `No results found for "${params.query}".` }],
						details: { query: params.query, resultCount: 0 },
					};
				}

				// Format results
				let output = `Found ${data.results.length} result${data.results.length === 1 ? "" : "s"} for "${params.query}":\n\n`;

				for (let i = 0; i < data.results.length; i++) {
					const r = data.results[i];
					output += `## ${i + 1}. ${r.title || "Untitled"}\n`;
					output += `URL: ${r.url}\n`;
					if (r.publishedDate) output += `Published: ${r.publishedDate.split("T")[0]}\n`;
					if (r.author) output += `Author: ${r.author}\n`;
					output += "\n";

					if (r.text) {
						output += r.text.trim() + "\n";
					}

					output += "\n---\n\n";
				}

				// Truncate if needed
				const truncation = truncateHead(output, {
					maxLines: DEFAULT_MAX_LINES,
					maxBytes: DEFAULT_MAX_BYTES,
				});

				let result = truncation.content;
				if (truncation.truncated) {
					result += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
					result += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)})]`;
				}

				return {
					content: [{ type: "text", text: result }],
					details: {
						query: params.query,
						resultCount: data.results.length,
						results: data.results.map((r) => ({
							title: r.title,
							url: r.url,
							publishedDate: r.publishedDate,
						})),
					},
				};
			} catch (err: unknown) {
				if (signal?.aborted) {
					return {
						content: [{ type: "text", text: "Search cancelled." }],
						details: { cancelled: true },
					};
				}
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: `Exa search error: ${message}` }],
					details: { error: message },
					isError: true,
				};
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("exa_search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.numResults && args.numResults !== 5) {
				text += theme.fg("muted", ` (${args.numResults} results)`);
			}
			if (args.category) {
				text += theme.fg("muted", ` [${args.category}]`);
			}
			if (args.type && args.type !== "auto") {
				text += theme.fg("dim", ` ${args.type}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching…"), 0, 0);
			}

			const details = result.details as Record<string, unknown> | undefined;

			if (details?.error) {
				return new Text(theme.fg("error", `✗ ${String(details.error)}`), 0, 0);
			}

			const count = (details?.resultCount as number) ?? 0;
			const results = (details?.results as Array<{ title: string; url: string }>) ?? [];

			if (count === 0) {
				return new Text(theme.fg("warning", "No results found"), 0, 0);
			}

			let text = theme.fg("success", `✓ ${count} result${count === 1 ? "" : "s"}`);

			if (expanded && results.length > 0) {
				for (const r of results) {
					text += "\n  " + theme.fg("accent", r.title || "Untitled");
					text += "\n  " + theme.fg("dim", r.url);
				}
			} else if (results.length > 0) {
				const titles = results.map((r) => r.title || "Untitled").join(", ");
				text += theme.fg("muted", ` — ${titles}`);
			}

			return new Text(text, 0, 0);
		},
	});
}
