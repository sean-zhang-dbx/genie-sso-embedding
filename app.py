"""
Contoso Analytics Portal — host app that embeds a Databricks Genie Space.

All the SSO/OAuth machinery lives in `genie_sso.py`. This file is intentionally
thin: it owns the branded UI and wires in the SSO helper via three touch points
(`sso.enabled`, `sso.get_session`, `sso.embed_url`) plus one `include_router`.
"""

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse

from genie_sso import GenieSSO

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


def _branded_error(title: str, detail: str, retry_href: str) -> HTMLResponse:
    """Branded error page handed to GenieSSO so sign-in/token errors keep the
    Contoso shell instead of the library's minimal fallback."""
    return HTMLResponse(_shell(
        f'{_header()}<main><div class="card box"><h1>{title}</h1>'
        f'<p>{detail}</p><a class="cta" href="{retry_href}">Try again</a></div></main>'),
        status_code=400)


# Loads config from env, registers /dbx-login, /callback2, /logout.
sso = GenieSSO(error_page=_branded_error)
app.include_router(sso.router)


@app.get("/", response_class=HTMLResponse)
def home(request: Request):
    if not sso.enabled:
        return HTMLResponse(_shell(
            f'{_header()}<main><div class="card box"><h1>Not configured</h1>'
            f'<p>The Databricks OAuth client settings (SSO_*) are missing.</p></div></main>'))
    sess = sso.get_session(request)
    if not sess:
        body = f"""
{_header()}
<main><div class="card box">
  <h1>Sign in once</h1>
  <p>One sign-in, one redirect chain: this app is a registered Databricks OAuth client,
     so authenticating also establishes your Databricks session on the way through.
     No popup, no second prompt &mdash; Genie loads embedded immediately after.</p>
  <a class="cta" href="{sso.login_path}">&#128273;&nbsp; Sign in once</a>
</div></main>"""
        return HTMLResponse(_shell(body))
    who = sess.get("email") or "Signed in"
    body = f"""
{_header(who)}
<main><div class="content">
  <div class="stepbar ok"><b>Zero-friction SSO.</b> Your single sign-in also established the
  Databricks session &mdash; the native Genie iframe below loaded with no popup and no extra prompts.</div>
  <div class="embed-wrap"><div class="embed-card">
    <iframe src="{sso.embed_url}" allow="clipboard-write" width="100%" height="600" frameborder="0"></iframe>
  </div></div>
</div></main>"""
    return HTMLResponse(_shell(body))


@app.get("/healthz")
def healthz():
    return {"ok": True, "build": "zero-popup-only", "sso_enabled": sso.enabled}
