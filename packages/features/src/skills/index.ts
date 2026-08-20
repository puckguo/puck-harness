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
 *   - skillsToPrompt:      inject all skill descriptions into the system prompt
 *   - createSkillTool:     expose a `skill` tool; the model pulls instructions
 *                          on demand (cheaper context, one extra hop)
 */

import type { Tool, ToolResult } from "@puckguo123/core";
import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	instructions: string;
	path: string;
}

/** Parse the `name`/`description` header of a SKILL.md (both formats). */
function parseHeader(raw: string): { name: string | undefined; description: string } {
	// YAML frontmatter: leading `---` block, `key: value` lines. This is a
	// minimal reader (quoted scalars + block scalars), not a YAML parser —
	// skill headers in the wild only use these two shapes.
	if (raw.startsWith("---")) {
		const end = raw.indexOf("\n---", 3);
		if (end > 0) {
			const block = raw.slice(3, end);
			let name: string | undefined;
			let description = "";
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
				const m = line.match(/^(name|description):\s*(.+)$/);
				if (!m) continue;
				let value = m[2].trim();
				const quoted = value.match(/^["'](.*)["']$/);
				if (quoted) value = quoted[1];
				if (m[1] === "name") name = value;
				else description = value;
			}
			return { name, description };
		}
	}
	// Markdown title + `description:` line (puck native format)
	const lines = raw.split("\n");
	const titleMatch = lines[0]?.match(/^#\s+(.+)$/);
	const descriptionLine = lines.slice(1).find((line) => line.trim().startsWith("description:"));
	return {
		name: titleMatch?.[1]?.trim(),
		description: descriptionLine?.replace(/^\s*description:\s*/, "").trim() ?? "",
	};
}

/** Load every SKILL.md under a directory (one level deep). */
export async function loadSkills(dir: string): Promise<Skill[]> {
	const entries = await stat(dir).then((s) => s.isDirectory()).catch(() => false);
	if (!entries) return [];

	const skills: Skill[] = [];
	for (const name of readdirSync(dir)) {
		const skillPath = join(dir, name, "SKILL.md");
		const raw = await readFile(skillPath, "utf8").catch(() => null);
		if (raw === null) continue;

		const { name: parsedName, description } = parseHeader(raw);
		skills.push({
			name: parsedName ?? name,
			description,
			instructions: raw,
			path: skillPath,
		});
	}
	return skills;
}

/**
 * Load skills from every agent harness's skills directory on this machine:
 *   ~/.puck/skills, ~/.claude/skills, ~/.codex/skills, ~/.pi/skills
 * Missing directories are skipped silently. Skills with the same name from
 * different harnesses are deduplicated (first source wins, puck first).
 *
 * This is what the CLI wires up by default — a skill you installed for
 * Claude Code or Codex just works in puck, no copy needed.
 */
export async function loadAllHarnessSkills(home = process.env.USERPROFILE ?? process.env.HOME ?? "."): Promise<Skill[]> {
	const SOURCES = [".puck", ".claude", ".codex", ".pi"] as const;
	const byName = new Map<string, Skill>();
	for (const source of SOURCES) {
		const skills = await loadSkills(join(home, source, "skills"));
		for (const skill of skills) {
			if (!byName.has(skill.name)) byName.set(skill.name, skill);
		}
	}
	return [...byName.values()];
}

/** Render a system-prompt section listing available skills. */
export function skillsToPrompt(skills: Skill[]): string {
	if (skills.length === 0) return "";
	const lines = skills.map((skill) => `- ${skill.name}${skill.description ? `: ${skill.description}` : ""}`);
	return `\n\n## Skills\nThe following skills are available. Load one with the skill tool before using it:\n${lines.join("\n")}`;
}

/** A tool that loads a skill's full instructions into the conversation. */
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
