import assert from "node:assert/strict";
import test from "node:test";
import { Spinner, renderEditDiff, renderToolEnd } from "../packages/cli/dist/term.js";

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");

test("renderEditDiff: red minus / green plus, capped at 3 lines", () => {
	const out = renderEditDiff([{ oldText: "a\nb", newText: "A\nB" }]);
	const plain = strip(out);
	assert.ok(plain.includes("\n  - a\n  - b"), plain);
	assert.ok(plain.includes("\n  + A\n  + B"));
	assert.ok(out.includes("\x1b[31m"), "old lines are red");
	assert.ok(out.includes("\x1b[32m"), "new lines are green");

	// 5-line old → only first 3 shown
	const capped = strip(renderEditDiff([{ oldText: "1\n2\n3\n4\n5", newText: "x" }]));
	assert.ok(capped.includes("- 3"));
	assert.ok(!capped.includes("- 4"));

	assert.equal(renderEditDiff(undefined), "");
	assert.equal(renderEditDiff([]), "");
});

test("renderToolEnd: folds to 3 lines with +M more", () => {
	const mk = (lines: string[]): { content: Array<{ type: string; text: string }> } => ({
		content: [{ type: "text", text: lines.join("\n") }],
	});
	const small = renderToolEnd(mk(["only line"]));
	assert.equal(strip(small), "│ only line\n");
	assert.ok(!small.includes("more"));

	const big = renderToolEnd(mk(["one", "two", "three", "four", "five"]));
	const plain = strip(big);
	assert.ok(plain.includes("│ one"));
	assert.ok(plain.includes("│ three"));
	assert.ok(!plain.includes("│ four"));
	assert.ok(plain.includes("└─ +2 more"));

	// long single line clipped to width
	const long = renderToolEnd(mk(["x".repeat(200)]), 3, 80);
	assert.ok(strip(long).includes("…"));
	assert.ok(long.length < 200);

	assert.equal(renderToolEnd({ content: [] }), "");
});

test("Spinner: no-op when not TTY", () => {
	const s = new Spinner(false);
	s.start("", "thinking"); // piped → never paints
	assert.equal(s.active, false);
	s.stop(); // no throw
});
