<script lang="ts">
import { getActiveAccount, isAuthConfigured, loginSupported } from "../lib/auth.js";
import {
	ForbiddenError,
	type PricesResponse,
	UnauthenticatedError,
	fetchPrices,
	fmtDateTime,
	fmtRate,
	logout,
	redirectToLogin,
} from "../lib/api.js";

type PageState =
	| { kind: "loading" }
	| { kind: "loaded"; data: PricesResponse }
	| { kind: "error"; message: string }
	| { kind: "forbidden"; message: string }
	| { kind: "not-configured" }
	| { kind: "login-unsupported" };

function initialState(): PageState {
	if (!isAuthConfigured) return { kind: "not-configured" };
	if (!loginSupported) return { kind: "login-unsupported" };
	return { kind: "loading" };
}

let pageState: PageState = $state(initialState());
let query = $state("");

async function load(): Promise<void> {
	if (!isAuthConfigured) {
		pageState = { kind: "not-configured" };
		return;
	}
	if (!loginSupported) {
		pageState = { kind: "login-unsupported" };
		return;
	}
	if (!getActiveAccount()) {
		redirectToLogin();
		return;
	}
	pageState = { kind: "loading" };
	try {
		pageState = { kind: "loaded", data: await fetchPrices() };
	} catch (err) {
		if (err instanceof UnauthenticatedError) {
			redirectToLogin();
			return;
		}
		if (err instanceof ForbiddenError) {
			pageState = { kind: "forbidden", message: err.message };
			return;
		}
		pageState = { kind: "error", message: err instanceof Error ? err.message : String(err) };
	}
}

const filtered = $derived(
	pageState.kind === "loaded"
		? pageState.data.items.filter((m) => m.model.toLowerCase().includes(query.trim().toLowerCase()))
		: [],
);

$effect(() => {
	void load();
});
</script>

<main class="mx-auto max-w-6xl px-6 py-10">
	<header class="flex items-baseline justify-between gap-6">
		<div>
			<h1 class="text-2xl font-semibold tracking-tight">Model Price Reference</h1>
			<p class="mt-1 text-sm text-slate-600 dark:text-slate-400">
				List prices in USD per 1,000,000 tokens.
				{#if pageState.kind === "loaded"}
					{#if pageState.data.updatedAt}
						· Last fetched <span class="font-medium">{fmtDateTime(pageState.data.updatedAt)}</span>
						· {pageState.data.count} models
					{/if}
				{/if}
			</p>
		</div>
		<nav class="flex items-center gap-3 text-sm">
			<a href="/me" class="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">My Usage</a>
			<button type="button" onclick={logout} class="rounded-md border border-slate-300 bg-white px-3 py-1.5 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:hover:bg-slate-800">
				Log out
			</button>
		</nav>
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
			login flow can't run here.
		</p>
	{:else if pageState.kind === "forbidden"}
		<p class="mt-12 text-amber-600">{pageState.message}</p>
	{:else if pageState.kind === "error"}
		<p class="mt-12 text-rose-600">Error: {pageState.message}</p>
	{:else}
		<div class="mt-8">
			<input
				type="search"
				bind:value={query}
				placeholder="Filter models — e.g. opus, gemini, gpt, glm"
				class="w-full max-w-md rounded-md border border-slate-300 bg-white px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
			/>
			<p class="mt-2 text-xs text-slate-500">Showing {filtered.length} of {pageState.data.count} · “—” = $0 (free or flat-rate subscription)</p>
		</div>

		<section class="mt-4 overflow-x-auto rounded-xl bg-white shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
			<table class="w-full text-left text-sm">
				<thead class="text-xs uppercase tracking-wide text-slate-500">
					<tr class="border-b border-slate-100 dark:border-slate-800">
						<th class="px-4 py-3">Model</th>
						<th class="px-4 py-3 text-right">Input</th>
						<th class="px-4 py-3 text-right">Output</th>
						<th class="px-4 py-3 text-right">Cache read</th>
						<th class="px-4 py-3 text-right">Cache write</th>
					</tr>
				</thead>
				<tbody class="divide-y divide-slate-100 dark:divide-slate-800">
					{#each filtered as m (m.model)}
						<tr>
							<td class="px-4 py-2 font-mono text-xs">{m.model}</td>
							<td class="px-4 py-2 text-right tabular-nums">{fmtRate(m.inputPerMtok)}</td>
							<td class="px-4 py-2 text-right tabular-nums">{fmtRate(m.outputPerMtok)}</td>
							<td class="px-4 py-2 text-right tabular-nums">{fmtRate(m.cacheReadPerMtok)}</td>
							<td class="px-4 py-2 text-right tabular-nums">{fmtRate(m.cacheWritePerMtok)}</td>
						</tr>
					{:else}
						<tr><td colspan="5" class="px-4 py-6 text-center text-slate-500">No models match “{query}”.</td></tr>
					{/each}
				</tbody>
			</table>
		</section>

		{#if pageState.data.items.length > 0}
			<p class="mt-4 text-xs text-slate-500">Source: {pageState.data.items[0].source}</p>
		{/if}
	{/if}
</main>
