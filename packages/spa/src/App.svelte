<script lang="ts">
import Home from "./pages/Home.svelte";
import Me from "./pages/Me.svelte";
import Prices from "./pages/Prices.svelte";

const path = window.location.pathname;
const page =
	path === "/prices" || path.startsWith("/prices/")
		? "prices"
		: path === "/me" || path.startsWith("/me/")
			? "me"
			: "home";
</script>

{#if page === "prices"}
	<Prices />
{:else if page === "me"}
	<Me />
{:else}
	<Home />
{/if}
