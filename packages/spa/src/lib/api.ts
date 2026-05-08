/**
 * Tiny typed wrapper over fetch for the /api/* endpoints. Cookies are
 * sent automatically by the browser; on a 401 we redirect to the OIDC
 * flow at /auth/login (the API redirects from there to Dex / Entra /
 * etc.). Body shape mirrors what the Express handlers return verbatim.
 */

export interface Identity {
	readonly email: string;
	readonly name: string | null;
	readonly role: "admin" | "developer";
	readonly tokenLabel: string;
	readonly source: "cookie" | "bearer";
}

export interface UsageTotals {
	readonly costUsd: number;
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
}

export interface UsageByDay {
	readonly day: string;
	readonly costUsd: number;
	readonly turns: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
}

export interface UsageByModel {
	readonly model: string;
	readonly provider: string;
	readonly costUsd: number;
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
	readonly turns: number;
	readonly models: readonly string[];
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

async function getJson<T>(url: string): Promise<T> {
	const res = await fetch(url, { credentials: "same-origin" });
	if (res.status === 401) throw new UnauthenticatedError();
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

export function redirectToLogin(): void {
	window.location.assign("/auth/login");
}

export function fmtUsd(n: number): string {
	return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(n);
}

export function fmtInt(n: number): string {
	return new Intl.NumberFormat("en-US").format(n);
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
