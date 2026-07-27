import { Link, useLocation } from "react-router-dom";
import { Boxes } from "lucide-react";
import { useAuth } from "../context/AuthContext";

export function Header() {
  const { pathname } = useLocation();
  const { user } = useAuth();
  const nav = [
    { to: "/", label: "Preview" },
    { to: "/remove-bg", label: "Remove BG" },
    { to: "/editor", label: "Editor" },
    { to: "/showcase", label: "Showcase" },
  ];
  return (
    <header
      data-testid="site-header"
      className="sticky top-0 z-50 backdrop-blur-xl bg-[#050505]/80 border-b border-zinc-800/80"
    >
      <div className="max-w-7xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a
            href="/"
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 border border-indigo-500/30 transition-colors flex items-center gap-1"
          >
            ← AnimSuite Pro
          </a>
          <Link to="/" data-testid="logo-link" className="flex items-center gap-2.5 group">
            <span className="h-8 w-8 rounded-md bg-blue-600 grid place-items-center shadow-[0_0_18px_rgba(37,99,235,0.4)]">
              <Boxes className="h-4.5 w-4.5 text-white" strokeWidth={2} />
            </span>
            <span className="font-display font-bold text-lg tracking-tight">SVGA<span className="text-blue-500">.studio</span></span>
          </Link>
        </div>
        <nav className="flex items-center gap-1">
          {nav.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              data-testid={`nav-${n.label.toLowerCase()}`}
              className={`px-3.5 py-2 rounded-md text-sm font-medium transition-colors ${
                pathname === n.to ? "text-white bg-zinc-800/60" : "text-zinc-400 hover:text-white hover:bg-zinc-900"
              }`}
            >
              {n.label}
            </Link>
          ))}
          <Link
            to={user ? "/admin" : "/login"}
            data-testid="nav-admin"
            className="ml-2 px-4 py-2 rounded-md text-sm font-medium bg-blue-600 text-white hover:bg-blue-500 transition-colors shadow-[0_0_15px_rgba(37,99,235,0.25)]"
          >
            {user ? "Dashboard" : "Admin"}
          </Link>
        </nav>
      </div>
    </header>
  );
}
