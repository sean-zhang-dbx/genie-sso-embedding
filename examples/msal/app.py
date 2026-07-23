"""
GSK-style host app: MSAL authentication + Microsoft Graph group check +
genie_sso for the embedded Genie iframe.

This models the customer's real architecture:

  Layer 1  MSAL sign-in            -> establishes the ONE Entra session
  Layer 1  Graph group check       -> "is this a valid GSK user?" (allowed group ID)
  Layer 3  genie_sso gate          -> plants the Databricks workspace session
                                       via a SILENT Entra hop (session already exists)
  Render   Genie iframe            -> loads with no second login

Only the MSAL + Graph parts are the customer's existing code (mocked here).
genie_sso is additive: ~4 lines of wiring + one gate in the Genie route.

Run:  uvicorn app:app --port 8000 --reload    then open  http://localhost:8000
(single worker — the genie_sso PKCE store is in-process; see README.)
"""

import os
import sys

import requests
from fastapi import FastAPI, Request, Form
from fastapi.responses import HTMLResponse, RedirectResponse

# Import the real library from the repo root (two levels up), rather than
# vendoring a copy into the example.
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

import mock_cloud
from genie_sso import GenieSSO, GenieSSOConfig

# --- point genie_sso at the in-process mock "cloud" on this same origin -----
HOST = os.environ.get("MOCK_HOST", "localhost:8000")
os.environ.setdefault("SSO_SCHEME", "http")          # mock runs on http locally
cfg = GenieSSOConfig(
    ws_host=HOST, org_id="1234567890", space_id="mock-space-01",
    client_id="dbx-oauth-client", client_secret="dbx-oauth-secret",
    redirect_uri=f"http://{HOST}/callback2",
    session_secret="mock-session-secret", scheme="http",
    cookie_secure=False,   # mock runs on http; production leaves this True
)

app = FastAPI(title="GSK Analytics Portal (mockup)")

# Mount the mock Entra / Graph / Databricks endpoints.
app.include_router(mock_cloud.router)

# ------------------------------------------------------------------ genie_sso
# NOTE: the library defaults its session cookie to Secure. A real browser treats
# http://localhost as a secure context and keeps it, but plain HTTP clients drop
# it — so the mock config sets cookie_secure=False purely for local testing.
# Production keeps the default (Secure) because it runs on https.
sso = GenieSSO(cfg, success_redirect="/genie")
app.include_router(sso.router)

# ---- the customer's existing MSAL config (mocked) --------------------------
ALLOWED_GROUP_ID = mock_cloud.ALLOWED_GROUP_ID
GRAPH_BASE = f"http://{HOST}/graph"

BR = "#2b1a5e"   # GSK-ish purple


def shell(body: str, who: str = "") -> str:
    who_html = f'<span style="opacity:.85;font-size:13px">{who}</span>' if who else ""
    logout = ('<a href="/app-logout" style="color:#fff;border:1px solid rgba(255,255,255,.4);'
              'padding:6px 14px;border-radius:6px;text-decoration:none;font-size:13px">Sign out</a>'
              if who else "")
    return f"""<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>GSK Analytics Portal</title>
<style>
 *{{box-sizing:border-box;margin:0;padding:0}} html,body{{height:100%}}
 body{{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f4f8;color:{BR};
   display:flex;flex-direction:column;height:100vh}}
 header{{background:{BR};color:#fff;height:56px;display:flex;align-items:center;justify-content:space-between;
   padding:0 22px;flex:0 0 auto}}
 header .brand{{font-weight:700;letter-spacing:.5px}}
 header .right{{display:flex;gap:14px;align-items:center}}
 main{{flex:1;display:flex;min-height:0}}
 .content{{flex:1;display:flex;flex-direction:column;min-height:0}}
 .card{{background:#fff;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.08);margin:auto;
   padding:36px;width:440px}}
 h1{{font-size:22px;margin-bottom:8px}} p{{color:#5a5570;font-size:13.5px;line-height:1.55;margin-bottom:18px}}
 .u{{display:block;width:100%;text-align:left;background:#f6f5fb;border:1px solid #e4e0f0;border-radius:8px;
   padding:12px 14px;margin-bottom:10px;cursor:pointer;font-size:14px;color:{BR}}}
 .u b{{display:block}} .u span{{font-size:12px;color:#7a7690}}
 .u:hover{{border-color:{BR}}}
 .bar{{padding:8px 18px;font-size:12.5px;background:#eefaf0;border-bottom:1px solid #c7ecd0;color:#276b3a;flex:0 0 auto}}
 .embed{{flex:1;display:flex;padding:14px 18px 18px;min-height:0}}
 .frame{{flex:1;border:1px solid #e2e0ea;border-radius:10px;overflow:hidden;box-shadow:0 4px 18px rgba(0,0,0,.07)}}
 iframe{{border:none;width:100%;height:100%}}
 .err{{color:#b00}} a.cta{{color:{BR}}}
</style></head><body>
<header><div class="brand">GSK <span style="opacity:.55;font-weight:400">| Analytics Portal</span></div>
<div class="right">{who_html}{logout}</div></header>{body}</body></html>"""


def current_user(request: Request):
    return request.cookies.get("entra_session")


def user_in_allowed_group(email: str) -> bool:
    """Customer's existing check: call Graph, confirm membership in the allowed group."""
    r = requests.get(f"{GRAPH_BASE}/me/memberOf", params={"user": email}, timeout=10)
    groups = [g["id"] for g in r.json().get("value", [])]
    return ALLOWED_GROUP_ID in groups


# ============================ ROUTES ========================================
@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if current_user(request):
        return RedirectResponse("/genie")
    body = """
<main><div class="card">
  <h1>Sign in</h1>
  <p>MSAL / Microsoft Entra authentication. Pick a mock identity to sign in
     (this stands in for the interactive Entra prompt — the one and only login).</p>
  <form method="post" action="/app-login">
    <button class="u" name="email" value="valid.user@gsk.com">
      <b>valid.user@gsk.com</b><span>In allowed group + provisioned in Databricks &rarr; full success</span></button>
    <button class="u" name="email" value="outsider@contoso.com">
      <b>outsider@contoso.com</b><span>NOT in allowed group &rarr; blocked at the Graph gate</span></button>
    <button class="u" name="email" value="unsynced@gsk.com">
      <b>unsynced@gsk.com</b><span>In group but NOT synced to Databricks &rarr; iframe 403</span></button>
  </form>
</div></main>"""
    return HTMLResponse(shell(body))


@app.post("/app-login")
def app_login(email: str = Form(...)):
    """LAYER 1: MSAL sign-in (mock). Establishes the single Entra session."""
    resp = RedirectResponse("/genie", status_code=302)
    # The Entra session cookie: set once here, reused silently by the /aad/auth hop.
    resp.set_cookie("entra_session", email, httponly=True, samesite="lax", max_age=8 * 3600)
    return resp


@app.get("/genie", response_class=HTMLResponse)
def genie(request: Request):
    # ---- LAYER 1: MSAL gate (existing) ----
    email = current_user(request)
    if not email:
        return RedirectResponse("/")

    # ---- LAYER 1: Graph group check (existing) — "valid GSK user?" ----
    if not user_in_allowed_group(email):
        return HTMLResponse(shell(
            '<main><div class="card"><h1 class="err">Access denied</h1>'
            f'<p>{email} is not a member of the allowed group '
            f'<code>{ALLOWED_GROUP_ID}</code>. This block comes from the Microsoft '
            'Graph check — before Databricks is ever contacted.</p>'
            '<a class="cta" href="/app-logout">Try another user</a></div></main>', who=email),
            status_code=403)

    # ---- LAYER 3: genie_sso gate (NEW — the only added logic) ----
    # If no Databricks session yet, kick off the silent redirect chain. Entra is
    # already signed in, so /dbx-login -> /aad/auth returns with no prompt.
    if not sso.get_session(request):
        return RedirectResponse(sso.login_path)

    # ---- Render the Genie iframe: it now has a workspace session ----
    body = f"""
<main><div class="content">
  <div class="bar"><b>Single sign-on complete.</b> MSAL authenticated you, the Graph
   group check passed, and the Databricks session was planted silently — the Genie
   iframe below loaded with no second login.</div>
  <div class="embed"><div class="frame">
    <iframe src="{sso.embed_url}" allow="clipboard-write"></iframe>
  </div></div>
</div></main>"""
    return HTMLResponse(shell(body, who=email))


@app.get("/app-logout")
def app_logout():
    """Clear both the app (Entra) session and the Databricks session."""
    resp = RedirectResponse("/", status_code=302)
    resp.delete_cookie("entra_session")
    resp.delete_cookie("dbx_session")
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True, "sso_enabled": sso.enabled}
