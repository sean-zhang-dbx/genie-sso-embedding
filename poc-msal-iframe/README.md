# Genie MSAL iframe PoC

A Next.js proof-of-concept that mirrors **GSK's exact auth pattern** — MSAL sign-in +
Microsoft Graph group-membership gating — and adds the **one missing step** that makes a
native Genie iframe load with **no second sign-in**.

## The problem this proves out

GSK signs users in with MSAL (an Entra session + token) and gates access by checking the
user's Microsoft Graph group membership. That works for identifying a valid user. But their
**Genie iframe still prompts for a second login**, because:

> An iframe authenticates with a **Databricks session cookie**, not a Bearer token. MSAL
> only ever produces an Entra session + token — it never creates the Databricks cookie. So
> the iframe hits Databricks' own login.

## The fix (see `lib/genieBootstrap.ts`)

After MSAL sign-in and the group check pass, the app makes **one top-level call** to the
workspace `/aad/auth` endpoint (in a brief popup that auto-closes). Because MSAL already
established the Entra session, that hop is **silent** — no credential prompt — and it sets
the Databricks session cookie as a side effect. The iframe then loads against that cookie.

```
MSAL loginPopup ─► Graph group check ─► [NEW] top-level /aad/auth (silent) ─► Genie iframe loads
   (Entra session)     (valid user?)        (mints Databricks cookie)          (no 2nd login)
```

## Two mint strategies (`NEXT_PUBLIC_MINT_MODE`)

The cookie mint can run two ways. Both hit `/aad/auth` top-level and both need
third-party cookies; they differ in whether a Databricks account-admin is required.

| Mode | How it mints the cookie | Databricks account-admin? | UX |
|------|-------------------------|---------------------------|-----|
| **`server`** (default) | Server-side confidential-OAuth redirect chain, ported from the parent repo's Python `genie_sso` library into `app/api/*` + `lib/genieSso.ts`. Full-page redirect. | **Required** (register a custom OAuth app) | Fully seamless, no popup |
| **`popup`** | Client-only brief popup to `/aad/auth` that auto-closes. | **Not needed** | A short popup flashes |

Server mode is how you make the parent repo's `genie_sso` usable from this SPA:
its logic runs in Next.js **route handlers** (Node runtime), so the Databricks
**client secret stays server-side** — impossible in a pure browser SPA. PKCE
verifiers ride a short-lived signed httpOnly cookie instead of the Python
version's in-process dict, so it also works across multiple server instances
(no single-worker constraint).

## Files

| File | Role |
|------|------|
| `lib/msalAuthSetup.ts` | MSAL config + Graph group checks. **Mirrors GSK's file** (scopes unified to the Databricks resource). |
| `lib/AuthProvider.tsx` | React auth context. **Mirrors GSK's**, plus `genieReady`/`prepareGenie` that run the mint (server or popup) once group access passes. |
| `lib/genieBootstrap.ts` | Mint dispatch: `startServerMint()` / `genieStatus()` (server mode) and `bootstrapDatabricksSessionPopup()` (popup mode) + the `/embed/genie/rooms/...` URL builder. |
| `lib/genieSso.ts` | **Server-only.** The `genie_sso` logic ported to TypeScript: PKCE, `/aad/auth` URL, token exchange, SCIM identity, signed cookies. Imported only by `app/api/*`. |
| `app/api/dbx-login/route.ts` | Starts the server mint chain (sets PKCE cookie, redirects to `/aad/auth`). |
| `app/api/callback2/route.ts` | OAuth landing: code→token, SCIM identity, sets the signed `dbx_session` cookie. `DBX_REDIRECT_URI` must point here. |
| `app/api/genie-status/route.ts` | Reports whether the session cookie is minted, so the client reveals the iframe or triggers the mint. |
| `app/page.tsx` | Sign-in → group gate → "connecting…" → Genie iframe. |
| `app/layout.tsx` | Wraps everything in `AuthProvider`. |

## Run it

```bash
cp .env.example .env.local   # fill in your Entra app + Genie space (a working config is already committed in .env.local for the demo)
npm install
npm run dev                  # http://localhost:3000
```

Sign in with an org account that belongs to `NEXT_PUBLIC_ALLOWED_GROUP_ID`. On first
sign-in MSAL shows a one-time consent screen (delegated scopes — user-consentable, no admin
needed).

### Pre-provisioned demo config (committed in `.env.local`)

- **Entra app:** `genie-msal-iframe-poc` (client `f23f8a2a-6d07-435c-9bee-1a988620904d`, tenant `9f37a392…`)
- **Genie space:** NYC Taxi Trip Analytics on `adb-984752964297111` (org `984752964297111`, space `01f185d7461416c0b2e16c9703b26594`) — live and verified
- **Allowed group:** `a5f77939-…` (interview-workspace.interviewers)

## The hard dependency (make-or-break)

**Third-party cookies must be allowed** for the Databricks workspace domain in the browser.
The iframe uses the Databricks session cookie as a *third-party* cookie. If IT policy blocks
them (Chrome incognito blocks by default; Safari always), the iframe can't use the cookie
and the in-frame second login returns. **No code can override this** — it's a browser
security boundary. Verify GSK's managed-browser policy before promising the seamless flow.

## How this relates to the parent repo

The parent `genie-sso-embedding` app does the cookie mint via a **server-side confidential
OAuth client** (Python/FastAPI), fully seamless but **requiring a Databricks account-admin**
to register a custom OAuth app integration.

This PoC now supports **both** approaches (see *Two mint strategies* above):

- **`popup` mode** — the original client-only bootstrap. No account-admin, drops straight
  into GSK's existing MSAL frontend; the cost is a brief popup.
- **`server` mode** — the parent repo's Python `genie_sso` logic **ported natively to
  TypeScript** (`lib/genieSso.ts` + `app/api/*`). This is how you use `genie_sso` from a
  SPA: it can't be imported into browser code, so its server-side flow runs in Next.js route
  handlers within this same app — no separate Python service, and the client secret stays on
  the server. Fully seamless, but inherits the account-admin OAuth-app requirement.

Pick `server` when account-admin is available and you want zero popups; pick `popup` when it
isn't. Everything else (MSAL, Graph group gate, iframe) is identical between the two.
