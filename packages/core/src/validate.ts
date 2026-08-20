/**
 * Minimal JSON Schema validation for tool arguments.
 *
 * Supports the subset that tool schemas actually use:
 * type, required, properties, enum, items. Anything else is ignored —
 * an unknown construct validates as true. Failures return a message
 * suitable for handing back to the model.
 */

import type { Tool } from "./types.js";

type Schema = Record<string, any>;

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function checkType(value: unknown, expected: string): boolean {
	switch (expected) {
		case "string":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "integer":
			return typeof value === "number" && Number.isInteger(value);
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return typeOf(value) === "object";
		case "array":
			return Array.isArray(value);
		case "null":
			return value === null;
		default:
			return true;
	}
}

export function validateAgainstSchema(value: unknown, schema: Schema | undefined, path: string, errors: string[]): void {
	if (!schema || typeof schema !== "object") return;

	if (schema.type !== undefined && !checkType(value, schema.type)) {
		errors.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`);
		return;
	}

	if (Array.isArray(schema.enum) && !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
		errors.push(`${path}: value must be one of ${JSON.stringify(schema.enum)}`);
	}

	if (typeOf(value) === "object" && schema.properties) {
		const record = value as Record<string, unknown>;
		for (const [key, propSchema] of Object.entries(schema.properties)) {
			if (record[key] !== undefined) {
				validateAgainstSchema(record[key], propSchema as Schema, `args.${key}`, errors);
			}
		}
	}

	if (Array.isArray(value) && schema.items) {
		value.forEach((item, i) => validateAgainstSchema(item, schema.items as Schema, `${path}[${i}]`, errors));
	}
}

/**
 * Validate tool-call arguments against the tool's JSON Schema.
 * Returns null on success or a human/model readable error message.
 */
export function validateToolArguments(tool: Tool, args: unknown): string | null {
	if (typeOf(args) !== "object") {
		return `Arguments for tool "${tool.name}" must be a JSON object, got ${typeOf(args)}`;
	}

	const errors: string[] = [];
	const schema = tool.parameters ?? {};
	const record = args as Record<string, unknown>;

	for (const key of (schema.required as string[]) ?? []) {
		if (record[key] === undefined) {
			errors.push(`args.${key}: required property is missing`);
		}
	}

	validateAgainstSchema(args, schema, "args", errors);
	return errors.length > 0 ? `Invalid arguments for tool "${tool.name}": ${errors.join("; ")}` : null;
}
