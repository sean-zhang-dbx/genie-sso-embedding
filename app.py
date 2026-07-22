"""
Zero-popup SSO for embedding a Databricks Genie Space in an external app.

The app is registered as a Databricks custom OAuth app integration, so a single
sign-in runs as one top-level redirect chain:

  app /dbx-login
    -> workspace /aad/auth?next_url=b64(/oidc/v1/authorize?...)
    -> Entra (the ONE sign-in; silent if a session already exists)
    -> workspace session cookie set as a side effect
    -> /oidc/v1/authorize issues an auth code
    -> back to app /callback2 (exchange code at /oidc/v1/token, SCIM /Me)

After that the native Genie iframe loads directly against the established
workspace session: no popup, no second prompt. Requested scope is only
iam.current-user:read (identity), so the one-time Databricks consent screen is
benign.

Requires third-party cookies to be allowed (browser/IT policy) so the iframe can
use the Databricks session.
"""

import base64
import hashlib
import os
import secrets
import time
import urllib.parse

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import URLSafeSerializer, BadSignature

SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-only-change-me")

# ---- Databricks custom OAuth app integration + target Genie Space ----
# These come from registering this app as an OAuth client on the Databricks
# account. If any are blank, the app shows "Not configured".
SSO_WS_HOST = os.environ.get("SSO_WS_HOST", "")        # no https://
SSO_ORG_ID = os.environ.get("SSO_ORG_ID", "")          # the ?o= value
SSO_SPACE_ID = os.environ.get("SSO_SPACE_ID", "")
DBX_CLIENT_ID = os.environ.get("DBX_CLIENT_ID", "")
DBX_CLIENT_SECRET = os.environ.get("DBX_CLIENT_SECRET", "")
SSO_REDIRECT_URI = os.environ.get("SSO_REDIRECT_URI", "")  # must match the OAuth integration's redirect URL

SSO_EMBED_URL = f"https://{SSO_WS_HOST}/embed/genie/rooms/{SSO_SPACE_ID}?o={SSO_ORG_ID}"
SSO_ENABLED = all([SSO_WS_HOST, SSO_ORG_ID, SSO_SPACE_ID, DBX_CLIENT_ID, DBX_CLIENT_SECRET, SSO_REDIRECT_URI])

# PKCE verifiers keyed by state nonce (single worker; pruned on use/expiry).
_PKCE: dict = {}

dbx_signer = URLSafeSerializer(SESSION_SECRET, salt="dbx-session")

app = FastAPI(title="Contoso Analytics Portal")

BRAND = "#1B3139"
ACCENT = "#FF3621"


def _shell(body: str) -> str:
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Contoso Analytics Portal</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  html, body {{ height: 100%; }}
  body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
         color: {BRAND}; background: #eef0f2; display: flex; flex-direction: column; height: 100vh; }}
  a {{ color: {ACCENT}; }}
  header {{ background: {BRAND}; color: #fff; padding: 0 22px; height: 56px; display: flex;
           align-items: center; justify-content: space-between; flex: 0 0 auto; }}
  header .brand {{ font-weight: 700; letter-spacing: .5px; font-size: 15px; }}
  header .brand span {{ opacity: .55; font-weight: 400; }}
  header .who {{ font-size: 13px; opacity: .9; }}
  header a {{ color: #fff; text-decoration: none; font-size: 13px; }}
  header a.btn {{ border: 1px solid rgba(255,255,255,.4); padding: 6px 14px; border-radius: 6px; margin-left: 14px; }}
  main {{ flex: 1 1 auto; display: flex; min-height: 0; }}
  .content {{ flex: 1; min-height: 0; display: flex; flex-direction: column; }}
  .stepbar {{ font-size: 12.5px; padding: 8px 18px; flex: 0 0 auto; border-bottom: 1px solid #dfe3e6; }}
  .stepbar.ok {{ background: #eefaf0; border-color: #c7ecd0; color: #276b3a; }}
  iframe {{ border: none; width: 100%; flex: 1 1 auto; }}
  .embed-wrap {{ flex: 1 1 auto; min-height: 0; display: flex; padding: 14px 18px 18px; }}
  .embed-card {{ flex: 1; display: flex; min-height: 0; background: #fff; border: 1px solid #e2e6e9;
                 border-radius: 10px; overflow: hidden; box-shadow: 0 4px 18px rgba(0,0,0,.07); }}
  .embed-card iframe {{ height: 100%; }}
  .card {{ background: #fff; border-radius: 12px; box-shadow: 0 8px 30px rgba(0,0,0,.08); }}
  .box {{ margin: auto; padding: 40px; width: 400px; text-align: center; }}
  .box h1 {{ font-size: 22px; margin-bottom: 8px; }}
  .box p {{ color: #6b7680; font-size: 13.5px; margin-bottom: 24px; line-height: 1.55; }}
  .box .cta {{ display: inline-flex; align-items: center; gap: 10px; background: {ACCENT}; color: #fff;
               text-decoration: none; border: none; padding: 13px 26px; border-radius: 8px; font-weight: 600;
               font-size: 15px; cursor: pointer; }}
</style>
</head>
<body>
{body}
</body>
</html>"""


def _header(who: str = "") -> str:
    who_html = f'<span class="who">{who}</span>' if who else ""
    return f"""
<header>
  <div class="brand">CONTOSO <span>| Analytics Portal</span></div>
  <div style="display:flex;align-items:center;gap:16px;">
    {who_html}<a class="btn" href="/logout">Reset</a></div>
</header>"""


def _dbx(request: Request):
    c = request.cookies.get("dbx_session")
    if not c:
        return None
    try:
        return dbx_signer.loads(c)
    except BadSignature:
        return None


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if not SSO_ENABLED:
        return HTMLResponse(_shell(
            f'{_header()}<main><div class="card box"><h1>Not configured</h1>'
            f'<p>The Databricks OAuth client settings (SSO_*) are missing.</p></div></main>'))
    sess = _dbx(request)
    if not sess:
        body = f"""
{_header()}
<main><div class="card box">
  <h1>Sign in once</h1>
  <p>One sign-in, one redirect chain: this app is a registered Databricks OAuth client,
     so authenticating also establishes your Databricks session on the way through.
     No popup, no second prompt &mdash; Genie loads embedded immediately after.</p>
  <a class="cta" href="/dbx-login">&#128273;&nbsp; Sign in once</a>
</div></main>"""
        return HTMLResponse(_shell(body))
    who = sess.get("email") or "Signed in"
    body = f"""
{_header(who)}
<main><div class="content">
  <div class="stepbar ok"><b>Zero-friction SSO.</b> Your single sign-in also established the
  Databricks session &mdash; the native Genie iframe below loaded with no popup and no extra prompts.</div>
  <div class="embed-wrap"><div class="embed-card">
    <iframe src="{SSO_EMBED_URL}" allow="clipboard-write" width="100%" height="600" frameborder="0"></iframe>
  </div></div>
</div></main>"""
    return HTMLResponse(_shell(body))


@app.get("/dbx-login")
def dbx_login():
    if not SSO_ENABLED:
        return RedirectResponse("/", status_code=302)
    # Prune stale PKCE entries.
    now = time.time()
    for k in [k for k, v in _PKCE.items() if now - v[1] > 600]:
        _PKCE.pop(k, None)

    state = secrets.token_urlsafe(16)
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(
        hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    _PKCE[state] = (verifier, now)

    authorize_rel = "/oidc/v1/authorize?" + urllib.parse.urlencode({
        "client_id": DBX_CLIENT_ID,
        "redirect_uri": SSO_REDIRECT_URI,
        "response_type": "code",
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        # Minimal scope: the token is only used to identify the user (SCIM /Me).
        # The Genie iframe runs on the browser session, not this token — and
        # narrow scope keeps the consent screen benign (no "all-apis" warning).
        "scope": "iam.current-user:read",
    })
    next_b64 = urllib.parse.quote(base64.b64encode(authorize_rel.encode()).decode(), safe="")
    return RedirectResponse(f"https://{SSO_WS_HOST}/aad/auth?next_url={next_b64}", status_code=302)


@app.get("/callback2")
def callback2(request: Request):
    err = request.query_params.get("error")
    if err:
        return HTMLResponse(_shell(
            f'{_header()}<main><div class="card box"><h1>Sign-in failed</h1>'
            f'<p>{err}: {request.query_params.get("error_description","")}</p>'
            f'<a class="cta" href="/dbx-login">Try again</a></div></main>'), status_code=400)
    code = request.query_params.get("code")
    state = request.query_params.get("state")
    entry = _PKCE.pop(state, None) if state else None
    if not code or not entry:
        return RedirectResponse("/", status_code=302)
    verifier = entry[0]

    tr = requests.post(f"https://{SSO_WS_HOST}/oidc/v1/token", data={
        "client_id": DBX_CLIENT_ID,
        "client_secret": DBX_CLIENT_SECRET,
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": SSO_REDIRECT_URI,
        "code_verifier": verifier,
    }, timeout=30)
    if tr.status_code != 200:
        return HTMLResponse(_shell(
            f'{_header()}<main><div class="card box"><h1>Token exchange failed</h1>'
            f'<p>{tr.status_code}: {tr.text[:300]}</p><a class="cta" href="/dbx-login">Try again</a></div></main>'),
            status_code=400)
    access_token = tr.json().get("access_token", "")

    # Resolve identity via the workspace itself.
    email = None
    me = requests.get(f"https://{SSO_WS_HOST}/api/2.0/preview/scim/v2/Me",
                      headers={"Authorization": f"Bearer {access_token}"}, timeout=30)
    if me.status_code == 200:
        email = me.json().get("userName")

    resp = RedirectResponse("/", status_code=302)
    resp.set_cookie("dbx_session", dbx_signer.dumps({"email": email}),
                    httponly=True, secure=True, samesite="lax", max_age=8 * 3600)
    return resp


@app.get("/logout")
def logout():
    resp = RedirectResponse("/", status_code=302)
    resp.delete_cookie("dbx_session")
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True, "build": "zero-popup-only", "sso_enabled": SSO_ENABLED}
