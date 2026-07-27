import { useRef, useState } from "react";
import { Header } from "../components/Header";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../components/ui/tabs";
import { UploadCloud, Loader2, Download, Eraser, ImageIcon, Video } from "lucide-react";
import { api, apiErr } from "../lib/api";
import { toast } from "sonner";

const MODES = [
  { id: "transparent", label: "Transparent" },
  { id: "color", label: "Solid color" },
  { id: "image", label: "Custom image" },
];

function ModePicker({ mode, setMode, color, setColor, bgFile, setBgFile }) {
  const bgRef = useRef(null);
  return (
    <div className="space-y-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500">Background output</p>
      <div className="grid grid-cols-3 gap-2">
        {MODES.map((m) => (
          <button key={m.id} type="button" data-testid={`mode-${m.id}`} onClick={() => setMode(m.id)}
            className={`py-2 rounded-md text-sm font-medium border transition-colors ${mode === m.id ? "bg-zinc-800 border-zinc-600 text-white" : "border-zinc-800 text-zinc-400 hover:bg-zinc-900"}`}>
            {m.label}
          </button>
        ))}
      </div>
      {mode === "color" && (
        <div className="flex items-center gap-3">
          <input data-testid="bg-color-input" type="color" value={color} onChange={(e) => setColor(e.target.value)}
            className="h-9 w-12 rounded bg-transparent border border-zinc-800 cursor-pointer" />
          <span className="font-mono text-sm text-zinc-400">{color}</span>
        </div>
      )}
      {mode === "image" && (
        <button type="button" onClick={() => bgRef.current?.click()}
          className="w-full text-sm rounded-md border border-zinc-800 hover:bg-zinc-900 px-3 py-2 text-left text-zinc-400">
          {bgFile ? bgFile.name : "Choose a background image…"}
          <input ref={bgRef} type="file" accept="image/*" hidden data-testid="bg-image-input"
            onChange={(e) => setBgFile(e.target.files?.[0])} />
        </button>
      )}
    </div>
  );
}

function Dropzone({ accept, file, setFile, testid, hint }) {
  const ref = useRef(null);
  return (
    <div onClick={() => ref.current?.click()} data-testid={testid}
      className="cursor-pointer rounded-xl border-2 border-dashed border-zinc-700 hover:border-blue-500 hover:bg-blue-900/5 transition-colors p-10 text-center">
      <UploadCloud className="h-8 w-8 text-blue-500 mx-auto mb-3" strokeWidth={1.5} />
      <p className="text-sm text-zinc-300">{file ? file.name : `Drop or click to select`}</p>
      <p className="text-xs text-zinc-600 mt-1">{hint}</p>
      <input ref={ref} type="file" accept={accept} hidden onChange={(e) => setFile(e.target.files?.[0])} />
    </div>
  );
}

function ImageRemover() {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("transparent");
  const [color, setColor] = useState("#10B981");
  const [bgFile, setBgFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const run = async () => {
    if (!file) { toast.error("Select an image"); return; }
    setBusy(true); setResult(null);
    const fd = new FormData();
    fd.append("file", file); fd.append("mode", mode); fd.append("color", color);
    if (mode === "image" && bgFile) fd.append("background", bgFile);
    try {
      const r = await api.post("/bg/image", fd, { responseType: "blob" });
      setResult(URL.createObjectURL(r.data));
      toast.success("Background removed");
    } catch (e) {
      let msg = "Failed";
      if (e.response?.data instanceof Blob) { try { msg = JSON.parse(await e.response.data.text()).detail; } catch (parseErr) { console.error("bg image error parse failed", parseErr); } }
      toast.error(msg || apiErr(e));
    } finally { setBusy(false); }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="space-y-5">
        <Dropzone accept="image/*" file={file} setFile={setFile} testid="image-dropzone" hint="PNG · JPG · WebP" />
        <ModePicker mode={mode} setMode={setMode} color={color} setColor={setColor} bgFile={bgFile} setBgFile={setBgFile} />
        <button data-testid="remove-image-btn" onClick={run} disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2.5 font-medium transition-colors">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
          {busy ? "Removing…" : "Remove background"}
        </button>
      </div>
      <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-4">
        <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Result</p>
        <div className="checker rounded-lg min-h-[320px] grid place-items-center overflow-hidden">
          {result ? <img data-testid="image-result" src={result} alt="result" className="max-w-full max-h-[360px] object-contain" />
            : <p className="text-sm text-zinc-600">Output preview appears here</p>}
        </div>
        {result && (
          <a data-testid="image-download" href={result} download="image-nobg.png"
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-zinc-700 hover:bg-zinc-800 px-4 py-2 text-sm font-medium transition-colors">
            <Download className="h-4 w-4" /> Download
          </a>
        )}
      </div>
    </div>
  );
}

function VideoRemover() {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState("transparent");
  const [color, setColor] = useState("#10B981");
  const [bgFile, setBgFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState(null);
  const [resultExt, setResultExt] = useState("webm");

  const run = async () => {
    if (!file) { toast.error("Select a video"); return; }
    setBusy(true); setResult(null); setStatus("Uploading…");
    const fd = new FormData();
    fd.append("file", file); fd.append("mode", mode); fd.append("color", color);
    if (mode === "image" && bgFile) fd.append("background", bgFile);
    try {
      const sub = await api.post("/bg/video/submit", fd);
      const jobId = sub.data.job_id;
      setStatus("Processing frames… this can take up to a minute");
      const poll = async () => {
        const st = await api.get(`/bg/video/status/${jobId}`);
        if (st.data.status === "done") {
          const r = await api.get(`/bg/video/result/${jobId}`, { responseType: "blob" });
          setResult(URL.createObjectURL(r.data));
          setResultExt(st.data.ext || "webm");
          setStatus(""); setBusy(false);
          toast.success("Background removed");
        } else if (st.data.status === "error") {
          setStatus(""); setBusy(false);
          toast.error(st.data.error || "Processing failed");
        } else {
          setTimeout(poll, 2500);
        }
      };
      setTimeout(poll, 2500);
    } catch (e) {
      setStatus(""); setBusy(false);
      toast.error(apiErr(e));
    }
  };

  return (
    <div className="grid lg:grid-cols-2 gap-6">
      <div className="space-y-5">
        <Dropzone accept="video/*" file={file} setFile={setFile} testid="video-dropzone" hint="MP4 · WebM · MOV · processed up to ~8s @ 480p" />
        <ModePicker mode={mode} setMode={setMode} color={color} setColor={setColor} bgFile={bgFile} setBgFile={setBgFile} />
        <button data-testid="remove-video-btn" onClick={run} disabled={busy}
          className="w-full inline-flex items-center justify-center gap-2 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white py-2.5 font-medium transition-colors">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Eraser className="h-4 w-4" />}
          {busy ? "Working…" : "Remove background"}
        </button>
        {status && <p data-testid="video-status" className="text-sm text-zinc-500">{status}</p>}
      </div>
      <div className="rounded-xl border border-zinc-800/80 bg-[#0A0A0A] p-4">
        <p className="text-[11px] uppercase tracking-[0.15em] text-zinc-500 mb-3">Result</p>
        <div className="checker rounded-lg min-h-[320px] grid place-items-center overflow-hidden">
          {result ? <video data-testid="video-result" src={result} className="max-w-full max-h-[360px]" autoPlay loop muted controls />
            : <p className="text-sm text-zinc-600">Output preview appears here</p>}
        </div>
        {result && (
          <a data-testid="video-download" href={result} download={`video-nobg.${resultExt}`}
            className="mt-3 inline-flex items-center gap-2 rounded-md border border-zinc-700 hover:bg-zinc-800 px-4 py-2 text-sm font-medium transition-colors">
            <Download className="h-4 w-4" /> Download .{resultExt}
          </a>
        )}
      </div>
    </div>
  );
}

export default function RemoveBg() {
  return (
    <div className="min-h-screen bg-[#050505]">
      <Header />
      <div className="max-w-6xl mx-auto px-5 md:px-8 py-14">
        <p className="text-xs uppercase tracking-[0.2em] text-blue-500 font-medium mb-3">AI tools</p>
        <h1 className="font-display text-4xl sm:text-5xl font-black tracking-tighter">Background remover</h1>
        <p className="text-zinc-400 mt-4 max-w-2xl">Remove backgrounds from images and videos with AI. Export transparent, or replace with a solid color or your own image.</p>

        <div className="mt-10">
          <Tabs defaultValue="image">
            <TabsList className="bg-[#0A0A0A] border border-zinc-800/80">
              <TabsTrigger value="image" data-testid="tab-image"><ImageIcon className="h-4 w-4 mr-2" />Image</TabsTrigger>
              <TabsTrigger value="video" data-testid="tab-video"><Video className="h-4 w-4 mr-2" />Video</TabsTrigger>
            </TabsList>
            <TabsContent value="image" className="mt-6"><ImageRemover /></TabsContent>
            <TabsContent value="video" className="mt-6"><VideoRemover /></TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}
