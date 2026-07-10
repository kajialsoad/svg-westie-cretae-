/**
 * SVGA diagnostic — tells you WHY a file does or doesn't compress.
 * Usage:  node diagnose-svga.js "path\to\your.svga"
 *
 * Reports, for the embedded assets:
 *   - PNG color type (palette PNG8 vs full RGBA) and bit depth
 *   - how much of each image is transparent padding (trim potential)
 *   - duplicate / unused asset counts
 *   - how frames are positioned (identity / translation / matrix)
 * This reveals the realistic size-reduction headroom.
 */
const fs = require('fs');
const sharp = require('sharp');
const svga = require('./services/svga');

const COLOR_TYPE = {
  0: 'grayscale', 2: 'RGB', 3: 'PALETTE(PNG8)', 4: 'grayscale+alpha', 6: 'RGBA',
};

(async () => {
  const file = process.argv[2];
  if (!file || !fs.existsSync(file)) {
    console.error('Provide a valid .svga path:  node diagnose-svga.js "file.svga"');
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const movie = await svga.parseSVGA(buf);
  const meta = svga.getMetadata(movie);
  console.log('=== FILE ===');
  console.log('size:', buf.length, 'bytes', `(${(buf.length / 1048576).toFixed(2)} MB)`);
  console.log('meta:', meta);

  const images = movie.images || {};
  const keys = Object.keys(images);

  // Duplicate detection
  const crypto = require('crypto');
  const hashes = new Map();
  let dupBytes = 0, dupCount = 0;
  for (const k of keys) {
    const b = Buffer.from(images[k]);
    const h = crypto.createHash('sha1').update(b).digest('hex');
    if (hashes.has(h)) { dupCount++; dupBytes += b.length; }
    else hashes.set(h, k);
  }

  // Referenced (used) detection
  const referenced = new Set();
  for (const s of (movie.sprites || [])) if (s.imageKey) referenced.add(s.imageKey);
  for (const a of (movie.audios || [])) if (a.audioKey) referenced.add(a.audioKey);
  const unused = keys.filter(k => !referenced.has(k));

  // Per-image analysis
  console.log('\n=== IMAGES ===  (count:', keys.length, ')');
  let totalImgBytes = 0, totalTrimSavable = 0, paletteCount = 0, rgbaCount = 0;
  for (const k of keys) {
    const b = Buffer.from(images[k]);
    totalImgBytes += b.length;
    let line = `  ${k}: ${b.length} B`;
    try {
      const m = await sharp(b).metadata();
      line += ` | ${m.width}x${m.height} | ${COLOR_TYPE[m.channels === 4 ? 6 : m.channels === 3 ? 2 : '?'] || ('ch=' + m.channels)}`;
      // Detect PNG color type from header (byte 25)
      if (b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG') {
        const ct = b[25];
        line += ` | PNG:${COLOR_TYPE[ct] || ct} depth${b[24]}`;
        if (ct === 3) paletteCount++; else if (ct === 6) rgbaCount++;
      }
      // Trim potential
      const t = await sharp(b).ensureAlpha()
        .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 }, threshold: 0 })
        .toBuffer({ resolveWithObject: true });
      const before = m.width * m.height;
      const after = t.info.width * t.info.height;
      const trimPct = before ? (1 - after / before) * 100 : 0;
      if (trimPct > 1) {
        line += ` | trimmable ${trimPct.toFixed(0)}% (-> ${t.info.width}x${t.info.height})`;
        totalTrimSavable += trimPct / 100 * b.length;
      }
    } catch {
      line += ' | (non-image / audio)';
    }
    if (keys.length <= 20) console.log(line);
  }
  if (keys.length > 20) console.log('  (per-image lines hidden; >20 images)');

  // Frame positioning stats
  let identity = 0, translation = 0, matrix = 0, withClip = 0, withShapes = 0, matte = 0;
  for (const s of (movie.sprites || [])) {
    if (s.matteKey) matte++;
    for (const f of (s.frames || [])) {
      if (!f) continue;
      if (f.clipPath && f.clipPath.length) withClip++;
      if (Array.isArray(f.shapes) && f.shapes.length) withShapes++;
      const t = f.transform || {};
      const rot = Math.abs((t.a ?? 1) - 1) > 1e-3 || Math.abs(t.b ?? 0) > 1e-3 ||
        Math.abs(t.c ?? 0) > 1e-3 || Math.abs((t.d ?? 1) - 1) > 1e-3;
      const tr = Math.abs(t.tx ?? 0) > 1e-3 || Math.abs(t.ty ?? 0) > 1e-3;
      if (rot) matrix++; else if (tr) translation++; else identity++;
    }
  }

  console.log('\n=== SUMMARY ===');
  console.log('image bytes total:', totalImgBytes, `(${(totalImgBytes / 1048576).toFixed(2)} MB) = ${(totalImgBytes / buf.length * 100).toFixed(0)}% of file`);
  console.log('PNG palette(PNG8):', paletteCount, '| RGBA:', rgbaCount);
  console.log('duplicate assets:', dupCount, `(~${(dupBytes / 1048576).toFixed(2)} MB reclaimable)`);
  console.log('unused assets:', unused.length);
  console.log('trim-savable (approx):', `~${(totalTrimSavable / 1048576).toFixed(2)} MB`);
  console.log('frame positioning -> identity:', identity, '| translation:', translation, '| matrix(rotate/scale):', matrix);
  console.log('frames with clipPath:', withClip, '| shapes:', withShapes, '| sprites with matte:', matte);
  console.log('\nInterpretation:');
  if (paletteCount > rgbaCount) console.log(' - Images are ALREADY palette-quantized -> little lossless headroom; big gains need lossy (ONE MB mode).');
  else console.log(' - Images are full RGBA -> palette quantization (ONE MB mode) should give large, near-lossless gains.');
  if (totalTrimSavable > buf.length * 0.1) console.log(' - Significant transparent padding -> trimming should help notably.');
  if (matrix > 0) console.log(' - Some frames use rotation/scale matrices -> those are skipped by safe trim.');
})().catch(e => { console.error('DIAGNOSTIC FAILED:', e); process.exit(1); });
