/**
 * Tiny typed wrapper over fetch for the /api/* endpoints. Every request
 * carries `Authorization: Bearer <IdP access token>` obtained from MSAL
 * (see lib/auth.ts) — there is no cookie and no /auth/* on the server.
 * Body shape mirrors what the Express handlers return verbatim.
 *
 *   401 → the token is missing/expired and silent renewal failed →
 *         `UnauthenticatedError` (caller triggers a login redirect).
 *   403 → authenticated but the IdP didn't assign this user a role for
 *         the app → `ForbiddenError` (a permanent state for that user;
 *         redirecting to login won't help — show the message).
 */

import { getAccessToken, login } from "./auth.js";

export interface Identity {
	readonly email: string;
	readonly name: string | null;
	readonly role: "admin" | "user" | "viewer";
	readonly roles: readonly string[];
	readonly oid: string | null;
}

export interface UsageTotals {
	/** Actually-billed cost. $0 for subscription (flat-rate) usage. */
	readonly costUsd: number;
	/** List-price cost; for subscription usage this is the estimate. */
	readonly estimatedCostUsd: number;
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface UsageByDay {
	readonly day: string;
	readonly costUsd: number;
	readonly estimatedCostUsd: number;
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export interface UsageByModel {
	readonly model: string;
	readonly provider: string;
	readonly costUsd: number;
	readonly estimatedCostUsd: number;
	readonly turns: number;
}

export interface UsageResponse {
	readonly from: string;
	readonly to: string;
	readonly totals: UsageTotals;
	readonly byDay: readonly UsageByDay[];
	readonly byModel: readonly UsageByModel[];
}

export interface SessionItem {
	readonly sessionId: string;
	readonly firstTs: string;
	readonly lastTs: string;
	readonly costUsd: number;
	readonly estimatedCostUsd: number;
	readonly turns: number;
	readonly models: readonly string[];
}

export interface ModelPrice {
	readonly model: string;
	readonly inputPerMtok: number;
	readonly outputPerMtok: number;
	readonly cacheReadPerMtok: number;
	readonly cacheWritePerMtok: number;
	readonly source: string;
}

export interface PricesResponse {
	/** When prices were last synced (ISO 8601), or null if empty. */
	readonly updatedAt: string | null;
	readonly count: number;
	readonly items: readonly ModelPrice[];
}

export interface SessionsResponse {
	readonly from: string;
	readonly to: string;
	readonly items: readonly SessionItem[];
	readonly nextCursor: string | null;
}

export class UnauthenticatedError extends Error {
	constructor() {
		super("unauthenticated");
		this.name = "UnauthenticatedError";
	}
}

export class ForbiddenError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ForbiddenError";
	}
}

async function getJson<T>(url: string): Promise<T> {
	const token = await getAccessToken();
	const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
	if (res.status === 401) throw new UnauthenticatedError();
	if (res.status === 403) {
		const body = (await res.json().catch(() => ({}))) as { error?: unknown };
		throw new ForbiddenError(typeof body.error === "string" ? body.error : "you don't have access to this app");
	}
	if (!res.ok) throw new Error(`${url} → ${res.status}`);
	return (await res.json()) as T;
}

export function fetchMe(): Promise<Identity> {
	return getJson<Identity>("/api/me");
}

export function fetchUsage(from?: Date, to?: Date): Promise<UsageResponse> {
	const params = new URLSearchParams();
	if (from) params.set("from", from.toISOString());
	if (to) params.set("to", to.toISOString());
	const qs = params.toString();
	return getJson<UsageResponse>(`/api/me/usage${qs ? `?${qs}` : ""}`);
}

export function fetchSessions(opts?: {
	from?: Date;
	to?: Date;
	limit?: number;
	cursor?: string;
}): Promise<SessionsResponse> {
	const params = new URLSearchParams();
	if (opts?.from) params.set("from", opts.from.toISOString());
	if (opts?.to) params.set("to", opts.to.toISOString());
	if (opts?.limit) params.set("limit", String(opts.limit));
	if (opts?.cursor) params.set("cursor", opts.cursor);
	const qs = params.toString();
	return getJson<SessionsResponse>(`/api/me/sessions${qs ? `?${qs}` : ""}`);
}

export function fetchPrices(): Promise<PricesResponse> {
	return getJson<PricesResponse>("/api/prices");
}

/** Begin the IdP login redirect (handled entirely client-side by MSAL). */
export function redirectToLogin(): void {
	login();
}

export { logout } from "./auth.js";

export function fmtUsd(n: number): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);
}

export function fmtInt(n: number): string {
	return new Intl.NumberFormat("en-US").format(n);
}

/** Price per 1M tokens, e.g. `$5.00`. `$0` is shown as `—` (free/subscription). */
export function fmtRate(n: number): string {
	if (n === 0) return "—";
	return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);
}

export function fmtDateTime(iso: string): string {
	return new Date(iso).toLocaleString();
}

export function fmtDuration(fromIso: string, toIso: string): string {
	const ms = new Date(toIso).getTime() - new Date(fromIso).getTime();
	if (ms <= 0) return "—";
	const m = Math.floor(ms / 60_000);
	const h = Math.floor(m / 60);
	if (h >= 1) return `${h}h ${m % 60}m`;
	return `${m}m`;
}
