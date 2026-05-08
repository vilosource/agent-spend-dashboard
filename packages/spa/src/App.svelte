<script lang="ts">
import Home from "./pages/Home.svelte";
import Me from "./pages/Me.svelte";

const path = window.location.pathname;
const page = path === "/me" || path.startsWith("/me/") ? "me" : "home";
</script>

{#if page === "me"}
	<Me />
{:else}
	<Home />
{/if}
