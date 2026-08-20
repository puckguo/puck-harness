import { slugify } from "../src/math.js";

export function formatTag(...words) {
	// T4: calls slugify — refactors must keep call sites working
	return slugify(words.join(" "));
}

export function formatDate(d) {
	return d.toISOString().slice(0, 10);
}

export function formatLabel(name, date) {
	return formatTag(name) + "@" + formatDate(date);
}
