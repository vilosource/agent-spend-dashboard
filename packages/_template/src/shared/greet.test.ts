import { describe, expect, it } from "vitest";
import { greet } from "./greet.js";

describe("greet", () => {
	it("returns a greeting for a normal recipient", () => {
		const result = greet("world");
		expect(result.recipient).toBe("world");
		expect(result.message).toBe("Hello, world");
	});

	it("trims surrounding whitespace from the recipient", () => {
		const result = greet("  alice  ");
		expect(result.recipient).toBe("alice");
		expect(result.message).toBe("Hello, alice");
	});

	it("throws when given an empty recipient", () => {
		expect(() => greet("")).toThrow("recipient must not be empty");
	});

	it("throws when given a whitespace-only recipient", () => {
		expect(() => greet("   ")).toThrow("recipient must not be empty");
	});
});
