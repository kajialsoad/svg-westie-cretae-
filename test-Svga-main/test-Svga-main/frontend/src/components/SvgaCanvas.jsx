import { useEffect, useRef } from "react";
import { Parser, Player } from "svgaplayerweb";

export function SvgaCanvas({ src, file, className = "", bg = "transparent", playing = true, onLoad, onError, onCanvasReady }) {
  const canvasRef = useRef(null);
  const playerRef = useRef(null);
  const urlRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    let loadUrl = src;
    if (file) {
      urlRef.current = URL.createObjectURL(file);
      loadUrl = urlRef.current;
    }
    if (!loadUrl) return;

    const parser = new Parser();
    parser.load(
      loadUrl,
      (videoItem) => {
        if (cancelled) return;
        try {
          const rect = canvas.getBoundingClientRect();
          canvas.width = Math.max(1, Math.round(rect.width));
          canvas.height = Math.max(1, Math.round(rect.height));
          const player = new Player(canvas);
          if (player.setContentMode) player.setContentMode("AspectFit");
          player.loops = 0;
          player.clearsAfterStop = false;
          player.setVideoItem(videoItem);
          player.startAnimation();
          playerRef.current = player;
          onCanvasReady && onCanvasReady(canvas);
          onLoad && onLoad(videoItem);
        } catch (e) {
          onError && onError(e);
        }
      },
      (e) => onError && onError(e)
    );

    return () => {
      cancelled = true;
      try { playerRef.current && playerRef.current.stopAnimation(true); } catch (e) { console.debug("svga stop on cleanup", e); }
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    };
  }, [src, file]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      if (playing) p.startAnimation();
      else p.pauseAnimation();
    } catch (e) { console.debug("svga play/pause", e); }
  }, [playing]);

  return <canvas data-testid="svga-canvas" ref={canvasRef} className={className} style={{ background: bg }} />;
}
