/**
 * TimingStore — append-only JSONL persistence for TurnTiming records.
 * Global file (~/.puck/timings.jsonl) so dashboards can compare across
 * sessions, models, and days. Tolerates torn trailing lines.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TurnTiming } from "./types.js";

export class TimingStore {
	readonly path: string;

	constructor(file?: string) {
		this.path = file ?? join(timingDir(), "timings.jsonl");
	}

	append(record: TurnTiming): void {
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
	}

	appendAll(records: TurnTiming[]): void {
		if (records.length === 0) return;
		mkdirSync(dirname(this.path), { recursive: true });
		appendFileSync(this.path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
	}

	load(): TurnTiming[] {
		if (!existsSync(this.path)) return [];
		const records: TurnTiming[] = [];
		for (const line of readFileSync(this.path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try {
				records.push(JSON.parse(line) as TurnTiming);
			} catch {
				/* torn tail — skip */
			}
		}
		return records;
	}

	clear(): void {
		writeFileSync(this.path, "", "utf8");
	}

	get size(): number {
		return this.load().length;
	}
}

function timingDir(): string {
	const home = process.env.PUCK_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? ".", ".puck");
	return join(home, "");
}
