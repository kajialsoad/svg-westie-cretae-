import { useRef, useState } from "react";
import { FileUp, Download, Loader2, ArrowRight } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { api, apiErr } from "../lib/api";
import { pollJob, saveBlob } from "../lib/jobs";
import { toast } from "sonner";

const TO_SVGA = [
  { kind: "gif-to-svga", title: "GIF → SVGA", desc: "Convert animations to SVGA", accept: ".gif" },
  { kind: "mp4-to-svga", title: "MP4 → SVGA", desc: "Video → SVGA, optional bg removal, under 5MB", accept: ".mp4,.mov,.webm,.avi,.mkv", job: true },
  { kind: "webp-to-svga", title: "WebP → SVGA", desc: "Maintain transparency, reduce size", accept: ".webp" },
];
const FROM_SVGA = [
  { kind: "svga-to-gif", title: "SVGA → GIF", desc: "Export as animated GIF" },
  { kind: "svga-to-mp4", title: "SVGA → MP4", desc: "Export as video file" },
  { kind: "svga-to-alpha-webm", title: "SVGA → Alpha WebM", desc: "Transparent video (VP9)" },
  { kind: "svga-to-alpha-mov", title: "SVGA → Alpha MOV", desc: "ProRes 4444 for video editors" },
  { kind: "svga-to-png", title: "SVGA → PNG", desc: "Frames as PNG sequence (zip)" },
  { kind: "svga-to-webp", title: "SVGA → WebP", desc: "Modern animated web format" },
  { kind: "svga-to-lottie", title: "SVGA → Lottie", desc: "Convert to Lottie JSON" },
  { kind: "svga-to-json", title: "SVGA → JSON", desc: "Export animation data" },
];

function ToolCard({ tool, onClick }) {
  return (
    <button
      data-testid={`tool-${tool.kind}`}
      onClick={() => onClick(tool)}
      className="group text-left p-5 bg-[#0A0A0A] hover:bg-zinc-900/60 transition-colors relative"
    >
      <div className="flex items-center justify-between">
        <span className="font-display font-medium text-base tracking-tight">{tool.title}</span>
        <ArrowRight className="h-4 w-4 text-zinc-600 group-hover:text-blue-500 group-hover:translate-x-1 transition-all" />
      </div>
      <p className="text-sm text-zinc-500 mt-1.5">{tool.desc}</p>
    </button>
  );
}

export function ConvertTools() {
  const [open, setOpen] = useState(false);
  const [tool, setTool] = useState(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState(null);
  const [removeBg, setRemoveBg] = useState(false);
  const [preset, setPreset] = useState("balanced");
  const [status, setStatus] = useState("");
  const inputRef = useRef(null);

  const openTool = (t) => { setTool(t); setFile(null); setStatus(""); setRemoveBg(false); setOpen(true); };

  const runJob = async () => {
    setStatus("Uploading…");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("remove_bg", removeBg ? "true" : "false");
    fd.append("preset", preset);
    const sub = await api.post("/jobs/mp4-to-svga", fd);
    setStatus(removeBg ? "Removing background & building SVGA… (can take a few minutes)" : "Building SVGA…");
    const { blob, ext, size } = await pollJob(sub.data.job_id, {
      onTick: (s) => setStatus(s.status === "processing" ? (removeBg ? "Removing background & building SVGA…" : "Building SVGA…") : s.status),
    });
    saveBlob(blob, `${(file.name || "video").replace(/\.[^.]+$/, "")}.${ext}`);
    let kb = "";
    if (size) kb = size < 1024 * 1024 ? ` (${Math.max(1, Math.round(size / 1024))} KB)` : ` (${(size / 1024 / 1024).toFixed(2)} MB)`;
    toast.success(`SVGA ready${kb} — downloading`);
  };

  const runSync = async () => {
    const fd = new FormData();
    fd.append("file", file);
    const r = await api.post(`/convert/${tool.kind}`, fd, { responseType: "blob" });
    const cd = r.headers["content-disposition"] || "";
    const m = cd.match(/filename="?(.+?)"?$/);
    saveBlob(r.data, m ? m[1] : "output");
    toast.success("Conversion complete — downloading");
  };

  const run = async () => {
    if (!file) { toast.error("Select a file first"); return; }
    setBusy(true);
    try {
      if (tool.job) await runJob();
      else await runSync();
      setOpen(false);
    } catch (e) {
      let msg = "Conversion failed";
      if (e.response?.data instanceof Blob) { try { msg = JSON.parse(await e.response.data.text()).detail || msg; } catch (parseErr) { console.error("convert error parse failed", parseErr); } }
      else msg = e.message || apiErr(e);
      toast.error(msg);
    } finally { setBusy(false); setStatus(""); }
  };

  const accept = tool ? (tool.accept || ".svga") : "";

  return (
    <>
      <div className="space-y-8">
        <div>
          <h3 className="font-display text-lg font-medium tracking-tight mb-3 text-zinc-300">Convert to SVGA</h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-[1px] bg-zinc-800/60 border border-zinc-800/80 rounded-lg overflow-hidden">
            {TO_SVGA.map((t) => <ToolCard key={t.kind} tool={t} onClick={openTool} />)}
          </div>
        </div>
        <div>
          <h3 className="font-display text-lg font-medium tracking-tight mb-3 text-zinc-300">Convert from SVGA</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-[1px] bg-zinc-800/60 border border-zinc-800/80 rounded-lg overflow-hidden">
            {FROM_SVGA.map((t) => <ToolCard key={t.kind} tool={t} onClick={openTool} />)}
          </div>
        </div>
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="bg-[#0A0A0A] border-zinc-800 text-white" data-testid="convert-dialog">
          <DialogHeader>
            <DialogTitle className="font-display tracking-tight">{tool?.title}</DialogTitle>
            <DialogDescription className="text-zinc-500">{tool?.desc}</DialogDescription>
          </DialogHeader>
          <div
            onClick={() => inputRef.current?.click()}
            className="cursor-pointer rounded-lg border-2 border-dashed border-zinc-700 hover:border-blue-500 transition-colors p-8 text-center"
            data-testid="convert-dropzone"
          >
            <FileUp className="h-7 w-7 text-blue-500 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-sm text-zinc-300">{file ? file.name : `Select a file (${accept})`}</p>
            <input ref={inputRef} type="file" accept={accept} hidden data-testid="convert-file-input"
              onChange={(e) => setFile(e.target.files?.[0])} />
          </div>

          {tool?.job && (
            <div className="space-y-3 rounded-lg border border-zinc-800 p-4">
              <label className="flex items-center gap-3 cursor-pointer">
                <input type="checkbox" data-testid="remove-bg-checkbox" checked={removeBg}
                  onChange={(e) => setRemoveBg(e.target.checked)} className="h-4 w-4 accent-blue-600" />
                <span className="text-sm text-zinc-200">Auto-remove background (AI)</span>
              </label>
              <div>
                <span className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">Quality preset</span>
                <Select value={preset} onValueChange={setPreset}>
                  <SelectTrigger data-testid="preset-select" className="mt-2 bg-[#050505] border-zinc-800 text-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="small">Small — 480p · 12fps</SelectItem>
                    <SelectItem value="balanced">Balanced — 540p · 15fps (recommended)</SelectItem>
                    <SelectItem value="quality">Quality — 720p · 20fps</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-zinc-600 mt-2">Output auto-compresses to stay under 5MB for 10–15s clips.</p>
              </div>
            </div>
          )}

          {status && <p data-testid="convert-status" className="text-sm text-zinc-500">{status}</p>}
          <button
            data-testid="convert-run-btn"
            disabled={busy}
            onClick={run}
            className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-4 py-2.5 font-medium transition-colors"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            {busy ? "Converting…" : "Convert & Download"}
          </button>
        </DialogContent>
      </Dialog>
    </>
  );
}
