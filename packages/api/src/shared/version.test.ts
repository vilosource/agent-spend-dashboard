import { describe, expect, it } from "vitest";
import { VERSION } from "./version.js";

describe("VERSION", () => {
	it("is a non-empty string in semver-shaped form", () => {
		expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/i);
	});
});
