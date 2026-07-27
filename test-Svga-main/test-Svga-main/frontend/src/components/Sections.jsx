import { useEffect, useState } from "react";
import { ShieldCheck, Zap, Smartphone, Gift } from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { api } from "../lib/api";

const COMPARE = [
  { name: "Lottie", kb: 120 },
  { name: "GIF", kb: 280 },
  { name: "MP4", kb: 200 },
  { name: "SVGA", kb: 85, hl: true },
];
const WHY = [
  { icon: ShieldCheck, title: "100% Secure", desc: "Preview runs locally in your browser — files never leave your device." },
  { icon: Zap, title: "Lightning Fast", desc: "Instant SVGA playback with hardware-accelerated rendering." },
  { icon: Smartphone, title: "Device Preview", desc: "Inspect animations across iPhone, Galaxy, Pixel and custom frames." },
  { icon: Gift, title: "Completely Free", desc: "No registration, no limits. Preview and convert as much as you need." },
];
const DEFAULT_FAQ = [
  { question: "What is SVGA and why should I use it?", answer: "SVGA is a cross-platform animation format that renders After Effects and Animate CC animations natively on iOS, Android, Flutter, Web and HarmonyOS, with smaller file sizes than GIF or MP4." },
  { question: "Why won't my SVGA file load?", answer: "Ensure the file has a valid .svga extension and isn't corrupted. Very large files take longer to parse. Confirm it was exported correctly from After Effects or Animate CC." },
  { question: "How do I create SVGA files?", answer: "Design animations in After Effects or Animate CC, then export them with the official SVGA converter plugins, or use the conversion tools on this site." },
  { question: "Is my data safe?", answer: "Yes. All preview processing happens locally in your browser. Files used for conversion are processed transiently and not retained." },
];

export function Sections() {
  const [faq, setFaq] = useState(DEFAULT_FAQ);

  useEffect(() => {
    api.get("/faq").then((r) => { if (r.data?.length) setFaq(r.data); }).catch(() => {});
  }, []);

  const max = Math.max(...COMPARE.map((c) => c.kb));

  return (
    <div className="space-y-24">
      {/* About + comparison */}
      <section id="about">
        <div className="grid lg:grid-cols-2 gap-12 items-center">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-blue-500 font-medium mb-3">About the format</p>
            <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight">What is SVGA?</h2>
            <p className="text-zinc-400 mt-4 leading-relaxed">
              SVGA is a cross-platform animation format for rendering After Effects and Animate CC animations
              natively across mobile and web. It delivers high-performance playback at a fraction of the file size.
            </p>
            <ul className="mt-6 space-y-3">
              {["Cross-platform — iOS, Android, Flutter, Web, HarmonyOS", "High performance with minimal resource use", "Designer-friendly export pipeline", "Compact, efficient file sizes"].map((t) => (
                <li key={t} className="flex gap-3 text-sm text-zinc-300">
                  <span className="mt-1.5 h-1.5 w-1.5 rounded-full bg-blue-500 shrink-0" />{t}
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-6">
            <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500 mb-5">File size comparison</p>
            <div className="space-y-4">
              {COMPARE.map((c) => (
                <div key={c.name}>
                  <div className="flex justify-between text-sm mb-1.5">
                    <span className={c.hl ? "text-blue-400 font-medium" : "text-zinc-300"}>{c.name}</span>
                    <span className="font-mono text-zinc-400">{c.kb}kb</span>
                  </div>
                  <div className="h-2.5 rounded-full bg-zinc-900 overflow-hidden">
                    <div className={`h-full rounded-full ${c.hl ? "bg-blue-500" : "bg-zinc-600"}`} style={{ width: `${(c.kb / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Why */}
      <section>
        <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-center">Why choose our preview?</h2>
        <div className="mt-10 grid sm:grid-cols-2 lg:grid-cols-4 gap-[1px] bg-zinc-800/60 border border-zinc-800/80 rounded-xl overflow-hidden">
          {WHY.map((w) => (
            <div key={w.title} className="bg-[#0A0A0A] p-6">
              <span className="h-10 w-10 rounded-lg bg-blue-600/10 border border-blue-600/20 grid place-items-center mb-4">
                <w.icon className="h-5 w-5 text-blue-500" strokeWidth={1.5} />
              </span>
              <h3 className="font-display font-medium tracking-tight">{w.title}</h3>
              <p className="text-sm text-zinc-500 mt-1.5 leading-relaxed">{w.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section id="faq">
        <h2 className="font-display text-3xl sm:text-4xl font-bold tracking-tight text-center">Frequently asked questions</h2>
        <div className="max-w-3xl mx-auto mt-10">
          <Accordion type="single" collapsible className="space-y-3" data-testid="faq-accordion">
            {faq.map((f, i) => (
              <AccordionItem key={f.id || i} value={`item-${i}`} className="border border-zinc-800/80 rounded-lg px-5 bg-[#0A0A0A]">
                <AccordionTrigger data-testid={`faq-q-${i}`} className="text-left font-medium hover:no-underline">{f.question}</AccordionTrigger>
                <AccordionContent className="text-zinc-400 leading-relaxed">{f.answer}</AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </div>
      </section>
    </div>
  );
}
