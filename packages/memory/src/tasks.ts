/**
 * Idle task scheduler — the catalog + trigger machinery for background jobs
 * (daily summary, index sync, …). The catalog lives in the system dir
 * (<home>/tasks/catalog.json) and doubles as the user-visible task registry
 * (/tasks command).
 *
 * Design: no daemon, no cron. Tasks only run inside a live REPL when it has
 * been idle (no active run, no queued input) for `idleMs`. Missed schedules
 * (PC was off) are caught up on the next startup nudge — `lastRun` is a date
 * string, not a wall-clock slot.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Schedule = "daily" | "weekly";

export interface TaskState {
	schedule: Schedule;
	/** YYYY-MM-DD of the last successful run. */
	lastRun?: string;
	/** last outcome — "ok", a short error note, or "skip: …" */
	state?: string;
	/** human description shown by /tasks. */
	note?: string;
}

export interface TaskCatalogFile {
	tasks: Record<string, TaskState>;
}

export function localDateStr(now = new Date()): string {
	const y = now.getFullYear();
	const m = String(now.getMonth() + 1).padStart(2, "0");
	const d = String(now.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

export class TaskCatalog {
	private file: TaskCatalogFile = { tasks: {} };
	constructor(private readonly path: string) {
		try {
			if (existsSync(path)) this.file = JSON.parse(readFileSync(path, "utf8")) as TaskCatalogFile;
		} catch {
			this.file = { tasks: {} }; // corrupt catalog → start fresh, never break the REPL
		}
	}

	/** Ensure the task is registered (idempotent) — this IS the task directory listing. */
	register(id: string, schedule: Schedule, note: string): void {
		if (!this.file.tasks[id] || this.file.tasks[id].schedule !== schedule) {
			this.file.tasks[id] = { schedule, ...(this.file.tasks[id]?.lastRun ? { lastRun: this.file.tasks[id].lastRun } : {}), note };
		} else if (this.file.tasks[id].note !== note) {
			this.file.tasks[id].note = note;
		}
		this.save();
	}

	private save(): void {
		mkdirSync(join(this.path, ".."), { recursive: true });
		writeFileSync(this.path, JSON.stringify(this.file, null, "\t"));
	}

	get(id: string): TaskState | undefined {
		return this.file.tasks[id];
	}

	all(): Array<{ id: string } & TaskState> {
		return Object.entries(this.file.tasks).map(([id, s]) => ({ id, ...s }));
	}

	/** daily tasks are due when lastRun isn't today (or never ran); weekly when the last run is ≥7 days ago. */
	isDue(id: string, today = localDateStr()): boolean {
		const t = this.file.tasks[id];
		if (!t) return false;
		if (t.schedule === "weekly") {
			if (!t.lastRun) return true;
			return (new Date(today).getTime() - new Date(t.lastRun).getTime()) / 86_400_000 >= 7;
		}
		return t.lastRun !== today;
	}

	markRun(id: string, state: string, day = localDateStr()): void {
		if (!this.file.tasks[id]) return;
		this.file.tasks[id].lastRun = day;
		this.file.tasks[id].state = state;
		this.save();
	}

	markState(id: string, state: string): void {
		if (!this.file.tasks[id]) return;
		this.file.tasks[id].state = state;
		this.save();
	}
}

export interface SchedulerOptions {
	home: string;
	/** idle time before a due task may start (default 20s). */
	idleMs?: number;
	/** true when the REPL is interactive and no run/queued input is active. */
	isIdle: () => boolean;
	/** run one task by id; resolves with a state note for the catalog. */
	runTask: (id: string) => Promise<string>;
	/** surface progress lines (dim) to the terminal. */
	log: (line: string) => void;
}

export class IdleTaskScheduler {
	private readonly catalog: TaskCatalog;
	private timer: NodeJS.Timeout | undefined;
	private busy = false;
	private readonly idleMs: number;

	constructor(private readonly opts: SchedulerOptions) {
		this.catalog = new TaskCatalog(join(opts.home, "tasks", "catalog.json"));
		this.idleMs = opts.idleMs ?? 20_000;
	}

	/** True while a background task is executing (idle checks wait for it). */
	get running(): boolean {
		return this.busy;
	}

	get tasks(): TaskCatalog {
		return this.catalog;
	}

	register(id: string, schedule: Schedule, note: string): void {
		this.catalog.register(id, schedule, note);
	}

	/** Called at every idle point (startup, after each run settles). Arms a delayed check. */
	nudge(): void {
		if (this.timer !== undefined || this.busy) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.fire();
		}, this.idleMs);
		this.timer.unref?.();
	}

	private async fire(): Promise<void> {
		if (this.busy || !this.opts.isIdle()) {
			this.nudge(); // still busy — retry at the next idle window
			return;
		}
		const due = this.catalog.all().filter((t) => this.catalog.isDue(t.id)).map((t) => t.id);
		if (due.length === 0) return;
		this.busy = true;
		try {
			for (const id of due) {
				try {
					const state = await this.opts.runTask(id);
					this.catalog.markRun(id, state);
					// silent skips: a fresh REPL with nothing to summarize must not
					// scroll the screen with "nothing to do" chatter
					if (state.startsWith("ok")) this.opts.log(`后台任务 ${id} ✓ ${state}`);
				} catch (err) {
					const note = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
					this.catalog.markState(id, `error: ${note}`);
					this.opts.log(`后台任务 ${id} ✗ ${note}`);
				}
			}
		} finally {
			this.busy = false;
		}
	}
}
