/**
 * @puck-agent/llm — provider adapters behind puck's single StreamFn seam.
 */

export type { Model } from "./models.js";
export { contextWindowFor, defineModel, getModel, modelFor, recordContextWindow, resolveModel, MODEL_CATALOG } from "./models.js";
export { streamOpenAi, splitThinkTags } from "./openai.js";
export { streamAnthropic } from "./anthropic.js";
export { createMockStreamFn, type MockOptions, type MockStep, type MockToolCall } from "./mock.js";
export { createAssistantStream } from "./stream-utils.js";

// auth: provider registry, credential store, interactive login, live model discovery
export {
	FileCredentialStore,
	findProvider,
	listModels,
	listProviders,
	loginProvider,
	logoutProvider,
	puckDir,
	PROVIDERS,
	resolveApiKey,
	resolveProviderApiKey,
	discoverUsableModels,
	type CredentialStore,
	type LoginInteraction,
	type Provider,
	type ProviderModel,
} from "./auth.js";

import type { CredentialStore } from "./auth.js";
import type { Model } from "./models.js";
import type { StreamFn } from "@puck-agent/core";
import { streamAnthropic } from "./anthropic.js";
import { streamOpenAi } from "./openai.js";

/**
 * Create the StreamFn for a model. Dispatches on `model.api`:
 * "openai" → chat/completions, "anthropic" → messages.
 * API keys resolve per call: options.apiKey ?? credentialStore ?? process.env[model.apiKeyEnv].
 */
export function createStreamFn(model: Model, credentials?: CredentialStore): StreamFn {
	switch (model.api) {
		case "openai":
			return streamOpenAi(model, credentials);
		case "anthropic":
			return streamAnthropic(model, credentials);
		default:
			throw new Error(
				`Unknown api "${model.api}" for model ${model.id}. Use streamOpenAi/streamAnthropic directly for custom protocols.`,
			);
	}
}
