// GET /api/dbx-login — starts the Databricks cookie-mint redirect chain.
//
// Ported from the Python library's `/dbx-login` route. Instead of an in-process
// PKCE dict, the {state, verifier} ride along in a short-lived signed httpOnly
// cookie, so this works across multiple server instances (Azure Web App scale).

import { NextRequest, NextResponse } from "next/server"
import {
  loadConfig, isConfigured, aadAuthUrl, newPkce, encodePkceCookie,
  COOKIE_PKCE, PKCE_MAX_AGE_SEC, type MintCarrier,
} from "../../../lib/genieSso"

export const runtime = "nodejs"          // needs node:crypto + the client secret
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const cfg = loadConfig()
  if (!isConfigured(cfg)) {
    return NextResponse.json(
      { error: "genie_sso not configured (DBX_* env vars missing)" },
      { status: 503 },
    )
  }

  // carrier tells /api/callback2 how the flow was launched, so it knows how to
  // finish (redirect vs. postMessage a parent iframe vs. postMessage+close a
  // popup). It rides in the signed PKCE cookie so it survives the round-trip.
  //   ?carrier=popup   -> interactive popup (fresh login / reconnect)
  //   ?carrier=iframe  -> hidden iframe (silent re-mint)
  //   (default)        -> redirect (full-page navigation)
  const q = req.nextUrl.searchParams.get("carrier")
  const carrier: MintCarrier = q === "popup" || q === "iframe" ? q : "redirect"

  const pkce = newPkce()
  const res = NextResponse.redirect(aadAuthUrl(cfg, pkce))
  res.cookies.set(COOKIE_PKCE, encodePkceCookie(pkce, cfg.sessionSecret, carrier), {
    httpOnly: true,
    secure: cfg.scheme === "https",
    sameSite: "lax",
    maxAge: PKCE_MAX_AGE_SEC,
    path: "/",
  })
  return res
}
