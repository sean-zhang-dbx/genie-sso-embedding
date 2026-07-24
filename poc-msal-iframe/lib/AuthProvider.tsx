'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode, useCallback, useRef } from 'react';
import { AccountInfo, EventType, EventMessage } from '@azure/msal-browser';
import { initializeMsal, authHelpers, msalInstance } from './msalAuthSetup';
import {
  mintMode,
  genieStatus,
  startServerMint,
  silentRemint,
  mintViaPopup,
  mintViaClientPopup,
} from './genieBootstrap';

// Mirrors GSK's AuthProvider. The additions for the iframe PoC are:
//   - `genieReady` state + `prepareGenie()` which runs the /aad/auth cookie mint
//     once group access passes, BEFORE the iframe is shown.
// Everything else (MSAL init, silent login, group gating) matches GSK.
//
// prepareGenie() supports two mint strategies (NEXT_PUBLIC_MINT_MODE):
//   - "server" (default): check /api/genie-status; if not yet minted, full-page
//     redirect into /api/dbx-login (the ported genie_sso chain). On return the
//     status reads ready=true and the iframe is revealed. No popup.
//   - "popup": the original client-only popup bootstrap.
//
// Session lifecycle (server mode):
//   - Gap 1 (token refresh): on every MSAL silent token renewal we run a hidden
//     silent re-mint so the Databricks session tracks the app session.
//   - Gap 2 (cross-window Databricks logout): on window focus / visibility we
//     re-mint silently and reload the iframe behind a "Reconnecting" overlay, so
//     the user never sees Databricks' in-iframe login button. If the silent
//     re-mint fails (Entra also expired), we fall back to a visible re-auth.

interface UserInfo {
  sub?: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  given_name?: string;
  family_name?: string;
  username?: string;
}

interface AuthContextType {
  isAuthenticated: boolean;
  user: UserInfo | null;
  isLoading: boolean;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
  error: string | null;
  getUserEmail: () => string | null;
  getUserName: () => string | null;
  hasGroupAccess: boolean;
  userGroups: string[];
  accessDenied: boolean;
  // iframe PoC additions:
  genieReady: boolean;        // Databricks cookie minted, iframe safe to render
  geniePreparing: boolean;    // initial bootstrap in progress
  genieReconnecting: boolean; // silent re-mint / recovery in progress (show overlay)
  genieFrameKey: number;      // bump to force the Genie iframe to reload
  genieMayNeedReconnect: boolean; // popup mode: user returned to tab; offer a Reconnect action
  reconnectGenie: () => Promise<void>; // popup mode: re-run the mint on user click
  notifyGenieFrameLoaded: () => void;  // page calls this on each iframe load event
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

const convertMsalAccountToUserInfo = (account: AccountInfo): UserInfo => {
  const claims = account.idTokenClaims as any;
  return {
    sub: account.localAccountId,
    email: account.username,
    name: account.name || claims?.name,
    username: account.username,
    preferred_username: account.username,
    given_name: claims?.given_name,
    family_name: claims?.family_name,
  };
};

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasGroupAccess, setHasGroupAccess] = useState(false);
  const [userGroups, setUserGroups] = useState<string[]>([]);
  const [accessDenied, setAccessDenied] = useState(false);
  const [genieReady, setGenieReady] = useState(false);
  const [geniePreparing, setGeniePreparing] = useState(false);
  const [genieReconnecting, setGenieReconnecting] = useState(false);
  const [genieFrameKey, setGenieFrameKey] = useState(0);
  const [genieMayNeedReconnect, setGenieMayNeedReconnect] = useState(false);
  // Guards against overlapping recovery runs (focus can fire in bursts).
  const recoveringRef = useRef(false);
  // Set once we kick off the server-mode full-page redirect. window.location
  // navigation is async, so without this latch prepareGenie re-fires on the next
  // render and hammers /api/dbx-login (the redirect loop). Never cleared — the
  // page is leaving.
  const serverRedirectingRef = useRef(false);
  // Tracks iframe load events. The first load is the legitimate Genie render.
  // A later load we did NOT trigger ourselves means the embed navigated (almost
  // always a bounce to Databricks' login after the session died) -> offer reconnect.
  const frameLoadCountRef = useRef(0);
  const expectedReloadRef = useRef(false);

  // Called by the page on every iframe `onload`. Detects the dead-session bounce
  // proactively so the Reconnect banner appears without waiting for a tab refocus.
  const notifyGenieFrameLoaded = useCallback(() => {
    frameLoadCountRef.current += 1;
    if (frameLoadCountRef.current === 1) return;      // initial Genie load, fine
    if (expectedReloadRef.current) {                  // our own deliberate reload
      expectedReloadRef.current = false;
      return;
    }
    if (mintMode() !== 'server') setGenieMayNeedReconnect(true);
  }, []);

  const getUserEmail = (): string | null => {
    if (user?.email) return user.email;
    if (user?.preferred_username) return user.preferred_username;
    if (user?.username) return user.username;
    return null;
  };

  const getUserName = (): string | null => {
    if (user?.name) return user.name;
    if (user?.given_name && user?.family_name) return `${user.given_name} ${user.family_name}`;
    if (user?.given_name) return user.given_name;
    return null;
  };

  const checkGroupAccess = async (): Promise<boolean> => {
    try {
      const tokenGroups = authHelpers.getUserGroups();
      const graphGroups = await authHelpers.getUserGroupsViaGraph();
      const hasAccess = await authHelpers.hasGroupAccess();
      const allGroups = [...new Set([...tokenGroups, ...graphGroups])];
      setUserGroups(allGroups);
      setHasGroupAccess(hasAccess);
      return hasAccess;
    } catch (error) {
      console.error('Error in checkGroupAccess:', error);
      return false;
    }
  };

  // The iframe-PoC step: mint the Databricks session cookie top-level so the
  // iframe loads without a second login. Silent because MSAL already
  // established the Entra session.
  const prepareGenie = useCallback(async (): Promise<void> => {
    if (genieReady || geniePreparing || serverRedirectingRef.current) return;
    try {
      setGeniePreparing(true);

      const mode = mintMode();

      if (mode === 'server') {
        // Full-page OAuth redirect. Is the cookie already minted this session?
        const status = await genieStatus();
        if (status.ready) {
          setGenieReady(true);
          return;
        }
        // Not yet — full-page redirect into the server mint chain. window.location
        // navigation is async; latch first so a re-render can't re-fire this and
        // hammer /api/dbx-login before the browser actually leaves the page.
        // callback2 redirects back to "/", where prepareGenie runs once more and
        // genieStatus() now reports ready=true.
        serverRedirectingRef.current = true;
        startServerMint();
        return; // navigation in flight; nothing more to do here
      }

      if (mode === 'oauth-popup') {
        // OAuth flow carried in a popup. Resolves deterministically when
        // /api/callback2 (our origin) posts completion and self-closes.
        await mintViaPopup();
        setGenieReady(true);
        return;
      }

      // mode === 'client': no OAuth app. Best-effort popup straight to the
      // workspace /aad/auth -> embed page (ends cross-origin; best-effort close).
      await mintViaClientPopup();
      setGenieReady(true);
    } catch (err) {
      console.error('Genie bootstrap failed:', err);
      // Still reveal the iframe — worst case it prompts in-frame, which visibly
      // demonstrates the failure mode for the demo.
      setGenieReady(true);
    } finally {
      setGeniePreparing(false);
    }
  }, [genieReady, geniePreparing]);

  // Keep the Databricks session alive / recover it without the user ever seeing
  // Databricks' in-iframe login. Runs a hidden silent re-mint:
  //   - success  -> reload the iframe so it picks up the refreshed cookie
  //   - failure  -> Entra can't go silent either; fall back to a visible re-auth
  // `showOverlay` covers the iframe during focus-triggered recovery (Gap 2). The
  // proactive MSAL-renewal path (Gap 1) runs without an overlay.
  const recoverGenieSession = useCallback(
    async (showOverlay: boolean): Promise<void> => {
      if (mintMode() !== 'server') return;      // popup mode has no silent path
      if (recoveringRef.current) return;         // de-dupe bursts of focus events
      recoveringRef.current = true;
      if (showOverlay) setGenieReconnecting(true);
      try {
        const ok = await silentRemint();
        if (ok) {
          // Cookie refreshed. Reload the iframe so a dead session is replaced.
          expectedReloadRef.current = true;
          setGenieFrameKey((k) => k + 1);
        } else if (showOverlay) {
          // Silent path blocked (Entra session gone). Visible re-auth — this is
          // a genuine full re-login, not just the Databricks cookie.
          startServerMint();
        }
      } catch (err) {
        console.error('Genie session recovery failed:', err);
      } finally {
        recoveringRef.current = false;
        setGenieReconnecting(false);
      }
    },
    [],
  );

  // Popup-mode recovery (Gap 2 for popup mode). We cannot read the cross-origin
  // iframe to know its Databricks session died, so the user clicks Reconnect and
  // this re-runs the SAME interactive popup OAuth flow as fresh login. Because it
  // ends on /api/callback2 (our origin), it resolves deterministically and closes
  // itself — no timer, no cross-origin guessing. Handles the hard-logout consent
  // step too, since the popup can show it.
  const reconnectGenie = useCallback(async (): Promise<void> => {
    if (recoveringRef.current) return;
    recoveringRef.current = true;
    setGenieReconnecting(true);
    try {
      // oauth-popup: deterministic OAuth popup. client: best-effort no-OAuth popup.
      await (mintMode() === 'client' ? mintViaClientPopup() : mintViaPopup());
      expectedReloadRef.current = true; // this reload is ours; don't re-flag reconnect
      setGenieFrameKey((k) => k + 1);   // reload iframe against the refreshed cookie
      setGenieMayNeedReconnect(false);
    } catch (err) {
      console.error('Genie reconnect failed:', err);
    } finally {
      recoveringRef.current = false;
      setGenieReconnecting(false);
    }
  }, []);

  useEffect(() => {
    const initializeAuth = async () => {
      try {
        setIsLoading(true);
        setError(null);
        setAccessDenied(false);

        if (
          typeof window !== 'undefined' &&
          window.location.protocol !== 'https:' &&
          window.location.hostname !== 'localhost'
        ) {
          throw new Error('HTTPS is required for authentication. Please use HTTPS or localhost.');
        }

        const initialized = await initializeMsal();
        if (!initialized) throw new Error('Failed to initialize authentication');

        const loggedIn = authHelpers.isLoggedIn();
        if (loggedIn) {
          const currentUser = authHelpers.getCurrentUser();
          if (currentUser) {
            setUser(convertMsalAccountToUserInfo(currentUser));
            const hasAccess = await checkGroupAccess();
            if (hasAccess) setIsAuthenticated(true);
            else { setAccessDenied(true); setIsAuthenticated(false); }
          }
        } else {
          try {
            const silentLoginSuccess = await authHelpers.loginSilent();
            if (silentLoginSuccess) {
              const currentUser = authHelpers.getCurrentUser();
              if (currentUser) {
                setUser(convertMsalAccountToUserInfo(currentUser));
                const hasAccess = await checkGroupAccess();
                if (hasAccess) setIsAuthenticated(true);
                else { setAccessDenied(true); setIsAuthenticated(false); }
              }
            }
          } catch {
            /* silent login not available */
          }
        }
      } catch (err) {
        console.error('Auth initialization error:', err);
        setError(err instanceof Error ? err.message : 'Authentication initialization failed');
      } finally {
        setIsLoading(false);
      }
    };
    initializeAuth();
  }, []);

  // Once authenticated + group-approved, mint the Databricks cookie so the
  // iframe can render with no second login.
  useEffect(() => {
    if (isAuthenticated && hasGroupAccess) prepareGenie();
  }, [isAuthenticated, hasGroupAccess, prepareGenie]);

  // Gap 1 — token refresh. MSAL raises ACQUIRE_TOKEN_SUCCESS on every silent
  // Entra token renewal. Piggyback on it to refresh the Databricks session on
  // the same cadence, so the cookie never drifts out of sync with the app
  // session. No overlay: this is proactive upkeep, not a user-visible recovery.
  useEffect(() => {
    if (!genieReady) return;
    const callbackId = msalInstance.addEventCallback((message: EventMessage) => {
      if (
        message.eventType === EventType.ACQUIRE_TOKEN_SUCCESS ||
        message.eventType === EventType.SSO_SILENT_SUCCESS
      ) {
        recoverGenieSession(false);
      }
    });
    return () => {
      if (callbackId) msalInstance.removeEventCallback(callbackId);
    };
  }, [genieReady, recoverGenieSession]);

  // Gap 2 — cross-window Databricks logout. When the user returns to the app tab
  // (they log out of Databricks elsewhere, then come back), we recover the
  // session so they never have to touch Databricks' in-iframe login button.
  //   - server mode: silently re-mint behind an overlay and reload the iframe.
  //   - popup mode: we cannot read the cross-origin iframe to know the session
  //     died, so surface a Reconnect affordance the user clicks (a gesture also
  //     satisfies popup-blocker rules); reconnectGenie() then re-mints + reloads.
  useEffect(() => {
    if (!genieReady) return;
    const onFocus = () => {
      if (document.visibilityState !== 'visible') return;
      if (recoveringRef.current) return; // a reconnect is completing; don't re-flag
      if (mintMode() === 'server') {
        recoverGenieSession(true);
      } else {
        setGenieMayNeedReconnect(true);
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [genieReady, recoverGenieSession]);

  const login = async (): Promise<void> => {
    try {
      setIsLoading(true);
      setError(null);
      setAccessDenied(false);

      const success = await authHelpers.loginPopup();
      if (success) {
        const currentUser = authHelpers.getCurrentUser();
        if (currentUser) {
          setUser(convertMsalAccountToUserInfo(currentUser));
          const hasAccess = await checkGroupAccess();
          if (hasAccess) {
            setIsAuthenticated(true);
          } else {
            setAccessDenied(true);
            setIsAuthenticated(false);
            throw new Error("You currently don't have access. Please contact support for access.");
          }
        }
      } else {
        throw new Error('Login was not successful');
      }
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : 'Login failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  };

  const logout = useCallback(async (): Promise<void> => {
    try {
      setIsLoading(true);
      setError(null);
      await authHelpers.logout();
      setUser(null);
      setIsAuthenticated(false);
      setHasGroupAccess(false);
      setUserGroups([]);
      setAccessDenied(false);
      setGenieReady(false);
      setGenieReconnecting(false);
      setGenieMayNeedReconnect(false);
    } catch (err) {
      console.error('Logout error:', err);
      setError(err instanceof Error ? err.message : 'Logout failed');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const getAccessToken = async (): Promise<string | null> => {
    try {
      return await authHelpers.getAccessToken();
    } catch (err) {
      console.error('Token retrieval error:', err);
      return null;
    }
  };

  const contextValue: AuthContextType = {
    isAuthenticated,
    user,
    isLoading,
    login,
    logout,
    getAccessToken,
    error,
    getUserEmail,
    getUserName,
    hasGroupAccess,
    userGroups,
    accessDenied,
    genieReady,
    geniePreparing,
    genieReconnecting,
    genieFrameKey,
    genieMayNeedReconnect,
    reconnectGenie,
    notifyGenieFrameLoaded,
  };

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
