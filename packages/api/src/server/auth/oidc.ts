/**
 * OIDC client setup.
 *
 * Discovery happens once at server boot, not per request. A failing
 * discovery is a fatal startup error so misconfigured deployments fail
 * loud rather than silently 500-ing every request.
 *
 * openid-client v6 enforces HTTPS for the issuer by default. The lab
 * uses Dex over plain HTTP (`http://idp.localhost:7019`); we relax that
 * check only when the configured issuer is `http://`. Production
 * deployments must use `https://` and the relaxation is a no-op.
 */

import * as client from "openid-client";
import type { OidcConfig } from "../config.js";

export type OidcContext = client.Configuration;

export async function configureOidc(cfg: OidcConfig): Promise<OidcContext> {
	const issuerUrl = new URL(cfg.issuerUrl);
	const isHttp = issuerUrl.protocol === "http:";
	return client.discovery(issuerUrl, cfg.clientId, cfg.clientSecret, undefined, {
		execute: isHttp ? [client.allowInsecureRequests] : [],
	});
}
