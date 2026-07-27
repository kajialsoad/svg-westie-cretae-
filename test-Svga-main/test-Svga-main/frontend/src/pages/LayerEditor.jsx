import { useRef, useState } from "react";
import { Header } from "../components/Header";
import { SvgaCanvas } from "../components/SvgaCanvas";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { UploadCloud, Eye, EyeOff, ArrowUp, ArrowDown, Loader2, Download, Layers } from "lucide-react";
import { api, apiErr } from "../lib/api";
import { pollJob, saveBlob } from "../lib/jobs";
import { toast } from "sonner";

const FORMATS = [
  { v: "gif", label: "GIF" },
  { v: "mp4", label: "MP4" },
  { v: "webp", label: "WebP (animated)" },
  { v: "png", label: "PNG frames (zip)" },
  { v: "alpha-webm", label: "Alpha WebM (VP9)" },
  { v: "alpha-mov", label: "Alpha MOV (ProRes 4444)" },
  { v: "svga", label: "SVGA (re-export)" },
];

function LayerRow({ layer, edit, pos, total, onChange, onMove }) {
  return (
    <div data-testid={`layer-row-${layer.index}`} className="flex items-center gap-3 rounded-lg border border-zinc-800/80 bg-[#0A0A0A] p-3">
      <div className="h-12 w-12 shrink-0 rounded-md checker overflow-hidden grid place-items-center">
        {layer.thumb ? <img src={layer.thumb} alt="" className="max-w-full max-h-full object-contain" /> : <Layers className="h-4 w-4 text-zinc-600" />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-mono text-zinc-300 truncate">L{layer.index} · {layer.imageKey}</span>
          <button data-testid={`layer-toggle-${layer.index}`} onClick={() => onChange({ visible: !edit.visible })}
            className={`shrink-0 ${edit.visible ? "text-blue-400" : "text-zinc-600"}`}>
            {edit.visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 mt-2">
          <label className="flex items-center gap-2 text-[11px] text-zinc-500">Opacity
            <input type="range" min="0" max="1" step="0.05" value={edit.opacity} data-testid={`layer-opacity-${layer.index}`}
              onChange={(e) => onChange({ opacity: parseFloat(e.target.value) })} className="flex-1 accent-blue-600" />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-zinc-500">Scale
            <input type="range" min="0.2" max="2" step="0.05" value={edit.scale} data-testid={`layer-scale-${layer.index}`}
              onChange={(e) => onChange({ scale: parseFloat(e.target.value) })} className="flex-1 accent-blue-600" />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-zinc-500">X
            <input type="number" value={edit.dx} data-testid={`layer-dx-${layer.index}`}
              onChange={(e) => onChange({ dx: parseFloat(e.target.value) || 0 })}
              className="w-16 bg-[#050505] border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-white" />
          </label>
          <label className="flex items-center gap-2 text-[11px] text-zinc-500">Y
            <input type="number" value={edit.dy} data-testid={`layer-dy-${layer.index}`}
              onChange={(e) => onChange({ dy: parseFloat(e.target.value) || 0 })}
              className="w-16 bg-[#050505] border border-zinc-800 rounded px-1.5 py-0.5 text-xs text-white" />
          </label>
        </div>
      </div>
      <div className="flex flex-col gap-1 shrink-0">
        <button data-testid={`layer-up-${layer.index}`} disabled={pos === 0} onClick={() => onMove(-1)}
          className="text-zinc-500 hover:text-white disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
        <button data-testid={`layer-down-${layer.index}`} disabled={pos === total - 1} onClick={() => onMove(1)}
          className="text-zinc-500 hover:text-white disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

export default function LayerEditor() {
  const [file, setFile] = useState(null);
  const [meta, setMeta] = useState(null);
  const [edits, setEdits] = useState({});
  const [order, setOrder] = useState([]);
  const [format, setFormat] = useState("alpha-webm");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);
  const inputRef = useRef(null);

  const load = async (f) => {
    if (!f || !f.name.toLowerCase().endsWith(".svga")) { toast.error("Select a .svga file"); return; }
    setFile(f); setResult(null);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api.post("/svga/layers", fd);
      setMeta(r.data);
      const e = {};
      r.data.layers.forEach((l) => { e[l.index] = { visible: true, opacity: 1, scale: 1, dx: 0, dy: 0 }; });
      setEdits(e);
      setOrder(r.data.layers.map((l) => l.index));
    } catch (err) { toast.error(apiErr(err)); setFile(null); setMeta(null); }
  };

  const setEdit = (idx, patch) => setEdits((p) => ({ ...p, [idx]: { ...p[idx], ...patch } }));
  const move = (idx, dir) => setOrder((p) => {
    const i = p.indexOf(idx); const j = i + dir;
    if (j < 0 || j >= p.length) return p;
    const n = [...p]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  const doExport = async () => {
    if (!file) return;
    setBusy(true); setResult(null); setStatus("Rendering edited layers…");
    const payload = {};
    order.forEach((idx, pos) => { payload[idx] = { ...edits[idx], order: pos }; });
    const fd = new FormData();
    fd.append("file", file);
    fd.append("edits", JSON.stringify(payload));
    fd.append("target", format);
    try {
      const sub = await api.post("/jobs/svga-export", fd);
      const { blob, ext } = await pollJob(sub.data.job_id, { onTick: () => setStatus("Rendering & encoding…") });
      const url = URL.createObjectURL(blob);
      setResult({ url, ext });
      saveBlob(blob, `${file.name.replace(/\.svga$/i, "")}-edited.${ext}`);
      toast.success("Export ready — downloading");
    } catch (e) { toast.error(e.message || apiErr(e)); }
    finally { setBusy(false); setStatus(""); }
  };

  const isVideo = result && ["webm", "mp4", "mov"].includes(result.ext);
  const isImg = result && ["gif", "webp"].includes(result.ext);

  return (
    <div className="min-h-screen bg-[#050505]">
      <Header />
      <div className="max-w-7xl mx-auto px-5 md:px-8 py-14">
        <p className="text-xs uppercase tracking-[0.2em] text-blue-500 font-medium mb-3">Editor</p>
        <h1 className="font-display text-4xl sm:text-5xl font-black tracking-tighter">SVGA layer editor</h1>
        <p className="text-zinc-400 mt-4 max-w-2xl">Separate an SVGA into its layers, then toggle, fade, move, scale and reorder each one before exporting to any format — including transparent Alpha video.</p>

        {!meta ? (
          <div data-testid="editor-dropzone" onClick={() => inputRef.current?.click()}
            className="mt-10 cursor-pointer rounded-xl border-2 border-dashed border-zinc-700 hover:border-blue-500 hover:bg-blue-900/5 transition-colors p-16 text-center">
            <UploadCloud className="h-8 w-8 text-blue-500 mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-sm text-zinc-300">Drop or click to select an .svga file</p>
            <input ref={inputRef} type="file" accept=".svga" hidden data-testid="editor-file-input"
              onChange={(e) => load(e.target.files?.[0])} />
          </div>
        ) : (
          <div className="mt-10 grid lg:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-4">
                <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Original preview · {meta.width}×{meta.height} · {meta.layerCount} layers</p>
                <div className="checker h-64 grid place-items-center rounded-lg">
                  <SvgaCanvas file={file} className="w-full h-full block" />
                </div>
              </div>
              <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-4 space-y-3">
                <div className="flex items-center gap-3">
                  <Select value={format} onValueChange={setFormat}>
                    <SelectTrigger data-testid="export-format-select" className="bg-[#050505] border-zinc-800 text-white flex-1"><SelectValue /></SelectTrigger>
                    <SelectContent>{FORMATS.map((f) => <SelectItem key={f.v} value={f.v}>{f.label}</SelectItem>)}</SelectContent>
                  </Select>
                  <button data-testid="export-btn" onClick={doExport} disabled={busy}
                    className="inline-flex items-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-5 py-2.5 font-medium transition-colors">
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
                  </button>
                </div>
                {status && <p data-testid="editor-status" className="text-sm text-zinc-500">{status}</p>}
                {result && (
                  <div className="checker rounded-lg p-3 grid place-items-center min-h-[180px]" data-testid="editor-result">
                    {isVideo && <video src={result.url} className="max-h-64" autoPlay loop muted controls />}
                    {isImg && <img src={result.url} alt="result" className="max-h-64" />}
                    {!isVideo && !isImg && <p className="text-sm text-zinc-400">Downloaded .{result.ext}</p>}
                  </div>
                )}
              </div>
            </div>

            <div className="space-y-2.5 max-h-[640px] overflow-y-auto thin-scroll pr-1" data-testid="layers-list">
              {order.map((idx, pos) => {
                const layer = meta.layers.find((l) => l.index === idx);
                if (!layer) return null;
                return (
                  <LayerRow key={idx} layer={layer} edit={edits[idx]} pos={pos} total={order.length}
                    onChange={(patch) => setEdit(idx, patch)} onMove={(dir) => move(idx, dir)} />
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
