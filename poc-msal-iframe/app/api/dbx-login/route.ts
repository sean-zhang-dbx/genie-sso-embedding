// GET /api/dbx-login — starts the Databricks cookie-mint redirect chain.
//
// Ported from the Python library's `/dbx-login` route. Instead of an in-process
// PKCE dict, the {state, verifier} ride along in a short-lived signed httpOnly
// cookie, so this works across multiple server instances (Azure Web App scale).

import { NextResponse } from "next/server"
import {
  loadConfig, isConfigured, aadAuthUrl, newPkce,
  encodePkceCookie, COOKIE_PKCE, PKCE_MAX_AGE_SEC,
} from "../../../lib/genieSso"

export const runtime = "nodejs"          // needs node:crypto + the client secret
export const dynamic = "force-dynamic"

export async function GET() {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    return NextResponse.json(
      { error: "genie_sso not configured (DBX_* env vars missing)" },
      { status: 503 },
    )
  }

  const pkce = newPkce()
  const res = NextResponse.redirect(aadAuthUrl(cfg, pkce))
  res.cookies.set(COOKIE_PKCE, encodePkceCookie(pkce, cfg.sessionSecret), {
    httpOnly: true,
    secure: cfg.scheme === "https",
    sameSite: "lax",
    maxAge: PKCE_MAX_AGE_SEC,
    path: "/",
  })
  return res
}
