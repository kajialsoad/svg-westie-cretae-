// In-browser canvas recorder. Composites a chosen background behind the
// animation so transparent SVGA frames don't record as black.

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function pickMime() {
  if (typeof MediaRecorder === "undefined") return null;
  const opts = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
  return opts.find((m) => MediaRecorder.isTypeSupported(m)) || null;
}

export async function recordCanvasComposite(srcCanvas, seconds = 3, bg = "transparent", fps = 30) {
  if (!srcCanvas) throw new Error("Nothing to record");
  if (typeof MediaRecorder === "undefined" || !document.createElement("canvas").captureStream) {
    throw new Error("Recording is not supported in this browser");
  }
  const mime = pickMime();
  if (!mime) throw new Error("WebM recording not supported here");

  const w = srcCanvas.width || srcCanvas.clientWidth || 400;
  const h = srcCanvas.height || srcCanvas.clientHeight || 400;
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");

  let stop = false;
  let raf;
  const draw = () => {
    if (stop) return;
    if (bg && bg !== "transparent") {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
    } else {
      ctx.clearRect(0, 0, w, h);
    }
    try { ctx.drawImage(srcCanvas, 0, 0, w, h); } catch (e) {}
    raf = requestAnimationFrame(draw);
  };
  draw();

  const stream = off.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8000000 });
  const chunks = [];
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  const done = new Promise((res) => { rec.onstop = () => res(new Blob(chunks, { type: "video/webm" })); });

  rec.start();
  await new Promise((r) => setTimeout(r, seconds * 1000));
  stop = true;
  cancelAnimationFrame(raf);
  rec.stop();
  return done;
}
