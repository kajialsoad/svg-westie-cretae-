import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Boxes, Loader2, Mail, Lock, User } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { apiErr } from "../lib/api";
import { toast } from "sonner";

export default function Login() {
  const { login, register, loginGoogle, user } = useAuth();
  const nav = useNavigate();
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const hash = window.location.hash;
    if (hash.includes("session_id=")) {
      const sid = new URLSearchParams(hash.replace("#", "")).get("session_id");
      if (sid) {
        setBusy(true);
        loginGoogle(sid)
          .then(() => { window.location.hash = ""; toast.success("Signed in with Google"); nav("/admin"); })
          .catch((e) => toast.error(apiErr(e)))
          .finally(() => setBusy(false));
      }
    } else if (user) {
      nav("/admin");
    }
  }, []); // eslint-disable-line

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "login") await login(email, password);
      else await register(email, password, name || "User");
      toast.success("Welcome back");
      nav("/admin");
    } catch (err) {
      toast.error(apiErr(err));
    } finally { setBusy(false); }
  };

  const google = () => {
    window.location.href = `https://auth.emergentagent.com/?redirect=${encodeURIComponent(window.location.origin + "/login")}`;
  };

  return (
    <div className="min-h-screen bg-[#050505] grid place-items-center px-5">
      <div className="w-full max-w-md fade-up">
        <a href="/" className="flex items-center justify-center gap-2.5 mb-8">
          <span className="h-9 w-9 rounded-md bg-blue-600 grid place-items-center shadow-[0_0_18px_rgba(37,99,235,0.4)]">
            <Boxes className="h-5 w-5 text-white" />
          </span>
          <span className="font-display font-bold text-xl tracking-tight">SVGA<span className="text-blue-500">.studio</span></span>
        </a>

        <div className="rounded-2xl border border-zinc-800/80 bg-[#0A0A0A] p-7">
          <h1 className="font-display text-2xl font-bold tracking-tight">{mode === "login" ? "Admin sign in" : "Create account"}</h1>
          <p className="text-sm text-zinc-500 mt-1">Manage the showcase gallery, FAQ and stats.</p>

          <form onSubmit={submit} className="mt-6 space-y-4">
            {mode === "register" && (
              <div className="relative">
                <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
                <input data-testid="name-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name"
                  className="w-full bg-[#050505] border border-zinc-800 focus:border-blue-500 rounded-md pl-10 pr-3 py-2.5 text-sm outline-none" />
              </div>
            )}
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
              <input data-testid="email-input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Email"
                className="w-full bg-[#050505] border border-zinc-800 focus:border-blue-500 rounded-md pl-10 pr-3 py-2.5 text-sm outline-none" />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-500" />
              <input data-testid="password-input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password"
                className="w-full bg-[#050505] border border-zinc-800 focus:border-blue-500 rounded-md pl-10 pr-3 py-2.5 text-sm outline-none" />
            </div>
            <button data-testid="submit-auth-btn" disabled={busy}
              className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2.5 font-medium transition-colors">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {mode === "login" ? "Sign in" : "Create account"}
            </button>
          </form>

          <div className="flex items-center gap-3 my-5">
            <div className="h-px flex-1 bg-zinc-800" /><span className="text-xs text-zinc-600">or</span><div className="h-px flex-1 bg-zinc-800" />
          </div>

          <button data-testid="google-login-btn" onClick={google}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md border border-zinc-700 hover:bg-zinc-900 text-zinc-200 py-2.5 font-medium transition-colors">
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" alt="" className="h-4 w-4" />
            Continue with Google
          </button>

          <p className="text-center text-sm text-zinc-500 mt-6">
            {mode === "login" ? "Need an account?" : "Already have one?"}{" "}
            <button data-testid="toggle-mode-btn" onClick={() => setMode(mode === "login" ? "register" : "login")} className="text-blue-500 hover:underline">
              {mode === "login" ? "Register" : "Sign in"}
            </button>
          </p>
          <p className="text-center text-xs text-zinc-700 mt-3 font-mono">admin@svga.dev · admin123</p>
        </div>
      </div>
    </div>
  );
}
