"""
One app, three ways to reach a Databricks Genie Space — ALL via the native
Genie iframe (no Conversation API anywhere).

  v0  Zero-friction SSO (the fix). The app is registered as a Databricks custom
      OAuth app integration, so the single sign-in runs as one top-level
      redirect chain: app -> workspace /aad/auth -> Entra (the ONE sign-in) ->
      workspace session set as a side effect -> OIDC authorize -> back to the
      app. The native Genie iframe then loads directly: no popup, no second
      prompt. Requested scope is only iam.current-user:read (identity), so the
      one-time Databricks consent screen is benign. (v1, the popup-bootstrap
      variant behind an Entra app login, is superseded by v0 and now redirects.)

  v2  Popup bootstrap behind a generic portal login (for comparison): the
      Databricks session can only be minted top-level (Microsoft sends
      X-Frame-Options: DENY on every interactive page, even with third-party
      cookies enabled), so without the OAuth registration a brief self-closing
      popup is the minimum.

  v3  Current experience: the iframe triggers the Databricks sign-in in-frame —
      the double login the customer complains about today.

Requires third-party cookies to be allowed (browser/IT policy) so the iframe
can use the Databricks session.
"""

import base64
import os
import secrets
import time
import urllib.parse

import requests
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import URLSafeSerializer, BadSignature

SESSION_SECRET = os.environ.get("SESSION_SECRET", "dev-only-change-me")
TENANT_ID = os.environ["TENANT_ID"]
CLIENT_ID = os.environ["CLIENT_ID"]
CLIENT_SECRET = os.environ["CLIENT_SECRET"]
REDIRECT_URI = os.environ["REDIRECT_URI"]

WS_HOST = os.environ["WS_HOST"]
ORG_ID = os.environ["ORG_ID"]
SPACE_ID = os.environ["SPACE_ID"]

AUTHORITY = f"https://login.microsoftonline.com/{TENANT_ID}"
AUTHORIZE_URL = f"{AUTHORITY}/oauth2/v2.0/authorize"
TOKEN_URL = f"{AUTHORITY}/oauth2/v2.0/token"
# Identity-only scopes: fastest, least likely to trigger consent interstitials.
SCOPES = "openid profile email"

_RELATIVE = f"/embed/genie/rooms/{SPACE_ID}?o={ORG_ID}"
EMBED_URL = f"https://{WS_HOST}{_RELATIVE}"
_NEXT_B64 = base64.b64encode(_RELATIVE.encode()).decode()
AAD_EMBED_URL = f"https://{WS_HOST}/aad/auth?next_url={_NEXT_B64}"

# ---- v0: zero-popup SSO via a Databricks custom OAuth app integration ----
# The app is registered as an OAuth client ON the Databricks account, so the
# single sign-in can run as one top-level redirect chain:
#   app -> workspace /aad/auth?next_url=b64(/oidc/v1/authorize?...)
#       -> Entra (the ONE sign-in; silent if a session exists)
#       -> workspace session cookie set as a side effect
#       -> OIDC authorize issues a code -> back to app /callback2
# After that the native Genie iframe loads directly: no popup, no second login.
SSO_WS_HOST = os.environ.get("SSO_WS_HOST", "")
SSO_ORG_ID = os.environ.get("SSO_ORG_ID", "")
SSO_SPACE_ID = os.environ.get("SSO_SPACE_ID", "")
DBX_CLIENT_ID = os.environ.get("DBX_CLIENT_ID", "")
DBX_CLIENT_SECRET = os.environ.get("DBX_CLIENT_SECRET", "")
SSO_REDIRECT_URI = os.environ.get("SSO_REDIRECT_URI", "")

SSO_EMBED_URL = f"https://{SSO_WS_HOST}/embed/genie/rooms/{SSO_SPACE_ID}?o={SSO_ORG_ID}"
SSO_ENABLED = all([SSO_WS_HOST, SSO_ORG_ID, SSO_SPACE_ID, DBX_CLIENT_ID, DBX_CLIENT_SECRET, SSO_REDIRECT_URI])

# PKCE verifiers keyed by state nonce (single worker; pruned on use/expiry).
_PKCE: dict = {}

signer = URLSafeSerializer(SESSION_SECRET, salt="app-session")
entra_signer = URLSafeSerializer(SESSION_SECRET, salt="entra-session")
state_signer = URLSafeSerializer(SESSION_SECRET, salt="oauth-state")
dbx_signer = URLSafeSerializer(SESSION_SECRET, salt="dbx-session")

app = FastAPI(title="Contoso Analytics Portal")

BRAND = "#1B3139"
ACCENT = "#FF3621"


def _portal(request: Request):
    c = request.cookies.get("app_session")
    if not c:
        return None
    try:
        return signer.loads(c)
    except BadSignature:
        return None


def _entra(request: Request):
    c = request.cookies.get("entra_session")
    if not c:
        return None
    try:
        return entra_signer.loads(c)
    except BadSignature:
        return None


def _shell(body: str, script: str = "") -> str:
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
  .stepbar.warn {{ background: #fff7f0; border-color: #ffd9c7; color: #8a4b2a; }}
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
  form.box label {{ display:block; text-align:left; font-size:12px; font-weight:600; color:#4a555e;
                    margin:0 0 6px; text-transform:uppercase; letter-spacing:.4px; }}
  form.box input {{ width:100%; padding:11px 12px; border:1px solid #cfd6db; border-radius:7px; font-size:14px; margin-bottom:16px; }}
  form.box button {{ width:100%; }}
  .menu {{ margin: auto; padding: 40px; max-width: 960px; }}
  .menu h1 {{ font-size: 24px; margin-bottom: 6px; }}
  .menu .sub {{ color: #6b7680; font-size: 14px; margin-bottom: 28px; }}
  .grid {{ display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }}
  .vcard {{ display:flex; flex-direction:column; padding:22px; text-decoration:none; color:{BRAND};
            transition: transform .08s ease, box-shadow .08s ease; }}
  .vcard:hover {{ transform: translateY(-2px); box-shadow: 0 12px 34px rgba(0,0,0,.12); }}
  .badge {{ align-self:flex-start; font-size:10.5px; font-weight:700; letter-spacing:.4px; text-transform:uppercase;
            padding:3px 9px; border-radius:20px; margin-bottom:14px; }}
  .badge.fix {{ background:#e6f7ec; color:#1f9d55; }}
  .badge.mit {{ background:#fff4e6; color:#c97a1c; }}
  .badge.cur {{ background:#fdecec; color:#d64545; }}
  .vcard h2 {{ font-size:16px; margin-bottom:8px; }}
  .vcard p {{ font-size:12.5px; color:#5b6770; line-height:1.55; }}
  .vcard .go {{ margin-top:auto; padding-top:16px; font-size:12.5px; font-weight:600; color:{ACCENT}; }}
  .connect {{ margin:auto; text-align:center; padding:48px; }}
  .connect h1 {{ font-size:22px; margin-bottom:10px; }}
  .connect p {{ color:#5b6770; font-size:14px; max-width:500px; margin:0 auto 26px; }}
  .connect button.main {{ background:{ACCENT}; color:#fff; border:none; padding:14px 30px; border-radius:8px; font-weight:600; font-size:15px; cursor:pointer; }}
  .connect .sec {{ margin-top:16px; }}
  .connect .sec button {{ background:none; border:1px solid #cfd6db; color:#4a555e; padding:9px 18px; border-radius:7px; font-size:13px; cursor:pointer; margin:0 4px; }}
</style>
</head>
<body>
{body}
{script}
</body>
</html>"""


def _header(who: str = "") -> str:
    who_html = f'<span class="who">{who}</span>' if who else ""
    return f"""
<header>
  <div class="brand">CONTOSO <span>| Analytics Portal</span></div>
  <div style="display:flex;align-items:center;gap:16px;">
    <a href="/">&larr; All versions</a>{who_html}<a class="btn" href="/logout">Reset</a></div>
</header>"""


# Shared popup-bootstrap script: opens the workspace /aad/auth flow in a small
# top-level popup (where Microsoft is allowed to respond; silent with a live
# Entra session), auto-closes it, then loads the native Genie iframe.
def _bootstrap_script(autoclose_ms: int = 7000) -> str:
    return """
<script>
  var POPUP_URL="%s", EMBED_SRC="%s", popup=null, timer=null, autoclose=null;
  function connect(){
    var w=480,h=640,left=(screen.width-w)/2,top=(screen.height-h)/2;
    /* popup=yes forces a real separate WINDOW (not a tab) in modern browsers. */
    popup=window.open(POPUP_URL,"dbxauth","popup=yes,width="+w+",height="+h+",left="+left+",top="+top+",menubar=no,toolbar=no,location=no,status=no");
    var bar=document.getElementById("bar"); if(bar) bar.textContent="Connecting to Databricks with your existing sign-in\\u2026";
    var sec=document.getElementById("sec"); if(sec) sec.style.display="block";
    timer=setInterval(function(){ if(popup&&popup.closed){ clearInterval(timer); loadGenie(); } },700);
    autoclose=setTimeout(function(){ try{ if(popup&&!popup.closed) popup.close(); }catch(e){} loadGenie(); },%d);
  }
  function loadGenie(){
    if(timer) clearInterval(timer);
    if(autoclose) clearTimeout(autoclose);
    if(popup&&!popup.closed){ try{popup.close();}catch(e){} }
    var c=document.getElementById("connect"); if(c) c.style.display="none";
    var bar=document.getElementById("bar"); if(bar) bar.textContent="Connected \\u2014 your Genie Space, embedded natively.";
    var f=document.getElementById("genie"); f.src=EMBED_SRC; f.style.display="block";
  }
  function retry(){
    var f=document.getElementById("genie"); f.style.display="none"; f.src="about:blank";
    var c=document.getElementById("connect"); if(c) c.style.display="block";
    connect();
  }
</script>""" % (AAD_EMBED_URL, EMBED_URL, autoclose_ms)


@app.get("/", response_class=HTMLResponse)
def menu():
    body = f"""
<header><div class="brand">CONTOSO <span>| Analytics Portal</span></div><a href="/logout" style="color:#fff;text-decoration:none;font-size:13px;">Reset sessions</a></header>
<main><div class="menu">
  <h1>Genie embedding &mdash; three approaches</h1>
  <div class="sub">All three embed the <b>native Genie iframe</b>; they differ in how the Databricks session is established.</div>
  <div class="grid">
    <a class="card vcard" href="/v0" style="border: 2px solid #1f9d55;">
      <span class="badge fix">Zero friction</span>
      <h2>0 &middot; Sign in once &mdash; nothing else</h2>
      <p>The app is registered as a <b>Databricks OAuth client</b>, so one sign-in runs as a
         single redirect chain: app &rarr; Entra &rarr; back, with the Databricks session set
         along the way. <b>No popup, no second prompt</b> &mdash; the native Genie iframe just loads.</p>
      <div class="go">Open &rarr;</div>
    </a>
    <a class="card vcard" href="/v2">
      <span class="badge mit">Comparison</span>
      <h2>2 &middot; Popup bootstrap</h2>
      <p>Same silent-connect mechanic behind a generic portal login, for
         comparison during the demo.</p>
      <div class="go">Open &rarr;</div>
    </a>
    <a class="card vcard" href="/v3">
      <span class="badge cur">Today</span>
      <h2>3 &middot; Current experience</h2>
      <p>The iframe triggers the Databricks sign-in <b>inside the frame</b> &mdash;
         the double login your customer hits now.</p>
      <div class="go">Open &rarr;</div>
    </a>
  </div>
</div></main>"""
    return HTMLResponse(_shell(body))


# ---------------- v0: zero-popup — Databricks OAuth redirect chain ----------------

def _dbx(request: Request):
    c = request.cookies.get("dbx_session")
    if not c:
        return None
    try:
        return dbx_signer.loads(c)
    except BadSignature:
        return None


@app.get("/v0", response_class=HTMLResponse)
def v0(request: Request):
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
    who = sess.get("email") or sess.get("name") or "Signed in"
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
        return RedirectResponse("/v0", status_code=302)
    # Prune stale PKCE entries.
    import hashlib
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
        return RedirectResponse("/v0", status_code=302)
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

    resp = RedirectResponse("/v0", status_code=302)
    resp.set_cookie("dbx_session", dbx_signer.dumps({"email": email}),
                    httponly=True, secure=True, samesite="lax", max_age=8 * 3600)
    return resp


# ---------------- v1 removed: superseded by v0 (zero-popup SSO) ----------------

@app.get("/v1")
def v1_redirect():
    return RedirectResponse("/v0", status_code=302)


# ---------------- portal login for v2/v3 ----------------

def _portal_login_page(target: str) -> str:
    return f"""
{_header()}
<main><form class="card box" method="post" action="/applogin">
  <input type="hidden" name="target" value="{target}">
  <h1>Sign in</h1>
  <p>Access your Contoso Analytics Portal.</p>
  <label>Username</label>
  <input name="username" type="text" placeholder="you@contoso.com" autofocus required>
  <label>Password</label>
  <input name="password" type="password" placeholder="&bull;&bull;&bull;&bull;&bull;&bull;" required>
  <button class="cta" type="submit">Log in to portal</button>
</form></main>"""


@app.post("/applogin")
async def applogin(request: Request):
    raw = (await request.body()).decode()
    form = urllib.parse.parse_qs(raw)
    username = (form.get("username", [""])[0] or "").strip()
    target = (form.get("target", ["/"])[0] or "/")
    if target not in ("/v2", "/v3"):
        target = "/"
    if not username:
        return RedirectResponse(target, status_code=302)
    resp = RedirectResponse(target, status_code=302)
    resp.set_cookie("app_session", signer.dumps({"username": username}),
                    httponly=True, secure=True, samesite="lax", max_age=3600)
    return resp


@app.get("/v2", response_class=HTMLResponse)
def v2(request: Request):
    if not _portal(request):
        return HTMLResponse(_shell(_portal_login_page("/v2")))
    who = _portal(request).get("username", "Signed in")
    body = f"""
{_header(who)}
<main><div class="content">
  <div class="stepbar warn" id="bar"><b>Popup bootstrap.</b> A brief window establishes the Databricks
  session top-level (silent if you have an Entra session), then the native iframe loads.</div>
  <div class="connect" id="connect">
    <h1>Continue to Databricks analytics</h1>
    <p>A small sign-in window opens (not a tab), completes single sign-on, and closes
       itself &mdash; then the embedded Genie Space loads here.</p>
    <button class="main" onclick="connect()">Continue &rarr;</button>
    <div class="sec" id="sec" style="display:none;">
      <button onclick="loadGenie()">Load Genie now</button>
      <button onclick="retry()">Re-run connection</button>
    </div>
  </div>
  <iframe id="genie" style="display:none;" allow="clipboard-write" width="100%" height="600" frameborder="0"></iframe>
</div></main>"""
    return HTMLResponse(_shell(body, _bootstrap_script(8000)))


@app.get("/v3", response_class=HTMLResponse)
def v3(request: Request):
    if not _portal(request):
        return HTMLResponse(_shell(_portal_login_page("/v3")))
    who = _portal(request).get("username", "Signed in")
    body = f"""
{_header(who)}
<main><div class="content">
  <div class="stepbar warn"><b>Current experience.</b> The embedded frame triggers the Databricks
  sign-in <b>inside the iframe</b> &mdash; the double login the customer hits today.</div>
  <iframe src="{EMBED_URL}" allow="clipboard-write" width="100%" height="600" frameborder="0"></iframe>
</div></main>"""
    return HTMLResponse(_shell(body))


@app.get("/logout")
def logout():
    resp = RedirectResponse("/", status_code=302)
    resp.delete_cookie("app_session")
    resp.delete_cookie("entra_session")
    resp.delete_cookie("dbx_session")
    return resp


@app.get("/healthz")
def healthz():
    return {"ok": True, "build": "zero-popup-6", "sso_enabled": SSO_ENABLED}
