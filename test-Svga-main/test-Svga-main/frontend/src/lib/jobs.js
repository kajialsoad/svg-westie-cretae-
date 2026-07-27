import { api } from "./api";

// Polls a server-side async job until done, then returns the result blob.
export async function pollJob(jobId, { onTick, interval = 2500 } = {}) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const st = await api.get(`/jobs/${jobId}/status`);
    onTick && onTick(st.data);
    if (st.data.status === "done") {
      const r = await api.get(`/jobs/${jobId}/result`, { responseType: "blob" });
      return { blob: r.data, ext: st.data.ext, size: st.data.size };
    }
    if (st.data.status === "error") throw new Error(st.data.error || "Processing failed");
    await new Promise((r) => setTimeout(r, interval));
  }
}

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
