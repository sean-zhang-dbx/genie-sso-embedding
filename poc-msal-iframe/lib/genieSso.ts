// -----------------------------------------------------------------------------
// genieSso — the server-side Databricks cookie-mint logic, ported natively into
// the customer's Next.js stack from the Python `genie_sso` library.
//
// This is SERVER-ONLY (uses node:crypto and the Databricks client secret). It is
// imported exclusively by the route handlers under app/api/*. Never import it
// into a Client Component ('use client') — the secret must not reach the browser.
//
// It reproduces the Python library's flow exactly:
//   /api/dbx-login  ->  workspace /aad/auth?next_url=b64(/oidc/v1/authorize?...)
//                       -> Entra (silent; MSAL already signed the user in)
//                       -> workspace session cookie planted as a side effect
//                       -> /oidc/v1/authorize issues a code
//                   ->  /api/callback2 (exchange at /oidc/v1/token, SCIM /Me)
//
// Difference from the Python version (deliberate, an improvement for Azure):
//   PKCE verifiers are carried in a short-lived signed httpOnly cookie rather
//   than an in-process dict — so this works across multiple server instances,
//   removing the single-worker constraint.
// -----------------------------------------------------------------------------

import crypto from "node:crypto"

export interface GenieSsoConfig {
  wsHost: string        // no scheme, e.g. adb-984752964297111.11.azuredatabricks.net
  orgId: string         // the ?o= value
  spaceId: string       // the Genie space id
  clientId: string      // Databricks custom OAuth app client id
  clientSecret: string  // Databricks custom OAuth app secret (SERVER ONLY)
  redirectUri: string   // must match the OAuth integration's redirect URL
  sessionSecret: string // HMAC key for signing our session + PKCE cookies
  scheme: string        // "https" in prod; "http" only for local testing
}

export const COOKIE_SESSION = "dbx_session"
export const COOKIE_PKCE = "dbx_pkce"
export const SESSION_MAX_AGE_SEC = 8 * 3600
export const PKCE_MAX_AGE_SEC = 600

/** Load config from env. Genie target reuses the NEXT_PUBLIC_GENIE_* vars the
 *  SPA already sets; the OAuth client id/secret are server-only. */
export function loadConfig(): GenieSsoConfig {
  return {
    wsHost: process.env.DBX_WS_HOST || process.env.NEXT_PUBLIC_GENIE_WS_HOST || "",
    orgId: process.env.DBX_ORG_ID || process.env.NEXT_PUBLIC_GENIE_ORG_ID || "",
    spaceId: process.env.DBX_SPACE_ID || process.env.NEXT_PUBLIC_GENIE_SPACE_ID || "",
    clientId: process.env.DBX_CLIENT_ID || "",
    clientSecret: process.env.DBX_CLIENT_SECRET || "",
    redirectUri: process.env.DBX_REDIRECT_URI || "",
    sessionSecret: process.env.SESSION_SECRET || "dev-only-change-me",
    scheme: process.env.DBX_SCHEME || "https",
  }
}

export function isConfigured(cfg: GenieSsoConfig): boolean {
  return Boolean(
    cfg.wsHost && cfg.orgId && cfg.spaceId &&
    cfg.clientId && cfg.clientSecret && cfg.redirectUri,
  )
}

export function baseUrl(cfg: GenieSsoConfig): string {
  return `${cfg.scheme}://${cfg.wsHost}`
}

export function embedUrl(cfg: GenieSsoConfig): string {
  return `${baseUrl(cfg)}/embed/genie/rooms/${cfg.spaceId}?o=${cfg.orgId}`
}

// ---- HMAC-signed values (mirrors itsdangerous URLSafeSerializer semantics) ---
function sign(value: string, secret: string): string {
  const mac = crypto.createHmac("sha256", secret).update(value).digest("base64url")
  return `${value}.${mac}`
}

function unsign(signed: string, secret: string): string | null {
  const i = signed.lastIndexOf(".")
  if (i < 0) return null
  const value = signed.slice(0, i)
  const mac = signed.slice(i + 1)
  const expected = crypto.createHmac("sha256", secret).update(value).digest("base64url")
  const a = Buffer.from(mac)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return null
  if (!crypto.timingSafeEqual(a, b)) return null
  return value
}

export function encodeSession(payload: Record<string, unknown>, secret: string): string {
  const json = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return sign(json, secret)
}

export function decodeSession(cookie: string | undefined, secret: string): Record<string, unknown> | null {
  if (!cookie) return null
  const value = unsign(cookie, secret)
  if (!value) return null
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

// ---- PKCE ------------------------------------------------------------------
export interface Pkce {
  state: string
  verifier: string
  challenge: string
}

export function newPkce(): Pkce {
  const state = crypto.randomBytes(16).toString("base64url")
  const verifier = crypto.randomBytes(48).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  return { state, verifier, challenge }
}

// How the mint flow is being carried, which tells /api/callback2 how to finish:
//   - "redirect": full-page navigation -> redirect the browser back to the app
//   - "iframe":   hidden iframe (silent re-mint) -> postMessage window.parent
//   - "popup":    interactive popup -> postMessage window.opener, then close
export type MintCarrier = "redirect" | "iframe" | "popup"

/** The signed PKCE cookie value carrying {state, verifier, carrier} through the
 *  flow, so the callback knows how it was launched and how to finish. */
export function encodePkceCookie(pkce: Pkce, secret: string, carrier: MintCarrier = "redirect"): string {
  return encodeSession({ state: pkce.state, verifier: pkce.verifier, carrier }, secret)
}

export function decodePkceCookie(
  cookie: string | undefined,
  secret: string,
): { state: string; verifier: string; carrier: MintCarrier } | null {
  const d = decodeSession(cookie, secret)
  if (!d || typeof d.state !== "string" || typeof d.verifier !== "string") return null
  const carrier: MintCarrier =
    d.carrier === "iframe" || d.carrier === "popup" ? d.carrier : "redirect"
  return { state: d.state, verifier: d.verifier, carrier }
}

// ---- The /aad/auth redirect URL (mirrors _login in the Python lib) ---------
export function aadAuthUrl(cfg: GenieSsoConfig, pkce: Pkce): string {
  const authorizeParams = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    state: pkce.state,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    // Minimal scope: identity only (SCIM /Me). The iframe runs on the browser
    // session cookie, not this token, so a narrow scope keeps consent benign.
    scope: "iam.current-user:read",
  })
  const authorizeRel = "/oidc/v1/authorize?" + authorizeParams.toString()
  const nextB64 = encodeURIComponent(Buffer.from(authorizeRel).toString("base64"))
  return `${baseUrl(cfg)}/aad/auth?next_url=${nextB64}`
}

// ---- Token exchange + identity (mirrors _callback in the Python lib) -------
export async function exchangeCodeForToken(
  cfg: GenieSsoConfig,
  code: string,
  verifier: string,
): Promise<string> {
  const body = new URLSearchParams({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  })
  const r = await fetch(`${baseUrl(cfg)}/oidc/v1/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`token exchange failed: ${r.status} ${text.slice(0, 300)}`)
  }
  const data = (await r.json()) as { access_token?: string }
  return data.access_token || ""
}

export async function resolveIdentity(cfg: GenieSsoConfig, accessToken: string): Promise<string | null> {
  const r = await fetch(`${baseUrl(cfg)}/api/2.0/preview/scim/v2/Me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!r.ok) return null
  const data = (await r.json()) as { userName?: string }
  return data.userName || null
}

// The message type the completion page posts back to the app window.
export const GENIE_MINT_MESSAGE = "genie-sso:mint-complete"

/** HTML for the OAuth completion callback, rendered on OUR origin at the end of
 *  the mint flow (the OAuth redirect_uri lands here). Because it is same-origin
 *  with the app, it can signal the opener/parent deterministically and close
 *  itself — no cross-origin guessing, no timers.
 *
 *  It handles BOTH carriers:
 *   - popup:        posts to window.opener, then window.close()
 *   - hidden iframe: posts to window.parent (legacy silent re-mint path)
 *
 *  The parent/opener listens for GENIE_MINT_MESSAGE and reloads the iframe. */
export function mintCompletionHtml(ok: boolean, origin: string, detail = ""): string {
  const payload = JSON.stringify({ type: GENIE_MINT_MESSAGE, ok, detail })
  const target = JSON.stringify(origin)
  // origin and payload are server-controlled (config + booleans), not user input.
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting…</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1B3139;padding:28px">
<p>Connected. You can close this window.</p>
<script>
  try {
    var msg = ${payload}, target = ${target};
    if (window.opener && window.opener !== window) {
      window.opener.postMessage(msg, target);   // popup path
      window.close();
    } else if (window.parent && window.parent !== window) {
      window.parent.postMessage(msg, target);    // hidden-iframe path
    }
  } catch (e) {}
</script>
</body></html>`
}

/** @deprecated use mintCompletionHtml — kept as an alias for the hidden-iframe path. */
export const silentCompletionHtml = mintCompletionHtml
