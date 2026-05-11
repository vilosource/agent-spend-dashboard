/**
 * Tests for the IdP access-token verifier. No Dex, no testcontainers:
 * we generate an RSA keypair locally, stand up a throwaway HTTP server
 * that serves an OIDC discovery doc + a JWKs set, and verify
 * locally-signed tokens through `createVerifier`. That covers the
 * happy path plus the rejection branches the redesign exists to
 * guarantee (forged signature, wrong audience, wrong issuer, expired,
 * malformed, IdP unreachable).
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, type KeyLike, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createVerifier, type Verifier } from "./idp.js";

const CLIENT_ID = "token-tracker-api";
const KID = "test-key-1";

interface IdpFixture {
	issuer: string;
	server: Server;
	privateKey: KeyLike;
	publicJwk: JWK;
}

let idp: IdpFixture;
let verifier: Verifier;

beforeAll(async () => {
	idp = await startIdp();
	verifier = createVerifier({ issuerUrl: idp.issuer, clientId: CLIENT_ID });
});

afterAll(async () => {
	await new Promise<void>((resolve) => idp.server.close(() => resolve()));
});

describe("createVerifier — happy path", () => {
	it("verifies a well-formed access token and extracts identity + roles", async () => {
		const token = await mintToken({
			sub: "00000000-0000-0000-0000-000000000001",
			preferred_username: "Alice@Example.Invalid",
			name: "Alice",
			oid: "00000000-0000-0000-0000-000000000001",
			roles: ["TokenTracker.User"],
		});
		const claims = await verifier.verifyAccessToken(token);
		expect(claims).toEqual({
			email: "alice@example.invalid",
			oid: "00000000-0000-0000-0000-000000000001",
			name: "Alice",
			roles: ["TokenTracker.User"],
		});
	});

	it("prefers upn over preferred_username over email", async () => {
		const token = await mintToken({
			sub: "u",
			upn: "upn@example.invalid",
			preferred_username: "pu@example.invalid",
			email: "em@example.invalid",
			roles: [],
		});
		expect((await verifier.verifyAccessToken(token)).email).toBe("upn@example.invalid");
	});

	it("returns roles: [] and oid: null / name: null when those claims are absent", async () => {
		const token = await mintToken({ sub: "u", email: "bob@example.invalid" });
		const claims = await verifier.verifyAccessToken(token);
		expect(claims.roles).toEqual([]);
		expect(claims.oid).toBeNull();
		expect(claims.name).toBeNull();
	});

	it("accepts the api://<client-id> audience form", async () => {
		const token = await mintToken({ sub: "u", email: "c@example.invalid" }, { audience: `api://${CLIENT_ID}` });
		await expect(verifier.verifyAccessToken(token)).resolves.toMatchObject({ email: "c@example.invalid" });
	});
});

describe("createVerifier — rejections (AuthError 'invalid')", () => {
	it("rejects a token signed by a different key (forgery)", async () => {
		const { privateKey: otherKey } = await generateKeyPair("RS256", { extractable: true });
		const forged = await new SignJWT({ email: "evil@example.invalid", roles: ["TokenTracker.Admin"] })
			.setProtectedHeader({ alg: "RS256", kid: KID })
			.setIssuer(idp.issuer)
			.setAudience(CLIENT_ID)
			.setSubject("evil")
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(otherKey);
		await expect(verifier.verifyAccessToken(forged)).rejects.toMatchObject({
			name: "AuthError",
			kind: "invalid",
		});
	});

	it("rejects a token with the wrong audience", async () => {
		const token = await mintToken({ sub: "u", email: "a@example.invalid" }, { audience: "some-other-app" });
		await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects a token with the wrong issuer", async () => {
		const token = await mintToken(
			{ sub: "u", email: "a@example.invalid" },
			{ issuer: "https://evil.example.invalid" },
		);
		await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects an expired token", async () => {
		const expiredAtEpoch = Math.floor(Date.now() / 1000) - 60;
		const token = await mintToken(
			{ sub: "u", email: "a@example.invalid" },
			{ expiresAt: expiredAtEpoch, issuedAt: -600 },
		);
		await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects a token with no usable email/upn/preferred_username claim", async () => {
		const token = await mintToken({ sub: "u", roles: ["TokenTracker.User"] });
		await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects a structurally malformed token", async () => {
		await expect(verifier.verifyAccessToken("not-a-jwt")).rejects.toMatchObject({ kind: "invalid" });
	});

	it("rejects an HS256 token (alg not in the allow-list)", async () => {
		const hs = await new SignJWT({ email: "a@example.invalid" })
			.setProtectedHeader({ alg: "HS256" })
			.setIssuer(idp.issuer)
			.setAudience(CLIENT_ID)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(new TextEncoder().encode("a-shared-secret-that-should-never-work"));
		await expect(verifier.verifyAccessToken(hs)).rejects.toMatchObject({ kind: "invalid" });
	});
});

describe("createVerifier — IdP unreachable (AuthError 'unavailable')", () => {
	it("surfaces a discovery failure as 'unavailable' and stays retryable", async () => {
		// Point at a port nothing is listening on.
		const down = createVerifier({ issuerUrl: "http://127.0.0.1:1", clientId: CLIENT_ID });
		await expect(down.verifyAccessToken("whatever")).rejects.toMatchObject({
			name: "AuthError",
			kind: "unavailable",
		});
		// A second call retries discovery (still down) — also "unavailable", not a stuck rejected promise.
		await expect(down.verifyAccessToken("whatever")).rejects.toMatchObject({ kind: "unavailable" });
	});
});

// ---------------------------------------------------------------------------
// local IdP fixture
// ---------------------------------------------------------------------------

async function startIdp(): Promise<IdpFixture> {
	const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
	const publicJwk = await exportJWK(publicKey);
	publicJwk.kid = KID;
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";

	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		if (url.startsWith("/.well-known/openid-configuration")) {
			const issuer = `http://127.0.0.1:${port()}`;
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ issuer, jwks_uri: `${issuer}/jwks`, token_endpoint: `${issuer}/token` }));
			return;
		}
		if (url.startsWith("/jwks")) {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ keys: [publicJwk] }));
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	function port(): number {
		return (server.address() as AddressInfo).port;
	}
	return { issuer: `http://127.0.0.1:${port()}`, server, privateKey, publicJwk };
}

interface MintClaims {
	sub: string;
	upn?: string;
	preferred_username?: string;
	email?: string;
	name?: string;
	oid?: string;
	roles?: string[];
}

interface MintOpts {
	issuer?: string;
	audience?: string;
	expiresAt?: string | number; // jose-style relative string or an absolute epoch-seconds number
	issuedAt?: number; // seconds offset from now; defaults to "now"
}

async function mintToken(claims: MintClaims, opts: MintOpts = {}): Promise<string> {
	const { sub, ...rest } = claims;
	const builder = new SignJWT({ ...rest })
		.setProtectedHeader({ alg: "RS256", kid: KID })
		.setIssuer(opts.issuer ?? idp.issuer)
		.setAudience(opts.audience ?? CLIENT_ID)
		.setSubject(sub)
		.setExpirationTime(opts.expiresAt ?? "5m");
	if (opts.issuedAt !== undefined) {
		builder.setIssuedAt(Math.floor(Date.now() / 1000) + opts.issuedAt);
	} else {
		builder.setIssuedAt();
	}
	return await builder.sign(idp.privateKey);
}
