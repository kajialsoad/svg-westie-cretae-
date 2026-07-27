# SVGA Studio — PRD

## Original Problem Statement
Clone of https://svga.dev/svga-preview/ (SVGA animation preview tool) WITH a backend admin panel — full website.

## User Choices
- Full preview clone: upload + playback, device presets, background colors, alignment, play controls, file info, assets.
- Convert tools MUST work: GIF/MP4/WebP → SVGA and SVGA → GIF/MP4/PNG/WebP/Lottie/JSON.
- Admin panel manages BOTH a public showcase gallery AND FAQ + site stats.
- Auth: JWT email/password AND Emergent Google login.
- Uploads stored on server (Emergent object storage) for the showcase.

## Architecture
- Frontend: React (CRA), TailwindCSS, shadcn/ui, svgaplayerweb for in-browser playback, framer/sonner.
- Backend: FastAPI + Motor/MongoDB. Pure-python SVGA 2.x codec (protobuf+zlib) for decode/encode/render; ffmpeg + Pillow for media conversions.
- Storage: Emergent object storage (showcase .svga files). Auth: JWT (bcrypt) + Emergent Google OAuth.

## Personas
- Visitor: previews/converts SVGA files, browses showcase, reads FAQ.
- Admin: manages showcase gallery, FAQ, and views usage stats.

## Implemented (2026-06-30)
- Home: drag/drop SVGA preview, device frames, bg colors, alignment, play/pause, re-upload, file info + assets grid.
- Convert tools (9 kinds) — all verified working end-to-end.
- Showcase gallery (public) + admin CRUD (object storage backed).
- FAQ (public list w/ defaults) + admin CRUD.
- Stats (public summary + admin breakdown).
- Auth: JWT login/register + Google login; seeded admin (admin@svga.dev / admin123).
- 30/30 backend tests pass; frontend flows pass.

## Backlog
- P1: Showcase edit (title/desc) UI; category filter chips on /showcase; pagination.
- P1: Convert progress feedback for large MP4 inputs; size/duration guardrails.
- P2: SVGA→Lottie fidelity for vector shapes (currently image-sequence based); matte/clipPath rendering in codec.
- P2: User-facing accounts beyond admin; download history.

## Next Tasks
- Add showcase category filtering + edit modal in admin.
