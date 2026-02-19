import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const LMSTUDIO_BASE_URL = "http://localhost:1234/v1";
const LMSTUDIO_API_KEY = "lm-studio"; // LM Studio ignores this but it's required

interface LMStudioModel {
  id: string;
  object: string;
  owned_by?: string;
}

async function fetchModels(): Promise<LMStudioModel[]> {
  try {
    const res = await fetch(`${LMSTUDIO_BASE_URL}/models`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.data ?? [];
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  async function registerModels(ctx?: { ui: { notify: (msg: string, level: string) => void } }) {
    const models = await fetchModels();
    if (models.length === 0) {
      ctx?.ui.notify("LM Studio: not running or no models loaded", "warning");
      return;
    }

    pi.registerProvider("lmstudio", {
      baseUrl: LMSTUDIO_BASE_URL,
      apiKey: LMSTUDIO_API_KEY,
      api: "openai-completions",
      models: models.map((m) => ({
        id: m.id,
        name: `LM Studio: ${m.id}`,
        reasoning: false,
        input: ["text"] as ("text" | "image")[],
        contextWindow: 128000,
        maxTokens: 16384,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: {
          supportsUsageInStreaming: false,
          maxTokensField: "max_tokens" as const,
          supportsDeveloperRole: false,
        },
      })),
    });

    ctx?.ui.notify(`LM Studio: ${models.length} model(s) detected`, "info");
  }

  // Auto-discover on session start
  pi.on("session_start", async (_event, ctx) => {
    await registerModels(ctx);
  });

  // Command to manually refresh
  pi.registerCommand("lmstudio", {
    description: "Refresh LM Studio models",
    handler: async (_args, ctx) => {
      await registerModels(ctx);
    },
  });
}
