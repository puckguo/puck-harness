/**
 * Auth (credential store / login) and model switching tests.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@puckguo123/core";
import type { AgentEvent } from "@puckguo123/core";
import {
	createMockStreamFn,
	FileCredentialStore,
	findProvider,
	listModels,
	listProviders,
	loginProvider,
	logoutProvider,
	resolveApiKey,
} from "@puckguo123/llm";

function makeStorePath(): string {
	return join(mkdtempSync(join(tmpdir(), "puck-auth-")), "auth.json");
}

test("store: write/read/delete roundtrip, 0600 permissions", () => {
	const store = new FileCredentialStore(makeStorePath());
	store.write("minimax", "sk-test-123");
	assert.equal(store.read("minimax"), "sk-test-123");
	assert.equal(store.read("nope"), undefined);
	assert.ok(store.list().some((entry) => entry.provider === "minimax" && entry.hasKey));

	const mode = statSync(store.filePath).mode & 0o777;
	assert.ok(mode === 0o600 || process.platform === "win32", `expected 0600, got ${mode.toString(8)}`);

	assert.equal(logoutProvider("minimax", store), true);
	assert.equal(store.read("minimax"), undefined);
	assert.equal(logoutProvider("minimax", store), false); // already gone
});

test("store: survives restart (file persistence)", () => {
	const path = makeStorePath();
	const first = new FileCredentialStore(path);
	first.write("deepseek", "sk-ds");
	const second = new FileCredentialStore(path);
	assert.equal(second.read("deepseek"), "sk-ds");
});

test("resolveApiKey precedence: explicit > stored > env", () => {
	const path = makeStorePath();
	const store = new FileCredentialStore(path);
	const model = { apiKeyEnv: "PUCK_TEST_KEY", provider: "pucktest" } as never as Parameters<typeof resolveApiKey>[0];

	process.env.PUCK_TEST_KEY = "from-env";
	assert.equal(resolveApiKey(model, undefined), "from-env");

	store.write("pucktest", "from-store");
	assert.equal(resolveApiKey(model, store), "from-store"); // store beats env
	assert.equal(resolveApiKey(model, store, "explicit"), "explicit"); // explicit beats all
	delete process.env.PUCK_TEST_KEY;
});

test("loginProvider: prompts, stores, validates", async () => {
	const store = new FileCredentialStore(makeStorePath());
	const prompts: string[] = [];

	await loginProvider("minimax", store, {
		promptSecret: (message) => {
			prompts.push(message);
			return Promise.resolve("  sk-new-key  ");
		},
		info: () => {},
	});
	assert.match(prompts[0], /minimax/i);
	assert.equal(store.read("minimax"), "sk-new-key"); // trimmed

	// cancel on empty input
	await assert.rejects(
		loginProvider("deepseek", store, {
			promptSecret: () => Promise.resolve(""),
			info: () => {},
		}),
		/cancel/,
	);
	assert.equal(store.read("deepseek"), undefined);

	// unknown provider
	await assert.rejects(
		loginProvider("nope", store, { promptSecret: () => Promise.resolve("x"), info: () => {} }),
		/Unknown provider/,
	);
});

test("providers: registry carries env vars and lookup works", () => {
	const providers = listProviders();
	assert.ok(providers.length >= 25, "provider registry should be sizeable");
	const minimaxCn = providers.find((p) => p.id === "minimax-cn");
	assert.ok(minimaxCn);
	assert.ok(minimaxCn.apiKeyEnvs.includes("MINIMAX_CN_API_KEY"));
	assert.match(minimaxCn.baseUrl, /minimaxi\.com/);
	assert.ok(findProvider("minimax-cn"));
	assert.ok(findProvider("MiniMax CN")); // by display name
	assert.equal(findProvider("nope"), undefined);
});

test("listModels: parses OpenAI-compatible /models payloads", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(
			JSON.stringify({ data: [{ id: "model-b" }, { id: "model-a" }, { id: "model-b" }, {}] }),
			{ status: 200 },
		)) as typeof fetch;
	try {
		const models = await listModels(findProvider("minimax-cn")!, "sk-test");
		assert.deepEqual(models, ["model-a", "model-b"]); // sorted + deduped, empty dropped
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("Agent: setModel swaps streamFn and emits model_update", async () => {
	const first = createMockStreamFn([{ text: "from model one" }]);
	const second = createMockStreamFn([{ text: "from model two" }]);
	const agent = new Agent({ streamFn: first, modelId: "model-one" });

	const events: AgentEvent[] = [];
	agent.subscribe((event) => void events.push(event));

	let current = first;
	agent.setModel("model-two", second);
	// the agent's streamFn is what the loop reads per call — verify it changed
	assert.equal(agent.streamFn, second);

	const added = await agent.prompt("hi");
	const final = added.find((m) => m.role === "assistant");
	assert.ok(final && final.role === "assistant");
	assert.equal(
		final.content.find((c) => c.type === "text")?.type === "text"
			? (final.content[0] as { text: string }).text
			: "",
		"from model two",
	);

	const update = events.find((e) => e.type === "model_update");
	assert.ok(update && update.type === "model_update");
	assert.equal(update.modelId, "model-two");
	assert.equal(update.previousModelId, "model-one");
});

test("SDK: setModel switches mid-session and credentials flow through", async () => {
	const { createPuck } = await import("@puckguo123/sdk");
	const store = new FileCredentialStore(makeStorePath());

	const puck = createPuck({
		model: "mock",
		streamFn: createMockStreamFn([{ text: "before switch" }]),
		tools: "none",
		session: false,
		credentials: store,
	});
	assert.equal(puck.modelId, undefined); // custom streamFn → no logical id

	const first = await puck.run("hi");
	assert.equal(first.text, "before switch");

	puck.setModel("mock");
	const second = await puck.run("again");
	assert.equal(second.text, "(mock model)"); // streamFn swapped by setModel
	assert.ok(puck.credentials === store);
});
