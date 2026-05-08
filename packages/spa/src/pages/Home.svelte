<script lang="ts">
import { fetchMe, redirectToLogin, UnauthenticatedError } from "../lib/api.js";

let status: "checking" | "anonymous" | "redirecting-to-me" | "error" = $state("checking");
let errorMessage = $state("");

$effect(() => {
	void (async () => {
		try {
			await fetchMe();
			status = "redirecting-to-me";
			window.location.assign("/me");
		} catch (err) {
			if (err instanceof UnauthenticatedError) {
				status = "anonymous";
				return;
			}
			errorMessage = err instanceof Error ? err.message : String(err);
			status = "error";
		}
	})();
});
</script>

<main class="mx-auto max-w-2xl px-6 py-16">
	<h1 class="text-3xl font-semibold tracking-tight">Agent Spend</h1>
	<p class="mt-2 text-slate-600 dark:text-slate-400">
		The reference dashboard server for tracking developer LLM spend across harnesses.
	</p>

	{#if status === "checking" || status === "redirecting-to-me"}
		<p class="mt-12 text-slate-500">Checking session…</p>
	{:else if status === "anonymous"}
		<div class="mt-12 rounded-xl bg-white p-8 shadow-sm ring-1 ring-slate-200 dark:bg-slate-900 dark:ring-slate-800">
			<h2 class="text-xl font-semibold">Sign in</h2>
			<p class="mt-2 text-sm text-slate-600 dark:text-slate-400">
				Log in via your organization's identity provider. The lab uses Dex; production deployments swap in Entra,
				Google, Okta, or any OIDC-compliant IdP.
			</p>
			<button
				type="button"
				onclick={redirectToLogin}
				class="mt-6 inline-flex items-center rounded-lg bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-sky-500"
			>
				Log in
			</button>
		</div>
	{:else if status === "error"}
		<p class="mt-12 text-rose-600">Error: {errorMessage}</p>
	{/if}
</main>
