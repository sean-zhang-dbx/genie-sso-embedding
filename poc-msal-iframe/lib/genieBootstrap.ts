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

// Three selectable approaches, chosen via NEXT_PUBLIC_MINT_MODE:
//
//   "server"      (default) — full-page OAuth redirect through /api/dbx-login.
//                  Seamless, deterministic. REQUIRES a Databricks account-admin
//                  to register a custom OAuth app.
//
//   "oauth-popup" — the same server-side OAuth flow, but carried in a popup so it
//                  can show interactive consent and never navigates the main
//                  window. Deterministic close (lands on /api/callback2, posts
//                  back, self-closes). Also REQUIRES the OAuth app.
//
//   "client"      — no OAuth app at all: a popup hits the workspace /aad/auth
//                  pointing straight at the Genie embed page. Works with NO
//                  account-admin setup, but the popup ends cross-origin so its
//                  close is best-effort (focus/close heuristic), not deterministic.
export type MintMode = "server" | "oauth-popup" | "client"

export function mintMode(): MintMode {
  const m = process.env.NEXT_PUBLIC_MINT_MODE
  return m === "oauth-popup" || m === "client" ? m : "server"
}

// True when the selected mode needs the Databricks OAuth app registration.
export function mintNeedsOAuthApp(): boolean {
  return mintMode() !== "client"
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

// The message /api/callback2 posts back to us on completion (mirror of
// GENIE_MINT_MESSAGE in genieSso.ts — duplicated here to avoid importing a
// server module into the client bundle).
const GENIE_MINT_MESSAGE = "genie-sso:mint-complete"

// Establish the Databricks session in an INTERACTIVE POPUP running the full
// OAuth flow (carrier=popup). Because the OAuth redirect_uri lands the popup back
// on /api/callback2 (our origin), that page postMessages us and self-closes, so
// this resolves DETERMINISTICALLY the moment the flow completes — no 6s timer, no
// cross-origin URL guessing. The popup can also display any interactive consent /
// group-select step (unlike a hidden iframe, which X-Frame-Options blocks), so it
// handles both fresh login and reconnect after a hard logout.
//
// Returns true if the session was established, false if the user closed the popup
// or it timed out. `maxWaitMs` is only a safety cap for an abandoned popup.
export function mintViaPopup(maxWaitMs = 180000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false)

    const w = 480, h = 680
    const left = (screen.width - w) / 2
    const top = (screen.height - h) / 2
    const popup = window.open(
      "/api/dbx-login?carrier=popup",
      "dbxauth",
      `popup=yes,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`,
    )

    let done = false
    let closeTimer: ReturnType<typeof setInterval>
    let capTimer: ReturnType<typeof setTimeout>

    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return
      if (!e.data || e.data.type !== GENIE_MINT_MESSAGE) return
      finish(Boolean(e.data.ok))
    }

    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearInterval(closeTimer)
      clearTimeout(capTimer)
      window.removeEventListener("message", onMessage)
      try { if (popup && !popup.closed) popup.close() } catch { /* cross-origin */ }
      try { window.focus() } catch { /* ignore */ }
      resolve(ok)
    }

    // Primary signal: /api/callback2 posted completion (deterministic).
    window.addEventListener("message", onMessage)
    // Backup: user closed the popup themselves before completing.
    closeTimer = setInterval(() => { if (!popup || popup.closed) finish(false) }, 600)
    // Safety cap for an abandoned popup only.
    capTimer = setTimeout(() => finish(false), maxWaitMs)
  })
}

// Re-establish the Databricks session WITHOUT a visible redirect or popup, by
// running the mint chain inside a hidden iframe. Works only when Entra can
// complete the /aad/auth hop silently (MSAL session still valid). If Entra needs
// to show a page, X-Frame-Options blocks it in the hidden frame and we time out —
// the caller then falls back to a visible re-auth (startServerMint).
//
// Returns true if the session was refreshed, false if it timed out / failed.
export function silentRemint(timeoutMs = 8000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false)

    const frame = document.createElement("iframe")
    frame.style.display = "none"
    frame.setAttribute("aria-hidden", "true")
    frame.src = "/api/dbx-login?carrier=iframe"

    let done = false
    const cleanup = () => {
      window.removeEventListener("message", onMessage)
      clearTimeout(timer)
      try { frame.remove() } catch { /* already gone */ }
    }
    const finish = (ok: boolean) => {
      if (done) return
      done = true
      cleanup()
      resolve(ok)
    }

    const onMessage = (e: MessageEvent) => {
      // Only trust messages from our own origin and our message type.
      if (e.origin !== window.location.origin) return
      const data = e.data
      if (!data || data.type !== GENIE_MINT_MESSAGE) return
      finish(Boolean(data.ok))
    }

    window.addEventListener("message", onMessage)
    // If Entra can't go silent, the frame stalls on a blocked login page; time out.
    const timer = setTimeout(() => finish(false), timeoutMs)
    document.body.appendChild(frame)
  })
}

// ---- client mode: no OAuth app required ------------------------------------
// A popup hits the workspace /aad/auth pointing directly at the Genie embed page
// (no client_id, no OAuth). The workspace cookie is planted during the /aad/auth
// hop. Because the popup ends on the Databricks embed page (cross-origin), we
// cannot read its URL or receive a postMessage, so completion is BEST-EFFORT:
// we resolve when the app window regains focus (the user returning) or the popup
// closes. This is the inherent tradeoff of not using the OAuth app — no
// deterministic close. Kept as a selectable mode for deployments that cannot get
// an account-admin OAuth registration.
function clientAadAuthUrl(): string {
  const relative = `/embed/genie/rooms/${GENIE_CONFIG.SPACE_ID}?o=${GENIE_CONFIG.ORG_ID}`
  const nextB64 = btoa(relative)
  return `https://${GENIE_CONFIG.WS_HOST}/aad/auth?next_url=${encodeURIComponent(nextB64)}`
}

export function mintViaClientPopup(maxWaitMs = 180000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof window === "undefined") return resolve(false)
    const w = 480, h = 680
    const left = (screen.width - w) / 2
    const top = (screen.height - h) / 2
    const popup = window.open(
      clientAadAuthUrl(),
      "dbxauth",
      `popup=yes,width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`,
    )

    let done = false
    let armed = false
    let armTimer: ReturnType<typeof setTimeout>
    let capTimer: ReturnType<typeof setTimeout>
    let closeTimer: ReturnType<typeof setInterval>
    const onAppFocus = () => { if (armed) finish(true) }

    const finish = (ok: boolean) => {
      if (done) return
      done = true
      clearInterval(closeTimer)
      clearTimeout(armTimer)
      clearTimeout(capTimer)
      window.removeEventListener("focus", onAppFocus)
      try { if (popup && !popup.closed) popup.close() } catch { /* cross-origin */ }
      try { window.focus() } catch { /* ignore */ }
      resolve(ok)
    }

    // Best-effort completion: user returns to the app window (armed after a short
    // delay so the opening gesture doesn't fire it), or the popup is closed.
    armTimer = setTimeout(() => { armed = true }, 1500)
    window.addEventListener("focus", onAppFocus)
    closeTimer = setInterval(() => { if (!popup || popup.closed) finish(true) }, 600)
    capTimer = setTimeout(() => finish(false), maxWaitMs)
  })
}
