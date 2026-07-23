// -----------------------------------------------------------------------------
// The ONE piece GSK's MSAL code is missing.
//
// After MSAL sign-in, the browser holds an ENTRA session + tokens. But the Genie
// iframe authenticates with a DATABRICKS SESSION COOKIE, which MSAL never
// creates. A Bearer token cannot authenticate an iframe. So without this step
// the iframe hits Databricks' own login = the second sign-in.
//
// This mints the Databricks cookie by hitting the workspace /aad/auth endpoint
// TOP-LEVEL (never inside the iframe — Microsoft sends X-Frame-Options: DENY on
// its login pages, so an in-frame attempt fails). Because MSAL already
// established the Entra session, that /aad/auth -> Entra hop is SILENT: no
// credential prompt. A brief popup does it, then auto-closes.
//
// HARD DEPENDENCY: third-party cookies must be allowed for the workspace domain,
// or the iframe can't use the cookie and you fall back to the in-frame login.
// That is a browser/IT policy boundary, not something code can override.
// -----------------------------------------------------------------------------

export const GENIE_CONFIG = {
  WS_HOST: process.env.NEXT_PUBLIC_GENIE_WS_HOST!,   // e.g. adb-984752964297111.11.azuredatabricks.net (no https://)
  ORG_ID: process.env.NEXT_PUBLIC_GENIE_ORG_ID!,     // the ?o= value
  SPACE_ID: process.env.NEXT_PUBLIC_GENIE_SPACE_ID!, // the Genie space id
}

// The embeddable Genie surface. IMPORTANT: use /embed/genie/rooms/... — it
// serves frame-ancestors * so it renders in any iframe. The plain
// /genie/rooms/... room URL has a fixed frame-ancestors allow-list and refuses
// to load in a third-party iframe ("refused to connect").
export function genieEmbedUrl(): string {
  return `https://${GENIE_CONFIG.WS_HOST}/embed/genie/rooms/${GENIE_CONFIG.SPACE_ID}?o=${GENIE_CONFIG.ORG_ID}`
}

// The top-level /aad/auth URL that mints the Databricks session cookie and then
// forwards to the embed path. next_url must be base64 of the RELATIVE embed
// path; browsers handle the URL-encoding of the query param for us.
function aadAuthUrl(): string {
  const relative = `/embed/genie/rooms/${GENIE_CONFIG.SPACE_ID}?o=${GENIE_CONFIG.ORG_ID}`
  const nextB64 = btoa(relative)
  return `https://${GENIE_CONFIG.WS_HOST}/aad/auth?next_url=${encodeURIComponent(nextB64)}`
}

// Open a brief top-level popup to establish the Databricks session, then close
// it. Resolves once the popup closes or after `autocloseMs`. The caller reveals
// the iframe afterward.
export function bootstrapDatabricksSession(autocloseMs = 6000): Promise<void> {
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
