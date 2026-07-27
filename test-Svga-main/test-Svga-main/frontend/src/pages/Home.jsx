import { Header } from "../components/Header";
import { Link } from "react-router-dom";
import { Eraser, ArrowRight } from "lucide-react";
import { SvgaPreviewer } from "../components/SvgaPreviewer";
import { ConvertTools } from "../components/ConvertTools";
import { Sections } from "../components/Sections";

function Footer() {
  return (
    <footer className="border-t border-zinc-800/80 mt-24">
      <div className="max-w-7xl mx-auto px-5 md:px-8 py-10 flex flex-col sm:flex-row items-center justify-between gap-4">
        <p className="text-sm text-zinc-500">© {new Date().getFullYear()} SVGA.studio — preview & convert SVGA animations.</p>
        <p className="font-mono text-xs text-zinc-600">Built for iOS · Android · Flutter · Web · HarmonyOS</p>
      </div>
    </footer>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-[#050505]">
      <Header />

      <section className="relative overflow-hidden border-b border-zinc-800/60">
        <div
          className="absolute inset-0 opacity-[0.12] pointer-events-none"
          style={{
            backgroundImage:
              "url(https://images.unsplash.com/photo-1718844054440-22acf5d5c8f0?crop=entropy&cs=srgb&fm=jpg&q=85&w=1600)",
            backgroundSize: "cover",
            maskImage: "linear-gradient(to bottom, black, transparent)",
            WebkitMaskImage: "linear-gradient(to bottom, black, transparent)",
          }}
        />
        <div className="relative max-w-7xl mx-auto px-5 md:px-8 pt-16 pb-12">
          <div className="max-w-3xl fade-up">
            <span className="inline-flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-xs font-mono text-zinc-400 mb-5">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" /> Secure · in-browser preview
            </span>
            <h1 className="font-display text-4xl sm:text-5xl lg:text-6xl font-black tracking-tighter leading-none">
              Preview & convert <span className="text-blue-500">SVGA</span> animations.
            </h1>
            <p className="text-zinc-400 mt-5 text-base leading-relaxed">
              Drag, drop and inspect SVGA files instantly across device frames — preview many at once, record any animation to video, and convert to/from GIF, MP4, WebP, PNG, Lottie and JSON.
            </p>
          </div>

          <div className="mt-10">
            <SvgaPreviewer />
          </div>
        </div>
      </section>

      <section className="max-w-7xl mx-auto px-5 md:px-8 py-20">
        <p className="text-xs uppercase tracking-[0.2em] text-blue-500 font-medium mb-3">Toolkit</p>
        <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight mb-10">SVGA convert tools</h2>
        <ConvertTools />

        <Link to="/remove-bg" data-testid="removebg-cta"
          className="group mt-8 flex items-center justify-between rounded-xl border border-zinc-800/80 bg-gradient-to-r from-blue-600/10 to-transparent hover:border-blue-600/40 p-6 transition-colors">
          <div className="flex items-center gap-4">
            <span className="h-11 w-11 rounded-lg bg-blue-600/15 border border-blue-600/30 grid place-items-center">
              <Eraser className="h-5 w-5 text-blue-400" strokeWidth={1.5} />
            </span>
            <div>
              <h3 className="font-display font-medium tracking-tight text-lg">AI Background Remover</h3>
              <p className="text-sm text-zinc-500">Remove backgrounds from images & videos — transparent, solid color or custom image.</p>
            </div>
          </div>
          <ArrowRight className="h-5 w-5 text-zinc-500 group-hover:text-blue-400 group-hover:translate-x-1 transition-all" />
        </Link>
      </section>

      <section className="max-w-7xl mx-auto px-5 md:px-8 pb-10">
        <Sections />
      </section>

      <Footer />
    </div>
  );
}
