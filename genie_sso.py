"""
Zero-popup SSO for embedding a Databricks Genie Space in an external app.

This module contains all the authentication machinery, extracted so that a host
FastAPI app only needs to (a) construct a GenieSSO, (b) mount its router, and
(c) read three helpers: `enabled`, `get_session(request)`, and `embed_url`.

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

NOTE: the PKCE store is in-process (keyed by state nonce). Run a single worker,
or override `pkce_store` with a shared backend (e.g. Redis) for multi-worker
deployments — a login started on one worker and a callback landing on another
will otherwise fail.
"""

import base64
import hashlib
import os
import secrets
import time
import urllib.parse

import requests
from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from itsdangerous import URLSafeSerializer, BadSignature


class GenieSSOConfig:
    """Databricks custom-OAuth-app settings, loaded from the environment by default.

    Values come from registering the app as an OAuth client on the Databricks
    account. If any required field is blank, `enabled` is False and the host app
    can render a "Not configured" state.
    """

    def __init__(
        self,
        *,
        ws_host: str = None,          # no https://
        org_id: str = None,           # the ?o= value
        space_id: str = None,
        client_id: str = None,
        client_secret: str = None,
        redirect_uri: str = None,     # must match the OAuth integration's redirect URL
        session_secret: str = None,
        cookie_name: str = "dbx_session",
        session_max_age: int = 8 * 3600,
    ):
        self.ws_host = ws_host if ws_host is not None else os.environ.get("SSO_WS_HOST", "")
        self.org_id = org_id if org_id is not None else os.environ.get("SSO_ORG_ID", "")
        self.space_id = space_id if space_id is not None else os.environ.get("SSO_SPACE_ID", "")
        self.client_id = client_id if client_id is not None else os.environ.get("DBX_CLIENT_ID", "")
        self.client_secret = (
            client_secret if client_secret is not None else os.environ.get("DBX_CLIENT_SECRET", "")
        )
        self.redirect_uri = (
            redirect_uri if redirect_uri is not None else os.environ.get("SSO_REDIRECT_URI", "")
        )
        self.session_secret = (
            session_secret if session_secret is not None
            else os.environ.get("SESSION_SECRET", "dev-only-change-me")
        )
        self.cookie_name = cookie_name
        self.session_max_age = session_max_age

    @property
    def enabled(self) -> bool:
        return all([
            self.ws_host, self.org_id, self.space_id,
            self.client_id, self.client_secret, self.redirect_uri,
        ])

    @property
    def embed_url(self) -> str:
        return f"https://{self.ws_host}/embed/genie/rooms/{self.space_id}?o={self.org_id}"


def _default_error_page(title: str, detail: str, retry_href: str) -> HTMLResponse:
    """Minimal fallback error page. Host apps can pass their own `error_page`
    to keep the branded look-and-feel."""
    return HTMLResponse(
        "<!DOCTYPE html><html><head><meta charset='utf-8'></head>"
        "<body style='font-family:sans-serif;padding:40px'>"
        f"<h1>{title}</h1><p>{detail}</p><a href='{retry_href}'>Try again</a>"
        "</body></html>",
        status_code=400,
    )


class GenieSSO:
    """Self-contained Databricks Genie SSO embedding helper.

    Usage in a host FastAPI app::

        sso = GenieSSO()
        app.include_router(sso.router)

        # then in your own routes:
        if not sso.enabled: ...
        sess = sso.get_session(request)     # {"email": ...} or None
        iframe_src = sso.embed_url

    Args:
        config:          GenieSSOConfig; defaults to reading the environment.
        login_path:      route that starts the redirect chain.
        callback_path:   OAuth redirect landing route. MUST match the path in
                         `SSO_REDIRECT_URI` and the registered OAuth integration.
        logout_path:     clears the local session cookie.
        success_redirect: where to send the user after login/logout.
        error_page:      callable(title, detail, retry_href) -> Response, so the
                         host app can supply branded error rendering.
        pkce_store:      dict-like store for PKCE verifiers keyed by state nonce.
                         Defaults to an in-process dict (single worker only).
    """

    def __init__(
        self,
        config: GenieSSOConfig = None,
        *,
        login_path: str = "/dbx-login",
        callback_path: str = "/callback2",
        logout_path: str = "/logout",
        success_redirect: str = "/",
        error_page=_default_error_page,
        pkce_store: dict = None,
    ):
        self.cfg = config or GenieSSOConfig()
        self.login_path = login_path
        self.callback_path = callback_path
        self.logout_path = logout_path
        self.success_redirect = success_redirect
        self.error_page = error_page
        self._pkce = pkce_store if pkce_store is not None else {}
        self._signer = URLSafeSerializer(self.cfg.session_secret, salt="dbx-session")

        self.router = APIRouter()
        self.router.add_api_route(login_path, self._login, methods=["GET"])
        self.router.add_api_route(callback_path, self._callback, methods=["GET"])
        self.router.add_api_route(logout_path, self._logout, methods=["GET"])

    # ---- public helpers used by the host app ----
    @property
    def enabled(self) -> bool:
        return self.cfg.enabled

    @property
    def embed_url(self) -> str:
        return self.cfg.embed_url

    def get_session(self, request: Request):
        """Return the decoded session dict ({"email": ...}) or None."""
        c = request.cookies.get(self.cfg.cookie_name)
        if not c:
            return None
        try:
            return self._signer.loads(c)
        except BadSignature:
            return None

    # ---- routes ----
    def _login(self):
        if not self.cfg.enabled:
            return RedirectResponse(self.success_redirect, status_code=302)
        # Prune stale PKCE entries.
        now = time.time()
        for k in [k for k, v in self._pkce.items() if now - v[1] > 600]:
            self._pkce.pop(k, None)

        state = secrets.token_urlsafe(16)
        verifier = secrets.token_urlsafe(48)
        challenge = base64.urlsafe_b64encode(
            hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        self._pkce[state] = (verifier, now)

        authorize_rel = "/oidc/v1/authorize?" + urllib.parse.urlencode({
            "client_id": self.cfg.client_id,
            "redirect_uri": self.cfg.redirect_uri,
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
        return RedirectResponse(
            f"https://{self.cfg.ws_host}/aad/auth?next_url={next_b64}", status_code=302)

    def _callback(self, request: Request):
        err = request.query_params.get("error")
        if err:
            return self.error_page(
                "Sign-in failed",
                f"{err}: {request.query_params.get('error_description', '')}",
                self.login_path,
            )
        code = request.query_params.get("code")
        state = request.query_params.get("state")
        entry = self._pkce.pop(state, None) if state else None
        if not code or not entry:
            return RedirectResponse(self.success_redirect, status_code=302)
        verifier = entry[0]

        tr = requests.post(f"https://{self.cfg.ws_host}/oidc/v1/token", data={
            "client_id": self.cfg.client_id,
            "client_secret": self.cfg.client_secret,
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": self.cfg.redirect_uri,
            "code_verifier": verifier,
        }, timeout=30)
        if tr.status_code != 200:
            return self.error_page(
                "Token exchange failed", f"{tr.status_code}: {tr.text[:300]}", self.login_path)
        access_token = tr.json().get("access_token", "")

        # Resolve identity via the workspace itself.
        email = None
        me = requests.get(f"https://{self.cfg.ws_host}/api/2.0/preview/scim/v2/Me",
                          headers={"Authorization": f"Bearer {access_token}"}, timeout=30)
        if me.status_code == 200:
            email = me.json().get("userName")

        resp = RedirectResponse(self.success_redirect, status_code=302)
        resp.set_cookie(self.cfg.cookie_name, self._signer.dumps({"email": email}),
                        httponly=True, secure=True, samesite="lax",
                        max_age=self.cfg.session_max_age)
        return resp

    def _logout(self):
        resp = RedirectResponse(self.success_redirect, status_code=302)
        resp.delete_cookie(self.cfg.cookie_name)
        return resp
