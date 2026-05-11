/**
 * SPA-side auth via MSAL.js (PKCE redirect flow).
 *
 * Per token-tracker-redesign-DESIGN.md §4.2 / D3:
 *   - the SPA obtains an IdP access token; the server (a pure resource
 *     server) only ever verifies it.
 *   - the access token lives in memory only — `cacheLocation:
 *     "memoryStorage"`. On tab refresh it's lost; `ssoSilent` (a hidden
 *     iframe to the IdP authorize endpoint) recovers a fresh one within
 *     ~200ms if the user still has an IdP session, otherwise the user
 *     sees the sign-in CTA and clicks through a redirect. Never
 *     localStorage, never sessionStorage for the token. (MSAL's
 *     *temporary* cache — the few-second PKCE state during a redirect —
 *     defaults to sessionStorage and must, or the redirect handshake
 *     can't complete; that's transient request state, not the token.)
 *
 * Config is build-time, via Vite env vars (the SPA bundle is baked into
 * the API image at build time, so the deploying org sets these when it
 * builds the image):
 *   VITE_TOKEN_TRACKER_AUTHORITY    e.g. https://login.microsoftonline.com/<tenant>
 *   VITE_TOKEN_TRACKER_CLIENT_ID    the SPA app registration's client id
 *   VITE_TOKEN_TRACKER_API_SCOPE    the scope that yields an access token whose `aud`
 *                                   is the API's client id, e.g. api://<api-client-id>/access_as_user
 *   VITE_TOKEN_TRACKER_REDIRECT_URI optional; defaults to window.location.origin
 *
 * When these are unset (the public reference repo, or a lab without an
 * IdP wired up yet) `isAuthConfigured` is false and the pages render a
 * "not configured" state instead of attempting a broken login.
 */

import {
	type AccountInfo,
	BrowserCacheLocation,
	InteractionRequiredAuthError,
	PublicClientApplication,
} from "@azure/msal-browser";

const CLIENT_ID = import.meta.env.VITE_TOKEN_TRACKER_CLIENT_ID ?? "";
const AUTHORITY = import.meta.env.VITE_TOKEN_TRACKER_AUTHORITY ?? "";
const API_SCOPE = import.meta.env.VITE_TOKEN_TRACKER_API_SCOPE ?? "";
const REDIRECT_URI =
	import.meta.env.VITE_TOKEN_TRACKER_REDIRECT_URI ?? (typeof window !== "undefined" ? window.location.origin : "");

export const isAuthConfigured = CLIENT_ID !== "" && AUTHORITY !== "" && API_SCOPE !== "";

const SCOPES = [API_SCOPE];

const msal = new PublicClientApplication({
	auth: { clientId: CLIENT_ID, authority: AUTHORITY, redirectUri: REDIRECT_URI },
	cache: { cacheLocation: BrowserCacheLocation.MemoryStorage },
});

let initialized = false;

/** Call once at app bootstrap, before rendering. No-op if auth isn't configured. */
export async function initializeAuth(): Promise<void> {
	if (!isAuthConfigured || initialized) return;
	await msal.initialize();
	const redirectResult = await msal.handleRedirectPromise();
	if (redirectResult?.account) {
		msal.setActiveAccount(redirectResult.account);
	} else if (!msal.getActiveAccount()) {
		const existing = msal.getAllAccounts()[0];
		if (existing) {
			msal.setActiveAccount(existing);
		} else {
			// Best-effort silent SSO via the IdP session cookie; tolerate failure
			// (the user just sees the sign-in CTA).
			try {
				const result = await msal.ssoSilent({ scopes: SCOPES });
				if (result.account) msal.setActiveAccount(result.account);
			} catch {
				/* no IdP session yet */
			}
		}
	}
	initialized = true;
}

export function getActiveAccount(): AccountInfo | null {
	return msal.getActiveAccount();
}

/** Begin the login redirect. Navigates away. */
export function login(): void {
	void msal.loginRedirect({ scopes: SCOPES });
}

/** Begin the logout redirect (clears MSAL state, hits the IdP end-session endpoint). Navigates away. */
export function logout(): void {
	void msal.logoutRedirect();
}

/**
 * Returns a bearer access token for the API. If the cached token is
 * still valid it's returned immediately; if it's expired MSAL refreshes
 * it via a hidden iframe; if interaction is required the browser is
 * redirected to the IdP and the returned promise never resolves (the
 * page navigates away).
 */
export async function getAccessToken(): Promise<string> {
	const account = msal.getActiveAccount();
	if (!account) {
		login();
		return await never();
	}
	try {
		const result = await msal.acquireTokenSilent({ scopes: SCOPES, account });
		return result.accessToken;
	} catch (err) {
		if (err instanceof InteractionRequiredAuthError) {
			void msal.acquireTokenRedirect({ scopes: SCOPES, account });
			return await never();
		}
		throw err;
	}
}

/** A promise that never settles — used when the browser is mid-redirect. */
function never(): Promise<never> {
	return new Promise<never>(() => {});
}
