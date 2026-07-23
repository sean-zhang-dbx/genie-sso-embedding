// -----------------------------------------------------------------------------
// The ONE piece GSK's MSAL code is missing: establishing the Databricks SESSION
// COOKIE the Genie iframe needs (MSAL only ever produces an Entra session +
// token; a Bearer token cannot authenticate an iframe, so without this step the
// iframe hits Databricks' own login = the second sign-in).
//
// Two mint strategies, selected with NEXT_PUBLIC_MINT_MODE:
//
//   "server" (default) — hand off to the server-side route /api/dbx-login, which
//       runs the confidential-OAuth redirect chain (ported from the Python
//       genie_sso library into app/api + lib/genieSso.ts) and plants the cookie.
//       Fully seamless: a top-level redirect, no popup. REQUIRES a Databricks
//       account-admin to register a custom OAuth app integration.
//
//   "popup" — the original client-only approach: a brief top-level popup to
//       /aad/auth that auto-closes. Needs NO OAuth-app registration. Kept for
//       environments where account-admin approval isn't available.
//
// Both mints hit /aad/auth TOP-LEVEL (never inside the iframe — Microsoft sends
// X-Frame-Options: DENY on its login pages). Because MSAL already established the
// Entra session, that /aad/auth -> Entra hop is SILENT: no credential prompt.
//
// HARD DEPENDENCY (both modes): third-party cookies must be allowed for the
// workspace domain, or the iframe can't use the cookie and the in-frame second
// login returns. Browser/IT policy boundary — not something code can override.
// -----------------------------------------------------------------------------

export const GENIE_CONFIG = {
  WS_HOST: process.env.NEXT_PUBLIC_GENIE_WS_HOST!,   // e.g. adb-984752964297111.11.azuredatabricks.net (no https://)
  ORG_ID: process.env.NEXT_PUBLIC_GENIE_ORG_ID!,     // the ?o= value
  SPACE_ID: process.env.NEXT_PUBLIC_GENIE_SPACE_ID!, // the Genie space id
}

export type MintMode = "server" | "popup"

export function mintMode(): MintMode {
  return (process.env.NEXT_PUBLIC_MINT_MODE as MintMode) || "server"
}

// The embeddable Genie surface. IMPORTANT: use /embed/genie/rooms/... — it
// serves frame-ancestors * so it renders in any iframe. The plain
// /genie/rooms/... room URL has a fixed frame-ancestors allow-list and refuses
// to load in a third-party iframe ("refused to connect").
export function genieEmbedUrl(): string {
  return `https://${GENIE_CONFIG.WS_HOST}/embed/genie/rooms/${GENIE_CONFIG.SPACE_ID}?o=${GENIE_CONFIG.ORG_ID}`
}

// ---- server mode -----------------------------------------------------------

// Is the Databricks session already minted this browser session? Asks the
// server route, which reads the signed httpOnly session cookie.
export async function genieStatus(): Promise<{ configured: boolean; ready: boolean; email: string | null }> {
  try {
    const r = await fetch("/api/genie-status", { cache: "no-store" })
    if (!r.ok) return { configured: false, ready: false, email: null }
    return await r.json()
  } catch {
    return { configured: false, ready: false, email: null }
  }
}

// Full-page navigation to the server mint route. It redirects the browser
// TOP-LEVEL through /aad/auth (silent) and back to the app with the Databricks
// cookie planted. A full-page redirect — not fetch — is required so the browser
// follows the cross-origin hops and stores the workspace cookie.
export function startServerMint(): void {
  window.location.assign("/api/dbx-login")
}

// ---- popup mode (original client-only mint; no server, no OAuth app) --------

function aadAuthUrl(): string {
  const relative = `/embed/genie/rooms/${GENIE_CONFIG.SPACE_ID}?o=${GENIE_CONFIG.ORG_ID}`
  const nextB64 = btoa(relative)
  return `https://${GENIE_CONFIG.WS_HOST}/aad/auth?next_url=${encodeURIComponent(nextB64)}`
}

// Open a brief top-level popup to establish the Databricks session, then close
// it. Resolves once the popup closes or after `autocloseMs`. The caller reveals
// the iframe afterward.
export function bootstrapDatabricksSessionPopup(autocloseMs = 6000): Promise<void> {
  return new Promise((resolve) => {
    const w = 480
    const h = 640
    const left = (screen.width - w) / 2
    const top = (screen.height - h) / 2
    const popup = window.open(
      aadAuthUrl(),
      "dbxauth",
      `popup=yes,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`,
    )

    let done = false
    const finish = () => {
      if (done) return
      done = true
      try {
        if (popup && !popup.closed) popup.close()
      } catch {
        /* cross-origin close guard */
      }
      resolve()
    }

    // Poll for the popup closing itself after the silent redirect completes.
    const timer = setInterval(() => {
      if (popup && popup.closed) {
        clearInterval(timer)
        finish()
      }
    }, 500)

    // Safety net: close and proceed after the timeout regardless.
    setTimeout(() => {
      clearInterval(timer)
      finish()
    }, autocloseMs)
  })
}
