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
MSAL loginPopup ─► Graph group check ─► [NEW] top-level /aad/auth popup (silent) ─► Genie iframe loads
   (Entra session)     (valid user?)        (mints Databricks cookie)                (no 2nd login)
```

## Files

| File | Role |
|------|------|
| `lib/msalAuthSetup.ts` | MSAL config + Graph group checks. **Mirrors GSK's file** (scopes unified to the Databricks resource). |
| `lib/AuthProvider.tsx` | React auth context. **Mirrors GSK's**, plus `genieReady`/`prepareGenie` that run the bootstrap once group access passes. |
| `lib/genieBootstrap.ts` | **The new piece.** Top-level `/aad/auth` cookie mint + the `/embed/genie/rooms/...` URL builder. |
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

The parent `genie-sso-embedding` app does the same cookie mint via a **server-side
confidential OAuth client** (the zero-popup `/v0` flow), which is fully seamless but
**requires a Databricks account-admin** to register a custom OAuth app integration. This PoC
uses the **popup-bootstrap** approach instead: slightly less polished (a brief popup) but
**needs no account-admin**, and drops directly into GSK's existing MSAL frontend.
