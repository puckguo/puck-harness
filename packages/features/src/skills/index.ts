/**
 * Skills — reusable instruction packs loaded from a directory.
 *
 * A skill is a folder with a SKILL.md:
 *
 *   my-skill/
 *     SKILL.md     # first line: "# name", then "description: ..." (optional)
 *     ...          # any supporting files the skill references
 *
 * Two integration modes:
 *   - skillsToPrompt:      inject all skill descriptions into the system prompt
 *   - createSkillTool:     expose a `skill` tool; the model pulls instructions
 *                          on demand (cheaper context, one extra hop)
 */

import type { Tool, ToolResult } from "@puck-agent/core";
import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Skill {
	name: string;
	description: string;
	instructions: string;
	path: string;
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

		const lines = raw.split("\n");
		const titleMatch = lines[0]?.match(/^#\s+(.+)$/);
		const descriptionLine = lines
			.slice(1)
			.find((line) => line.trim().startsWith("description:"));
		skills.push({
			name: titleMatch?.[1]?.trim() ?? name,
			description: descriptionLine?.replace(/^\s*description:\s*/, "").trim() ?? "",
			instructions: raw,
			path: skillPath,
		});
	}
	return skills;
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
