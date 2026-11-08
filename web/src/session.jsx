import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { ApiError, request } from "./api.js";

const SessionContext = createContext(null);
const TOKEN_KEY = "ledgerproof.token";

// The token lives in sessionStorage: it disappears when the tab closes. Any script running on this
// page could read it, which is why the app renders everything through React (no raw HTML).
function readToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function saveToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Storage can be blocked; the session then lasts until the page reloads.
  }
}

export function SessionProvider({ children }) {
  const [token, setToken] = useState(readToken);
  const [user, setUser] = useState(null);

  const logout = useCallback(() => {
    saveToken(null);
    setToken(null);
    setUser(null);
  }, []);

  // Restores the user after a page reload. The role always comes from the server, never from the token.
  useEffect(() => {
    if (!token || user) return undefined;
    let cancelled = false;
    request("GET", "/api/me", { token })
      .then(({ data }) => !cancelled && setUser(data.user))
      .catch(() => !cancelled && logout());
    return () => {
      cancelled = true;
    };
  }, [token, user, logout]);

  const login = useCallback(async (email, password) => {
    const { data } = await request("POST", "/api/auth/login", { body: { email, password } });
    const me = await request("GET", "/api/me", { token: data.token });
    saveToken(data.token);
    setToken(data.token);
    setUser(me.data.user);
  }, []);

  // An authenticated request; an expired or revoked token (401) signs the user out.
  const call = useCallback(
    async (method, path, options) => {
      try {
        return await request(method, path, { ...options, token });
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) logout();
        throw err;
      }
    },
    [token, logout],
  );

  const value = useMemo(() => ({ ready: !token || Boolean(user), user, login, logout, call }), [token, user, login, logout, call]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  return useContext(SessionContext);
}
