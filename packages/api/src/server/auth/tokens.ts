/**
 * Token-hash helper. SHA-256 hex of the JWT, used as the lookup key in
 * the `api_tokens` table. Matches the partial unique index on
 * api_tokens(token_hash) WHERE revoked_at IS NULL.
 *
 * D14 explains why SHA-256 (deterministic, O(1) lookup) and not bcrypt:
 * tokens are high-entropy random JWTs; bcrypt's slowness only adds CPU
 * cost on the request path while making lookup-by-hash impossible.
 */

import { createHash } from "node:crypto";

export function sha256Hex(input: string): string {
	return createHash("sha256").update(input).digest("hex");
}
