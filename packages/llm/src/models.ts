/**
 * Model catalog and resolution.
 *
 * Models are resolved from PROVIDERS (auth.ts) at runtime: a model id plus
 * its provider fully determine the endpoint — no static catalog needed for
 * login flows. A few well-known ids stay in FALLBACK_CATALOG for offline
 * use (docs, mock tests) and for providers whose /models endpoint hides
 * chat models.
 */

import { FileCredentialStore, PROVIDERS, type Provider } from "./auth.js";

export interface Model {
	/** Model id sent to the provider API. */
	id: string;
	/** Human-readable name. */
	name: string;
	/** Wire protocol: "openai" (chat/completions) or "anthropic" (messages). */
	api: string;
	/** Provider registry id (auth.json key). */
	provider: string;
	baseUrl: string;
	/** First env var checked for the API key (full list lives on the provider). */
	apiKeyEnv: string;
	contextWindow: number;
	maxOutputTokens?: number;
	/** USD per 1M tokens. */
	cost?: { input: number; output: number };
	/**
	 * Model emits reasoning inline as <think>...</think> inside content
	 * (MiniMax-M3, Qwen3, GLM, ...). When true, the adapter splits it into
	 * ThinkingContent blocks instead of leaking it as visible text.
	 */
	thinkingTags?: boolean;
}

/** Resolve a model id against the provider registry: "provider/model" or bare id. */
export function resolveModel(modelId: string, providerHint?: string): Model {
	const [slashProvider, slashModel] = modelId.includes("/") ? (modelId.split("/", 2) as [string, string]) : [undefined, modelId];

	for (const provider of PROVIDERS) {
		if (providerHint && provider.id !== providerHint && provider.name.toLowerCase() !== providerHint.toLowerCase()) continue;
		if (slashProvider && provider.id !== slashProvider && provider.name.toLowerCase() !== slashProvider.toLowerCase()) continue;
		if (slashProvider || providerHint) {
			// explicit provider — return a wire model for the bare id
			return toModel(provider, slashModel ?? modelId);
		}
	}
	if (slashProvider || providerHint) {
		throw new Error(
			`Unknown provider "${providerHint ?? slashProvider ?? modelId}". Known: ${PROVIDERS.map((p) => p.id).join(", ")}`,
		);
	}

	// Bare model id: route by model-family affinity first (glm-5.3 is a ZAI
	// model regardless of how many other keys are stored), then fall back to
	// "the one usable provider". Never guess the FIRST registry provider — that
	// silently sends the request to the wrong vendor's endpoint.
	const lower = modelId.toLowerCase();
	for (const [pattern, providerIds] of MODEL_FAMILY_PROVIDERS) {
		if (!lower.includes(pattern)) continue;
		const preferred = providerIds.find((id) => {
			const provider = PROVIDERS.find((p) => p.id === id);
			return provider ? providerUsable(provider) : false;
		});
		const chosen = preferred ?? providerIds[0]; // no key → still route home (honest "未配置 key" warning)
		const provider = PROVIDERS.find((p) => p.id === chosen);
		if (provider) return toModel(provider, modelId);
	}

	const usable = PROVIDERS.filter((provider) => providerUsable(provider));
	if (usable.length === 1) return toModel(usable[0], modelId);
	throw new Error(
		`Ambiguous model "${modelId}" — use "provider/${modelId}" (usable keys: ${usable.map((p) => p.id).join(", ") || "none"})`,
	);
}

/**
 * Model families → their home provider(s), matched by substring on a bare id
 * (most specific first). First usable candidate wins; without a key the family
 * still routes home — a missing-key warning beats a wrong-vendor request.
 */
const MODEL_FAMILY_PROVIDERS: Array<[pattern: string, providerIds: string[]]> = [
	["minimax-", ["minimax-cn", "minimax"]],
	["abab", ["minimax-cn", "minimax"]],
	["glm-", ["zai-coding-cn", "zai"]],
	["deepseek", ["deepseek"]],
	["kimi", ["kimi", "moonshot-cn", "moonshot"]],
	["claude-", ["anthropic"]],
	["gpt-", ["openai"]],
	["o1", ["openai"]],
	["o3", ["openai"]],
	["o4-mini", ["openai"]],
	["gemini-", ["google"]],
	["qwen", ["qwen-token-plan-cn", "qwen-token-plan", "alibaba"]],
	["grok-", ["xai"]],
	["mistral-", ["mistral"]],
	["mixtral", ["mistral"]],
];

function providerUsable(provider: Provider): boolean {
	if (provider.apiKeyEnvs.some((name) => process.env[name])) return true;
	try {
		return Boolean(new FileCredentialStore().read(provider.id));
	} catch {
		return false;
	}
}

/** Look up provider then build a wire Model for the given model id. */
export function modelFor(providerId: string, modelId: string): Model {
	const provider = PROVIDERS.find((p) => p.id === providerId);
	if (!provider) throw new Error(`Unknown provider "${providerId}"`);
	return toModel(provider, modelId);
}

/** Providers whose models emit inline <think> reasoning (family trait, not per-model). */
const THINKING_TAG_PROVIDERS = new Set(["minimax", "minimax-cn", "zai", "zai-coding-cn"]);

/**
 * Known context windows (tokens), matched case-insensitively by substring —
 * most specific keys first. Sources: vendor docs; MiniMax-M3 and GLM-5.3
 * are 1M per the vendors. Everything unlisted falls back to the OpenAI-compat
 * norm of 128k, or to a /models-reported value via recordContextWindow().
 */
const KNOWN_CONTEXT_WINDOWS: Array<[pattern: string, tokens: number]> = [
	["minimax-m3", 1_000_000],
	["minimax-m2", 200_000],
	["glm-5", 1_000_000], // GLM-5 series incl. 5.2 / 5.3
	["glm-4", 128_000],
	["gemini-2.5", 1_000_000],
	["claude-sonnet-4", 200_000],
	["claude-opus-4", 200_000],
	["claude-3-7", 200_000],
	["claude-3-5", 200_000],
	["gpt-5", 400_000],
	["o3", 200_000],
	["o4-mini", 200_000],
	["gpt-4o", 128_000],
	["gpt-4-turbo", 128_000],
	["deepseek", 128_000],
	["qwen3-coder", 256_000],
	["kimi-k2", 131_072],
	["grok-4", 256_000],
];

/** contextWindow values discovered live from /models responses, by model id. */
const discoveredContextWindows = new Map<string, number>();

/** Called by listModels when a provider reports a context field for a model. */
export function recordContextWindow(modelId: string, tokens: number): void {
	if (Number.isFinite(tokens) && tokens > 0) discoveredContextWindows.set(modelId, Math.floor(tokens));
}

/** Best-known context window for a model id: known table > /models-reported > 128k. */
export function contextWindowFor(modelId: string): number {
	const lower = modelId.toLowerCase();
	for (const [pattern, tokens] of KNOWN_CONTEXT_WINDOWS) {
		if (lower.includes(pattern)) return tokens;
	}
	return discoveredContextWindows.get(modelId) ?? 128_000;
}

function toModel(provider: Provider, modelId: string): Model {
	return {
		id: modelId,
		name: modelId,
		api: provider.id === "anthropic" ? "anthropic" : "openai",
		provider: provider.id,
		baseUrl: provider.baseUrl,
		apiKeyEnv: provider.apiKeyEnvs[0],
		contextWindow: contextWindowFor(modelId),
		...(THINKING_TAG_PROVIDERS.has(provider.id) ? { thinkingTags: true } : {}),
	};
}

/** Back-compat alias: old call sites passed catalog ids. */
export const getModel = resolveModel;

/** A few known entries for docs/tests; resolveModel covers everything else. */
export const MODEL_CATALOG: Model[] = [
	{ ...toModel(PROVIDERS.find((p) => p.id === "deepseek")!, "deepseek-chat"), name: "DeepSeek V3", cost: { input: 0.27, output: 1.1 }, maxOutputTokens: 8_192 },
	{ ...toModel(PROVIDERS.find((p) => p.id === "deepseek")!, "deepseek-reasoner"), name: "DeepSeek R1", cost: { input: 0.55, output: 2.19 }, maxOutputTokens: 8_192 },
	{ ...toModel(PROVIDERS.find((p) => p.id === "minimax-cn")!, "MiniMax-M3"), name: "MiniMax M3", thinkingTags: true, maxOutputTokens: 16_384, contextWindow: 1_000_000 },
	{ ...toModel(PROVIDERS.find((p) => p.id === "openai")!, "gpt-4o"), name: "GPT-4o", cost: { input: 2.5, output: 10 }, maxOutputTokens: 16_384 },
	{ ...toModel(PROVIDERS.find((p) => p.id === "anthropic")!, "claude-sonnet-4-5"), name: "Claude Sonnet 4.5", cost: { input: 3, output: 15 }, maxOutputTokens: 8_192 },
];

/** Define a model for any custom endpoint (ollama, vllm, private gateways). */
export function defineModel(model: Omit<Model, "api" | "provider"> & { api?: string; provider?: string }): Model {
	return { api: "openai", provider: "custom", ...model };
}
