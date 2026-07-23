// GET /api/callback2 — OAuth redirect landing. Exchanges the auth code for a
// token, resolves identity via SCIM, sets the signed dbx_session cookie, then
// sends the browser back to the app so the iframe can render.
//
// Ported from the Python library's `/callback2` route. `DBX_REDIRECT_URI` must
// point here (…/api/callback2) AND match the registered OAuth integration.

import { NextRequest, NextResponse } from "next/server"
import {
  loadConfig, isConfigured, exchangeCodeForToken, resolveIdentity,
  decodePkceCookie, encodeSession,
  COOKIE_PKCE, COOKIE_SESSION, SESSION_MAX_AGE_SEC,
} from "../../../lib/genieSso"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Where to send the user after the cookie is planted (the app root by default).
const SUCCESS_REDIRECT = process.env.DBX_SUCCESS_REDIRECT || "/"

function fail(req: NextRequest, msg: string) {
  const url = new URL(SUCCESS_REDIRECT, req.url)
  url.searchParams.set("dbx_error", msg)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) return fail(req, "not_configured")

  const params = req.nextUrl.searchParams
  const err = params.get("error")
  if (err) return fail(req, `${err}: ${params.get("error_description") || ""}`)

  const code = params.get("code")
  const state = params.get("state")
  const pkce = decodePkceCookie(req.cookies.get(COOKIE_PKCE)?.value, cfg.sessionSecret)

  // State must match what we signed into the PKCE cookie (CSRF protection).
  if (!code || !pkce || !state || state !== pkce.state) {
    return fail(req, "invalid_state")
  }

  let email: string | null = null
  try {
    const token = await exchangeCodeForToken(cfg, code, pkce.verifier)
    email = await resolveIdentity(cfg, token)
  } catch (e) {
    return fail(req, e instanceof Error ? e.message.slice(0, 120) : "token_exchange_failed")
  }

  const res = NextResponse.redirect(new URL(SUCCESS_REDIRECT, req.url))
  // Clear the one-time PKCE cookie.
  res.cookies.set(COOKIE_PKCE, "", { path: "/", maxAge: 0 })
  // Set the signed app-side session marker (identity only; the actual Databricks
  // workspace cookie was planted on the databricks.net domain during /aad/auth).
  res.cookies.set(COOKIE_SESSION, encodeSession({ email }, cfg.sessionSecret), {
    httpOnly: true,
    secure: cfg.scheme === "https",
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SEC,
    path: "/",
  })
  return res
}
