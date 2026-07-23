// GET /api/callback2 — OAuth redirect landing. Exchanges the auth code for a
// token, resolves identity via SCIM, sets the signed dbx_session cookie, then
// either sends the browser back to the app (normal mode) or posts a completion
// message to the parent window (silent re-mint mode, run in a hidden iframe).
//
// Ported from the Python library's `/callback2` route. `DBX_REDIRECT_URI` must
// point here (…/api/callback2) AND match the registered OAuth integration.

import { NextRequest, NextResponse } from "next/server"
import {
  loadConfig, isConfigured, exchangeCodeForToken, resolveIdentity,
  decodePkceCookie, encodeSession, silentCompletionHtml,
  COOKIE_PKCE, COOKIE_SESSION, SESSION_MAX_AGE_SEC,
} from "../../../lib/genieSso"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Where to send the user after the cookie is planted (the app root by default).
const SUCCESS_REDIRECT = process.env.DBX_SUCCESS_REDIRECT || "/"

// Silent-mode responses render a tiny page that postMessages the parent. We
// always clear the PKCE cookie on these too.
function silentResponse(req: NextRequest, ok: boolean, detail = "") {
  const html = silentCompletionHtml(ok, req.nextUrl.origin, detail)
  const res = new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
  res.cookies.set(COOKIE_PKCE, "", { path: "/", maxAge: 0 })
  return res
}

function redirectFail(req: NextRequest, msg: string) {
  const url = new URL(SUCCESS_REDIRECT, req.url)
  url.searchParams.set("dbx_error", msg)
  const res = NextResponse.redirect(url)
  res.cookies.set(COOKIE_PKCE, "", { path: "/", maxAge: 0 })
  return res
}

export async function GET(req: NextRequest) {
  const cfg = loadConfig()
  const params = req.nextUrl.searchParams
  const pkce = decodePkceCookie(req.cookies.get(COOKIE_PKCE)?.value, cfg.sessionSecret)
  // Trust the signed cookie for whether this is a silent (hidden-iframe) mint.
  const silent = pkce?.silent === true

  const fail = (msg: string) =>
    silent ? silentResponse(req, false, msg) : redirectFail(req, msg)

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
  const res = silent
    ? silentResponse(req, true)
    : NextResponse.redirect(new URL(SUCCESS_REDIRECT, req.url))
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
