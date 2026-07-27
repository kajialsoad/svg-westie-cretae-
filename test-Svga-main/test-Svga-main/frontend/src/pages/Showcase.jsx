import { useEffect, useState } from "react";
import { Header } from "../components/Header";
import { SvgaCanvas } from "../components/SvgaCanvas";
import { api, API } from "../lib/api";

export default function Showcase() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/showcase").then((r) => setItems(r.data)).catch(() => {}).finally(() => setLoading(false));
  }, []);

  return (
    <div className="min-h-screen bg-[#050505]">
      <Header />
      <div className="max-w-7xl mx-auto px-5 md:px-8 py-14">
        <p className="text-xs uppercase tracking-[0.2em] text-blue-500 font-medium mb-3">Gallery</p>
        <h1 className="font-display text-4xl sm:text-5xl font-black tracking-tighter">Featured SVGA showcase</h1>
        <p className="text-zinc-400 mt-4 max-w-2xl">A curated collection of SVGA animations. Click play to watch them render live in your browser.</p>

        {loading ? (
          <p className="text-zinc-500 mt-12">Loading…</p>
        ) : items.length === 0 ? (
          <div className="mt-12 rounded-xl border border-dashed border-zinc-800 p-16 text-center text-zinc-500" data-testid="showcase-empty">
            No animations yet. Admins can add featured SVGA files from the dashboard.
          </div>
        ) : (
          <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-3 gap-5" data-testid="showcase-grid">
            {items.map((it) => (
              <div key={it.id} data-testid={`showcase-${it.id}`} className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] overflow-hidden group hover:-translate-y-1 transition-transform">
                <div className="checker h-56 grid place-items-center p-4">
                  <SvgaCanvas src={`${API}/showcase/${it.id}/file`} className="w-full h-full block" />
                </div>
                <div className="p-4 border-t border-zinc-800/80">
                  <div className="flex items-center justify-between">
                    <h3 className="font-display font-medium tracking-tight truncate">{it.title}</h3>
                    <span className="text-[10px] font-mono uppercase px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-zinc-400">{it.category}</span>
                  </div>
                  {it.description && <p className="text-sm text-zinc-500 mt-1 line-clamp-2">{it.description}</p>}
                  <div className="flex gap-3 mt-3 font-mono text-[11px] text-zinc-600">
                    <span>{it.width}×{it.height}</span><span>·</span><span>{it.frames}f</span><span>·</span><span>{it.fps}fps</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
