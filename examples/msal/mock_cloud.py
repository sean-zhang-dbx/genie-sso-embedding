"""
mock_cloud — an in-process stand-in for Entra ID, Microsoft Graph, and a
Databricks workspace. Lets the whole scenario run from ONE `uvicorn app:app`
with no real credentials.

WHAT THIS FAKES (and the real-world caveat for each):

  * Entra sign-in + silent session
      - /aad/auth : the "silent hop". In reality this is Microsoft Entra on
        login.microsoftonline.com. Because MSAL already signed the user in, this
        hop finds a live Entra session and returns WITHOUT prompting. We model
        that by reading an `entra_session` cookie that the app's MSAL mock sets
        at login; if present, /aad/auth redirects straight through — no prompt.
        CAVEAT: real Entra lives on a different origin; here it shares localhost.

  * Microsoft Graph group check
      - /graph/me/memberOf : returns the user's Entra group IDs. The app calls
        this to enforce "valid GSK user = member of ALLOWED_GROUP_ID".

  * Databricks workspace
      - /oidc/v1/authorize, /oidc/v1/token : the custom OAuth app (PKCE) flow.
      - /api/2.0/preview/scim/v2/Me : identity lookup used by genie_sso.
      - /embed/genie/rooms/{id} : the Genie iframe target. THIS is where
        Databricks enforces its OWN authorization: it checks for the workspace
        session cookie AND that the user's synced group is granted on the space.
        CAVEAT: real Databricks is a separate origin; the workspace cookie there
        is a genuine third-party cookie relative to the host app.

  * SCIM-synced Entra -> Databricks groups
      - DIRECTORY below is the shared source of truth: the same Entra group that
        Graph reports is the group Databricks sees (this is the "same Entra
        synced to Databricks" assumption made concrete).
"""

import base64
import secrets
import urllib.parse

from fastapi import APIRouter, Request, Form
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

# ---------------------------------------------------------------------------
# Shared identity directory. In reality this lives in Entra and is SCIM-synced
# into the Databricks account. Here one dict is BOTH, so Graph and Databricks
# can never disagree — exactly the guarantee you get from syncing one group.
# ---------------------------------------------------------------------------
ALLOWED_GROUP_ID = "gsk-genie-users"          # the "allowed group ID" the app gates on
GENIE_GRANTED_GROUP = "gsk-genie-users"       # the group Databricks granted on the space

USERS = {
    # email                     entra groups                         provisioned in DBX?
    "valid.user@gsk.com":     {"groups": ["gsk-genie-users", "all-staff"], "dbx": True},
    "outsider@contoso.com":   {"groups": ["all-staff"],                    "dbx": True},
    "unsynced@gsk.com":       {"groups": ["gsk-genie-users"],              "dbx": False},
}

router = APIRouter()

# In-memory OAuth state for the mock Databricks workspace.
_AUTH_CODES: dict = {}   # code -> email


def _entra_user(request: Request):
    """The 'silent' part: who is signed into Entra right now (set at MSAL login)."""
    return request.cookies.get("entra_session")


# ============================ ENTRA =========================================
@router.get("/aad/auth")
def aad_auth(request: Request, next_url: str = ""):
    """Databricks bounces the browser here to authenticate + plant its session.

    If an Entra session already exists (MSAL signed the user in moments ago),
    this returns SILENTLY — no prompt. That silent behaviour is the whole point.
    """
    email = _entra_user(request)
    if not email:
        # No Entra session at all -> this is where a REAL first-time prompt would be.
        return HTMLResponse(
            "<h3>[mock Entra] No active session — a real Entra login prompt would appear here.</h3>",
            status_code=401)
    # Silent: decode the wrapped Databricks authorize URL and continue the chain.
    try:
        decoded = base64.b64decode(urllib.parse.unquote(next_url)).decode()
    except Exception:
        return HTMLResponse("[mock Entra] bad next_url", status_code=400)
    # Redirect (relative) into the Databricks OIDC authorize endpoint.
    return RedirectResponse(decoded, status_code=302)


# ============================ MICROSOFT GRAPH ===============================
@router.get("/graph/me/memberOf")
def graph_member_of(request: Request):
    """The app calls this (with the MSAL user) to check group membership."""
    email = request.query_params.get("user", "")
    groups = USERS.get(email, {}).get("groups", [])
    return JSONResponse({"value": [{"id": g} for g in groups]})


# ============================ DATABRICKS: OAuth =============================
@router.get("/oidc/v1/authorize")
def oidc_authorize(request: Request):
    """Databricks issues an auth code back to the app's redirect_uri.

    Reached via the silent Entra hop, so we trust the Entra session for identity.
    """
    email = _entra_user(request)
    redirect_uri = request.query_params.get("redirect_uri", "")
    state = request.query_params.get("state", "")
    if not email or not redirect_uri:
        return HTMLResponse("[mock DBX] missing session or redirect_uri", status_code=400)
    code = secrets.token_urlsafe(16)
    _AUTH_CODES[code] = email
    sep = "&" if "?" in redirect_uri else "?"
    return RedirectResponse(f"{redirect_uri}{sep}code={code}&state={state}", status_code=302)


@router.post("/oidc/v1/token")
def oidc_token(code: str = Form(...), grant_type: str = Form(...),
               client_id: str = Form(...), client_secret: str = Form(None),
               redirect_uri: str = Form(None), code_verifier: str = Form(None)):
    """Exchange the auth code for an access token (mock: token encodes the email)."""
    email = _AUTH_CODES.pop(code, None)
    if not email:
        return JSONResponse({"error": "invalid_grant"}, status_code=400)
    token = base64.urlsafe_b64encode(email.encode()).decode()
    return JSONResponse({"access_token": token, "token_type": "Bearer", "expires_in": 3600})


@router.get("/api/2.0/preview/scim/v2/Me")
def scim_me(request: Request):
    """genie_sso calls this to resolve identity from the access token."""
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        return JSONResponse({"error": "unauthorized"}, status_code=401)
    try:
        email = base64.urlsafe_b64decode(auth[7:].encode()).decode()
    except Exception:
        return JSONResponse({"error": "bad token"}, status_code=401)
    return JSONResponse({"userName": email, "active": True})


# ============================ DATABRICKS: the iframe ========================
@router.get("/embed/genie/rooms/{space_id}")
def embed_genie(space_id: str, request: Request):
    """The Genie iframe target. Databricks enforces its OWN authorization here.

    Two independent checks, both required:
      1. A workspace session must exist (planted via the silent hop). We model
         the workspace session by reading the same entra_session cookie — on this
         single origin it stands in for the Databricks workspace cookie.
      2. The user must be provisioned in Databricks AND their synced group must
         be granted on this space.
    """
    email = request.cookies.get("entra_session")
    if not email:
        # No Databricks session in the frame -> real Databricks would try to log
        # in inside the iframe, which Entra blocks (X-Frame-Options). THE double login.
        return HTMLResponse(
            "<div style='font-family:sans-serif;padding:30px;color:#b00'>"
            "<b>[mock Databricks] No workspace session in this iframe.</b><br>"
            "In production this triggers a second Databricks/Entra login that gets "
            "blocked inside the frame — the double-login problem.</div>",
            status_code=401)

    info = USERS.get(email, {})
    if not info.get("dbx"):
        return HTMLResponse(
            "<div style='font-family:sans-serif;padding:30px;color:#b00'>"
            f"<b>[mock Databricks] {email} is not provisioned in Databricks.</b><br>"
            "Authentication succeeded but the user was never SCIM-synced.</div>",
            status_code=403)
    if GENIE_GRANTED_GROUP not in info.get("groups", []):
        return HTMLResponse(
            "<div style='font-family:sans-serif;padding:30px;color:#b00'>"
            f"<b>[mock Databricks] {email} has no permission on this Genie space.</b></div>",
            status_code=403)

    # Success: render a fake Genie space.
    return HTMLResponse(
        "<div style='font-family:sans-serif;height:100%;display:flex;flex-direction:column;"
        "background:linear-gradient(135deg,#0b3d2e,#155e46);color:#eafff5'>"
        "<div style='padding:14px 18px;background:rgba(0,0,0,.25);font-weight:700'>"
        f"&#129504; Genie Space <span style='opacity:.7;font-weight:400'>({space_id})</span></div>"
        "<div style='flex:1;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px'>"
        f"<div style='font-size:18px'>Hello <b>{email}</b> &mdash; you're in.</div>"
        "<div style='opacity:.8;max-width:440px;text-align:center;line-height:1.5'>"
        "This iframe rendered with <b>no second login</b>. The workspace session was "
        "planted during the silent Entra hop, and your synced group grants access.</div>"
        "<div style='margin-top:10px;padding:10px 16px;background:rgba(255,255,255,.12);"
        "border-radius:8px'>Ask Genie: <i>“What were Q3 sales by region?”</i></div>"
        "</div></div>")
