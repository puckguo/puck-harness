/**
 * Provider credential management — puck's take on pi's /login.
 *
 * Providers are API-key holders (one key per vendor, e.g. "MiniMax CN"),
 * NOT model lists. Models are fetched live from each provider's
 * `GET {baseUrl}/models` endpoint (OpenAI-compatible) after login, so the
 * catalog never goes stale and new models appear without code changes.
 *
 * Resolution order for API keys (checked at every LLM call):
 *   1. explicit options.apiKey
 *   2. stored credential (~/.puck/auth.json, written by /login)
 *   3. environment variable (provider.apiKeyEnv)
 *
 * Storage is auth.json with 0600 permissions, keyed by provider id.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recordContextWindow } from "./models.js";

// ---------------------------------------------------------------------------
// Provider registry (mirrors pi's provider list; OpenAI-compatible endpoints
// unless noted). Extend by pushing to PROVIDERS — nothing else references it.
// ---------------------------------------------------------------------------

export interface Provider {
	/** Registry id (stored in auth.json). */
	id: string;
	/** Display name, e.g. "MiniMax CN". */
	name: string;
	/** OpenAI-compatible base URL (models + chat both resolve from it). */
	baseUrl: string;
	/** Environment variables accepted for this provider (first hit wins). */
	apiKeyEnvs: string[];
	/** Model id prefix filter for the /models listing, when the endpoint returns foreign models too. */
	modelFilter?: (id: string) => boolean;
}

export const PROVIDERS: Provider[] = [
	{ id: "alibaba", name: "Alibaba DashScope", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKeyEnvs: ["DASHSCOPE_API_KEY"] },
	{ id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnvs: ["ANTHROPIC_API_KEY"] },
	{ id: "ant-ling", name: "Ant Ling", baseUrl: "https://api.ant-ling.com/v1", apiKeyEnvs: ["ANT_LING_API_KEY"] },
	{ id: "cerebras", name: "Cerebras", baseUrl: "https://api.cerebras.ai/v1", apiKeyEnvs: ["CEREBRAS_API_KEY"] },
	{ id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKeyEnvs: ["DEEPSEEK_API_KEY"] },
	{ id: "fireworks", name: "Fireworks", baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnvs: ["FIREWORKS_API_KEY"] },
	{ id: "google", name: "Google AI", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKeyEnvs: ["GEMINI_API_KEY", "GOOGLE_API_KEY"] },
	{ id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnvs: ["GROQ_API_KEY"] },
	{ id: "huggingface", name: "Hugging Face", baseUrl: "https://router.huggingface.co/v1", apiKeyEnvs: ["HF_TOKEN"] },
	{ id: "kimi", name: "Kimi For Coding", baseUrl: "https://api.kimi.com/coding/v1", apiKeyEnvs: ["KIMI_API_KEY"] },
	{ id: "minimax", name: "MiniMax", baseUrl: "https://api.minimax.io/v1", apiKeyEnvs: ["MINIMAX_API_KEY"] },
	{ id: "minimax-cn", name: "MiniMax CN", baseUrl: "https://api.minimaxi.com/v1", apiKeyEnvs: ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"] },
	{ id: "mistral", name: "Mistral", baseUrl: "https://api.mistral.ai/v1", apiKeyEnvs: ["MISTRAL_API_KEY"] },
	{ id: "moonshot", name: "Moonshot AI", baseUrl: "https://api.moonshot.ai/v1", apiKeyEnvs: ["MOONSHOT_API_KEY"] },
	{ id: "moonshot-cn", name: "Moonshot AI CN", baseUrl: "https://api.moonshot.cn/v1", apiKeyEnvs: ["MOONSHOT_CN_API_KEY", "MOONSHOT_API_KEY"] },
	{ id: "nvidia", name: "NVIDIA", baseUrl: "https://integrate.api.nvidia.com/v1", apiKeyEnvs: ["NVIDIA_API_KEY"] },
	{ id: "ollama", name: "Ollama (local)", baseUrl: "http://localhost:11434/v1", apiKeyEnvs: ["OLLAMA_API_KEY"] },
	{ id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", apiKeyEnvs: ["OPENAI_API_KEY"] },
	{ id: "opencode", name: "OpenCode Zen", baseUrl: "https://opencode.ai/zen/v1", apiKeyEnvs: ["OPENCODE_API_KEY"] },
	{ id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnvs: ["OPENROUTER_API_KEY"] },
	{ id: "lmstudio", name: "LM Studio (local)", baseUrl: "http://localhost:1234/v1", apiKeyEnvs: ["LMSTUDIO_API_KEY"] },
	{ id: "qwen-token-plan", name: "Qwen Token Plan", baseUrl: "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1", apiKeyEnvs: ["QWEN_TOKEN_PLAN_API_KEY"] },
	{ id: "qwen-token-plan-cn", name: "Qwen Token Plan CN", baseUrl: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", apiKeyEnvs: ["QWEN_TOKEN_PLAN_CN_API_KEY"] },
	{ id: "together", name: "Together", baseUrl: "https://api.together.ai/v1", apiKeyEnvs: ["TOGETHER_API_KEY"] },
	{ id: "vercel", name: "Vercel AI Gateway", baseUrl: "https://ai-gateway.vercel.sh/v1", apiKeyEnvs: ["AI_GATEWAY_API_KEY"] },
	{ id: "vllm", name: "vLLM (local)", baseUrl: "http://localhost:8000/v1", apiKeyEnvs: ["VLLM_API_KEY"] },
	{ id: "xai", name: "xAI", baseUrl: "https://api.x.ai/v1", apiKeyEnvs: ["XAI_API_KEY"] },
	{ id: "xiaomi", name: "Xiaomi", baseUrl: "https://api.xiaomimimo.com/v1", apiKeyEnvs: ["XIAOMI_API_KEY"] },
	{ id: "zai", name: "ZAI", baseUrl: "https://api.z.ai/api/paas/v4", apiKeyEnvs: ["ZAI_API_KEY"] },
	{ id: "zai-coding-cn", name: "Z.AI Coding CN", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4", apiKeyEnvs: ["ZAI_CODING_CN_API_KEY", "GLM_CODING_API_KEY"] },
];

export function findProvider(idOrName: string): Provider | undefined {
	const needle = idOrName.trim().toLowerCase();
	return PROVIDERS.find(
		(p) => p.id === needle || p.name.toLowerCase() === needle || p.name.toLowerCase().startsWith(needle),
	);
}

export function listProviders(): Provider[] {
	return PROVIDERS;
}

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

/** Minimal store interface so hosts can bring their own storage. */
export interface CredentialStore {
	read(provider: string): string | undefined;
	write(provider: string, apiKey: string): void;
	delete(provider: string): void;
	list(): Array<{ provider: string; hasKey: boolean }>;
}

export function puckDir(): string {
	return process.env.PUCK_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".puck");
}

/** JSON file store at <dir>/auth.json, provider id → API key. */
export class FileCredentialStore implements CredentialStore {
	private readonly path: string;

	constructor(file?: string) {
		this.path = file ?? join(puckDir(), "auth.json");
	}

	private load(): Record<string, string> {
		try {
			return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, string>;
		} catch {
			return {};
		}
	}

	private save(data: Record<string, string>): void {
		mkdirSync(dirname(this.path), { recursive: true });
		writeFileSync(this.path, JSON.stringify(data, null, "\t"), { encoding: "utf8", mode: 0o600 });
		try {
			chmodSync(this.path, 0o600);
		} catch {
			/* best-effort on Windows */
		}
	}

	read(provider: string): string | undefined {
		const key = this.load()[provider];
		return key && key.length > 0 ? key : undefined;
	}

	write(provider: string, apiKey: string): void {
		const data = this.load();
		data[provider] = apiKey;
		this.save(data);
	}

	delete(provider: string): void {
		const data = this.load();
		delete data[provider];
		this.save(data);
	}

	list(): Array<{ provider: string; hasKey: boolean }> {
		const data = this.load();
		return PROVIDERS.map((provider) => ({ provider: provider.id, hasKey: Boolean(data[provider.id]) }));
	}

	get filePath(): string {
		return this.path;
	}
}

// ---------------------------------------------------------------------------
// Login interaction
// ---------------------------------------------------------------------------

/**
 * UI callbacks for interactive login — the host renders them however it
 * wants (CLI hides input, web app shows a form, tests return canned values).
 */
export interface LoginInteraction {
	/** Show a prompt and read a secret (e.g. API key). Return "" to cancel. */
	promptSecret(message: string): Promise<string>;
	/** Non-blocking status message. */
	info(message: string): void;
}

/** Interactive login for one provider: prompt for the API key, store it. */
export async function loginProvider(
	providerId: string,
	store: CredentialStore,
	interaction: LoginInteraction,
): Promise<void> {
	const provider = findProvider(providerId);
	if (!provider) {
		throw new Error(`Unknown provider "${providerId}". Available: ${PROVIDERS.map((p) => p.id).join(", ")}`);
	}

	const key = await interaction.promptSecret(`${provider.name} API key (${provider.apiKeyEnvs[0]}) — paste the key, empty to cancel:`);
	if (!key.trim()) throw new Error("Login cancelled");

	store.write(provider.id, key.trim());
	interaction.info(`Saved ${provider.name} key to ${store instanceof FileCredentialStore ? store.filePath : "credential store"}`);

	// verify the key by listing models; surface a warning (not an error) when it fails
	try {
		const models = await listModels(provider, key.trim());
		if (models.length > 0) interaction.info(`Key works — ${models.length} models available (e.g. ${models.slice(0, 3).join(", ")})`);
	} catch (error) {
		interaction.info(`Warning: key saved, but model listing failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Remove a stored key (logout). No-op when nothing stored. */
export function logoutProvider(providerId: string, store: CredentialStore): boolean {
	if (!store.read(providerId)) return false;
	store.delete(providerId);
	return true;
}

// ---------------------------------------------------------------------------
// Key resolution
// ---------------------------------------------------------------------------

/** Resolve the API key for a provider: explicit > stored > env. */
export function resolveProviderApiKey(provider: Provider, store: CredentialStore | undefined, explicit?: string): string | undefined {
	if (explicit) return explicit;
	const stored = store?.read(provider.id);
	if (stored) return stored;
	for (const env of provider.apiKeyEnvs) {
		const value = process.env[env];
		if (value) return value;
	}
	return undefined;
}

/** Resolve the key for a wire Model (looks its provider up in the registry). */
export function resolveApiKey(
	model: { provider: string; apiKeyEnv?: string },
	store: CredentialStore | undefined,
	explicit?: string,
): string | undefined {
	if (explicit) return explicit;
	const registry = PROVIDERS.find((p) => p.id === model.provider);
	if (registry) return resolveProviderApiKey(registry, store);
	const stored = store?.read(model.provider);
	if (stored) return stored;
	return model.apiKeyEnv ? process.env[model.apiKeyEnv] : undefined;
}

// ---------------------------------------------------------------------------
// Live model discovery — providers expose OpenAI-compatible GET /models
// ---------------------------------------------------------------------------

export interface ProviderModel {
	id: string;
	/** Optional display name from the endpoint. */
	name?: string;
	/** Rough context window when the endpoint reports it. */
	contextLength?: number;
}

/**
 * Fetch the provider's model list from `GET {baseUrl}/models`.
 * Works for every OpenAI-compatible endpoint (incl. ollama, vllm, lmstudio,
 * openrouter...). Returns ids sorted; empty on endpoints that don't list.
 */
export async function listModels(provider: Provider, apiKey: string): Promise<string[]> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/models`, {
			headers: { authorization: `Bearer ${apiKey}` },
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const payload = (await response.json()) as {
			data?: Array<{ id?: string; context_length?: number; context_window?: number; max_context_length?: number; max_model_len?: number; top_provider?: { context_length?: number } }>;
		};
		// Providers that report context (OpenRouter, Groq, Together, vLLM…) feed
		// the resolver; ids stay the primary output.
		for (const entry of payload.data ?? []) {
			if (!entry?.id) continue;
			const tokens = entry.context_length ?? entry.context_window ?? entry.max_context_length ?? entry.max_model_len ?? entry.top_provider?.context_length;
			if (typeof tokens === "number") recordContextWindow(entry.id, tokens);
		}
		const ids = (payload.data ?? [])
			.map((entry) => entry?.id)
			.filter((id): id is string => typeof id === "string" && id.length > 0)
			.filter((id) => (provider.modelFilter ? provider.modelFilter(id) : true));
		return [...new Set(ids)].sort();
	} finally {
		clearTimeout(timeout);
	}
}

/**
 * All providers with usable credentials (stored key or env), with their
 * live model lists. Used by the CLI to build the model picker after login.
 */
export async function discoverUsableModels(
	store: CredentialStore,
	options: { signal?: AbortSignal } = {},
): Promise<Array<{ provider: Provider; models: string[] }>> {
	const usable: Array<{ provider: Provider; models: string[] }> = [];
	for (const provider of PROVIDERS) {
		if (options.signal?.aborted) break;
		const key = resolveProviderApiKey(provider, store);
		if (!key) continue;
		try {
			const models = await listModels(provider, key);
			if (models.length > 0) usable.push({ provider, models });
		} catch {
			/* key exists but listing failed — skip provider silently */
		}
	}
	return usable;
}
