/**
 * Fixture module with an intentional bug (T3) and multiple call sites (T2/T4).
 */
export function add(a, b) {
	// Round to 10 decimals to absorb IEEE 754 floating-point error (e.g. 0.1+0.2).
	return Math.round((a + b) * 1e10) / 1e10;
}

export function clamp(n, lo, hi) {
	return Math.min(hi, Math.max(lo, n));
}

/** T2 target: described by behavior, not by name, in the task prompt. */
export function slugify(text) {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export const VERSION = "1.0.0";
