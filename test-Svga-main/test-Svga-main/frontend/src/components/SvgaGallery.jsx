import { useRef, useState } from "react";
import { Video, X, Plus, RotateCcw, Loader2 } from "lucide-react";
import { SvgaCanvas } from "./SvgaCanvas";
import { recordCanvasComposite, downloadBlob } from "../lib/recorder";
import { toast } from "sonner";

const BGS = ["transparent", "#050505", "#FFFFFF", "#2563EB", "#10B981", "#F59E0B"];

function GalleryTile({ file, idx, bg, onRemove }) {
  const canvasRef = useRef(null);
  const [recording, setRecording] = useState(false);

  const record = async () => {
    if (!canvasRef.current) { toast.error("Animation still loading"); return; }
    setRecording(true);
    toast.info("Recording 4s…");
    try {
      const blob = await recordCanvasComposite(canvasRef.current, 4, bg);
      downloadBlob(blob, `${file.name.replace(/\.svga$/i, "")}.webm`);
      toast.success("Recording saved");
    } catch (e) { toast.error(e.message || "Recording failed"); }
    finally { setRecording(false); }
  };

  return (
    <div data-testid={`gallery-tile-${idx}`} className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] overflow-hidden group">
      <div className="checker h-44 grid place-items-center p-3 relative" style={bg !== "transparent" ? { background: bg } : {}}>
        <SvgaCanvas key={file.name + idx} file={file} className="w-full h-full block"
          onCanvasReady={(c) => { canvasRef.current = c; }} />
        <button data-testid={`remove-tile-${idx}`} onClick={() => onRemove(idx)}
          className="absolute top-2 right-2 h-7 w-7 rounded-md bg-black/60 text-zinc-300 hover:text-red-400 grid place-items-center opacity-0 group-hover:opacity-100 transition-opacity">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-zinc-800/80 p-2.5">
        <span className="text-xs font-mono text-zinc-400 truncate">{file.name}</span>
        <button data-testid={`record-tile-${idx}`} onClick={record} disabled={recording}
          className="inline-flex items-center gap-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white px-2.5 py-1.5 text-xs font-medium transition-colors shrink-0">
          {recording ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Video className="h-3.5 w-3.5" />}
          Record
        </button>
      </div>
    </div>
  );
}

export function SvgaGallery({ files, onReset, onAdd }) {
  const [list, setList] = useState(files);
  const [bg, setBg] = useState("transparent");
  const addRef = useRef(null);

  const remove = (idx) => {
    const next = list.filter((_, i) => i !== idx);
    if (next.length <= 1) { onReset(); return; }
    setList(next);
  };

  return (
    <div data-testid="svga-gallery" className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <h3 className="font-display text-xl font-bold tracking-tight">Multi preview <span className="font-mono text-sm text-zinc-500 font-normal">({list.length})</span></h3>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-[0.15em] text-zinc-500 mr-1">BG</span>
            {BGS.map((c) => (
              <button key={c} data-testid={`gallery-bg-${c}`} onClick={() => setBg(c)}
                className={`h-7 w-7 rounded-md border ${bg === c ? "ring-2 ring-blue-500 border-blue-500" : "border-zinc-700"} ${c === "transparent" ? "checker" : ""}`}
                style={c !== "transparent" ? { background: c } : {}} title={c} />
            ))}
          </div>
          <button data-testid="gallery-add-btn" onClick={() => addRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-700 hover:bg-zinc-800 px-3 py-2 text-sm font-medium transition-colors">
            <Plus className="h-4 w-4" /> Add files
          </button>
          <button data-testid="gallery-reset-btn" onClick={onReset}
            className="inline-flex items-center gap-2 rounded-md border border-zinc-700 hover:bg-zinc-800 px-3 py-2 text-sm font-medium transition-colors">
            <RotateCcw className="h-4 w-4" /> Reset
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {list.map((f, i) => <GalleryTile key={f.name + i} file={f} idx={i} bg={bg} onRemove={remove} />)}
      </div>

      <input ref={addRef} type="file" accept=".svga" multiple hidden
        onChange={(e) => {
          const extra = [...(e.target.files || [])].filter((f) => f.name.toLowerCase().endsWith(".svga"));
          if (extra.length) setList((p) => [...p, ...extra]);
          e.target.value = "";
        }} />
    </div>
  );
}
