/**
 * SPA-side auth via MSAL.js (PKCE redirect flow).
 *
 * Per token-tracker-redesign-DESIGN.md §4.2 / D3:
 *   - the SPA obtains an IdP access token; the server (a pure resource
 *     server) only ever verifies it.
 *   - the token is cached in `sessionStorage`: gone when the tab closes,
 *     never written to disk, never shared across tabs — but it survives
 *     in-tab navigation and page reloads, which this app relies on (it
 *     routes `/` → `/me` with a full reload, and the IdP redirect-back
 *     is a reload too). The original D3 said memory-only; that proved
 *     non-functional — every navigation wipes an in-memory cache, and
 *     `ssoSilent` (the intended recovery path: a hidden iframe to the
 *     IdP) is blocked by modern browsers' third-party-cookie policies —
 *     so D3 was revised to `sessionStorage`. Still never `localStorage`.
 *     (`storeAuthStateInCookie` keeps the transient PKCE/state alive
 *     across the cross-origin redirect in partitioned-storage browsers;
 *     that's in-flight request state, not the token.)
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
	type AuthenticationResult,
	BrowserCacheLocation,
	InteractionRequiredAuthError,
	ProtocolMode,
	PublicClientApplication,
} from "@azure/msal-browser";

const CLIENT_ID = import.meta.env.VITE_TOKEN_TRACKER_CLIENT_ID ?? "";
const AUTHORITY = import.meta.env.VITE_TOKEN_TRACKER_AUTHORITY ?? "";
const API_SCOPE = import.meta.env.VITE_TOKEN_TRACKER_API_SCOPE ?? "";
const REDIRECT_URI =
	import.meta.env.VITE_TOKEN_TRACKER_REDIRECT_URI ?? (typeof window !== "undefined" ? window.location.origin : "");

export const isAuthConfigured = CLIENT_ID !== "" && AUTHORITY !== "" && API_SCOPE !== "";

/**
 * MSAL.js v4 requires an `https://` authority — there is no `localhost`
 * exception. The HTTP local-lab IdP therefore can't drive the browser login
 * flow; the pages show a note instead. (The API-side path — `/api/me`,
 * `/v1/traces`, token verification — works fine over HTTP; see `make smoke`.)
 * To exercise the SPA login locally, point VITE_TOKEN_TRACKER_AUTHORITY at an
 * HTTPS IdP (an Entra dev tenant, or the lab IdP behind a trusted-cert proxy).
 */
export const loginSupported = isAuthConfigured && /^https:\/\//i.test(AUTHORITY);

const SCOPES = [API_SCOPE];

const msal = new PublicClientApplication({
	auth: {
		clientId: CLIENT_ID,
		authority: AUTHORITY,
		redirectUri: REDIRECT_URI,
		// Treat the authority as a plain OIDC issuer (discover endpoints from
		// `<authority>/.well-known/openid-configuration`) rather than an Entra
		// tenant — works for any compliant OIDC IdP, including Entra v2.0 and the
		// local lab IdP. Also lets MSAL accept an `http://localhost` authority for
		// the lab; in AAD mode a non-Entra authority would need knownAuthorities.
		protocolMode: ProtocolMode.OIDC,
		// Don't navigate the page back to the login-request URL after the redirect
		// handshake. The redirect URI *is* the app entry point, so that navigation
		// would just reload the page (pointlessly, and — before we moved the cache
		// off memoryStorage — it threw away the token we'd just acquired). MSAL
		// processes the response and strips `?code=…`/`#code=…` from the URL in
		// place instead.
		navigateToLoginRequestUrl: false,
	},
	cache: {
		// Token cache in `sessionStorage`: cleared when the tab closes, never
		// written to disk, never shared across tabs — but it survives in-tab
		// navigation and page reloads, which this app does on every route change
		// (`/` → `/me`) and on the redirect-back from the IdP. (We tried
		// `memoryStorage` first, per the original D3 — see DESIGN §4.2 — but it's
		// non-functional here: every navigation wipes it, and the documented
		// recovery path, `ssoSilent`'s hidden IdP iframe, is blocked by modern
		// browsers' third-party-cookie policies.) `storeAuthStateInCookie` keeps
		// the transient PKCE/state surviving the cross-origin hop even in browsers
		// that partition storage; that cookie holds the in-flight request, not the
		// token, and MSAL clears it on return.
		cacheLocation: BrowserCacheLocation.SessionStorage,
		storeAuthStateInCookie: true,
	},
});

let initialized = false;

/** Call once at app bootstrap, before rendering. No-op if auth isn't configured. */
export async function initializeAuth(): Promise<void> {
	if (!isAuthConfigured || initialized) return;
	await msal.initialize();
	// handleRedirectPromise rejects if the IdP redirected back with an error
	// response (consent declined, a config mismatch, a stale/used code, …).
	// That must never crash the whole app — swallow it and fall through to the
	// sign-in CTA; the user can retry the login from a clean state.
	let redirectResult: AuthenticationResult | null = null;
	try {
		redirectResult = await msal.handleRedirectPromise();
	} catch (err) {
		console.warn("MSAL: handleRedirectPromise failed; treating as not-signed-in.", err);
	}
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
