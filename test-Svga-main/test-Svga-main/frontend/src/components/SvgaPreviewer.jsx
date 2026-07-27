import { useCallback, useRef, useState } from "react";
import { UploadCloud, Play, Pause, RotateCcw, Ruler, Package, Film, Zap, Timer, Image as ImageIcon, HardDrive, Video, Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { SvgaCanvas } from "./SvgaCanvas";
import { SvgaGallery } from "./SvgaGallery";
import { recordCanvasComposite, downloadBlob } from "../lib/recorder";
import { api, apiErr } from "../lib/api";
import { toast } from "sonner";

const DEVICES = [
  { id: "default", label: "Default", w: 0, h: 0 },
  { id: "iphone16pro", label: "iPhone 16 Pro", w: 393, h: 852 },
  { id: "iphone16promax", label: "iPhone 16 Pro Max", w: 440, h: 956 },
  { id: "s25ultra", label: "Galaxy S25 Ultra", w: 412, h: 919 },
  { id: "pixel9pro", label: "Pixel 9 Pro", w: 412, h: 892 },
  { id: "xiaomi15", label: "Xiaomi 15", w: 400, h: 880 },
  { id: "square", label: "Square 1:1", w: 500, h: 500 },
];
const BGS = ["transparent", "#050505", "#FFFFFF", "#2563EB", "#10B981", "#F59E0B"];
const ALIGN = ["Top", "Center", "Bottom"];

function StatCard({ icon: Icon, label, value, testid }) {
  return (
    <div className="p-4 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-zinc-500">
        <Icon className="h-3.5 w-3.5" strokeWidth={1.5} />
        <span className="text-[11px] uppercase tracking-[0.15em]">{label}</span>
      </div>
      <span data-testid={testid} className="font-mono text-base text-white">{value}</span>
    </div>
  );
}

function fmtSize(b) {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1048576) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1048576).toFixed(2)} MB`;
}

export function SvgaPreviewer() {
  const [file, setFile] = useState(null);
  const [info, setInfo] = useState(null);
  const [assets, setAssets] = useState([]);
  const [memory, setMemory] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [device, setDevice] = useState("default");
  const [bg, setBg] = useState("transparent");
  const [align, setAlign] = useState("Center");
  const [dragging, setDragging] = useState(false);
  const [gallery, setGallery] = useState([]);
  const [recording, setRecording] = useState(false);
  const inputRef = useRef(null);
  const canvasElRef = useRef(null);

  const handleFile = useCallback(async (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".svga")) {
      toast.error("Please select a .svga file");
      return;
    }
    setFile(f);
    setAssets([]);
    setMemory(0);
    const fd = new FormData();
    fd.append("file", f);
    try {
      const r = await api.post("/preview/info", fd);
      setInfo({ ...r.data });
    } catch (e) {
      toast.error(apiErr(e));
      setInfo(null);
    }
  }, []);

  const onVideo = useCallback((videoItem) => {
    try {
      const imgs = videoItem.images || {};
      const entries = Object.entries(imgs);
      let mem = 0;
      const thumbs = entries.slice(0, 60).map(([k, v]) => {
        let url = null;
        if (typeof v === "string") { url = `data:image/png;base64,${v}`; mem += v.length * 0.75; }
        else if (v && v.src) url = v.src;
        return { key: k, url };
      });
      setAssets(thumbs);
      const vs = videoItem.videoSize || {};
      if (!mem && vs.width) mem = entries.length * vs.width * vs.height * 4;
      setMemory(mem);
    } catch (e) {}
  }, []);

  const reupload = () => {
    setFile(null); setInfo(null); setAssets([]); setMemory(0); setPlaying(true); setGallery([]);
    if (inputRef.current) inputRef.current.value = "";
  };

  const handleSelect = useCallback((fileList) => {
    const arr = [...(fileList || [])].filter((f) => f.name.toLowerCase().endsWith(".svga"));
    if (arr.length === 0) { toast.error("Please select .svga file(s)"); return; }
    if (arr.length === 1) { setGallery([]); handleFile(arr[0]); }
    else { setFile(null); setInfo(null); setAssets([]); setMemory(0); setGallery(arr); }
  }, [handleFile]);

  const recordSingle = async () => {
    if (!canvasElRef.current) { toast.error("Nothing to record yet"); return; }
    setRecording(true);
    const secs = Math.min(15, Math.max(2, Math.ceil((info?.duration || 3) * 2)));
    toast.info(`Recording ${secs}s…`);
    try {
      const blob = await recordCanvasComposite(canvasElRef.current, secs, bg);
      downloadBlob(blob, `${(file?.name || "svga").replace(/\.svga$/i, "")}.webm`);
      toast.success("Recording saved");
    } catch (e) { toast.error(e.message || "Recording failed"); }
    finally { setRecording(false); }
  };

  if (gallery.length > 1) {
    return <SvgaGallery files={gallery} onReset={reupload} onAdd={handleSelect} />;
  }

  const dev = DEVICES.find((d) => d.id === device);
  const alignClass = align === "Top" ? "items-start" : align === "Bottom" ? "items-end" : "items-center";

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
      {/* Canvas / dropzone */}
      <div className="lg:col-span-8">
        {!file ? (
          <div
            data-testid="upload-svga-zone"
            onClick={() => inputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); handleSelect(e.dataTransfer.files); }}
            className={`cursor-pointer rounded-xl border-2 border-dashed transition-colors duration-300 min-h-[440px] grid place-items-center text-center px-6 ${
              dragging ? "border-blue-500 bg-blue-900/10" : "border-zinc-700 hover:border-blue-500 hover:bg-blue-900/5"
            }`}
          >
            <div>
              <span className="mx-auto mb-5 h-16 w-16 rounded-2xl bg-zinc-900 border border-zinc-800 grid place-items-center">
                <UploadCloud className="h-7 w-7 text-blue-500" strokeWidth={1.5} />
              </span>
              <h3 className="font-display text-2xl font-bold tracking-tight">Drop your SVGA file(s) here</h3>
              <p className="text-zinc-500 mt-2 text-sm">click to select one — or multiple — SVGA files · 100% in-browser</p>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] overflow-hidden">
            <div className={`checker flex justify-center ${alignClass} min-h-[440px] p-6`}>
              <div
                className={dev.w ? "rounded-[2rem] border-[6px] border-zinc-700 bg-black overflow-hidden shadow-2xl" : "w-full h-[400px]"}
                style={dev.w ? { width: Math.min(280, dev.w / 1.6), aspectRatio: `${dev.w}/${dev.h}` } : {}}
              >
                <SvgaCanvas
                  key={`${file.name}-${device}`}
                  file={file}
                  playing={playing}
                  bg={bg}
                  onLoad={onVideo}
                  onCanvasReady={(c) => { canvasElRef.current = c; }}
                  onError={() => toast.error("Failed to render SVGA")}
                  className="w-full h-full block"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 border-t border-zinc-800/80 p-3">
              <button
                data-testid="play-pause-btn"
                onClick={() => setPlaying((p) => !p)}
                className="inline-flex items-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium transition-colors"
              >
                {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {playing ? "Pause" : "Play"}
              </button>
              <button
                data-testid="reupload-btn"
                onClick={reupload}
                className="inline-flex items-center gap-2 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-4 py-2 text-sm font-medium transition-colors"
              >
                <RotateCcw className="h-4 w-4" /> Re-upload
              </button>
              <button
                data-testid="record-btn"
                onClick={recordSingle}
                disabled={recording}
                className="inline-flex items-center gap-2 rounded-md border border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50 px-4 py-2 text-sm font-medium transition-colors"
                title="Record this animation to a WebM video"
              >
                {recording ? <Loader2 className="h-4 w-4 animate-spin" /> : <Video className="h-4 w-4" />}
                {recording ? "Recording…" : "Record video"}
              </button>
            </div>
          </div>
        )}
        <input ref={inputRef} type="file" accept=".svga" multiple hidden data-testid="file-input"
          onChange={(e) => handleSelect(e.target.files)} />
      </div>

      {/* Controls */}
      <div className="lg:col-span-4 space-y-4">
        <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-5 space-y-5">
          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">Preview Device</label>
            <Select value={device} onValueChange={setDevice}>
              <SelectTrigger data-testid="device-select" className="mt-2 bg-[#050505] border-zinc-800 text-white">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DEVICES.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">Background</label>
            <div className="mt-2 flex gap-2">
              {BGS.map((c) => (
                <button key={c} data-testid={`bg-${c}`} onClick={() => setBg(c)}
                  className={`h-8 w-8 rounded-md border ${bg === c ? "ring-2 ring-blue-500 border-blue-500" : "border-zinc-700"} ${c === "transparent" ? "checker" : ""}`}
                  style={c !== "transparent" ? { background: c } : {}} title={c} />
              ))}
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">Alignment</label>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {ALIGN.map((a) => (
                <button key={a} data-testid={`align-${a.toLowerCase()}`} onClick={() => setAlign(a)}
                  className={`py-2 rounded-md text-sm font-medium border transition-colors ${align === a ? "bg-zinc-800 border-zinc-600 text-white" : "border-zinc-800 text-zinc-400 hover:bg-zinc-900"}`}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* File info */}
        <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] overflow-hidden" data-testid="file-info-panel">
          <div className="px-5 py-3 border-b border-zinc-800/80">
            <h4 className="font-display font-medium tracking-tight">File Information</h4>
          </div>
          <div className="grid grid-cols-2 divide-x divide-y divide-zinc-800/80 [&>div]:border-zinc-800/80">
            <StatCard icon={Ruler} label="Dimensions" testid="stat-dimensions" value={info ? `${info.width}×${info.height}` : "—"} />
            <StatCard icon={Package} label="Size" testid="stat-size" value={fmtSize(info?.size)} />
            <StatCard icon={Film} label="Frames" testid="stat-frames" value={info?.frames ?? "—"} />
            <StatCard icon={Zap} label="FPS" testid="stat-fps" value={info?.fps ?? "—"} />
            <StatCard icon={Timer} label="Duration" testid="stat-duration" value={info ? `${info.duration}s` : "—"} />
            <StatCard icon={ImageIcon} label="Assets" testid="stat-assets" value={info?.assets ?? "—"} />
            <StatCard icon={HardDrive} label="Memory" testid="stat-memory" value={memory ? fmtSize(memory) : "—"} />
            <StatCard icon={Package} label="Sprites" testid="stat-sprites" value={info?.sprites ?? "—"} />
          </div>
        </div>
      </div>

      {/* Assets */}
      <div className="lg:col-span-12">
        <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-5">
          <h4 className="font-display font-medium tracking-tight mb-4">Assets Preview <span className="text-zinc-500 font-normal font-mono text-sm">({assets.length})</span></h4>
          {assets.length === 0 ? (
            <p className="text-sm text-zinc-600">Upload an SVGA file to inspect its image assets.</p>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-10 gap-2 max-h-64 overflow-y-auto thin-scroll">
              {assets.map((a, i) => (
                <div key={`${a.key}-${i}`} data-testid={`asset-${i}`} className="aspect-square rounded-md border border-zinc-800 checker grid place-items-center overflow-hidden">
                  {a.url ? <img src={a.url} alt={a.key} className="max-w-full max-h-full object-contain" /> : <span className="text-[9px] text-zinc-500 font-mono px-1 truncate">{a.key}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
