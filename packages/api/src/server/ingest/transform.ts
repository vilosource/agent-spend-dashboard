/**
 * OTLP/JSON traces payload → agent_spend_logs row(s).
 *
 * Pure transform — no IO, no env reads. Mirrors the canonical Python
 * implementation in lab/bridge/bridge.py exactly so the bridge regression
 * tests in the lab keep validating the same field-mapping logic.
 *
 * Identity rule (D8 / design §5.3 step 4): the row's `user_id` comes
 * from the authenticated identity (req.identity.email), NOT from the
 * span's `agent.user.id` attribute. Extensions cannot forge identity by
 * setting that attribute.
 *
 * Per design §5.3 step 3, payload-shaped attributes
 * (`gen_ai.prompt`, `gen_ai.completion`, `gen_ai.tool_arguments`,
 * `gen_ai.tool_call.arguments`) are stripped before processing as
 * defense-in-depth — extensions shouldn't send these but we don't trust
 * them.
 */

export type AttrValue = string | number | boolean | (string | number | boolean)[];

interface OtlpAttribute {
	key?: string;
	value?: {
		stringValue?: string;
		intValue?: string | number;
		doubleValue?: number;
		boolValue?: boolean;
		arrayValue?: { values?: Array<Record<string, unknown>> };
	};
}

interface OtlpSpan {
	startTimeUnixNano?: string | number;
	attributes?: OtlpAttribute[];
}

interface OtlpScopeSpans {
	spans?: OtlpSpan[];
}

interface OtlpResource {
	attributes?: OtlpAttribute[];
}

interface OtlpResourceSpans {
	resource?: OtlpResource;
	scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpTracesPayload {
	resourceSpans?: OtlpResourceSpans[];
}

export type CostEstimation = "metered" | "subscription" | "unreported";

/**
 * Shape that maps 1:1 to the agent_spend_logs INSERT in db.ts. Names
 * are camelCase here (TS convention); the SQL layer remaps them.
 */
export interface SpendLogRow {
	readonly ts: Date;
	readonly userId: string;
	readonly team: string | null;
	readonly machineId: string;
	readonly sessionId: string;
	readonly workspaceCwd: string | null;
	readonly workspaceRepo: string | null;
	readonly workspaceBranch: string | null;
	readonly workspaceIsCi: boolean;
	readonly provider: string;
	readonly api: string;
	readonly model: string;
	readonly responseModel: string | null;
	readonly harnessName: string;
	readonly harnessVersion: string | null;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly costInputUsd: number;
	readonly costOutputUsd: number;
	readonly costCacheReadUsd: number;
	readonly costCacheWriteUsd: number;
	readonly costTotalUsd: number;
	readonly costEstimation: CostEstimation;
	readonly stopReason: string | null;
	readonly eventKind: string;
	readonly environment: string;
}

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Defense-in-depth: drop these even if the extension misbehaves and
 * sends them. We never write them anywhere, but stripping early avoids
 * accidentally logging them downstream.
 */
const FORBIDDEN_ATTR_KEYS = new Set<string>([
	"gen_ai.prompt",
	"gen_ai.completion",
	"gen_ai.tool_arguments",
	"gen_ai.tool_call.arguments",
]);

export function attrsToDict(attributes: readonly OtlpAttribute[] | undefined): Record<string, AttrValue> {
	const out: Record<string, AttrValue> = {};
	for (const a of attributes ?? []) {
		if (!a.key || FORBIDDEN_ATTR_KEYS.has(a.key)) continue;
		const value = unwrapOtlpValue(a.value);
		if (value !== undefined) out[a.key] = value;
	}
	return out;
}

function unwrapOtlpValue(v: OtlpAttribute["value"]): AttrValue | undefined {
	if (!v) return undefined;
	if (typeof v.stringValue === "string") return v.stringValue;
	if (v.intValue !== undefined) {
		return typeof v.intValue === "string" ? Number.parseInt(v.intValue, 10) : v.intValue;
	}
	if (typeof v.doubleValue === "number") return v.doubleValue;
	if (typeof v.boolValue === "boolean") return v.boolValue;
	if (v.arrayValue !== undefined) return unwrapOtlpArray(v.arrayValue.values);
	return undefined;
}

function unwrapOtlpArray(values: ReadonlyArray<Record<string, unknown>> | undefined): AttrValue {
	return (values ?? [])
		.map((item) => Object.values(item)[0])
		.filter(
			(x): x is string | number | boolean =>
				typeof x === "string" || typeof x === "number" || typeof x === "boolean",
		);
}

export interface IterSpansItem {
	readonly span: OtlpSpan;
	readonly resourceAttrs: Record<string, AttrValue>;
}

export function* iterSpans(payload: OtlpTracesPayload): Iterable<IterSpansItem> {
	for (const rs of payload.resourceSpans ?? []) {
		const resourceAttrs = attrsToDict(rs.resource?.attributes);
		for (const ss of rs.scopeSpans ?? []) {
			for (const span of ss.spans ?? []) {
				yield { span, resourceAttrs };
			}
		}
	}
}

/**
 * Convert one OTLP span into a row, or return null to skip the span.
 *
 * `authenticatedUserId` is the identity from req.identity (email or
 * sub). It overrides any `agent.user.id` attribute on the span — that
 * attribute is logged for audit but never written as the row's user_id.
 */
export function spanToRow(
	span: OtlpSpan,
	resourceAttrs: Record<string, AttrValue>,
	authenticatedUserId: string,
): SpendLogRow | null {
	const a: Record<string, AttrValue> = { ...resourceAttrs, ...attrsToDict(span.attributes) };
	const harnessName = asString(a["agent.harness.name"]);
	if (!harnessName) return null;
	return {
		ts: nanoTimestampToDate(span.startTimeUnixNano),
		userId: authenticatedUserId,
		harnessName,
		...identityFields(a),
		...workspaceFields(a),
		...modelFields(a),
		...usageFields(a),
		...costFields(a),
		...metaFields(a),
	};
}

function nanoTimestampToDate(ns: string | number | undefined): Date {
	const n = toNumber(ns) ?? 0;
	return new Date(n / 1_000_000);
}

function identityFields(a: Record<string, AttrValue>) {
	return {
		team: asString(a["agent.user.team"]),
		machineId: asString(a["agent.machine.id"]) ?? ZERO_UUID,
		sessionId: asString(a["agent.session.id"]) ?? ZERO_UUID,
		harnessVersion: asString(a["agent.harness.version"]),
	};
}

function workspaceFields(a: Record<string, AttrValue>) {
	return {
		workspaceCwd: asString(a["agent.workspace.cwd"]),
		workspaceRepo: asString(a["agent.workspace.repo"]),
		workspaceBranch: asString(a["agent.workspace.branch"]),
		workspaceIsCi: asBool(a["agent.workspace.is_ci"]) ?? false,
	};
}

function modelFields(a: Record<string, AttrValue>) {
	return {
		provider: asString(a["gen_ai.provider.name"]) ?? "unknown",
		api: asString(a["agent.api.dialect"]) ?? "unknown",
		model: asString(a["gen_ai.request.model"]) ?? "unknown",
		responseModel: asString(a["gen_ai.response.model"]),
	};
}

function usageFields(a: Record<string, AttrValue>) {
	return {
		inputTokens: asInt(a["gen_ai.usage.input_tokens"]) ?? 0,
		outputTokens: asInt(a["gen_ai.usage.output_tokens"]) ?? 0,
		cacheRead: asInt(a["gen_ai.usage.cache_read.input_tokens"]) ?? 0,
		cacheWrite: asInt(a["gen_ai.usage.cache_creation.input_tokens"]) ?? 0,
	};
}

function costFields(a: Record<string, AttrValue>) {
	return {
		costInputUsd: asNumber(a["agent.cost.input.usd"]) ?? 0,
		costOutputUsd: asNumber(a["agent.cost.output.usd"]) ?? 0,
		costCacheReadUsd: asNumber(a["agent.cost.cache_read.usd"]) ?? 0,
		costCacheWriteUsd: asNumber(a["agent.cost.cache_write.usd"]) ?? 0,
		costTotalUsd: asNumber(a["agent.cost.total.usd"]) ?? 0,
		costEstimation: asCostEstimation(a["agent.cost.estimation"]) ?? "metered",
	};
}

function metaFields(a: Record<string, AttrValue>) {
	return {
		stopReason: asString(a["agent.stop_reason"]),
		eventKind: asString(a["agent.event.kind"]) ?? "turn",
		environment: asString(a["deployment.environment"]) ?? "prod",
	};
}

/**
 * Convenience: walk the whole payload and return all valid rows. Skipped
 * spans (missing required attrs) are silently dropped. Counts come back
 * for the caller to log / return in the OTLP partialSuccess shape.
 */
export interface TransformResult {
	readonly rows: SpendLogRow[];
	readonly seen: number;
	readonly skipped: number;
}

export function payloadToRows(payload: OtlpTracesPayload, authenticatedUserId: string): TransformResult {
	const rows: SpendLogRow[] = [];
	let seen = 0;
	let skipped = 0;
	for (const { span, resourceAttrs } of iterSpans(payload)) {
		seen += 1;
		const row = spanToRow(span, resourceAttrs, authenticatedUserId);
		if (row) rows.push(row);
		else skipped += 1;
	}
	return { rows, seen, skipped };
}

// ---------------------------------------------------------------------------
// type-narrowing helpers
// ---------------------------------------------------------------------------

function asString(v: AttrValue | undefined): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

function asNumber(v: AttrValue | undefined): number | null {
	return typeof v === "number" ? v : null;
}

function asInt(v: AttrValue | undefined): number | null {
	if (typeof v === "number") return Math.trunc(v);
	return null;
}

function asBool(v: AttrValue | undefined): boolean | null {
	return typeof v === "boolean" ? v : null;
}

function asCostEstimation(v: AttrValue | undefined): CostEstimation | null {
	if (v === "metered" || v === "subscription" || v === "unreported") return v;
	return null;
}

function toNumber(v: string | number | undefined): number | null {
	if (typeof v === "number") return v;
	if (typeof v === "string") {
		const n = Number(v);
		return Number.isFinite(n) ? n : null;
	}
	return null;
}
