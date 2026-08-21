/**
 * Skills — reusable instruction packs loaded from a directory.
 *
 * A skill is a folder with a SKILL.md. Two header formats are recognized:
 *
 *   1. Markdown title (puck native):
 *        # my-skill
 *        description: does the thing
 *
 *   2. YAML frontmatter (claude / codex convention — so skills installed for
 *      those harnesses work in puck unchanged):
 *        ---
 *        name: my-skill
 *        description: does the thing
 *        ---
 *
 * A skill folder may carry supporting files (references/, scripts/…) next to
 * SKILL.md; the skill's instructions can reference them by relative path.
 *
 * Two integration modes:
 *  - skillsToPrompt:      inject all skill descriptions into the system prompt
 *  - createSkillTool:     expose a `skill` tool; the model pulls instructions
 *                          on demand (cheaper context, one extra hop)
 *
 * ── Skill packs (two-layer mode) ─────────────────────────────────────────
 * A folder with a PACK.md instead of a SKILL.md is a *skill pack*: a named
 * bundle of child skills. The pack gets ONE line in the system prompt; its
 * children are addressed as `pack/child` through the same `skill` tool and
 * stay invisible until the pack is loaded. This exists for suites like the
 * 25-strong lark family, whose descriptions would otherwise eat half the
 * prompt budget of a user who never opens Feishu.
 *
 *   lark/PACK.md            ← name/description + routing table for the model
 *   lark/lark-base/SKILL.md ← child skill: plain skill, one level deeper
 *
 * The loose (single-layer) format keeps working unchanged — packs are an
 * optional wrapper, not a new mandatory shape. claude/codex ignore PACK.md
 * folders (no SKILL.md → skip), so cross-harness sharing of the children
 * directory is not broken for harnesses without pack support.
 */

import type { Tool, ToolResult } from "@puckguo123/core";
import { readdirSync, statSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	instructions: string;
	path: string;
	/** claude/codex frontmatter flag: the model must NOT invoke this skill on
	 * its own — only an explicit user request may load it. puck honors it by
	 * omitting such skills from the system-prompt listing; the `skill` tool
	 * still serves them when the user explicitly names one. */
	userInvokedOnly?: boolean;
}

/** A named bundle of child skills (a skills/<name>/PACK.md directory).
 * Packs are the outer layer of the two-tier system: one prompt line, children
 * addressed as `pack/child`. `packInstructions` should carry a routing table
 * ("which child for which task") — PACK.md authors write that by hand or
 * generate it; loaders never invent it. */
export interface SkillPack {
	name: string;
	/** One-line summary shown in the system prompt in place of every child. */
	description: string;
	/** Full PACK.md body (header + routing table) returned when the pack loads. */
	packInstructions: string;
	/** Child skills, addressed as `<pack>/<child>` through the skill tool. */
	children: Skill[];
	/** Absolute path of the PACK.md. */
	path: string;
}

/** Everything the machine has to offer: packs + loose skills, deduplicated.
 * This is the type the CLI passes around in two-tier mode. */
export interface SkillIndex {
	packs: SkillPack[];
	/** Skills outside any pack — addressed by bare name, as before. */
	loose: Skill[];
}

/** Parse the `name`/`description` (+ `disable-model-invocation`) header of a
 * SKILL.md (both formats). */
export function parseHeader(raw: string): { name: string | undefined; description: string; userInvokedOnly: boolean } {
	// CRLF line endings (Windows-authored SKILL.md, e.g. the lark suite) break
	// every `$`-anchored regex below — strip them once up front so both line
	// styles parse identically.
	raw = raw.replace(/\r\n/g, "\n");
	// YAML frontmatter: leading `---` block, `key: value` lines. This is a
	// minimal reader (quoted scalars + block scalars), not a YAML parser —
	// skill headers in the wild only use these two shapes.
	if (raw.startsWith("---")) {
		const end = raw.indexOf("\n---", 3);
		if (end > 0) {
			const block = raw.slice(3, end);
			let name: string | undefined;
			let description = "";
			let userInvokedOnly = false;
			let inBlockScalar = false;
			for (const line of block.split("\n")) {
				const blockScalar = line.match(/^\s*(description|name):\s*[|>](-?\+?)\s*$/);
				if (blockScalar) {
					inBlockScalar = blockScalar[1] === "description" ? true : inBlockScalar && false;
					continue;
				}
				if (inBlockScalar) {
					// continuation of a block scalar: treat as one long paragraph
					description = (description + " " + line.trim()).trim();
					continue;
				}
				const flag = line.match(/^disable-model-invocation:\s*(true|false)\s*$/);
				if (flag) {
					userInvokedOnly = flag[1] === "true";
					continue;
				}
				const m = line.match(/^(name|description):\s*(.+)$/);
				if (!m) continue;
				let value = m[2].trim();
				const quoted = value.match(/^["'](.*)["']$/);
				if (quoted) value = quoted[1];
				if (m[1] === "name") name = value;
				else description = value;
			}
			return { name, description, userInvokedOnly };
		}
	}
	// Markdown title + `description:` line (puck native format)
	const lines = raw.split("\n");
	const titleMatch = lines[0]?.match(/^#\s+(.+)$/);
	const descriptionLine = lines.slice(1).find((line) => line.trim().startsWith("description:"));
	return {
		name: titleMatch?.[1]?.trim(),
		description: descriptionLine?.replace(/^\s*description:\s*/, "").trim() ?? "",
		userInvokedOnly: /^disable-model-invocation:\s*true\s*$/m.test(raw),
	};
}

/** Load every SKILL.md under a directory (one level deep).
 * Directories that carry a PACK.md are NOT returned here — use loadSkillPacks.
 * (This keeps the flat loader's output identical whether or not packs exist
 * next to loose skills.) */
export async function loadSkills(dir: string): Promise<Skill[]> {
	const isDir = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
	if (!isDir) return [];

	const skills: Skill[] = [];
	for (const name of readdirSync(dir)) {
		const entryDir = join(dir, name);
		if (!isDirectorySync(entryDir)) continue;
		if (hasPackMdSync(entryDir)) continue; // packs are loaded separately
		const skillPath = join(entryDir, "SKILL.md");
		const raw = await readFile(skillPath, "utf8").catch(() => null);
		if (raw === null) continue;

		const { name: parsedName, description, userInvokedOnly } = parseHeader(raw);
		skills.push({
			name: parsedName ?? name,
			description,
			userInvokedOnly,
			instructions: raw,
			path: skillPath,
		});
	}
	return skills;
}

/** Load every PACK.md pack under a directory. Each child is a plain skill
 * (same parser, one level deeper); the pack's parsed name defaults to the
 * folder name. Children with duplicate names inside one pack keep first
 * occurrence — a malformed suite shouldn't brick the whole pack. */
export async function loadSkillPacks(dir: string): Promise<SkillPack[]> {
	const isDir = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
	if (!isDir) return [];

	const packs: SkillPack[] = [];
	for (const name of readdirSync(dir)) {
		const packDir = join(dir, name);
		if (!isDirectorySync(packDir)) continue;
		const packPath = join(packDir, "PACK.md");
		const raw = await readFile(packPath, "utf8").catch(() => null);
		if (raw === null) continue; // not a pack

		const { name: parsedName, description } = parseHeader(raw);
		packs.push({
			name: parsedName ?? name,
			description,
			packInstructions: raw,
			children: await loadSkills(packDir),
			path: packPath,
		});
	}
	return packs;
}

function isDirectorySync(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

function hasPackMdSync(dir: string): boolean {
	try {
		return statSync(join(dir, "PACK.md")).isFile();
	} catch {
		return false;
	}
}

/**
 * Load skills from every agent harness's skills directory on this machine:
 *   ~/.puck/skills, ~/.claude/skills, ~/.codex/skills, ~/.pi/skills
 * Missing directories are skipped silently. Skills with the same name from
 * different harnesses are deduplicated (first source wins, puck first).
 *
 * Dedup is case-insensitive: "Deploy" and "deploy" from two harnesses are
 * one skill, not two — the model's tool enum must never contain near-dupes
 * that only differ in case. Priority order: .puck > .claude > .codex > .pi.
 *
 * This is what the CLI wires up by default — a skill installed for
 * Claude Code or Codex just works in puck, no copy needed.
 */
export interface HarnessSkills {
	/** Deduplicated skills, priority-ordered (.puck first). */
	skills: Skill[];
	/** name → every harness dir that offered this skill (e.g. [".claude", ".codex"]). */
	origins: Map<string, string[]>;
	/** How many raw SKILL.md entries were dropped by dedup. */
	duplicates: number;
}

/** Same as the two-tier loader but flat: packs are collapsed — each pack is
 * kept as one entry, its children are NOT listed individually. Kept for the
 * single-layer API surface; the CLI uses the *Detailed variant below. */
export async function loadAllHarnessSkills(
	home = process.env.USERPROFILE ?? process.env.HOME ?? ".",
): Promise<Skill[]> {
	const { skills } = await loadHarnessSkillsDetailed(home);
	return skills;
}

/** Same as loadAllHarnessSkills but also reports dedup provenance. */
export async function loadHarnessSkillsDetailed(
	home = process.env.USERPROFILE ?? process.env.HOME ?? ".",
): Promise<HarnessSkills> {
	const SOURCES = [".puck", ".claude", ".codex", ".pi"] as const;
	const byKey = new Map<string, Skill>();	// key = lowercase name
	const origins = new Map<string, string[]>();	// key = canonical (kept) name
	let duplicates = 0;
	for (const source of SOURCES) {
		const skills = await loadSkills(join(home, source, "skills"));
		for (const skill of skills) {
			const key = skill.name.toLowerCase();
			if (!byKey.has(key)) {
				byKey.set(key, skill);
				origins.set(skill.name, [source]);
			} else {
				duplicates++;
				// record that this harness also carries the skill (keep canonical name)
				const canonical = byKey.get(key)!.name;
				origins.get(canonical)!.push(source);
			}
		}
	}
	return { skills: [...byKey.values()], origins, duplicates };
}

/** Two-tier provenance: harness origin tracked per pack AND per loose skill. */
export interface HarnessSkillIndex {
	index: SkillIndex;
	/** name → harnesses that offered it. Keys: pack names and loose skill names. */
	origins: Map<string, string[]>;
	duplicates: number;
}

const SKILL_SOURCES = [".puck", ".claude", ".codex", ".pi"] as const;

/** Two-tier loader across all four harness dirs: packs (PACK.md) + loose
 * skills (SKILL.md), case-insensitively deduplicated within each tier by the
 * same .puck > .claude > .codex > .pi priority. Three dedup rules, in order:
 *   1. loose vs pack of the same name - pack wins (richer entry);
 *   2. loose vs loose - first source wins (classic cross-harness dedup);
 *   3. loose vs a PACK CHILD of the same name - the pack absorbs it: the
 *      child stays reachable as pack/child and by bare name through the
 *      skill tool, but it gets no separate prompt line. This is the
 *      migration path: bundle lark-* into ~/.puck/skills/lark/ while
 *      ~/.claude/skills/lark-* keeps existing for Claude Code - single
 *      source of truth, two views, no duplicate prompt lines in puck. */
export async function loadHarnessSkillsIndexed(
	home = process.env.USERPROFILE ?? process.env.HOME ?? ".",
): Promise<HarnessSkillIndex> {
	const packKeys = new Map<string, SkillPack>();
	const looseKeys = new Map<string, Skill>();
	const origins = new Map<string, string[]>();
	let duplicates = 0;

	for (const source of SKILL_SOURCES) {
		const dir = join(home, source, "skills");
		// packs first within a source: a later loose skill colliding with a
		// pack name is dropped against the pack
		const packs = await loadSkillPacks(dir);
		for (const pack of packs) {
			const key = pack.name.toLowerCase();
			if (!packKeys.has(key)) {
				packKeys.set(key, pack);
				origins.set(pack.name, [source]);
			} else {
				duplicates++;
				origins.get(packKeys.get(key)!.name)!.push(source);
			}
		}
	}
	// lowercase child name → owning pack, across ALL accepted packs, so the
	// loose pass below sees children of packs from every source (a .claude
	// loose skill must be absorbed by a .puck pack's child, not just same-dir)
	const childKeys = new Map<string, SkillPack>();
	for (const pack of packKeys.values()) {
		for (const child of pack.children) {
			const key = child.name.toLowerCase();
			if (!childKeys.has(key)) childKeys.set(key, pack);
		}
	}
	for (const source of SKILL_SOURCES) {
		const loose = await loadSkills(join(home, source, "skills"));
		for (const skill of loose) {
			const key = skill.name.toLowerCase();
			if (packKeys.has(key)) {
				// rule 1: pack wins, the loose copy is the shallow duplicate
				duplicates++;
				origins.get(packKeys.get(key)!.name)!.push(source);
				continue;
			}
			const owner = childKeys.get(key);
			if (owner) {
				// rule 3: a pack child absorbs the loose copy — no extra prompt
				// line; the bare name still resolves through the pack
				duplicates++;
				origins.get(owner.name)!.push(`${source}:${skill.name}`);
				continue;
			}
			if (!looseKeys.has(key)) {
				looseKeys.set(key, skill);
				origins.set(skill.name, [source]);
			} else {
				// rule 2
				duplicates++;
				origins.get(looseKeys.get(key)!.name)!.push(source);
			}
		}
	}
	return { index: { packs: [...packKeys.values()], loose: [...looseKeys.values()] }, origins, duplicates };
}

/** Render a system-prompt section listing available skills.
 *
 * Skills marked `disable-model-invocation: true` (claude/codex convention:
 * only the user may trigger them) are OMITTED from the listing — the model
 * never sees them, so it can't auto-load them. They stay loadable through
 * the `skill` tool when the user explicitly names one. */
export function skillsToPrompt(skills: Skill[]): string {
	const visible = skills.filter((s) => !s.userInvokedOnly);
	if (visible.length === 0) return "";
	const lines = visible.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`);
	return `\n\n## Skills\nThe following skills are available. Load one with the skill tool before using it:\n${lines.join("\n")}`;
}

/** Two-tier prompt: one line per pack (children hidden until loaded) + one
 * line per loose skill. A 25-child pack costs one line instead of 25. */
export function skillsIndexToPrompt(index: SkillIndex): string {
	const packLines = index.packs.map(
		(pack) => `- ${pack.name}: ${pack.description || `skill pack with ${pack.children.length} skills`}`,
	);
	const looseLines = skillsToPrompt(index.loose)
		.split("\n")
		.filter((line) => line.startsWith("- "));
	const lines = [...packLines, ...looseLines];
	if (lines.length === 0) return "";
	const packNote = index.packs.length
		? `\nA skill pack (marked "pack") bundles related skills: load the pack first, then its skills are addressed as "<pack>/<skill>".`
		: "";
	return `\n\n## Skills\nThe following skills are available. Load one with the skill tool before using it:\n${lines.join("\n")}${packNote}`;
}

/** Resolve a user/model-supplied skill address against an index.
 * Accepted forms: "name" (loose skill or pack), "pack/child".
 * Returns undefined when the address matches nothing. */
export function resolveSkillAddress(index: SkillIndex, address: string): { kind: "pack" | "skill"; pack?: SkillPack; skill: Skill } | undefined {
	const [head, child, ...rest] = address.split("/");
	if (!head || rest.length > 0) return undefined;
	if (child) {
		const pack = index.packs.find((p) => p.name.toLowerCase() === head.toLowerCase());
		if (!pack) return undefined;
		const skill = pack.children.find((s) => s.name.toLowerCase() === child.toLowerCase());
		if (!skill) return undefined;
		return { kind: "skill", pack, skill };
	}
	const loose = index.loose.find((s) => s.name.toLowerCase() === head.toLowerCase());
	if (loose) return { kind: "skill", skill: loose };
	const pack = index.packs.find((p) => p.name.toLowerCase() === head.toLowerCase());
	if (pack) return { kind: "pack", pack, skill: packToSkillLike(pack) };
	return undefined;
}

/** Render a pack as a loadable unit: its PACK.md body + a generated child
 * index (name + description per child). The routing table in PACK.md is the
 * author's map; the child index is ground truth from the filesystem. */
export function renderPackContent(pack: SkillPack): string {
	const children = pack.children
		.map((child) => `- ${child.name}${child.description ? `: ${child.description}` : ""}`)
		.join("\n");
	return `${pack.packInstructions}\n\n## Skills in this pack\nLoad a child with the skill tool using "<pack>/<skill>":\n${children}`;
}

function packToSkillLike(pack: SkillPack): Skill {
	return {
		name: pack.name,
		description: pack.description,
		instructions: renderPackContent(pack),
		path: pack.path,
	};
}

/** The flat tool, unchanged for single-tier callers. */
export function createSkillTool(skills: Skill[], options: { name?: string } = {}): Tool {
	return {
		name: options.name ?? "skill",
		description:
			"Load the full instructions of a skill. Call this before performing work the skill covers. " +
			`Available skills: ${skills.map((s) => s.name).join(", ") || "(none)"}`,
		parameters: {
			type: "object",
			properties: {
				name: { type: "string", description: "Skill name", enum: skills.map((s) => s.name) },
			},
			required: ["name"],
		},
		async execute(args): Promise<ToolResult> {
			const skill = skills.find((s) => s.name === (args as { name: string }).name);
			if (!skill) {
				return {
					content: [{ type: "text", text: `Unknown skill "${(args as { name: string }).name}". Available: ${skills.map((s) => s.name).join(", ")}` }],
					isError: true,
				};
			}
			return { content: [{ type: "text", text: skill.instructions }] };
		},
	};
}

/** Two-tier `skill` tool: enum lists loose skills + pack names (children are
 * NOT enumerated — the model must load the pack to see them, which is how a
 * 25-child suite costs one enum entry instead of 25). Address forms:
 * "skill-name" and "pack/child"; loading a pack returns its routing table
 * plus the child index. Case-insensitive matching keeps CJK/Latin and
 * "Deploy"/"deploy" typos harmless. */
export function createIndexedSkillTool(index: SkillIndex, options: { name?: string } = {}): Tool {
	const enumEntries = [
		...index.packs.map((p) => p.name),
		...index.loose.map((s) => s.name),
	];
	return {
		name: options.name ?? "skill",
		description:
			"Load the full instructions of a skill or skill pack. Call this before performing work the skill covers. " +
			"Names ending in a pack load its routing table; address a bundled skill as \"<pack>/<skill>\". " +
			`Available: ${enumEntries.join(", ") || "(none)"}`,
		parameters: {
			type: "object",
			properties: {
				name: {
					type: "string",
					description: 'Skill name, e.g. "deploy", or "lark/lark-base" for a skill inside a pack',
					enum: enumEntries,
				},
			},
			required: ["name"],
		},
		async execute(args): Promise<ToolResult> {
			const address = (args as { name: string }).name;
			const resolved = resolveSkillAddress(index, address);
			if (resolved) {
				if (resolved.kind === "pack" && resolved.pack) {
					return { content: [{ type: "text", text: renderPackContent(resolved.pack) }] };
				}
				return { content: [{ type: "text", text: resolved.skill.instructions }] };
			}
			// unknown address: point at the right layer instead of a flat list
			const [head, child] = address.split("/");
			const pack = index.packs.find((p) => p.name.toLowerCase() === head?.toLowerCase());
			if (pack && child) {
				const known = pack.children.map((c) => c.name).join(", ");
				return {
					content: [{ type: "text", text: `Pack "${pack.name}" has no skill "${child}". Skills in this pack: ${known}` }],
					isError: true,
				};
			}
			return {
				content: [{ type: "text", text: `Unknown skill "${address}". Available: ${enumEntries.join(", ")}` }],
				isError: true,
			};
		},
	};
}
