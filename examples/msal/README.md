# MSAL + Graph group check + genie_sso — runnable mockup

A self-contained mock of the GSK-style scenario: an app that authenticates users
with **MSAL / Entra**, authorizes them with a **Microsoft Graph group check**,
and then embeds a **Databricks Genie Space** in an iframe using the
[`genie-sso-embedding`](https://github.com/sean-zhang-dbx/genie-sso-embedding)
library — with **one sign-in and no second login**.

Everything external (Entra, Microsoft Graph, the Databricks workspace) is mocked
in-process, so it runs from a single command with **no real credentials**.

## Run it

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app:app --port 8000 --reload
# open http://localhost:8000
```

> Use port **8000** (or set `MOCK_HOST=localhost:<port>` to match). The app makes
> internal HTTP calls to its own mock Entra/Graph/Databricks endpoints, so the
> port it listens on and the port in `MOCK_HOST` must agree.

Pick one of three mock identities on the sign-in screen and watch the flow.

## What the flow models

```
Layer 1  MSAL sign-in         -> establishes the ONE Entra session   (app.py /app-login)
Layer 1  Graph group check    -> "valid GSK user?" = in allowed group (app.py user_in_allowed_group)
Layer 3  genie_sso gate       -> plants the Databricks workspace session via a
                                  SILENT Entra hop (session already exists)      (genie_sso /dbx-login)
Render   Genie iframe         -> loads with NO second login                      (mock_cloud /embed/genie)
```

The customer already has Layers 1. **genie_sso is purely additive** — in `app.py`
it is 4 lines of wiring plus one gate inside the `/genie` route:

```python
sso = GenieSSO(cfg, success_redirect="/genie")
app.include_router(sso.router)
...
if not sso.get_session(request):      # no DBX session yet?
    return RedirectResponse(sso.login_path)   # silent chain, then back here
# iframe now has a workspace session:
f'<iframe src="{sso.embed_url}">'
```

## The three test users (each proves a different point)

| User | Graph group? | Synced to Databricks? | Result |
|---|---|---|---|
| `valid.user@gsk.com` | ✅ in `gsk-genie-users` | ✅ | **Full success** — Genie renders, one login |
| `outsider@contoso.com` | ❌ | ✅ | **Blocked at the Graph gate (403)** — Databricks never contacted |
| `unsynced@gsk.com` | ✅ | ❌ not provisioned | Auth succeeds, but the **iframe 403s** — the "authorization missing" failure mode |

The `unsynced` case is the important lesson: authentication (same-tenant Entra)
is not the same as authorization (being SCIM-provisioned into Databricks with a
grant on the Genie space). Sync the *same* allowed group into Databricks and
grant it on the space, and this case becomes a success too.

## Files

| File | Role |
|---|---|
| `app.py` | The GSK host app — MSAL login, Graph group check, genie_sso wiring, Genie page |
| `mock_cloud.py` | In-process fake Entra + Microsoft Graph + Databricks workspace |
| `../../genie_sso.py` | The embedding library itself (imported from the repo root — **not** vendored here) |

`app.py` imports the real `genie_sso` from the repo root via a `sys.path` insert,
so this example always exercises the actual library, not a copy. The `scheme` and
`cookie_secure` config knobs it uses for local http both default to the
production-safe values (`https` / `Secure`) in the library.

## How the mock differs from production (read before drawing conclusions)

This runs as one process on one origin so it's trivially runnable. Two
simplifications matter:

1. **Everything is on `localhost:8000`.** In reality your app, Entra
   (`login.microsoftonline.com`), and Databricks (`*.databricks.com`) are three
   **separate origins**. That is exactly why the Databricks workspace cookie is a
   **third-party cookie** in the iframe — and why third-party cookies must be
   allowed in the browser/IT policy for the real thing to work. The mock cannot
   exercise that browser constraint; it only demonstrates the redirect/cookie
   *logic* and ordering.

2. **The "silent hop" is modeled by a shared `entra_session` cookie.** In the mock,
   `/aad/auth` returns without prompting whenever that cookie is present — standing
   in for a live same-tenant Entra session established by MSAL. In production the
   silent behaviour depends on Databricks and your MSAL app being in the **same
   Entra tenant** (the confirmed condition for GSK).

3. `cookie_secure=False` is set **only** for the local http mock. Production keeps
   the library default (`Secure`), since it runs on https.

Neither simplification changes the lesson: the ordering (MSAL → Graph → genie_sso
→ iframe) and the two distinct failure modes (wrong group vs. not-provisioned) are
faithful to the real architecture.

## Single worker only

genie_sso keeps its PKCE verifier store in-process. Run one worker locally. For a
multi-worker production deploy, pass a shared `pkce_store` (e.g. Redis-backed) to
`GenieSSO(...)`.
