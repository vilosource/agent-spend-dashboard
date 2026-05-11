/**
 * Unit tests for the OTLP→row transform. Pure functions; no IO.
 */

import { describe, expect, it } from "vitest";
import { attrsToDict, type OtlpTracesPayload, payloadToRows, spanToRow } from "./transform.js";

const AUTH_USER = "alice@example.invalid";

function attr(key: string, value: unknown, vtype = "stringValue"): { key: string; value: Record<string, unknown> } {
	return { key, value: { [vtype]: value } };
}

const happySpan = {
	startTimeUnixNano: "1700000000000000000",
	attributes: [
		attr("agent.harness.name", "pi"),
		attr("agent.harness.version", "0.66.1"),
		attr("agent.user.id", "claimed@example.invalid"), // should be IGNORED — see test below
		attr("agent.user.team", "platform"),
		attr("agent.machine.id", "11111111-1111-1111-1111-111111111111"),
		attr("agent.session.id", "22222222-2222-2222-2222-222222222222"),
		attr("agent.workspace.cwd", "/home/alice/repo"),
		attr("agent.workspace.repo", "vilosource/token-tracker"),
		attr("agent.workspace.branch", "main"),
		attr("agent.workspace.is_ci", false, "boolValue"),
		attr("gen_ai.provider.name", "z.ai"),
		attr("agent.api.dialect", "anthropic-messages"),
		attr("gen_ai.request.model", "glm-4.6"),
		attr("gen_ai.response.model", "glm-4.6"),
		attr("gen_ai.usage.input_tokens", 1000, "intValue"),
		attr("gen_ai.usage.output_tokens", 500, "intValue"),
		attr("gen_ai.usage.cache_read.input_tokens", 200, "intValue"),
		attr("gen_ai.usage.cache_creation.input_tokens", 100, "intValue"),
		attr("agent.cost.input.usd", 0.001, "doubleValue"),
		attr("agent.cost.output.usd", 0.002, "doubleValue"),
		attr("agent.cost.cache_read.usd", 0.0001, "doubleValue"),
		attr("agent.cost.cache_write.usd", 0.0002, "doubleValue"),
		attr("agent.cost.total.usd", 0.0033, "doubleValue"),
		attr("agent.cost.estimation", "metered"),
		attr("agent.stop_reason", "end_turn"),
		attr("agent.event.kind", "turn"),
		attr("deployment.environment", "lab"),
	],
};

describe("attrsToDict", () => {
	it("flattens stringValue / intValue / doubleValue / boolValue", () => {
		const d = attrsToDict([
			attr("s", "hello"),
			attr("i", 42, "intValue"),
			attr("d", 3.14, "doubleValue"),
			attr("b", true, "boolValue"),
		]);
		expect(d).toEqual({ s: "hello", i: 42, d: 3.14, b: true });
	});

	it("parses string-typed intValue (OTLP wraps int64 as string)", () => {
		const d = attrsToDict([attr("ts", "1700000000000000000", "intValue")]);
		expect(d).toEqual({ ts: 1700000000000000000 });
	});

	it("flattens arrayValue elements", () => {
		const d = attrsToDict([
			{
				key: "tags",
				value: {
					arrayValue: {
						values: [{ stringValue: "a" }, { stringValue: "b" }, { intValue: 1 }],
					},
				},
			},
		]);
		expect(d).toEqual({ tags: ["a", "b", 1] });
	});

	it("ignores keyless attributes", () => {
		const d = attrsToDict([{ value: { stringValue: "orphan" } }, attr("ok", "yes")]);
		expect(d).toEqual({ ok: "yes" });
	});

	it("strips forbidden payload-shaped attributes (defense in depth)", () => {
		const d = attrsToDict([
			attr("gen_ai.prompt", "DO NOT STORE"),
			attr("gen_ai.completion", "DO NOT STORE"),
			attr("gen_ai.tool_arguments", "DO NOT STORE"),
			attr("gen_ai.tool_call.arguments", "DO NOT STORE"),
			attr("gen_ai.provider.name", "z.ai"), // unaffected
		]);
		expect(d).toEqual({ "gen_ai.provider.name": "z.ai" });
	});
});

describe("spanToRow", () => {
	it("happy path: builds the full row and uses the authenticated user_id", () => {
		const row = spanToRow(happySpan, {}, AUTH_USER);
		expect(row).not.toBeNull();
		expect(row?.userId).toBe(AUTH_USER); // NOT "claimed@example.invalid" from the span attr
		expect(row?.harnessName).toBe("pi");
		expect(row?.harnessVersion).toBe("0.66.1");
		expect(row?.team).toBe("platform");
		expect(row?.machineId).toBe("11111111-1111-1111-1111-111111111111");
		expect(row?.sessionId).toBe("22222222-2222-2222-2222-222222222222");
		expect(row?.workspaceCwd).toBe("/home/alice/repo");
		expect(row?.workspaceRepo).toBe("vilosource/token-tracker");
		expect(row?.workspaceBranch).toBe("main");
		expect(row?.workspaceIsCi).toBe(false);
		expect(row?.provider).toBe("z.ai");
		expect(row?.api).toBe("anthropic-messages");
		expect(row?.model).toBe("glm-4.6");
		expect(row?.responseModel).toBe("glm-4.6");
		expect(row?.inputTokens).toBe(1000);
		expect(row?.outputTokens).toBe(500);
		expect(row?.cacheRead).toBe(200);
		expect(row?.cacheWrite).toBe(100);
		expect(row?.costInputUsd).toBe(0.001);
		expect(row?.costTotalUsd).toBe(0.0033);
		expect(row?.costEstimation).toBe("metered");
		expect(row?.stopReason).toBe("end_turn");
		expect(row?.eventKind).toBe("turn");
		expect(row?.environment).toBe("lab");
	});

	it("returns null when agent.harness.name is missing (defense-in-depth filter)", () => {
		const span = { ...happySpan, attributes: happySpan.attributes.filter((a) => a.key !== "agent.harness.name") };
		expect(spanToRow(span, {}, AUTH_USER)).toBeNull();
	});

	it("falls back to defaults when optional attributes are missing", () => {
		const minimal = {
			startTimeUnixNano: "1700000000000000000",
			attributes: [attr("agent.harness.name", "pi")],
		};
		const row = spanToRow(minimal, {}, AUTH_USER);
		expect(row).toMatchObject({
			userId: AUTH_USER,
			team: null,
			machineId: "00000000-0000-0000-0000-000000000000",
			sessionId: "00000000-0000-0000-0000-000000000000",
			workspaceCwd: null,
			workspaceIsCi: false,
			provider: "unknown",
			api: "unknown",
			model: "unknown",
			responseModel: null,
			harnessName: "pi",
			harnessVersion: null,
			inputTokens: 0,
			outputTokens: 0,
			cacheRead: 0,
			cacheWrite: 0,
			costInputUsd: 0,
			costOutputUsd: 0,
			costTotalUsd: 0,
			costEstimation: "metered", // default per schema D12
			stopReason: null,
			eventKind: "turn",
			environment: "prod",
		});
	});

	it("merges resource attributes UNDER span attributes (per-span overrides win)", () => {
		const resourceAttrs = { "deployment.environment": "from-resource" };
		const span = {
			startTimeUnixNano: "1700000000000000000",
			attributes: [attr("agent.harness.name", "pi"), attr("deployment.environment", "from-span")],
		};
		const row = spanToRow(span, resourceAttrs, AUTH_USER);
		expect(row?.environment).toBe("from-span");
	});

	it("uses resource attributes when span has no override", () => {
		const resourceAttrs = { "deployment.environment": "from-resource" };
		const span = {
			startTimeUnixNano: "1700000000000000000",
			attributes: [attr("agent.harness.name", "pi")],
		};
		const row = spanToRow(span, resourceAttrs, AUTH_USER);
		expect(row?.environment).toBe("from-resource");
	});

	it("converts startTimeUnixNano (string) to a Date", () => {
		const span = {
			startTimeUnixNano: "1700000000000000000",
			attributes: [attr("agent.harness.name", "pi")],
		};
		const row = spanToRow(span, {}, AUTH_USER);
		expect(row?.ts).toBeInstanceOf(Date);
		// 1.7e18 ns = 1.7e9 s = 2023-11-14T22:13:20Z
		expect(row?.ts.toISOString()).toBe("2023-11-14T22:13:20.000Z");
	});

	it("accepts the three known cost_estimation values; rejects others to default", () => {
		for (const v of ["metered", "subscription", "unreported"]) {
			const span = {
				startTimeUnixNano: "1700000000000000000",
				attributes: [attr("agent.harness.name", "pi"), attr("agent.cost.estimation", v)],
			};
			expect(spanToRow(span, {}, AUTH_USER)?.costEstimation).toBe(v);
		}
		const bad = {
			startTimeUnixNano: "1700000000000000000",
			attributes: [attr("agent.harness.name", "pi"), attr("agent.cost.estimation", "free")],
		};
		expect(spanToRow(bad, {}, AUTH_USER)?.costEstimation).toBe("metered");
	});
});

describe("payloadToRows", () => {
	it("walks resourceSpans → scopeSpans → spans and returns counts", () => {
		const payload: OtlpTracesPayload = {
			resourceSpans: [
				{
					resource: { attributes: [attr("deployment.environment", "lab")] },
					scopeSpans: [
						{
							spans: [
								happySpan,
								happySpan,
								// Skipped: missing harness name.
								{
									startTimeUnixNano: "1700000000000000000",
									attributes: [attr("gen_ai.provider.name", "z.ai")],
								},
							],
						},
					],
				},
			],
		};
		const result = payloadToRows(payload, AUTH_USER);
		expect(result.seen).toBe(3);
		expect(result.skipped).toBe(1);
		expect(result.rows).toHaveLength(2);
		expect(result.rows.every((r) => r.userId === AUTH_USER)).toBe(true);
	});

	it("returns empty result for an empty payload", () => {
		expect(payloadToRows({}, AUTH_USER)).toEqual({ rows: [], seen: 0, skipped: 0 });
	});
});
