// GET /api/genie-status — lets the client know whether the app-side session
// marker has been set (i.e. the mint round-trip completed), so AuthProvider can
// decide whether to run /api/dbx-login or reveal the iframe directly.

import { NextRequest, NextResponse } from "next/server"
import { loadConfig, isConfigured, decodeSession, COOKIE_SESSION } from "../../../lib/genieSso"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const cfg = loadConfig()
  const sess = decodeSession(req.cookies.get(COOKIE_SESSION)?.value, cfg.sessionSecret)
  return NextResponse.json({
    configured: isConfigured(cfg),
    ready: Boolean(sess),
    email: sess?.email ?? null,
  })
}
