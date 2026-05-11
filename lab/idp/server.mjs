#!/usr/bin/env node
/**
 * Minimal lab OIDC IdP — replaces the old Dex deployment.
 *
 * The token-tracker server is a pure OAuth 2.0 resource server: it verifies
 * the IdP-issued access token (signature against the published JWKs; `iss`,
 * `aud`, `exp`, `nbf`) and reads a `roles` claim to map to admin/user/viewer
 * (token-tracker-redesign-DESIGN.md §4). Dex's static-password connector can't
 * emit app-role claims, so the lab uses this tiny purpose-built IdP instead.
 * It issues exactly the token shape the API verifies, supports the SPA's MSAL
 * PKCE redirect flow and a device flow (for the eventual CLI), plus a non-spec
 * `POST /lab/token` shortcut for non-browser lab clients (the scenario harness).
 *
 * Zero npm deps — `node:crypto` signs the RS256 JWTs. Lab only: every value
 * here is bound to localhost, nothing is a real secret.
 *
 * Config (env): ISSUER (required, e.g. http://idp.localhost:7019),
 *               API_AUDIENCE (the `aud` stamped on access tokens; default
 *               token-tracker-api — must equal the API's TOKEN_TRACKER_OIDC_CLIENT_ID),
 *               PORT (default 5556).
 */

import { createHash, createSign, generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { URL, URLSearchParams } from "node:url";

const ISSUER = (process.env.ISSUER || "http://localhost:5556").replace(/\/+$/, "");
const API_AUDIENCE = process.env.API_AUDIENCE || "token-tracker-api";
const PORT = Number.parseInt(process.env.PORT || "5556", 10);
const KID = "lab-idp-1";
const ACCESS_TOKEN_TTL = 3600;
const ID_TOKEN_TTL = 3600;
const CODE_TTL = 300;
const DEVICE_CODE_TTL = 600;

// --- signing key (in-memory; regenerated on every restart) ---
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256", use: "sig" };

// --- lab users ---
const USERS = [
	{ sub: "00000000-0000-0000-0000-000000000001", email: "lab-admin@example.invalid", name: "Lab Admin", roles: ["TokenTracker.Admin"] },
	{ sub: "00000000-0000-0000-0000-000000000002", email: "lab-user@example.invalid", name: "Lab User", roles: ["TokenTracker.User"] },
	{ sub: "00000000-0000-0000-0000-000000000003", email: "lab-viewer@example.invalid", name: "Lab Viewer", roles: ["TokenTracker.Viewer"] },
];
function findUser(emailOrRole) {
	if (!emailOrRole) return null;
	const byEmail = USERS.find((u) => u.email === emailOrRole);
	if (byEmail) return byEmail;
	const role = `TokenTracker.${emailOrRole[0].toUpperCase()}${emailOrRole.slice(1).toLowerCase()}`;
	return USERS.find((u) => u.roles.includes(role)) ?? null;
}

// --- transient stores ---
const authCodes = new Map(); // code -> { user, codeChallenge, redirectUri, state, nonce, scope, clientId, exp }
const refreshTokens = new Map(); // refreshToken -> { user, scope, clientId }
const deviceCodes = new Map(); // deviceCode -> { userCode, user|null, scope, clientId, exp }

// --- helpers ---
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const now = () => Math.floor(Date.now() / 1000);

function signJwt(payload) {
	const header = { alg: "RS256", kid: KID, typ: "JWT" };
	const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
	const sig = createSign("RSA-SHA256").update(signingInput).end().sign(privateKey);
	return `${signingInput}.${b64url(sig)}`;
}

function accessToken(user, clientId, scope) {
	const iat = now();
	return signJwt({
		iss: ISSUER,
		aud: API_AUDIENCE,
		sub: user.sub,
		oid: user.sub,
		iat,
		nbf: iat,
		exp: iat + ACCESS_TOKEN_TTL,
		azp: clientId,
		scope: scope || "openid profile email",
		name: user.name,
		preferred_username: user.email,
		email: user.email,
		roles: user.roles,
		ver: "1.0",
	});
}

function idToken(user, clientId, nonce, atForHash) {
	const iat = now();
	const payload = {
		iss: ISSUER,
		aud: clientId,
		sub: user.sub,
		oid: user.sub,
		iat,
		exp: iat + ID_TOKEN_TTL,
		name: user.name,
		preferred_username: user.email,
		email: user.email,
		roles: user.roles,
		ver: "1.0",
	};
	if (nonce) payload.nonce = nonce;
	if (atForHash) payload.at_hash = b64url(createHash("sha256").update(atForHash).digest().subarray(0, 16));
	return signJwt(payload);
}

function issueTokens(user, clientId, scope, nonce) {
	const at = accessToken(user, clientId, scope);
	const rt = randomBytes(32).toString("base64url");
	refreshTokens.set(rt, { user, scope, clientId });
	return {
		token_type: "Bearer",
		expires_in: ACCESS_TOKEN_TTL,
		scope: scope || "openid profile email",
		access_token: at,
		id_token: idToken(user, clientId, nonce, at),
		refresh_token: rt,
	};
}

// --- HTTP plumbing ---
const sendJson = (res, status, obj) => {
	const body = JSON.stringify(obj);
	res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(body) });
	res.end(body);
};
const sendHtml = (res, status, html) => {
	res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
	res.end(html);
};
const redirect = (res, location) => {
	res.writeHead(302, { location });
	res.end();
};
const readBody = (req) =>
	new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => {
			data += c;
		});
		req.on("end", () => resolve(data));
	});
function userPickerHtml(title, hrefFor) {
	const items = USERS.map((u) => `<li><a href="${hrefFor(u)}">${u.name} — <code>${u.email}</code> — <code>${u.roles[0]}</code></a></li>`).join("\n");
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title} — lab IdP</title>
<style>body{font-family:system-ui,sans-serif;max-width:34em;margin:4em auto;padding:0 1em}li{margin:.6em 0}a{text-decoration:none}code{background:#f1f5f9;padding:.1em .3em;border-radius:3px}</style></head>
<body><h1>${title}</h1><p>Pick a lab identity:</p><ul>${items}</ul>
<p style="color:#64748b;font-size:.9em">This is the local lab IdP. No passwords — every identity here is a hardcoded placeholder.</p></body></html>`;
}

const ENDPOINTS = {
	authorization_endpoint: `${ISSUER}/authorize`,
	token_endpoint: `${ISSUER}/token`,
	device_authorization_endpoint: `${ISSUER}/device_authorization`,
};

createServer(async (req, res) => {
	try {
		const url = new URL(req.url || "/", ISSUER);
		const path = url.pathname;
		const method = req.method || "GET";

		if (path === "/.well-known/openid-configuration") {
			return sendJson(res, 200, {
				issuer: ISSUER,
				...ENDPOINTS,
				// Host-relative so each caller gets a JWKs URL it can actually reach:
				// the browser fetches the discovery doc via the host port mapping
				// (Host: localhost:7019), the resource server via compose DNS
				// (Host: idp:5556) — both then fetch /jwks at the host they used.
				jwks_uri: `http://${req.headers.host || ISSUER.replace(/^https?:\/\//, "")}/jwks`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:device_code"],
				subject_types_supported: ["public"],
				id_token_signing_alg_values_supported: ["RS256"],
				token_endpoint_auth_methods_supported: ["none"],
				code_challenge_methods_supported: ["S256"],
				scopes_supported: ["openid", "profile", "email", "offline_access"],
				claims_supported: ["sub", "iss", "aud", "exp", "iat", "nbf", "name", "preferred_username", "email", "oid", "roles"],
			});
		}

		if (path === "/jwks") return sendJson(res, 200, { keys: [publicJwk] });
		if (path === "/healthz") return sendHtml(res, 200, "ok");

		// --- authorization endpoint (auth-code + PKCE) ---
		if (path === "/authorize" && method === "GET") {
			const q = url.searchParams;
			const redirectUri = q.get("redirect_uri");
			const state = q.get("state");
			if (!redirectUri) return sendHtml(res, 400, "missing redirect_uri");
			const codeChallenge = q.get("code_challenge");
			if (codeChallenge && q.get("code_challenge_method") !== "S256") return sendHtml(res, 400, "only code_challenge_method=S256 is supported");
			const login = q.get("login");
			if (!login) {
				return sendHtml(res, 200, userPickerHtml("Sign in", (u) => {
					const next = new URLSearchParams(q);
					next.set("login", u.email);
					return `?${next.toString()}`;
				}));
			}
			const user = findUser(login);
			if (!user) return sendHtml(res, 400, `unknown lab user: ${login}`);
			const code = randomBytes(24).toString("base64url");
			authCodes.set(code, { user, codeChallenge, redirectUri, state, nonce: q.get("nonce"), scope: q.get("scope"), clientId: q.get("client_id"), exp: now() + CODE_TTL });
			const back = new URL(redirectUri);
			back.searchParams.set("code", code);
			if (state) back.searchParams.set("state", state);
			return redirect(res, back.toString());
		}

		// --- token endpoint ---
		if (path === "/token" && method === "POST") {
			const params = new URLSearchParams(await readBody(req));
			const grant = params.get("grant_type");

			if (grant === "authorization_code") {
				const code = params.get("code");
				const entry = code ? authCodes.get(code) : null;
				if (!entry || entry.exp < now()) return sendJson(res, 400, { error: "invalid_grant", error_description: "unknown or expired code" });
				authCodes.delete(code);
				if (entry.redirectUri !== params.get("redirect_uri")) return sendJson(res, 400, { error: "invalid_grant", error_description: "redirect_uri mismatch" });
				if (entry.codeChallenge) {
					const verifier = params.get("code_verifier") || "";
					const challenge = b64url(createHash("sha256").update(verifier).digest());
					if (challenge !== entry.codeChallenge) return sendJson(res, 400, { error: "invalid_grant", error_description: "PKCE verification failed" });
				}
				return sendJson(res, 200, issueTokens(entry.user, entry.clientId, entry.scope, entry.nonce));
			}

			if (grant === "refresh_token") {
				const rt = params.get("refresh_token");
				const entry = rt ? refreshTokens.get(rt) : null;
				if (!entry) return sendJson(res, 400, { error: "invalid_grant", error_description: "unknown refresh_token" });
				refreshTokens.delete(rt); // rotate
				return sendJson(res, 200, issueTokens(entry.user, entry.clientId, entry.scope, null));
			}

			if (grant === "urn:ietf:params:oauth:grant-type:device_code") {
				const dc = params.get("device_code");
				const entry = dc ? deviceCodes.get(dc) : null;
				if (!entry || entry.exp < now()) return sendJson(res, 400, { error: "expired_token" });
				if (!entry.user) return sendJson(res, 400, { error: "authorization_pending" });
				deviceCodes.delete(dc);
				return sendJson(res, 200, issueTokens(entry.user, entry.clientId, entry.scope, null));
			}

			return sendJson(res, 400, { error: "unsupported_grant_type" });
		}

		// --- device flow ---
		if (path === "/device_authorization" && method === "POST") {
			const params = new URLSearchParams(await readBody(req));
			const deviceCode = randomBytes(24).toString("base64url");
			const userCode = `${randomBytes(2).toString("hex")}-${randomBytes(2).toString("hex")}`.toUpperCase();
			deviceCodes.set(deviceCode, { userCode, user: null, scope: params.get("scope"), clientId: params.get("client_id"), exp: now() + DEVICE_CODE_TTL });
			return sendJson(res, 200, {
				device_code: deviceCode,
				user_code: userCode,
				verification_uri: `${ISSUER}/device`,
				verification_uri_complete: `${ISSUER}/device?user_code=${userCode}`,
				expires_in: DEVICE_CODE_TTL,
				interval: 2,
			});
		}
		if (path === "/device" && method === "GET") {
			const q = url.searchParams;
			const userCode = q.get("user_code");
			const entry = [...deviceCodes.entries()].find(([, v]) => v.userCode === userCode);
			if (!entry) return sendHtml(res, 400, "unknown or expired user_code");
			const login = q.get("login");
			if (!login) {
				return sendHtml(res, 200, userPickerHtml(`Approve device — ${userCode}`, (u) => `?user_code=${encodeURIComponent(userCode)}&login=${encodeURIComponent(u.email)}`));
			}
			const user = findUser(login);
			if (!user) return sendHtml(res, 400, `unknown lab user: ${login}`);
			entry[1].user = user;
			return sendHtml(res, 200, `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;max-width:34em;margin:4em auto"><h1>Approved</h1><p>Device <code>${userCode}</code> is now signed in as <code>${user.email}</code>. You can close this tab and return to the CLI.</p></body>`);
		}

		// --- lab convenience: direct token (NON-SPEC, lab only) ---
		// `POST /lab/token` with form/query `user=lab-user@example.invalid` (or `role=admin|user|viewer`)
		// returns an access token directly — no flow. For the scenario harness and ad-hoc testing.
		if (path === "/lab/token") {
			const params = method === "POST" ? new URLSearchParams(await readBody(req)) : url.searchParams;
			const user = findUser(params.get("user") || params.get("role") || "");
			if (!user) return sendJson(res, 400, { error: "invalid_request", error_description: "pass ?user=<email> or ?role=admin|user|viewer" });
			return sendJson(res, 200, { token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL, access_token: accessToken(user, "lab-cli", "openid profile email") });
		}

		return sendHtml(res, 404, "not found");
	} catch (err) {
		sendJson(res, 500, { error: "server_error", error_description: String(err?.message ?? err) });
	}
}).listen(PORT, "0.0.0.0", () => {
	console.log(`lab IdP listening on :${PORT} — issuer ${ISSUER}, aud ${API_AUDIENCE}`);
});
