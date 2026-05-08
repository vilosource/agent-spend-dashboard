/**
 * Pure example function demonstrating the shared/ layer convention.
 *
 * Pure: no IO, no environment access, no globals. Easy to test.
 * The dependency-cruiser rule "shared-is-pure" enforces that
 * files under src/shared/ cannot import from node:fs, node:os,
 * etc. — IO belongs in src/extension/ or src/cli/.
 */

export interface Greeting {
	readonly recipient: string;
	readonly message: string;
}

export function greet(recipient: string): Greeting {
	const trimmed = recipient.trim();
	if (trimmed.length === 0) {
		throw new Error("greet: recipient must not be empty");
	}
	return { recipient: trimmed, message: `Hello, ${trimmed}` };
}
