import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const t = localStorage.getItem("token");
    if (!t) { setLoading(false); return; }
    api.get("/auth/me")
      .then((r) => setUser(r.data))
      .catch((e) => { console.error("session check failed", e); localStorage.removeItem("token"); })
      .finally(() => setLoading(false));
  }, []);

  const finishAuth = (data) => {
    localStorage.setItem("token", data.token);
    setUser(data.user);
  };

  const login = async (email, password) => {
    const r = await api.post("/auth/login", { email, password });
    finishAuth(r.data);
    return r.data.user;
  };

  const register = async (email, password, name) => {
    const r = await api.post("/auth/register", { email, password, name });
    finishAuth(r.data);
    return r.data.user;
  };

  const loginGoogle = async (sessionId) => {
    const r = await api.post("/auth/google", {}, { headers: { "X-Session-ID": sessionId } });
    finishAuth(r.data);
    return r.data.user;
  };

  const logout = async () => {
    try { await api.post("/auth/logout"); } catch (e) { console.error("logout request failed", e); }
    localStorage.removeItem("token");
    setUser(null);
  };

  const value = useMemo(
    () => ({ user, loading, login, register, loginGoogle, logout }),
    [user, loading]
  );

  return (
    <AuthCtx.Provider value={value}>
      {children}
    </AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);
