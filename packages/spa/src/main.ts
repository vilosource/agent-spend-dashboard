/**
 * SPA mount point. Bootstraps MSAL (processes a redirect-back from the
 * IdP, recovers a silent SSO session if one exists) before mounting the
 * app, then picks the page component based on window.location.pathname;
 * v1 has just two routes (/ and /me) so a full client-side router is
 * overkill. Direct navigation between them does a full page reload —
 * fine for v1; revisit when more routes land.
 */

import { mount } from "svelte";
import App from "./App.svelte";
import { initializeAuth } from "./lib/auth.js";
import "./app.css";

const target = document.getElementById("app");
if (!target) throw new Error("missing #app mount point");

await initializeAuth();
mount(App, { target });
