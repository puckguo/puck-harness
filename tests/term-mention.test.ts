import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildMentionRows,
	expandFileMentions,
	FileIndex,
	filterFiles,
	isIgnored,
	matchFileEntry,
	parseGitignoreRules,
	parseMentionToken,
	walkProjectFiles,
	type FileIndexEntry,
} from "../packages/cli/dist/filemention.js";

// ---------------------------------------------------------------------------
// token parsing
// ---------------------------------------------------------------------------

test("parseMentionToken: detects the token at the cursor", () => {
	assert.deepEqual(parseMentionToken("hello @src/ind", 14), { at: 6, query: "src/ind" });
	assert.deepEqual(parseMentionToken("@", 1), { at: 0, query: "" });
	assert.deepEqual(parseMentionToken("a @b and @c", 11), { at: 9, query: "c" });
	// cursor mid-token: query is only the part left of the cursor
	assert.deepEqual(parseMentionToken("@abcd", 3), { at: 0, query: "ab" });
});

test("parseMentionToken: null outside a token / without @", () => {
	assert.equal(parseMentionToken("hello world", 5), null);
	assert.equal(parseMentionToken("email me", 8), null); // no @ before cursor
	assert.equal(parseMentionToken("@foo bar", 8), null); // space ends the token
	assert.equal(parseMentionToken("", 0), null);
});

// ---------------------------------------------------------------------------
// scoring
// ---------------------------------------------------------------------------

test("matchFileEntry: exact basename beats fuzzy beats path match", () => {
	const exact = matchFileEntry("src/term.ts", "term")!;
	const fuzzy = matchFileEntry("src/x_termx.ts", "term")!;
	assert.ok(exact.score > fuzzy.score, `exact ${exact.score} > fuzzy ${fuzzy.score}`);
	assert.ok(fuzzy.score > 150);
	// tier 3 (substring only in the full path) loses to any basename-tier match
	const pathMatch = matchFileEntry("src/term/test.ts", "term/t")!;
	assert.ok(exact.score > pathMatch.score);
});

test("matchFileEntry: tier ladder + null on no match", () => {
	// tier 3: substring only in the full path (penalties can push it below 100)
	const t3 = matchFileEntry("src/term/test.ts", "term/t")!;
	assert.ok(t3.score < 200, `path substring tier below basename tiers, got ${t3.score}`);
	// tier 4: fuzzy across the whole path — below tier 3
	const t4 = matchFileEntry("src/abc/def.ts", "sbf")!;
	assert.ok(t4.score < t3.score, `fuzzy path tier below substring tier, got ${t4.score}`);
	assert.equal(matchFileEntry("src/term.ts", "zzz"), null);
});

test("matchFileEntry: start-of-basename bonus + depth penalty", () => {
	const atStart = matchFileEntry("src/app.ts", "app")!;
	const mid = matchFileEntry("src/my-app.ts", "app")!;
	assert.ok(atStart.score > mid.score, `start ${atStart.score} > mid ${mid.score}`);
	const shallow = matchFileEntry("a.ts", "a")!;
	const deep = matchFileEntry("x/y/z/a.ts", "a")!;
	assert.ok(shallow.score > deep.score);
});

test("matchFileEntry: empty query matches everything, shallow first", () => {
	const root = matchFileEntry("a.ts", "")!;
	const deep = matchFileEntry("x/y/z/a.ts", "")!;
	assert.ok(root.score > deep.score);
	assert.ok(matchFileEntry("anything", "") !== null, "empty query always matches");
});

test("filterFiles: score desc, path asc tiebreak, dir flag, limit", () => {
	const entries: FileIndexEntry[] = [
		{ path: "b/mod.ts", dir: false },
		{ path: "a/mod.ts", dir: false },
		{ path: "mod.ts", dir: false },
		{ path: "src/mod", dir: true },
	];
	const out = filterFiles(entries, "mod", 10);
	// mod.ts (454) > src/mod (452: exact basename, shorter) > a/mod.ts = b/mod.ts (446, tie → path asc)
	assert.deepEqual(
		out.map((m) => m.path),
		["mod.ts", "src/mod", "a/mod.ts", "b/mod.ts"],
	);
	assert.equal(out[1].dir, true, "src/mod is a directory match");
	assert.equal(filterFiles(entries, "mod", 2).length, 2);
});

// ---------------------------------------------------------------------------
// gitignore subset
// ---------------------------------------------------------------------------

test("parseGitignoreRules + isIgnored: basics", () => {
	const rules = parseGitignoreRules("# comment\n\n*.log\n!keep.log\nbuild/\n/dist\nnode_*\n", "");
	assert.equal(isIgnored("debug.log", false, rules), true);
	assert.equal(isIgnored("keep.log", false, rules), false); // negation wins
	assert.equal(isIgnored("build", true, rules), true); // dir-only rule
	assert.equal(isIgnored("build", false, rules), false); // …never matches files
	assert.equal(isIgnored("a/build", true, rules), true); // unanchored matches any depth
	assert.equal(isIgnored("dist", false, rules), true); // anchored /dist…
	assert.equal(isIgnored("sub/dist", false, rules), false); // …only at root
	assert.equal(isIgnored("node_x", false, rules), true); // * within one segment
});

test("gitignore: nested scope + ** globs + single * never crosses separators", () => {
	const root = parseGitignoreRules("docs/**/generated/\n", "");
	assert.equal(isIgnored("docs/a/b/generated", true, root), true);
	assert.equal(isIgnored("docs/generated", true, root), true);
	assert.equal(isIgnored("docs/a/b/other", true, root), false);

	const single = parseGitignoreRules("a/*/b\n", "");
	assert.equal(isIgnored("a/x/b", false, single), true);
	assert.equal(isIgnored("a/x/y/b", false, single), false); // * must not cross /

	const nested = parseGitignoreRules("*.tmp\n", "sub/");
	assert.equal(isIgnored("sub/x.tmp", false, nested), true);
	assert.equal(isIgnored("other/x.tmp", false, nested), false); // scoped to sub/
});

// ---------------------------------------------------------------------------
// walker
// ---------------------------------------------------------------------------

function makeTree(): string {
	const dir = mkdtempSync(join(tmpdir(), "puck-mention-"));
	writeFileSync(join(dir, "readme.md"), "# hi\n");
	writeFileSync(join(dir, "app.ts"), "export {};\n");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "util.ts"), "export const x = 1;\n");
	mkdirSync(join(dir, "src", "deep"));
	writeFileSync(join(dir, "src", "deep", "x.ts"), "x\n");
	mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
	writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "junk\n");
	mkdirSync(join(dir, "dist"));
	writeFileSync(join(dir, "dist", "bundle.js"), "built\n");
	writeFileSync(join(dir, ".gitignore"), "dist/\n*.log\n");
	writeFileSync(join(dir, "debug.log"), "log\n");
	return dir;
}

test("walkProjectFiles: skips heavy dirs, honors .gitignore, indexes nested + dirs", async () => {
	const dir = makeTree();
	try {
		const { entries, truncated } = await walkProjectFiles(dir);
		const paths = entries.map((e) => e.path);
		assert.equal(truncated, false);
		assert.ok(paths.includes("readme.md"));
		assert.ok(paths.includes("src/util.ts"));
		assert.ok(paths.includes("src/deep/x.ts"));
		assert.ok(entries.find((e) => e.path === "src/deep")?.dir, "dirs are indexed too");
		assert.ok(!paths.some((p) => p.startsWith("node_modules/")), "node_modules skipped");
		assert.ok(!paths.some((p) => p.startsWith("dist/")), "gitignored dist skipped");
		assert.ok(!paths.includes("debug.log"), "gitignored *.log skipped");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("walkProjectFiles: nested .gitignore layers onto inherited rules", async () => {
	const dir = mkdtempSync(join(tmpdir(), "puck-mention-nested-"));
	try {
		mkdirSync(join(dir, "docs"));
		writeFileSync(join(dir, ".gitignore"), "*.md\n");
		writeFileSync(join(dir, "root.md"), "ignored\n");
		writeFileSync(join(dir, "docs", ".gitignore"), "!important.md\n");
		writeFileSync(join(dir, "docs", "important.md"), "kept\n");
		writeFileSync(join(dir, "docs", "other.md"), "ignored\n");
		const { entries } = await walkProjectFiles(dir);
		const paths = entries.map((e) => e.path);
		assert.ok(!paths.includes("root.md"));
		assert.ok(paths.includes("docs/important.md"), "nested negation un-ignores");
		assert.ok(!paths.includes("docs/other.md"));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("walkProjectFiles: maxEntries cap marks truncated; onBatch streams", async () => {
	const dir = makeTree();
	try {
		let batches = 0;
		const { entries, truncated } = await walkProjectFiles(dir, {
			maxEntries: 3,
			onBatch: () => {
				batches++;
			},
		});
		assert.equal(truncated, true);
		assert.equal(entries.length, 3);
		assert.ok(batches >= 1, "progressive callback fired");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("FileIndex: caches within TTL, re-walks after expiry", async () => {
	const dir = makeTree();
	try {
		const index = new FileIndex(dir);
		assert.equal(index.size, 0);
		index.refreshIfStale();
		assert.equal(index.walking, true);
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(index.ready, true);
		const size = index.size;
		assert.ok(size >= 5, `indexed ${size} entries`);
		// fresh cache: a second refresh call must NOT reset the entries
		index.refreshIfStale();
		assert.equal(index.size, size);
		// …but a zero-TTL refresh re-walks (entries reset → repopulated)
		index.refreshIfStale(0);
		await new Promise((r) => setTimeout(r, 600));
		assert.equal(index.size, size);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ---------------------------------------------------------------------------
// popup rows
// ---------------------------------------------------------------------------

test("buildMentionRows: marker, footer, dir suffix, clipping", () => {
	const matches = filterFiles(
		[
			{ path: "src/term.ts", dir: false },
			{ path: "src/mod", dir: true },
		],
		"src",
		10,
	);
	const rows = buildMentionRows(matches, 0, { cols: 80, total: matches.length });
	const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");
	assert.equal(rows.length, 3); // 2 rows + hint
	assert.ok(rows[0].includes("→"), "selected row has the marker");
	assert.ok(plain(rows[0]).endsWith("/"), "directory rows carry a trailing /");
	assert.ok(!rows[1].includes("→"));
	assert.ok(rows[2].includes("Tab/Enter"), "hint row lists the keys");
	assert.ok(rows[2].includes("2 项"));
	// narrow terminal: long paths clip but keep a readable row
	const narrow = buildMentionRows(
		[{ path: "very/long/path/to/some/file/with-a-long-name.ts", score: 1, dir: false, indices: [] }],
		0,
		{ cols: 24, total: 1 },
	);
	for (const r of narrow) {
		const plain = r.replace(/\x1b\[[0-9;]*m/g, "");
		assert.ok(plain.length <= 26, `clipped row: "${plain}"`);
	}
});

// ---------------------------------------------------------------------------
// submit-time expansion
// ---------------------------------------------------------------------------

const files: Record<string, { content: string; bytes: number } | undefined> = {
	"src/app.ts": { content: "export const a = 1;\n", bytes: 21 },
	"docs/readme.md": { content: "# Title\n\nbody\n", bytes: 15 },
	"big.log": { content: "x".repeat(100), bytes: 100 },
	"img.png": { content: "\u0000\u0000binary\u0000", bytes: 12 },
	"missing.ts": undefined,
};

const readFake = (p: string) => files[p];

test("expandFileMentions: attaches existing files, keeps the raw line", () => {
	const { text, attached } = expandFileMentions("看看 @src/app.ts 和 @docs/readme.md", readFake);
	assert.equal(attached.length, 2);
	assert.deepEqual(
		attached.map((f) => f.path),
		["src/app.ts", "docs/readme.md"],
	);
	assert.ok(text.startsWith("看看 @src/app.ts 和 @docs/readme.md"), "raw line preserved");
	assert.ok(text.includes("────── src/app.ts"), "content block header");
	assert.ok(text.includes("export const a = 1;"), "content attached");
	assert.ok(text.includes("【@文件引用】"));
});

test("expandFileMentions: skips missing / binary, dedupes, truncates big files", () => {
	const { text, attached } = expandFileMentions("@missing.ts @img.png @src/app.ts @src/app.ts @big.log", readFake, { maxFileBytes: 50 });
	assert.equal(attached.length, 2, "missing + binary skipped, dupe collapsed");
	assert.ok(attached.find((f) => f.path === "big.log")?.truncated, "oversize file marked truncated");
	assert.ok(text.includes("已截断"));
	// no tokens at all → line unchanged
	const none = expandFileMentions("plain message, no mentions", readFake);
	assert.equal(none.text, "plain message, no mentions");
	assert.equal(none.attached.length, 0);
});

test("expandFileMentions: backslash paths normalize; maxFiles caps attachments", () => {
	const back: Record<string, { content: string; bytes: number }> = { "a/b.ts": { content: "ab\n", bytes: 3 }, "c/d.ts": { content: "cd\n", bytes: 3 } };
	const { attached } = expandFileMentions("@a\\b.ts", (p) => back[p]);
	assert.equal(attached.length, 1);
	assert.equal(attached[0].path, "a/b.ts");
	const many = expandFileMentions("@a/b.ts @c/d.ts", (p) => back[p], { maxFiles: 1 });
	assert.equal(many.attached.length, 1);
});
