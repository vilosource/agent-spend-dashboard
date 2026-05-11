<script lang="ts">
import { getActiveAccount, isAuthConfigured, loginSupported } from "../lib/auth.js";
import CostTimeseries from "../lib/charts/CostTimeseries.svelte";
import ModelMix from "../lib/charts/ModelMix.svelte";
import {
	ForbiddenError,
	type Identity,
	type SessionItem,
	type UsageResponse,
	UnauthenticatedError,
	fetchMe,
	fetchSessions,
	fetchUsage,
	fmtDateTime,
	fmtDuration,
	fmtInt,
	fmtUsd,
	logout,
	redirectToLogin,
} from "../lib/api.js";

type RangeKey = "7" | "30" | "90";

interface Loaded {
	identity: Identity;
	usage: UsageResponse;
	sessions: readonly SessionItem[];
}

type PageState =
	| { kind: "loading" }
	| { kind: "loaded"; data: Loaded }
	| { kind: "error"; message: string }
	| { kind: "forbidden"; message: string }
	| { kind: "not-configured" }
	| { kind: "login-unsupported" };

function initialState(): PageState {
	if (!isAuthConfigured) return { kind: "not-configured" };
	if (!loginSupported) return { kind: "login-unsupported" };
	return { kind: "loading" };
}

let rangeDays: RangeKey = $state("7");
let pageState: PageState = $state(initialState());

function rangeBounds(days: RangeKey): { from: Date; to: Date } {
	const to = new Date();
	const from = new Date(to.getTime() - Number.parseInt(days, 10) * 86_400_000);
	return { from, to };
}

async function load(days: RangeKey): Promise<void> {
	if (!isAuthConfigured) {
		pageState = { kind: "not-configured" };
		return;
	}
	if (!loginSupported) {
		pageState = { kind: "login-unsupported" };
		return;
	}
	if (!getActiveAccount()) {
		redirectToLogin(); // navigates away
		return;
	}
	pageState = { kind: "loading" };
	try {
		const { from, to } = rangeBounds(days);
		const [identity, usage, sessions] = await Promise.all([
			fetchMe(),
			fetchUsage(from, to),
			fetchSessions({ from, to, limit: 25 }),
		]);
		pageState = { kind: "loaded", data: { identity, usage, sessions: sessions.items } };
	} catch (err) {
		if (err instanceof UnauthenticatedError) {
			redirectToLogin(); // token gone & silent renewal failed — navigates away
			return;
		}
		if (err instanceof ForbiddenError) {
			pageState = { kind: "forbidden", message: err.message };
			return;
		}
		pageState = { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

$effect(() => {
	void load(rangeDays);
});
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
	<header class="flex items-baseline justify-between gap-6">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">My Usage</h1>
			{#if pageState.kind === "loaded"}
				<p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
					{pageState.data.identity.email} ·
					<span class="rounded bg-slate-100 px-1.5 py-0.5 text-xs uppercase tracking-wide text-slate-700 dark:bg-slate-800 dark:text-slate-300">{pageState.data.identity.role}</span>
				</p>
			{/if}
		</div>
		<div class="flex items-center gap-3">
			<label class="text-sm text-slate-600 dark:text-slate-400">
				Range:
				<select bind:value={rangeDays} class="ml-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-sm dark:border-slate-700 dark:bg-slate-900">
					<option value="7">Last 7 days</option>
					<option value="30">Last 30 days</option>
					<option value="90">Last 90 days</option>
				</select>
			</label>
			<button type="button" onclick={logout} class="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
				Log out
			</button>
		</div>
	</header>

	{#if pageState.kind === "loading"}
		<p class="mt-12 text-slate-500">Loading…</p>
	{:else if pageState.kind === "not-configured"}
		<p class="mt-12 text-slate-600 dark:text-slate-400">
			Auth isn't configured — set <code>VITE_TOKEN_TRACKER_*</code> and rebuild the SPA.
		</p>
	{:else if pageState.kind === "login-unsupported"}
		<p class="mt-12 text-slate-600 dark:text-slate-400">
			MSAL.js requires an <code>https://</code> authority — the local lab serves its IdP over HTTP, so the SPA
			login flow can't run here. The API works directly (try <code>make smoke</code>); to exercise the SPA
			login, point <code>VITE_TOKEN_TRACKER_AUTHORITY</code> at an HTTPS IdP.
		</p>
	{:else if pageState.kind === "forbidden"}
		<p class="mt-12 text-amber-600">{pageState.message}</p>
	{:else if pageState.kind === "error"}
		<p class="mt-12 text-rose-600">Error: {pageState.message}</p>
	{:else}
		{@const data = pageState.data}

		<!-- KPI cards -->
		<section class="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
			<article class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
				<p class="text-xs uppercase tracking-wide text-slate-500">Cost</p>
				<p class="mt-2 text-3xl font-semibold">{fmtUsd(data.usage.totals.costUsd)}</p>
			</article>
			<article class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
				<p class="text-xs uppercase tracking-wide text-slate-500">Turns</p>
				<p class="mt-2 text-3xl font-semibold">{fmtInt(data.usage.totals.turns)}</p>
			</article>
			<article class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
				<p class="text-xs uppercase tracking-wide text-slate-500">Tokens</p>
				<p class="mt-2 text-3xl font-semibold">{fmtInt(data.usage.totals.inputTokens + data.usage.totals.outputTokens)}</p>
				<p class="mt-1 text-xs text-slate-500">{fmtInt(data.usage.totals.inputTokens)} in / {fmtInt(data.usage.totals.outputTokens)} out</p>
			</article>
		</section>

		<!-- Charts row -->
		<section class="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
			<article class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 lg:col-span-2 dark:bg-slate-900 dark:ring-slate-800">
				<h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Daily cost</h2>
				{#if data.usage.byDay.length === 0}
					<p class="mt-12 text-center text-sm text-slate-500">No turns in this range yet.</p>
				{:else}
					<div class="mt-4">
						<CostTimeseries byDay={data.usage.byDay} />
					</div>
				{/if}
			</article>
			<article class="rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
				<h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Model mix</h2>
				{#if data.usage.byModel.length === 0}
					<p class="mt-12 text-center text-sm text-slate-500">No models in this range yet.</p>
				{:else}
					<div class="mt-4">
						<ModelMix byModel={data.usage.byModel} />
					</div>
				{/if}
			</article>
		</section>

		<!-- Sessions table -->
		<section class="mt-6 rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
			<h2 class="text-sm font-semibold text-slate-700 dark:text-slate-300">Recent sessions</h2>
			{#if data.sessions.length === 0}
				<p class="mt-6 text-sm text-slate-500">No sessions in this range yet.</p>
			{:else}
				<div class="mt-4 overflow-x-auto">
					<table class="w-full text-left text-sm">
						<thead class="text-xs uppercase tracking-wide text-slate-500">
							<tr>
								<th class="py-2 pr-4">Started</th>
								<th class="py-2 pr-4">Duration</th>
								<th class="py-2 pr-4">Turns</th>
								<th class="py-2 pr-4">Cost</th>
								<th class="py-2">Models</th>
							</tr>
						</thead>
						<tbody class="divide-y divide-slate-100 dark:divide-slate-800">
							{#each data.sessions as s (s.sessionId)}
								<tr>
									<td class="py-2 pr-4 font-mono text-xs">{fmtDateTime(s.firstTs)}</td>
									<td class="py-2 pr-4">{fmtDuration(s.firstTs, s.lastTs)}</td>
									<td class="py-2 pr-4">{fmtInt(s.turns)}</td>
									<td class="py-2 pr-4">{fmtUsd(s.costUsd)}</td>
									<td class="py-2">
										<div class="flex flex-wrap gap-1">
											{#each s.models as m (m)}
												<span class="rounded bg-slate-100 px-1.5 py-0.5 text-xs dark:bg-slate-800">{m}</span>
											{/each}
										</div>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</section>
	{/if}
</main>
