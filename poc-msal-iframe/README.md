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

After MSAL sign-in and the group check pass, the app establishes the Databricks session by
driving the workspace `/aad/auth` endpoint **top-level** (never inside the iframe — Microsoft
sends `X-Frame-Options: DENY` on its login pages). Because MSAL already established the Entra
session, that hop is **silent** when the login identity and the workspace share the same Entra
tenant. It sets the Databricks session cookie as a side effect, and the iframe then loads
against that cookie.

```
MSAL loginPopup ─► Graph group check ─► establish Databricks session (/aad/auth) ─► Genie iframe loads
   (Entra session)     (valid user?)          (mints Databricks cookie)                (no 2nd login)
```

## Three mint strategies (`NEXT_PUBLIC_MINT_MODE`)

The session mint can run three ways, selected by one env var. All hit `/aad/auth` top-level
and all require third-party cookies; they differ in whether a Databricks account-admin is
needed and how deterministic the completion is.

| Mode | How it mints the cookie | OAuth app? | Completion |
|------|-------------------------|-----------|-----------|
| **`server`** (default) | Full-page confidential-OAuth redirect chain (`/api/dbx-login` → `/aad/auth` → `/oidc/v1/authorize` → `/api/callback2`). | **Required** | Deterministic — lands back on `/api/callback2` (our origin) |
| **`oauth-popup`** | The same OAuth flow, carried in a popup so it can show interactive consent without navigating the main window. | **Required** | Deterministic — `/api/callback2` posts back to the opener and self-closes |
| **`client`** | Popup straight to `/aad/auth` → the Genie embed page. No OAuth, no `client_id`. | **Not needed** | Best-effort — the popup ends cross-origin, so close is detected via focus/close heuristic |

**How to choose:**
- Account-admin can register a Databricks OAuth app → use **`server`** (cleanest, zero popup) or **`oauth-popup`** (popup that can show interactive consent, e.g. cross-tenant group-select).
- No account-admin available → use **`client`** (drops straight into the SPA, but the popup close is best-effort, not deterministic).

**Tenant note (important):** `server`'s full-page silent redirect only completes cleanly when
the user's login identity and the target Databricks workspace are in the **same Entra
tenant**. Cross-tenant, the `/aad/auth` hop needs an interactive consent/group-select step
that a silent full-page redirect cannot satisfy (it will loop) — use `oauth-popup` there,
since a popup *can* display that step.

The `server` and `oauth-popup` modes are how you make the parent repo's Python `genie_sso`
logic usable from a SPA: it runs in Next.js **route handlers** (Node runtime), so the
Databricks **client secret stays server-side** — impossible in a pure browser SPA. PKCE
verifiers ride a short-lived signed httpOnly cookie instead of the Python version's in-process
dict, so it also works across multiple server instances (no single-worker constraint).

## Files

| File | Role |
|------|------|
| `lib/msalAuthSetup.ts` | MSAL config + Graph group checks. **Mirrors GSK's file** (scopes unified to the Databricks resource). |
| `lib/AuthProvider.tsx` | React auth context. **Mirrors GSK's**, plus `prepareGenie` (initial mint), `recoverGenieSession`/`reconnectGenie` (session recovery), and the mode dispatch, run once group access passes. |
| `lib/genieBootstrap.ts` | Mint dispatch by mode: `startServerMint()` (server), `mintViaPopup()` (oauth-popup, deterministic), `mintViaClientPopup()` (client, best-effort), `silentRemint()` (background refresh), `genieStatus()`, `mintMode()`/`mintNeedsOAuthApp()`, + the `/embed/genie/rooms/...` URL builder. |
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

This PoC supports **three** approaches behind one `NEXT_PUBLIC_MINT_MODE` toggle (see *Three
mint strategies* above):

- **`server`** — the parent repo's Python `genie_sso` logic **ported natively to TypeScript**
  (`lib/genieSso.ts` + `app/api/*`), run as a full-page OAuth redirect. Fully seamless.
- **`oauth-popup`** — the same server-side OAuth flow, carried in a popup so it can display an
  interactive consent/group-select step (e.g. cross-tenant) while still ending deterministically
  on `/api/callback2`.
- **`client`** — the original client-only bootstrap; no account-admin OAuth app, drops straight
  into the SPA, at the cost of a best-effort (non-deterministic) popup close.

`server` and `oauth-popup` reuse `genie_sso` server-side (client secret never reaches the
browser). `client` needs no server registration. Everything else (MSAL, Graph group gate,
iframe rendering) is identical across all three.

## Testing / current validation status

- **`oauth-popup`** — validated end-to-end on Azure against a cross-tenant workspace
  (`adb-7405612038937045`): one MSAL sign-in, popup completes the interactive consent, Genie
  iframe renders, no second in-frame login.
- **`server`** — validated logic; requires a **same-tenant** workspace + a registered OAuth
  app to complete its silent full-page redirect (cross-tenant it loops, by design — see the
  tenant note above).
- **Session recovery** (Databricks session dropped in another window) is host-app UI, not part
  of the library; a "Reconnect" affordance is included but the seamlessness of recovery is
  bounded by browser cross-origin rules. Treat deep session-lifecycle edge cases as out of
  scope for the library itself.

## OAuth app registration (for `server` / `oauth-popup`)

An account admin registers a **custom OAuth app integration** on the Databricks **account**
(Account console → Settings → App connections → Add connection):

- **Confidential:** yes (generates a client secret)
- **Redirect URL:** `https://<your-app-host>/api/callback2` (exact match, no trailing slash;
  must equal the app's `DBX_REDIRECT_URI`)
- **Scopes:** `all-apis` (or minimally `offline_access` + `iam.current-user:read`)

The returned **client id** + **secret** go into the app's `DBX_CLIENT_ID` / `DBX_CLIENT_SECRET`
env vars. This is an account-admin action, not a code change.
