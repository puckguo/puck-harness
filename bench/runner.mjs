/**
 * Cross-harness benchmark runner — puck vs pi vs codex (vs dsh when built).
 *
 * Design (docs/benchmarking.md):
 *  - Same model+provider+key for every harness (controlled variable)
 *  - Interleaved ABBA order, N repeats per task, fresh session each run
 *  - External black-box timing (spawn → exit) + per-harness log parsing
 *  - Fixture repo is git-reset between runs; T3/T4 success = tests pass
 *
 * Usage:
 *   node bench/runner.mjs --model glm-5.3 --repeats 2 --tasks t1,t3
 *   node bench/runner.mjs --harnesses puck,pi --dry   (show resolved commands)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";

const ROOT = resolve(import.meta.dirname, "..");
const FIXTURE_SRC = join(ROOT, "bench", "fixture");
const TASKS_DIR = join(ROOT, "bench", "tasks");

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const opt = (name, def) => {
	const i = args.indexOf("--" + name);
	return i >= 0 ? args[i + 1] : def;
};
const MODEL = opt("model", "glm-5.3");
const REPEATS = Number(opt("repeats", 2));
const TASKS = (opt("tasks", "t1,t2,t3,t4") || "").split(",");
const WANTED = (opt("harnesses", "puck,pi,codex,dsh") || "").split(",");
const DRY = args.includes("--dry");
const TIMEOUT_MS = Number(opt("timeout", 300)) * 1000;

// Provider endpoints keyed by puck provider id — the single source of truth
// the runner maps onto each harness's config format.
const PROVIDERS = {
	"zai-coding-cn": {
		label: "zai-coding-cn",
		baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
		apiKey: readPuckKey("zai-coding-cn"),
	},
	"minimax-cn": {
		label: "minimax-cn",
		baseUrl: "https://api.minimaxi.com/v1",
		apiKey: readPuckKey("minimax-cn"),
	},
};

function readPuckKey(provider) {
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".puck", "auth.json"), "utf8"));
		const entry = auth[provider];
		return typeof entry === "string" ? entry : entry?.key; // both shapes exist in the wild
	} catch {
		return undefined;
	}
}

function providerOf(modelId) {
	if (modelId.startsWith("glm-")) return PROVIDERS["zai-coding-cn"];
	if (modelId.startsWith("MiniMax") || modelId.startsWith("minimax") || modelId.startsWith("abab")) return PROVIDERS["minimax-cn"];
	throw new Error(`unknown provider for model "${modelId}" — extend providerOf()`);
}

const PROVIDER = providerOf(MODEL);
if (!PROVIDER.apiKey) {
	console.error(`No API key for ${PROVIDER.label} in ~/.puck/auth.json`);
	process.exit(1);
}

// ---------------------------------------------------------------------------
// Harness registry: how to invoke each CLI non-interactively + how to read
// its own telemetry log afterwards. All isolated homes under bench/home/.
// ---------------------------------------------------------------------------
const HOME = join(ROOT, "bench", "home");
const PUCK_HOME = join(HOME, "puck");
const CODEX_HOME = join(HOME, "codex");

function prepPuck() {
	mkdirSync(join(PUCK_HOME), { recursive: true });
	writeFileSync(join(PUCK_HOME, "auth.json"), JSON.stringify({ [PROVIDER.label]: PROVIDER.apiKey }));
}

function prepCodex() {
	mkdirSync(CODEX_HOME, { recursive: true });
	writeFileSync(
		join(CODEX_HOME, "config.toml"),
		[
			`model = "${MODEL}"`,
			`model_provider = "bench"`,
			"",
			"[model_providers.bench]",
			`name = "bench-${PROVIDER.label}"`,
			`base_url = "${PROVIDER.baseUrl}"`,
			`env_key = "BENCH_API_KEY"`,
			`wire_api = "responses"`,
			"",
			"[tools]",
			`walk_roots = ["${FIXTURE_SRC.replaceAll("\\", "/").replaceAll("/", "\\\\")}"]`,
		].join("\n"),
	);
}

// Windows npm shims (.cmd) can't be spawned directly — resolve to the real
// node entrypoints / binaries once, up front.
function resolveNodeEntry(pkgPath, rel) {
	const p = join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "npm", "node_modules", ...pkgPath);
	return existsSync(p) ? p : undefined;
}
const PI_JS = resolveNodeEntry(["@earendil-works", "pi-coding-agent", "dist", "cli.js"]);
const CODEX_JS = resolveNodeEntry(["@openai", "codex", "bin", "codex.js"]);

const HARNESS = {
	puck: {
		label: "puck",
		ready: () => existsSync(join(ROOT, "packages", "cli", "dist", "index.js")),
		prep: prepPuck,
		cmd: (prompt) => [
			process.execPath,
			[join(ROOT, "packages", "cli", "dist", "index.js"), "--model", MODEL, prompt],
			{ env: { ...process.env, PUCK_HOME }, cwd: FIXTURE_SRC },
		],
		// timings.jsonl is per-home; records are appended with sessionId —
		// take the new records since a marker line count.
		telemetry: (marker) => {
			const file = join(PUCK_HOME, "timings.jsonl");
			if (!existsSync(file)) return [];
			const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
			return lines.slice(marker).map((l) => {
				const r = JSON.parse(l);
				return { ttftMs: r.ttftMs, llmMs: r.llmMs, toolMs: r.toolMs ?? 0, inputTokens: r.inputTokens, outputTokens: r.outputTokens, isError: r.isError };
			});
		},
		telemetryMarker: () => {
			const file = join(PUCK_HOME, "timings.jsonl");
			return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).length : 0;
		},
	},
	pi: {
		label: "pi",
		ready: () => Boolean(PI_JS), // auth comes from ~/.pi (user already logged in)
		prep: () => {},
		cmd: (prompt) => [
			process.execPath,
			[PI_JS, "--print", "--no-session", "--model", `${PROVIDER.label}/${MODEL}`, prompt],
			{ env: { ...process.env }, cwd: FIXTURE_SRC },
		],
		telemetry: () => [], // pi text mode emits no machine-readable per-turn log; black-box only
		telemetryMarker: () => 0,
	},
	codex: {
		label: "codex",
		ready: () => Boolean(CODEX_JS),
		prep: prepCodex,
		cmd: (prompt) => [
			process.execPath,
			[CODEX_JS, "exec", "--json", "--skip-git-repo-check", "-m", MODEL, prompt],
			{ env: { ...process.env, CODEX_HOME, BENCH_API_KEY: PROVIDER.apiKey }, cwd: FIXTURE_SRC },
		],
		telemetry: (marker, raw) => {
			// codex exec --json: JSONL events. Extract token usage + turn count.
			const out = [];
			for (const line of raw.split("\n")) {
				if (!line.startsWith("{")) continue;
				try {
					const e = JSON.parse(line);
					if (e.type === "turn_completed" || e.type === "token_count") out.push(e);
				} catch {}
			}
			return out;
		},
		telemetryMarker: () => 0,
	},
	dsh: {
		label: "dsh",
		ready: () => {
			// built from source at ../dsh once (pnpm install && pnpm build)
			const bin = join(ROOT, "..", "dsh", "apps", "cli", "lib", "bin.js");
			return existsSync(bin);
		},
		prep: () => {},
		cmd: (prompt) => {
			const bin = join(ROOT, "..", "dsh", "apps", "cli", "lib", "bin.js");
			if (!existsSync(bin)) return null;
			// wire an OpenAI-compatible provider via env once dsh's flags are known
			return [process.execPath, [bin, "--model", MODEL, prompt], { env: { ...process.env }, cwd: FIXTURE_SRC }];
		},
		telemetry: () => [],
		telemetryMarker: () => 0,
	},
};

// ---------------------------------------------------------------------------
// Task definitions
// ---------------------------------------------------------------------------
const TASK_DEFS = {
	t1: { file: "t1-qa.md", verify: () => true },
	t2: { file: "t2-locate.md", verify: () => true },
	t3: { file: "t3-fix.md", verify: runTests },
	// t4 baseline already carries t3's floating-point FAIL (fixtures reset per
	// task) — success = refactor landed AND no NEW failures beyond that one.
	t4: { file: "t4-refactor.md", verify: verifyT4 },
};

function failCount() {
	const r = spawnSync("node", ["test/math.test.js"], { cwd: FIXTURE_SRC, encoding: "utf8" });
	return (r.stdout.match(/FAIL/g) ?? []).length;
}

function verifyT4() {
	// 1) the refactor landed: formatTag now processes words individually
	const src = readFileSync(join(FIXTURE_SRC, "src", "format.js"), "utf8");
	const fn = src.slice(src.indexOf("formatTag"), src.indexOf("formatTag") + 400);
	const refactored = /\.map\(|\.forEach\(|for\s*\(|\.split\(/.test(fn);
	// 2) behavior preserved
	const r = spawnSync(
		process.execPath,
		["-e", 'import("./src/format.js").then(m => console.log(m.formatTag("Hello World", "SECOND")))'],
		{ cwd: FIXTURE_SRC, encoding: "utf8" },
	);
	const behaviorOk = (r.stdout || "").trim() === "hello-world-second";
	// 3) no new failures beyond t3's baseline float FAIL
	return refactored && behaviorOk && failCount() <= 1;
}

function runTests() {
	const r = spawnSync("node", ["test/math.test.js"], { cwd: FIXTURE_SRC, encoding: "utf8" });
	return !r.stdout.includes("FAIL") && r.status === 0;
}

function resetFixture() {
	// restore pristine fixture (runner works without git: keep a template copy)
	rmSync(FIXTURE_SRC, { recursive: true, force: true });
	cpSync(join(ROOT, "bench", "fixture-template"), FIXTURE_SRC, { recursive: true });
}

function median(list) {
	const s = [...list].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : undefined;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const active = WANTED.filter((w) => HARNESS[w] && HARNESS[w].ready());
const skipped = WANTED.filter((w) => HARNESS[w] && !HARNESS[w].ready());
for (const h of active) HARNESS[h].prep();

if (DRY) {
	console.log(`model=${MODEL} provider=${PROVIDER.label} baseUrl=${PROVIDER.baseUrl}`);
	for (const h of active) {
		const [cmd, argv] = HARNESS[h].cmd("dry-run prompt");
		console.log(`${h}: ${cmd ?? "(unset)"} ${(argv ?? []).join(" ").slice(0, 120)}`);
	}
	if (skipped.length) console.log(`skipped (not ready): ${skipped.join(", ")}`);
	process.exit(0);
}

const results = []; // {harness, task, repeat, ms, ok, ttftMs, inputTokens, outputTokens, toolEvents}

// interleave: for each repeat round, rotate harness order (ABBA-ish)
const taskNames = TASKS.filter((t) => TASK_DEFS[t]);
for (let rep = 0; rep < REPEATS; rep++) {
	for (const task of taskNames) {
		const order = rep % 2 === 0 ? active : [...active].reverse();
		for (const h of order) {
			if (!HARNESS[h].cmd) { results.push({ harness: h, task, repeat: rep, ms: -1, ok: false, note: "cmd not configured" }); continue; }
			resetFixture();
			const prompt = readFileSync(join(TASKS_DIR, TASK_DEFS[task].file), "utf8").trim();
			const marker = HARNESS[h].telemetryMarker();
			const [cmd, argv, opts] = HARNESS[h].cmd(prompt);
			const t0 = Date.now();
			const r = spawnSync(cmd, argv, { ...opts, encoding: "utf8", timeout: TIMEOUT_MS, input: "" });
			const ms = Date.now() - t0;
			const ok = TASK_DEFS[task].verify();
			const tel = HARNESS[h].telemetry(marker, r.stdout || "");
			results.push({
				harness: h,
				task,
				repeat: rep,
				ms,
				ok,
				ttftMs: tel.length && tel[0].ttftMs != null ? Math.min(...tel.map((t) => t.ttftMs).filter(Boolean)) : undefined,
				inputTokens: tel.reduce((a, t) => a + (t.inputTokens ?? 0), 0) || undefined,
				outputTokens: tel.reduce((a, t) => a + (t.outputTokens ?? 0), 0) || undefined,
				note: r.status !== 0 ? `exit=${r.status}` : undefined,
			});
			console.log(`  ${h}/${task}/${rep}: ${ms}ms ok=${ok}${r.status !== 0 ? ` exit=${r.status}` : ""}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
console.log(`\n=== ${MODEL} · ${REPEATS} repeats · median wall-clock ms (success rate) ===`);
const head = "task  " + active.map((h) => h.padEnd(16)).join("");
console.log(head);
for (const task of taskNames) {
	const cells = active.map((h) => {
		const rs = results.filter((r) => r.harness === h && r.task === task);
		if (!rs.length) return "(skipped)".padEnd(16);
		const ms = median(rs.filter((r) => r.ms > 0).map((r) => r.ms));
		const ok = rs.filter((r) => r.ok).length;
		return `${ms ?? "-"} (${ok}/${rs.length})`.padEnd(16);
	});
	console.log(`${task.padEnd(5)} ` + cells.join(""));
}
console.log("\n=== totals (all tasks, medians) ===");
for (const h of active) {
	const rs = results.filter((r) => r.harness === h && r.ms > 0);
	const ms = median(rs.map((r) => r.ms));
	const inTok = rs.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
	const outTok = rs.reduce((a, r) => a + (r.outputTokens ?? 0), 0);
	console.log(`${h.padEnd(6)} wall=${ms ?? "-"}ms · runs=${rs.length}/${results.filter((r) => r.harness === h).length} · tokens ↓${inTok || "-"} ↑${outTok || "-"}`);
}
if (skipped.length) console.log(`\nskipped harnesses: ${skipped.join(", ")} (dsh: build it first — cd dsh && pnpm install && pnpm build)`);
writeFileSync(join(ROOT, "bench", "results.json"), JSON.stringify({ model: MODEL, repeats: REPEATS, results }, null, 2));
console.log("\nraw → bench/results.json");
