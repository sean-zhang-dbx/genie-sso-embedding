'use client';

import React, { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { AccountInfo } from '@azure/msal-browser';
import { initializeMsal, authHelpers } from './msalAuthSetup';
import {
  mintMode,
  genieStatus,
  startServerMint,
  bootstrapDatabricksSessionPopup,
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
  genieReady: boolean;      // Databricks cookie minted, iframe safe to render
  geniePreparing: boolean;  // bootstrap popup in progress
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
    if (genieReady || geniePreparing) return;
    try {
      setGeniePreparing(true);

      if (mintMode() === 'server') {
        // Server mode: is the Databricks cookie already minted this session?
        const status = await genieStatus();
        if (status.ready) {
          setGenieReady(true);
          return;
        }
        // Not yet — full-page redirect into the server mint chain. This
        // navigates away; on return, initializeAuth() runs prepareGenie() again
        // and genieStatus() now reports ready=true.
        startServerMint();
        return; // navigation in flight; nothing more to do here
      }

      // Popup mode: original client-only bootstrap.
      await bootstrapDatabricksSessionPopup();
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
  };

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
};
