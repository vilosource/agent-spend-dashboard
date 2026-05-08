/**
 * Auth route handlers — phase 0.3.3.
 *
 * Three endpoints:
 *   GET  /auth/login     start the OIDC flow (PKCE + state + nonce)
 *   GET  /auth/callback  validate, upsert user, mint session cookie
 *   POST /auth/logout    clear session cookie
 *
 * The handlers are factory-built so the app can pass in deps (oidc
 * config, db, jwtSecret, publicUrl) without globals — keeping
 * createApp(deps) the single composition root.
 *
 * Per design §4.3 / authentication-STRATEGY.md §9: the first
 * authenticated user becomes role=admin; subsequent users default to
 * role=developer.
 */

import { type Request, type Response, Router } from "express";
import * as client from "openid-client";
import type { Db, UserRole } from "../db.js";
import type { OidcContext } from "./oidc.js";
import {
	clearFlowCookie,
	clearSession,
	type FlowState,
	issueSession,
	readFlowCookie,
	setFlowCookie,
} from "./session.js";

export interface AuthRouteDeps {
	readonly oidc: OidcContext;
	readonly db: Db;
	readonly jwtSecret: string;
	readonly publicUrl: string;
}

export function authRoutes(deps: AuthRouteDeps): Router {
	const router = Router();
	const redirectUri = `${deps.publicUrl}/auth/callback`;

	router.get("/login", async (req, res) => {
		try {
			await handleLogin(req, res, deps, redirectUri);
		} catch (err) {
			respondError(res, 500, err);
		}
	});

	router.get("/callback", async (req, res) => {
		try {
			await handleCallback(req, res, deps, redirectUri);
		} catch (err) {
			respondError(res, 500, err);
		}
	});

	router.post("/logout", (_req, res) => {
		clearSession(res);
		res.status(204).end();
	});

	return router;
}

async function handleLogin(req: Request, res: Response, deps: AuthRouteDeps, redirectUri: string): Promise<void> {
	const codeVerifier = client.randomPKCECodeVerifier();
	const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
	const state = client.randomState();
	const nonce = client.randomNonce();

	const returnTo = sanitizeReturnTo(typeof req.query["return_to"] === "string" ? req.query["return_to"] : "/");

	const flow: FlowState = { state, codeVerifier, nonce, returnTo };
	setFlowCookie(res, flow);

	const url = client.buildAuthorizationUrl(deps.oidc, {
		redirect_uri: redirectUri,
		scope: "openid email profile",
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		state,
		nonce,
	});

	res.redirect(url.href);
}

async function handleCallback(req: Request, res: Response, deps: AuthRouteDeps, redirectUri: string): Promise<void> {
	const flow = readFlowCookie(req);
	if (!flow) {
		res.status(400).type("text/plain").send("missing or invalid flow cookie");
		return;
	}

	// Reconstruct the URL openid-client should validate against. Express
	// gives us a path+query under req.originalUrl; combine with the
	// configured publicUrl host so the URL matches the redirect_uri.
	const currentUrl = new URL(redirectUri);
	const incoming = new URL(req.originalUrl, currentUrl);
	for (const [k, v] of incoming.searchParams) {
		currentUrl.searchParams.set(k, v);
	}

	const tokens = await client.authorizationCodeGrant(deps.oidc, currentUrl, {
		pkceCodeVerifier: flow.codeVerifier,
		expectedState: flow.state,
		expectedNonce: flow.nonce,
	});

	const claims = tokens.claims();
	if (!claims) {
		res.status(400).type("text/plain").send("missing id_token claims");
		return;
	}
	const sub = claims.sub;
	const email = typeof claims["email"] === "string" ? claims["email"].toLowerCase() : null;
	const name = typeof claims["name"] === "string" ? claims["name"] : null;
	if (!email) {
		res.status(400).type("text/plain").send("id_token missing email claim");
		return;
	}

	// First-user-becomes-admin bootstrap (design §4.3, strategy §9).
	const existing = await deps.db.findUserByEmail(email);
	let role: UserRole;
	if (existing) {
		role = existing.role;
	} else {
		const userCount = await deps.db.countUsers();
		role = userCount === 0 ? "admin" : "developer";
		await deps.db.insertUser({ email, name, role });
	}

	await issueSession(res, deps.jwtSecret, { sub, email, name, role });
	clearFlowCookie(res);

	res.redirect(flow.returnTo);
}

/** Reject open-redirects: only allow same-origin paths starting with `/`. */
function sanitizeReturnTo(input: string): string {
	if (input.startsWith("/") && !input.startsWith("//")) return input;
	return "/";
}

function respondError(res: Response, status: number, err: unknown): void {
	const msg = err instanceof Error ? err.message : String(err);
	res.status(status).type("text/plain").send(msg);
}
