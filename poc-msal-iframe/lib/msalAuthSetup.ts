import { PublicClientApplication, Configuration, PopupRequest, SilentRequest } from "@azure/msal-browser"

// This file deliberately mirrors GSK's own msalAuthSetup: MSAL for auth +
// Microsoft Graph group-membership gating. The ONLY addition for the iframe
// PoC lives in lib/genieBootstrap.ts (the top-level /aad/auth cookie mint) —
// MSAL itself is unchanged from GSK's pattern.

if (
  !process.env.NEXT_PUBLIC_CLIENT_ID ||
  !process.env.NEXT_PUBLIC_TENANT_ID ||
  !process.env.NEXT_PUBLIC_ALLOWED_GROUP_ID
) {
  throw new Error(
    "Missing required authentication environment variables: NEXT_PUBLIC_CLIENT_ID, NEXT_PUBLIC_TENANT_ID, or NEXT_PUBLIC_ALLOWED_GROUP_ID",
  )
}

export const AUTH_CONFIG = {
  CLIENT_ID: process.env.NEXT_PUBLIC_CLIENT_ID!,
  TENANT_ID: process.env.NEXT_PUBLIC_TENANT_ID!,
  AUTHORITY:
    process.env.NEXT_PUBLIC_AUTHORITY ||
    `https://login.microsoftonline.com/${process.env.NEXT_PUBLIC_TENANT_ID}`,
  REDIRECT_URI:
    process.env.NEXT_PUBLIC_REDIRECT_URI! ||
    (typeof window !== "undefined" ? window.location.origin : ""),
  POST_LOGOUT_REDIRECT_URI:
    process.env.NEXT_PUBLIC_POST_LOGOUT_REDIRECT_URI! ||
    (typeof window !== "undefined" ? window.location.origin : ""),
  ALLOWED_GROUP_ID: process.env.NEXT_PUBLIC_ALLOWED_GROUP_ID!,
  // The Databricks resource. Delegated scope; the token authenticates any API
  // calls you make, NOT the iframe (see genieBootstrap.ts for why).
  DBX_SCOPE:
    process.env.NEXT_PUBLIC_DBX_SCOPE ||
    "2ff814a6-3304-4ab8-85cb-cd0e6f879c1d/.default",
}

const msalConfig: Configuration = {
  auth: {
    clientId: AUTH_CONFIG.CLIENT_ID,
    authority: AUTH_CONFIG.AUTHORITY,
    redirectUri: AUTH_CONFIG.REDIRECT_URI,
    postLogoutRedirectUri: AUTH_CONFIG.POST_LOGOUT_REDIRECT_URI,
    navigateToLoginRequestUrl: false,
  },
  cache: {
    cacheLocation: "localStorage",
    storeAuthStateInCookie: false,
  },
  system: {
    loggerOptions: {
      loggerCallback: (_level: number, message: any, containsPii: any) => {
        if (containsPii) return
        if (_level === 0) console.error(`[MSAL] ${message}`)
      },
    },
  },
}

// Login request — Databricks .default scope so the consent + token target the
// Azure Databricks resource, same as GSK.
export const loginRequest: PopupRequest = {
  scopes: [AUTH_CONFIG.DBX_SCOPE],
  prompt: "select_account",
}

export const silentRequest: SilentRequest = {
  scopes: [AUTH_CONFIG.DBX_SCOPE],
}

// Graph API request — separate scope for checking group membership.
export const graphRequest: SilentRequest = {
  scopes: ["User.Read"],
}

export const msalInstance = new PublicClientApplication(msalConfig)

export const initializeMsal = async (): Promise<boolean> => {
  try {
    await msalInstance.initialize()

    const response = await msalInstance.handleRedirectPromise()
    if (response && response.account) {
      msalInstance.setActiveAccount(response.account)
    }

    const accounts = msalInstance.getAllAccounts()
    if (accounts.length > 0 && !msalInstance.getActiveAccount()) {
      msalInstance.setActiveAccount(accounts[0])
    }
    return true
  } catch (error) {
    console.error("MSAL initialization failed:", error)
    return false
  }
}

// --- Group membership checks (mirrors GSK) ---------------------------------

const checkSpecificGroupMembership = async (): Promise<{
  success: boolean
  isMember: boolean
  error?: string
}> => {
  try {
    const account = msalInstance.getActiveAccount()
    if (!account) return { success: false, isMember: false, error: "No active account" }

    const response = await msalInstance.acquireTokenSilent({ ...graphRequest, account })
    if (!response.accessToken)
      return { success: false, isMember: false, error: "Failed to get access token" }

    const checkResponse = await fetch("https://graph.microsoft.com/v1.0/me/checkMemberGroups", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${response.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ groupIds: [AUTH_CONFIG.ALLOWED_GROUP_ID] }),
    })

    if (!checkResponse.ok) {
      return await checkGroupMembershipViaGraph().then((result) => ({
        success: result.success,
        isMember: result.success ? result.groups.includes(AUTH_CONFIG.ALLOWED_GROUP_ID) : false,
        error: result.error,
      }))
    }

    const data = await checkResponse.json()
    const isMember = data.value && data.value.includes(AUTH_CONFIG.ALLOWED_GROUP_ID)
    return { success: true, isMember }
  } catch (error) {
    console.error("Error in specific group membership check:", error)
    return {
      success: false,
      isMember: false,
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

const checkGroupMembershipViaGraph = async (): Promise<{
  success: boolean
  groups: string[]
  error?: string
}> => {
  try {
    const account = msalInstance.getActiveAccount()
    if (!account) return { success: false, groups: [], error: "No active account" }

    const response = await msalInstance.acquireTokenSilent({ ...graphRequest, account })
    if (!response.accessToken)
      return { success: false, groups: [], error: "Failed to get access token" }

    const graphResponse = await fetch("https://graph.microsoft.com/v1.0/me/memberOf?$select=id", {
      headers: {
        Authorization: `Bearer ${response.accessToken}`,
        "Content-Type": "application/json",
      },
    })

    if (!graphResponse.ok) {
      const errorText = await graphResponse.text()
      console.error("Graph API error:", graphResponse.status, errorText)
      return { success: false, groups: [], error: `Graph API error: ${graphResponse.status}` }
    }

    const data = await graphResponse.json()
    const userGroups = data.value?.map((group: any) => group.id) || []
    return { success: true, groups: userGroups }
  } catch (error) {
    console.error("Error checking group membership via Graph API:", error)
    return {
      success: false,
      groups: [],
      error: error instanceof Error ? error.message : "Unknown error",
    }
  }
}

const isUserInAllowedGroup = async (): Promise<boolean> => {
  try {
    const account = msalInstance.getActiveAccount()
    if (!account || !account.idTokenClaims) return false

    const claims: any = account.idTokenClaims

    // Group overage (>200 groups): the token omits `groups` and sets _claim_names.
    const hasGroupOverage = !!claims._claim_names?.groups
    if (hasGroupOverage) {
      const specificCheck = await checkSpecificGroupMembership()
      if (specificCheck.success) return specificCheck.isMember
      const graphResult = await checkGroupMembershipViaGraph()
      if (graphResult.success) return graphResult.groups.includes(AUTH_CONFIG.ALLOWED_GROUP_ID)
      return false
    }

    const userGroups: string[] = claims.groups || []
    if (userGroups.includes(AUTH_CONFIG.ALLOWED_GROUP_ID)) return true

    // No groups in token but no overage flag — safety net via Graph.
    if (userGroups.length === 0) {
      const graphResult = await checkGroupMembershipViaGraph()
      if (graphResult.success) return graphResult.groups.includes(AUTH_CONFIG.ALLOWED_GROUP_ID)
    }
    return false
  } catch (error) {
    console.error("Error in group membership check:", error)
    return false
  }
}

export const authHelpers = {
  isLoggedIn: (): boolean => msalInstance.getActiveAccount() !== null,

  getCurrentUser: () => msalInstance.getActiveAccount(),

  hasGroupAccess: async (): Promise<boolean> => await isUserInAllowedGroup(),

  getUserGroups: (): string[] => {
    try {
      const account = msalInstance.getActiveAccount()
      if (!account || !account.idTokenClaims) return []
      const claims: any = account.idTokenClaims
      return claims.groups || []
    } catch (error) {
      console.error("Error getting user groups:", error)
      return []
    }
  },

  getUserGroupsViaGraph: async (): Promise<string[]> => {
    const result = await checkGroupMembershipViaGraph()
    return result.success ? result.groups : []
  },

  loginPopup: async (): Promise<boolean> => {
    const response = await msalInstance.loginPopup(loginRequest)
    if (response && response.account) {
      msalInstance.setActiveAccount(response.account)
      return true
    }
    return false
  },

  loginSilent: async (): Promise<boolean> => {
    try {
      const accounts = msalInstance.getAllAccounts()
      if (accounts.length === 0) return false
      const response = await msalInstance.acquireTokenSilent({
        ...silentRequest,
        account: accounts[0],
      })
      if (response && response.account) {
        msalInstance.setActiveAccount(response.account)
        return true
      }
      return false
    } catch (error) {
      console.error("Silent login failed:", error)
      return false
    }
  },

  logout: async (): Promise<void> => {
    await msalInstance.logoutPopup({
      mainWindowRedirectUri: AUTH_CONFIG.POST_LOGOUT_REDIRECT_URI,
    })
  },

  getAccessToken: async (): Promise<string | null> => {
    try {
      const account = msalInstance.getActiveAccount()
      if (!account) return null
      const response = await msalInstance.acquireTokenSilent({ ...silentRequest, account })
      return response.accessToken
    } catch (error) {
      console.error("Token acquisition failed:", error)
      return null
    }
  },
}
