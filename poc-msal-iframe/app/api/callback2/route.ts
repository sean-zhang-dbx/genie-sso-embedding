// GET /api/callback2 — the OAuth redirect_uri landing. This is the registered
// redirect URL of the Databricks custom OAuth app, so the flow always ends HERE,
// on our own origin, regardless of how it was launched. That is what lets us
// finish deterministically (no cross-origin guessing, no timers).
//
// It exchanges the auth code for a token, resolves identity via SCIM, sets the
// signed dbx_session cookie, then finishes according to how the flow was carried
// (see MintCarrier):
//   - redirect: send the browser back to the app
//   - iframe:   render a page that postMessages window.parent (silent re-mint)
//   - popup:    render a page that postMessages window.opener, then self-closes
//
// `DBX_REDIRECT_URI` must point here (…/api/callback2) AND match the registered
// OAuth integration.

import { NextRequest, NextResponse } from "next/server"
import {
  loadConfig, isConfigured, exchangeCodeForToken, resolveIdentity,
  decodePkceCookie, encodeSession, mintCompletionHtml,
  COOKIE_PKCE, COOKIE_SESSION, SESSION_MAX_AGE_SEC,
} from "../../../lib/genieSso"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Where to send the user after the cookie is planted (the app root by default).
const SUCCESS_REDIRECT = process.env.DBX_SUCCESS_REDIRECT || "/"

// The app's PUBLIC origin. Behind Azure App Service (and most proxies) req.url
// reflects the INTERNAL host:port (e.g. https://<container-id>:8080), so building
// redirects from it leaks that unreachable address to the browser (blank :8080
// page). Derive the real external origin instead, in priority order:
//   1) PUBLIC_ORIGIN env (explicit override)
//   2) the origin of DBX_REDIRECT_URI (already the public …/api/callback2 URL)
//   3) X-Forwarded-Proto + X-Forwarded-Host (what the proxy actually received)
//   4) req.nextUrl.origin (last resort; local dev)
function publicOrigin(req: NextRequest): string {
  if (process.env.PUBLIC_ORIGIN) return process.env.PUBLIC_ORIGIN.replace(/\/$/, "")
  const redir = process.env.DBX_REDIRECT_URI
  if (redir) { try { return new URL(redir).origin } catch { /* fall through */ } }
  const xfHost = req.headers.get("x-forwarded-host")
  if (xfHost) {
    const proto = req.headers.get("x-forwarded-proto") || "https"
    return `${proto}://${xfHost.split(",")[0].trim()}`
  }
  return req.nextUrl.origin
}

// Completion page for the iframe/popup carriers: signals the opener/parent and
// (for a popup) closes itself. Always clears the one-time PKCE cookie.
function completionResponse(req: NextRequest, ok: boolean, detail = "") {
  const html = mintCompletionHtml(ok, publicOrigin(req), detail)
  const res = new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
  res.cookies.set(COOKIE_PKCE, "", { path: "/", maxAge: 0 })
  return res
}

function redirectFail(req: NextRequest, msg: string) {
  const url = new URL(SUCCESS_REDIRECT, publicOrigin(req))
  url.searchParams.set("dbx_error", msg)
  const res = NextResponse.redirect(url)
  res.cookies.set(COOKIE_PKCE, "", { path: "/", maxAge: 0 })
  return res
}

export async function GET(req: NextRequest) {
  const cfg = loadConfig()
  const params = req.nextUrl.searchParams
  const pkce = decodePkceCookie(req.cookies.get(COOKIE_PKCE)?.value, cfg.sessionSecret)
  const carrier = pkce?.carrier ?? "redirect"
  const usesCompletionPage = carrier === "iframe" || carrier === "popup"

  const fail = (msg: string) =>
    usesCompletionPage ? completionResponse(req, false, msg) : redirectFail(req, msg)

  if (!isConfigured(cfg)) return fail("not_configured")

  const err = params.get("error")
  if (err) return fail(`${err}: ${params.get("error_description") || ""}`)

  const code = params.get("code")
  const state = params.get("state")

  // State must match what we signed into the PKCE cookie (CSRF protection).
  if (!code || !pkce || !state || state !== pkce.state) {
    return fail("invalid_state")
  }

  let email: string | null = null
  try {
    const token = await exchangeCodeForToken(cfg, code, pkce.verifier)
    email = await resolveIdentity(cfg, token)
  } catch (e) {
    return fail(e instanceof Error ? e.message.slice(0, 120) : "token_exchange_failed")
  }

  // Success: set the signed app-side session marker. (The actual Databricks
  // workspace cookie was planted on the databricks.net domain during /aad/auth.)
  const sessionCookie = encodeSession({ email, ts: Date.now() }, cfg.sessionSecret)
  const res = usesCompletionPage
    ? completionResponse(req, true)
    : NextResponse.redirect(new URL(SUCCESS_REDIRECT, publicOrigin(req)))
  res.cookies.set(COOKIE_PKCE, "", { path: "/", maxAge: 0 })
  res.cookies.set(COOKIE_SESSION, sessionCookie, {
    httpOnly: true,
    secure: cfg.scheme === "https",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  })
  return res
}
