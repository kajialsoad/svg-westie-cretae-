"""Is the renderer leaking, or was that just system memory pressure?"""
import ctypes
import gc
import os

import svga_codec


class PMC(ctypes.Structure):
    _fields_ = [("cb", ctypes.c_ulong), ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t)]


def rss_mb():
    c = PMC()
    c.cb = ctypes.sizeof(PMC)
    ctypes.windll.psapi.GetProcessMemoryInfo(
        ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    return c.WorkingSetSize / 1048576


PATH = r"F:\svg website\SVGAConverter_AE\sources\src\res\loading.svga"
data = open(PATH, "rb").read()

print(f"baseline RSS: {rss_mb():.1f} MB")

# Streaming: memory must stay flat regardless of frame count.
count = 0
for i, frame in enumerate(svga_codec.iter_render_frames(data)):
    frame.close()
    count += 1
    if i % 60 == 0:
        print(f"  streamed frame {i:3d}  RSS={rss_mb():.1f} MB")
print(f"streamed {count} frames, final RSS: {rss_mb():.1f} MB")

gc.collect()
print(f"after gc: {rss_mb():.1f} MB")

# Directory render is the path production code uses.
import tempfile
with tempfile.TemporaryDirectory() as tmp:
    r = svga_codec.render_frames_to_directory(data, tmp, prefix="f_")
    total = sum(os.path.getsize(p) for p in r["framePaths"])
    print(f"to-disk render: {r['totalFrames']} frames, {total/1048576:.1f} MB on disk, "
          f"RSS={rss_mb():.1f} MB")
