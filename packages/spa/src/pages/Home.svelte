<script lang="ts">
import { getActiveAccount, isAuthConfigured, login } from "../lib/auth.js";

// initializeAuth() ran in main.ts before mount, so by now MSAL has
// processed any redirect-back and attempted a silent SSO. If we have an
// account, the user is signed in — send them to their dashboard.
let status: "not-configured" | "redirecting" | "anonymous" = $state(
	!isAuthConfigured ? "not-configured" : getActiveAccount() ? "redirecting" : "anonymous",
);

$effect(() => {
	if (status === "redirecting") window.location.assign("/me");
});
</script>

<main class="mx-auto max-w-2xl px-6 py-16">
	<h1 class="text-3xl font-semibold tracking-tight">Token Tracker</h1>
	<p class="mt-2 text-slate-600 dark:text-slate-400">
		The reference dashboard server for tracking developer LLM spend across harnesses.
	</p>

	{#if status === "redirecting"}
		<p class="mt-12 text-slate-500">Taking you to your dashboard…</p>
	{:else if status === "not-configured"}
		<div class="mt-12 rounded-xl bg-white p-8 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
			<h2 class="text-xl font-semibold">Auth not configured</h2>
			<p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
				Set <code>VITE_TOKEN_TRACKER_AUTHORITY</code>, <code>VITE_TOKEN_TRACKER_CLIENT_ID</code> and
				<code>VITE_TOKEN_TRACKER_API_SCOPE</code> and rebuild the SPA. See
				<code>docs/design/token-tracker-redesign-DESIGN.md</code> §4.2.
			</p>
		</div>
	{:else}
		<div class="mt-12 rounded-xl bg-white p-8 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
			<h2 class="text-xl font-semibold">Sign in</h2>
			<p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
				Log in via your organization's identity provider.
			</p>
			<button
				type="button"
				onclick={login}
				class="mt-6 inline-flex items-center rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-sky-500"
			>
				Log in
			</button>
		</div>
	{/if}
</main>
