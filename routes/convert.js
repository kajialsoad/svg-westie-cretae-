/**
 * AnimSuite Pro - Conversion API Routes
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sharp = require('sharp');

const rateHits = new Map();
router.use((req, res, next) => {
  if (req.method === 'GET') return next();
  const key = String(req.ip || 'local') + ':' + req.path;
  const now = Date.now();
  const recent = (rateHits.get(key) || []).filter((t) => now - t < 60000);
  if (recent.length >= 40) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }
  recent.push(now);
  rateHits.set(key, recent);
  next();
});

const svgaService = require('../services/svga');
const svgaRenderer = require('../services/svgaRenderer');
const ffmpegService = require('../services/ffmpeg');
const compression = require('../services/compression');
const vapService = require('../services/vap');

const toFixedSafe = (value, digits = 2, fallback = '0.00') => (
  Number.isFinite(value) ? value.toFixed(digits) : fallback
);

const createCompressionSummary = ({ inputSize, outputSize, targetConfig, attempts, oneMbMode }) => {
  const safeInput = Math.max(1, Number(inputSize) || 1);
  const safeOutput = Math.max(1, Number(outputSize) || 1);
  const savedPercent = ((safeInput - safeOutput) / safeInput) * 100;

  return {
    mode: oneMbMode ? 'one-mb' : 'standard',
    targetSizeMB: targetConfig.targetSizeMB,
    targetMet: safeOutput <= targetConfig.toleranceBytes,
    finalSizeMB: toFixedSafe(safeOutput / (1024 * 1024), 2),
    inputSizeMB: toFixedSafe(safeInput / (1024 * 1024), 2),
    compressionRatio: toFixedSafe(safeInput / safeOutput, 2, '1.00'),
    estimatedRatio: toFixedSafe(
      compression.estimateCompressionRatio(safeInput, targetConfig.targetBytes),
      2,
      '1.00'
    ),
    savedPercent: toFixedSafe(savedPercent, 1, '0.0'),
    attempts,
  };
};

// Multer memory storage (no permanent files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// Job storage (in-memory for localhost)
const jobs = new Map();
const cleanupTimers = new Map();

/**
 * POST /api/upload
 * Upload a file and get a job_id
 */
router.post('/upload', upload.single('file'), (req, res) => {
  try {
    compression.getTargetConfig({ tier: 'standard' });

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const jobId = uuidv4();
    jobs.set(jobId, {
      id: jobId,
      status: 'uploaded',
      filename: req.file.originalname,
      mimetype: req.file.mimetype,
      size: req.file.size,
      buffer: req.file.buffer,
      createdAt: Date.now(),
    });

    res.json({
      success: true,
      jobId,
      filename: req.file.originalname,
      size: req.file.size,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/convert/svga
 * Convert SVGA animation to WebP, GIF, JSON, or SVGA
 */
router.post('/convert/svga', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'audio', maxCount: 1 }
]), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);

  try {
    const svgaFile = req.files && req.files['file'] ? req.files['file'][0] : null;
    const audioFile = req.files && req.files['audio'] ? req.files['audio'][0] : null;

    if (!svgaFile) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const format = req.body.format || 'webp';
    const tier = req.body.sizeTier || 'standard';
    const oneMbMode = compression.isOneMbModeEnabled(req.body.oneMbMode);
    // User-selected compression level for SVGA output: MAX -> sharp effort 10
    // (smallest, lossless, slower); FAST -> effort 4 (quicker).
    const maxCompression = req.body.maxCompression === '1' || req.body.maxCompression === 'true';
    const svgaEffort = maxCompression ? 10 : 4;
    console.log('[SVGA] compression level:', maxCompression ? 'MAX (effort 10)' : 'FAST (effort 4)');
    const tierSettings = compression.getTierSettings(tier);
    const targetConfig = compression.getTargetConfig({ tier, oneMbMode, sourceSizeBytes: svgaFile.size });

    // Handle optional audio file upload
    let audioBuffer = null;
    let audioDuration = 0;

    if (audioFile) {
      console.log('Audio file uploaded for SVGA embedding:', audioFile.originalname, audioFile.size);
      audioBuffer = audioFile.buffer;
      const tempAudioPath = path.join(tempDir, 'audio_upload' + path.extname(audioFile.originalname || '.mp3'));
      fs.writeFileSync(tempAudioPath, audioBuffer);
      
      try {
        const audioInfo = await ffmpegService.getVideoInfo(tempAudioPath);
        audioDuration = audioInfo.duration;
        console.log('Detected audio duration:', audioDuration, 'seconds');
      } catch (audioErr) {
        console.warn('Failed to parse audio duration via ffprobe:', audioErr.message);
      }
    }

    console.log('SVGA Conversion started:', {
      jobId,
      filename: svgaFile.originalname,
      size: svgaFile.size,
      format,
      tier,
      rawOneMbMode: req.body.oneMbMode,
      oneMbMode,
      hasAudio: !!audioBuffer,
    });

    // Update job status
    jobs.set(jobId, {
      id: jobId,
      status: 'processing',
      step: 'Parsing SVGA...',
      progress: 10,
    });

    // Step 1: Parse SVGA
    console.log('Step 1: Parsing SVGA...');
    const movieData = await svgaService.parseSVGA(svgaFile.buffer);
    const metadata = svgaService.getMetadata(movieData);
    console.log('SVGA Metadata:', metadata);

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting frames...', progress: 30 });

    const isSvgaOutput = format === 'svga';
    const framesDir = path.join(tempDir, 'frames');
    let renderResult = {
      totalFrames: metadata.totalFrames || 0,
      previewBuffer: null,
    };

    if (isSvgaOutput) {
      console.log('Step 2: Preparing SVGA preview frame...');
      renderResult.previewBuffer = await svgaRenderer.renderPreviewFrame(movieData, movieData.images || {}, 0);
      console.log('Prepared single preview frame for SVGA output');
      jobs.set(jobId, {
        ...jobs.get(jobId),
        step: 'Prepared SVGA preview...',
        progress: 46,
      });
    } else {
      // Step 2: Render frames to disk to keep memory stable on large SVGA files.
      console.log('Step 2: Rendering frames to disk...');
      renderResult = await svgaRenderer.renderFramesToDirectory(movieData, movieData.images || {}, framesDir, {
        onFrame: ({ frameIndex, totalFrames }) => {
          if ((frameIndex + 1) === totalFrames || (frameIndex + 1) % 15 === 0) {
            jobs.set(jobId, {
              ...jobs.get(jobId),
              step: `Rendering frames ${frameIndex + 1}/${totalFrames}...`,
              progress: Math.min(58, 30 + Math.round(((frameIndex + 1) / totalFrames) * 28)),
            });
          }
        },
      });

      console.log(`Rendered ${renderResult.totalFrames} frames to disk`);

      if (renderResult.totalFrames === 0) {
        throw new Error('No frames could be rendered from SVGA file. The file may be corrupted or empty.');
      }
    }

    // Step 3: Encode output
    let outputBuffer, filename, mimetype;
    let preview = null;
    let outputMetadata = null;
    let compressionSummary = createCompressionSummary({
      inputSize: svgaFile.size,
      outputSize: svgaFile.size,
      targetConfig,
      attempts: [],
      oneMbMode,
    });

    if (format === 'json') {
      console.log('Step 3: Creating JSON output...');
      // For JSON format, we just return the movie data without frames/images (or with them as base64)
      // To keep it clean, we'll remove the large image buffers if they are too big, 
      // but the user said "understand JSON", so let's keep them as metadata info
      const cleanMovieData = JSON.parse(JSON.stringify(movieData));
      // Replace image buffers with metadata
      if (cleanMovieData.images) {
        for (const key in cleanMovieData.images) {
          cleanMovieData.images[key] = {
            size: movieData.images[key] ? movieData.images[key].length : 0,
            type: 'image/png (hidden in JSON view)'
          };
        }
      }

      outputBuffer = Buffer.from(JSON.stringify(cleanMovieData, null, oneMbMode ? 0 : 2));
      filename = `metadata_${Date.now()}.json`;
      mimetype = 'application/json';
    } else {
      console.log(`Step 3: Converting to ${format.toUpperCase()}...`);

      // Keep a lightweight inline preview so browsers can always show
      // something even when animated output rendering is inconsistent.
      try {
        preview = {
          buffer: await sharp(renderResult.previewBuffer)
            .resize(tierSettings.resolution, tierSettings.resolution, {
              fit: 'inside',
              withoutEnlargement: true,
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toBuffer(),
          mimetype: 'image/png',
          filename: `preview_${Date.now()}.png`,
        };
      } catch (previewErr) {
        console.warn('Failed to generate inline preview:', previewErr.message);
      }

      if (format === 'svga') {
        if (!oneMbMode) {
          if (audioBuffer) {
            jobs.set(jobId, {
              ...jobs.get(jobId),
              step: 'Embedding audio track into SVGA...',
              progress: 72
            });

            outputBuffer = await svgaService.optimizeSVGADirect(svgaFile.buffer, {
              skipImageOptimization: true,
              audioBuffer,
              audioDuration
            });
          } else {
            jobs.set(jobId, {
              ...jobs.get(jobId),
              step: 'Compressing SVGA assets (playback-safe)...',
              progress: 72
            });

            // Standard SVGA->SVGA: apply playback-safe asset optimization.
            // Reduces embedded PNG size via RGBA color-quantization + max zlib,
            // WITHOUT resizing (which would break sprite layouts / playback).
            // Fall back to the original buffer if optimization doesn't help.
            const optimized = await svgaService.optimizeSVGADirect(svgaFile.buffer, {
              format: 'svga',
              // Safe, quality-preserving asset optimization only:
              //  - dedupe identical embedded PNGs and repoint sprites
              //  - drop image assets no sprite/audio references
              //  - best-of {lossless, palette} per image (never grows a frame)
              //  - maximum zlib deflate on the container
              removeUnusedAssets: true,
              dedupeAssets: true,
              // trimTransparent disabled: it alters sprite layout/transform,
              // which some native SVGA players render differently than our
              // validator, shifting content to the top-left. Layout must stay
              // byte-identical, so we only do asset-level optimization.
              trimTransparent: false,
              colors: 256,
              quality: 100,
              compressionLevel: 9,
              effort: svgaEffort,
              zlibLevel: 9,
              stripMetadata: true,
            });
            outputBuffer = optimized.length < svgaFile.buffer.length
              ? optimized
              : svgaFile.buffer;
          }

          filename = `converted_${Date.now()}.svga`;
          mimetype = 'application/x-svga';
          compressionSummary = createCompressionSummary({
            inputSize: svgaFile.size,
            outputSize: outputBuffer.length,
            targetConfig,
            attempts: [{
              attempt: 1,
              sizeMB: toFixedSafe(outputBuffer.length / (1024 * 1024), 2),
              quality: null,
              width: metadata.width,
              height: metadata.height,
            }],
            oneMbMode: false,
          });
        } else {
          jobs.set(jobId, {
            ...jobs.get(jobId),
            step: 'Smart SVGA compression towards ~1 MB...',
            progress: 60
          });

          const attempts = [];
          const inputSize = svgaFile.size;
          const maxAttempts = 8;
          let bestCandidate = null;
          let previousCandidate = null;

          // One-time structural pass (expensive but done ONCE): duplicate +
          // unused asset removal and validated transparent-border trimming.
          // These are lossless and independent of the palette color level, so
          // running them per attempt would just repeat the same heavy work.
          jobs.set(jobId, {
            ...jobs.get(jobId),
            step: 'Structural cleanup (dedupe + trim, validating)...',
            progress: 58,
          });
          let structuralBuffer = svgaFile.buffer;
          try {
            structuralBuffer = await svgaService.optimizeSVGADirect(svgaFile.buffer, {
              format: 'svga',
              removeUnusedAssets: true,
              dedupeAssets: true,
              trimTransparent: false,
              losslessOnly: true,
              compressionLevel: 9,
              effort: svgaEffort,
              zlibLevel: 9,
            });
            if (structuralBuffer.length > svgaFile.buffer.length) {
              structuralBuffer = svgaFile.buffer;
            }
          } catch (structErr) {
            console.warn('[SVGA->SVGA] Structural pass failed, using original:', structErr.message);
            structuralBuffer = svgaFile.buffer;
          }
          console.log(`[SVGA->SVGA] Structural pass: ${svgaFile.buffer.length} -> ${structuralBuffer.length} bytes`);

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const plan = compression.getOneMbAttemptPlan(format, attempt, metadata, tier, {
              targetBytes: targetConfig.targetBytes,
              sourceSizeBytes: svgaFile.size,
            }) || {};

            // Structural steps already done — palette attempts only re-encode
            // image bytes. Disable the heavy passes for each attempt.
            plan.trimTransparent = false;
            plan.dedupeAssets = false;
            plan.removeUnusedAssets = false;
            plan.effort = svgaEffort; // user-selected compression level

            if (audioBuffer && audioDuration) {
              plan.audioBuffer = audioBuffer;
              plan.audioDuration = audioDuration;
            }

            console.log(`Encoding ${format} attempt ${attempt}/${maxAttempts}...`, plan);

            // Run palette quantization on the structurally-optimized buffer.
            const candidateBuffer = await svgaService.optimizeSVGADirect(structuralBuffer, plan);
            const candidate = {
              attempt,
              buffer: candidateBuffer,
              size: candidateBuffer.length,
              sizeMB: toFixedSafe(candidateBuffer.length / (1024 * 1024), 2),
              plan,
            };

            attempts.push({
              attempt,
              sizeMB: candidate.sizeMB,
              quality: plan?.quality ?? null,
              width: metadata.width,
              height: metadata.height,
            });

            if (!bestCandidate || candidate.size < bestCandidate.size) {
              bestCandidate = candidate;
            }

            jobs.set(jobId, {
              ...jobs.get(jobId),
              step: `Smart SVGA compression attempt ${attempt}/${maxAttempts} -> ${candidate.sizeMB} MB`,
              progress: Math.min(88, 60 + Math.round((attempt / maxAttempts) * 28)),
            });

            if (candidate.size <= targetConfig.toleranceBytes) {
              break;
            }

            if (previousCandidate) {
              const improvementRatio = (previousCandidate.size - candidate.size) / Math.max(1, previousCandidate.size);

              if (attempt >= 3 && candidate.size > targetConfig.targetBytes * 10 && improvementRatio < 0.08) {
                console.log(`[SVGA->SVGA] Early stop after attempt ${attempt}: size is still far from 1MB and improvement dropped to ${(improvementRatio * 100).toFixed(1)}%`);
                break;
              }

              if (attempt >= 4 && improvementRatio < 0.03) {
                console.log(`[SVGA->SVGA] Early stop after attempt ${attempt}: compression plateau detected (${(improvementRatio * 100).toFixed(1)}% improvement)`);
                break;
              }
            }

            previousCandidate = candidate;
          }

          if (!bestCandidate) {
            throw new Error('Unable to optimize SVGA output.');
          }

          if (bestCandidate.size < inputSize || audioBuffer) {
            outputBuffer = bestCandidate.buffer;
          } else {
            console.log(`[SVGA->SVGA] No meaningful reduction found. Keeping original file (${toFixedSafe(inputSize / (1024 * 1024), 2)} MB).`);
            outputBuffer = svgaFile.buffer;
          }
          filename = `converted_${Date.now()}.svga`;
          mimetype = 'application/x-svga';
          compressionSummary = createCompressionSummary({
            inputSize: svgaFile.size,
            outputSize: outputBuffer.length,
            targetConfig,
            attempts,
            oneMbMode,
          });
        }
      } else {
        jobs.set(jobId, {
          ...jobs.get(jobId),
          step: oneMbMode
            ? `Smart ${format.toUpperCase()} compression towards ~1 MB...`
            : `Converting to ${format.toUpperCase()}...`,
          progress: 60
        });

        const attempts = [];
        const maxAttempts = oneMbMode
          ? (targetConfig.targetBytes <= 512 * 1024 ? 10 : 8)
          : 1;
        let bestCandidate = null;
        let lastEncodeLogAt = 0;
        const outputCeilingBytes = Number(targetConfig.outputCeilingBytes) || Infinity;
        const baseWebpOptions = format === 'webp'
          ? {
            quality: format === 'webp' ? tierSettings.quality : null,
            compressionLevel: tier === 'ultra' ? 6 : tier === 'high' ? 5 : 5,
            lossless: tier === 'ultra',
            alphaQuality: tier === 'ultra' ? 100 : tier === 'high' ? 100 : 96,
            preset: 'drawing',
          }
          : null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          const outputPath = path.join(tempDir, oneMbMode ? `output_attempt_${attempt}.${format}` : `output.${format}`);
          const plan = oneMbMode
            ? compression.getOneMbAttemptPlan(format, attempt, metadata, tier, {
              targetBytes: targetConfig.targetBytes,
              sourceSizeBytes: svgaFile.size,
            })
            : null;
          const fps = oneMbMode ? metadata.fps : Math.min(metadata.fps, tierSettings.fpsRange[1]);
          const targetWidth = plan?.width && Number(plan.width) !== Number(metadata.width)
            ? plan.width
            : null;
          const targetHeight = plan?.height && Number(plan.height) !== Number(metadata.height)
            ? plan.height
            : null;

          console.log(`Encoding ${format} attempt ${attempt}/${maxAttempts} with fps=${fps}...`, plan || {});

          if (format === 'gif') {
            await ffmpegService.framesToGIF(framesDir, 'frame_', outputPath, {
              fps,
              maxWidth: plan?.maxWidth || tierSettings.resolution,
              ditherScale: plan?.ditherScale || 5,
              stripMetadata: plan?.stripMetadata || false,
            });
          } else {
            await ffmpegService.framesToWebPSequence(framesDir, 'frame_', outputPath, {
              fps,
              quality: plan?.quality || baseWebpOptions?.quality || tierSettings.quality,
              compressionLevel: plan?.compressionLevel || baseWebpOptions?.compressionLevel || (oneMbMode ? 4 : 3),
              width: targetWidth,
              height: targetHeight,
              stripMetadata: plan?.stripMetadata || false,
              lossless: plan?.lossless ?? baseWebpOptions?.lossless ?? false,
              alphaQuality: plan?.alphaQuality || baseWebpOptions?.alphaQuality || 100,
              preset: plan?.preset || baseWebpOptions?.preset || 'drawing',
              crThreshold: plan?.crThreshold ?? null,
              crSize: plan?.crSize ?? null,
              onProgress: (progressInfo) => {
                const now = Date.now();
                if (now - lastEncodeLogAt < 1200) return;
                lastEncodeLogAt = now;

                const details = [
                  progressInfo.frame ? `frame ${progressInfo.frame}` : null,
                  progressInfo.time ? `time ${progressInfo.time}` : null,
                  progressInfo.speed ? `speed ${progressInfo.speed}` : null,
                ].filter(Boolean).join(' | ');

                jobs.set(jobId, {
                  ...jobs.get(jobId),
                  step: oneMbMode
                    ? `Smart ${format.toUpperCase()} encoding... ${details}`
                    : `Encoding ${format.toUpperCase()}... ${details}`,
                  progress: Math.max(
                    jobs.get(jobId)?.progress || 60,
                    Math.min(86, (jobs.get(jobId)?.progress || 60) + 1)
                  ),
                });

                console.log(`[SVGA->${format.toUpperCase()}][Attempt ${attempt}] ${details || progressInfo.raw}`);
              },
            });
          }

          const candidateBuffer = fs.readFileSync(outputPath);
          const candidate = {
            attempt,
            path: outputPath,
            buffer: candidateBuffer,
            size: candidateBuffer.length,
            sizeMB: toFixedSafe(candidateBuffer.length / (1024 * 1024), 2),
            plan,
          };

          attempts.push({
            attempt,
            sizeMB: candidate.sizeMB,
            quality: plan?.quality ?? null,
            width: plan?.width ?? plan?.maxWidth ?? null,
            height: plan?.height ?? null,
          });

          const candidateWithinCeiling = candidate.size <= outputCeilingBytes;
          const bestWithinCeiling = bestCandidate ? bestCandidate.size <= outputCeilingBytes : false;
          if (
            !bestCandidate ||
            (candidateWithinCeiling && !bestWithinCeiling) ||
            (
              candidateWithinCeiling === bestWithinCeiling &&
              (
                candidateWithinCeiling
                  ? Math.abs(candidate.size - targetConfig.targetBytes) < Math.abs(bestCandidate.size - targetConfig.targetBytes)
                  : candidate.size < bestCandidate.size
              )
            )
          ) {
            bestCandidate = candidate;
          }

          jobs.set(jobId, {
            ...jobs.get(jobId),
            step: oneMbMode
              ? `Smart compression attempt ${attempt}/${maxAttempts} -> ${candidate.sizeMB} MB`
              : `Encoded ${format.toUpperCase()} -> ${candidate.sizeMB} MB`,
            progress: Math.min(88, 60 + Math.round((attempt / maxAttempts) * 28)),
          });

          if (!oneMbMode || candidate.size <= targetConfig.toleranceBytes) {
            break;
          }
        }

        if (!bestCandidate) {
          throw new Error(`Unable to encode ${format.toUpperCase()} output.`);
        }

        outputBuffer = bestCandidate.buffer;
        filename = `converted_${Date.now()}.${format}`;
        mimetype = format === 'gif' ? 'image/gif' : 'image/webp';
        try {
          outputMetadata = await ffmpegService.getVideoInfo(bestCandidate.path);
        } catch (probeErr) {
          console.warn(`Failed to probe ${format.toUpperCase()} output metadata:`, probeErr.message);
        }
        compressionSummary = createCompressionSummary({
          inputSize: svgaFile.size,
          outputSize: outputBuffer.length,
          targetConfig,
          attempts,
          oneMbMode,
        });
      }
    }

    if (format === 'json') {
      compressionSummary = createCompressionSummary({
        inputSize: svgaFile.size,
        outputSize: outputBuffer.length,
        targetConfig,
        attempts: [{
          attempt: 1,
          sizeMB: toFixedSafe(outputBuffer.length / (1024 * 1024), 2),
          quality: null,
          width: null,
          height: null,
        }],
        oneMbMode,
      });
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Finalizing...', progress: 90 });

    // Store result
    jobs.set(jobId, {
      id: jobId,
      status: 'complete',
      step: 'Done!',
      progress: 100,
      result: {
        buffer: outputBuffer,
        filename,
        mimetype,
        size: outputBuffer.length,
        metadata,
        outputMetadata,
        preview,
        compression: compressionSummary,
        audioPreview: audioBuffer ? {
          buffer: audioBuffer,
          filename: `audio_${Date.now()}.mp3`,
          mimetype: 'audio/mpeg',
          size: audioBuffer.length,
        } : null,
      },
    });

    ffmpegService.cleanupTempDir(tempDir);

    console.log('SVGA Conversion complete:', {
      jobId,
      filename,
      size: outputBuffer.length,
      framesProcessed: renderResult.totalFrames
    });

    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      sizeMB: toFixedSafe(outputBuffer.length / (1024 * 1024), 2),
      framesProcessed: renderResult.totalFrames,
      metadata,
      outputMetadata,
      oneMbMode,
      compression: compressionSummary,
    });

  } catch (err) {
    console.error('SVGA Conversion error:', err);
    ffmpegService.cleanupTempDir(tempDir);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message, jobId });
  }
});

/**
 * POST /api/convert/video-svga
 * Convert video to SVGA animation with background removal
 */
router.post('/convert/video-svga', upload.single('file'), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const tier = req.body.sizeTier || 'standard';
    const removeBgParam = req.body.removeBg;
    const removeBgValue = String(removeBgParam ?? '').toLowerCase();
    const removeBg = removeBgParam === true || removeBgValue === 'true' || removeBgValue === 'yes' || removeBgValue === '1';
    const allowedBgColors = new Set(['green', 'black', 'white', 'transparent', 'nobackground']);
    let bgColor = String(req.body.bgColor || 'white').toLowerCase();
    if (!allowedBgColors.has(bgColor)) {
      bgColor = 'white';
    }
    if (!removeBg) {
      bgColor = 'none';
    }
    const sizeGovernance = compression.getSizeGovernance(tier);

    jobs.set(jobId, {
      id: jobId,
      status: 'processing',
      step: 'Saving video...',
      progress: 5,
    });

    // Step 1: Save video to temp
    const inputPath = path.join(tempDir, 'input' + path.extname(req.file.originalname || '.mp4'));
    fs.writeFileSync(inputPath, req.file.buffer);

    // Get video info
    const videoInfo = await ffmpegService.getVideoInfo(inputPath);

    // Limit duration
    if (videoInfo.duration > 10) {
      throw new Error('Video too long. Maximum 10 seconds allowed.');
    }

    // SVGA stores fps as an INTEGER (protobuf int32). Source videos are often
    // fractional (29.97, 23.976). If we extract at the fractional rate but
    // encode a truncated integer fps, then frames/fps != real duration and the
    // animation drifts faster/slower than the audio. Fix: pick ONE integer fps
    // and use it for BOTH extraction and encoding so:
    //   svga_duration = frameCount / fps  ==  real video duration.
    videoInfo.fpsExact = videoInfo.fps;
    videoInfo.fps = Math.max(1, Math.round(videoInfo.fps));
    console.log('[Video->SVGA][FPS] source(exact):', videoInfo.fpsExact, '-> integer fps used:', videoInfo.fps);

    const compParams = compression.getCompressionParams(tier, videoInfo.width, videoInfo.height, videoInfo.duration, videoInfo.fps);
    // Keep YES mode quality/compression behavior aligned with NO mode.
    const optimizationProfile = compression.getVideoOptimizationProfile(tier, false);

    // Strict frame stability: always lock to source FPS.
    compParams.fps = videoInfo.fps;

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting frames...', progress: 15 });

    // Step 2: Extract frames
    const rawFramesDir = path.join(tempDir, 'raw_frames');
    const framePaths = await ffmpegService.extractFrames(inputPath, rawFramesDir, {
      fps: videoInfo.fps,
      maxWidth: compParams.width,
      // rgb24 for FFmpeg extraction (most video codecs don't support rgba).
      // Alpha is added later by sharp.ensureAlpha() in removeBackground(),
      // so the unified segmentation pipeline still gets consistent RGBA data.
      pixFmt: 'rgb24',
    });
    // Strict frame integrity mode: keep extracted order/timeline unchanged.
    const selectedRawFramePaths = framePaths.slice();
    compParams.fps = videoInfo.fps;
    console.log('[Video->SVGA][TimelineNormalization]', {
      sourceExtracted: framePaths.length,
      normalized: selectedRawFramePaths.length,
      sourceFps: videoInfo.fps,
      duration: videoInfo.duration,
    });
    if (framePaths.length > 0) {
      const firstRawMeta = await sharp(framePaths[0]).metadata();
      console.log('[Video->SVGA][Frames][Raw]', {
        removeBg,
        count: framePaths.length,
        firstFramePath: framePaths[0],
        firstFrameSizeBytes: fs.statSync(framePaths[0]).size,
        firstFrameWidth: firstRawMeta.width,
        firstFrameHeight: firstRawMeta.height,
        firstFrameChannels: firstRawMeta.channels
      });
    }

    const processingMessage = removeBg
      ? `Removing ${bgColor} background...`
      : 'Processing frames...';
    jobs.set(jobId, { ...jobs.get(jobId), step: processingMessage, progress: 35 });

    // Step 3: Remove background (or copy if 'none')
    const processedDir = path.join(tempDir, 'processed');
    const bgProcess = await ffmpegService.removeBackgroundBatch(selectedRawFramePaths, processedDir, {
      outputBg: bgColor,
      keyColor: removeBg ? 'auto' : 'none',
    });
    const processedPaths = bgProcess.processedPaths;
    const bgReport = bgProcess.report || null;
    if (bgReport) {
      console.log('[Video->SVGA][BackgroundReport]', bgReport);
    }
    if (processedPaths.length > 0) {
      const firstProcessedMeta = await sharp(processedPaths[0]).metadata();
      console.log('[Video->SVGA][Frames][Processed]', {
        removeBg,
        count: processedPaths.length,
        firstFramePath: processedPaths[0],
        firstFrameSizeBytes: fs.statSync(processedPaths[0]).size,
        firstFrameWidth: firstProcessedMeta.width,
        firstFrameHeight: firstProcessedMeta.height,
        firstFrameChannels: firstProcessedMeta.channels
      });
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Building SVGA animation...', progress: 65 });

    // Step 4: Build SVGA from processed frames
    const isUltra = tier === 'ultra';

    const buildEncodedFrames = async (paths, frameOptions = {}, attemptIndex = 0) => {
      const frameBuffers = [];
      const profileDrop = attemptIndex * 6;
      const basePngQuality = Math.max(56, optimizationProfile.png.quality - profileDrop);
      const frameWidth = frameOptions.width || compParams.width;
      const frameHeight = frameOptions.height || compParams.height;
      const sourceCount = paths.length;

      for (let idx = 0; idx < paths.length; idx++) {
        const framePath = paths[idx];
        let sharpObj = sharp(framePath);

        sharpObj = sharpObj.resize(frameWidth, frameHeight, {
          fit: 'contain',
          kernel: isUltra ? sharp.kernel.lanczos3 : sharp.kernel.lanczos2
        }).toColorspace('srgb');

        // ALWAYS ensureAlpha — all modes get consistent RGBA data.
        // removeAlpha() was stripping precision from processed frames.
        // The SVGA encoder's opaqueFrames flag handles the semantic distinction.
        sharpObj = sharpObj.ensureAlpha();

        // Match NO mode encoding profile for both YES/NO (content preservation first).
        const usePalette = false;
        const encodedPng = await sharpObj.png({
          compressionLevel: optimizationProfile.png.compressionLevel,
          adaptiveFiltering: true,
          palette: usePalette,
          colors: usePalette ? optimizationProfile.png.colors : undefined,
          quality: isUltra ? 100 : basePngQuality,
        }).toBuffer();

        frameBuffers.push({
          imageBuffer: encodedPng,
          layout: { x: 0, y: 0, width: frameWidth, height: frameHeight },
          trimmed: false,
          delta: false,
          scene: 'motion',
        });
      }

      return {
        frameBuffers,
        sourceCount,
        keptCount: frameBuffers.length,
        keepRatio: sourceCount > 0 ? frameBuffers.length / sourceCount : 1,
        duplicateSkips: 0,
        scene: {
          staticRatio: 0,
          glowRatio: 0,
          motionRatio: 1,
          counts: { static: 0, motion: sourceCount, glow: 0 },
        },
      };
    };

    // Step 5: Optional Audio extraction
    let audioBuffer = null;
    const includeAudio = req.body.includeAudio === 'true' || req.body.includeAudio === true;

    if (includeAudio && videoInfo.hasAudio) {
      jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting audio...', progress: 85 });
      const audioPath = path.join(tempDir, 'audio.mp3');
      const audioSuccess = await ffmpegService.extractAudio(inputPath, audioPath, {
        bitrateKbps: optimizationProfile.audioBitrateKbps,
      });
      if (audioSuccess && fs.existsSync(audioPath)) {
        audioBuffer = fs.readFileSync(audioPath);
      }
    }
    let activeProcessedPaths = processedPaths;
    let activeFps = compParams.fps;
    let activeWidth = compParams.width;
    let activeHeight = compParams.height;
    let finalFrames = [];
    let svgaBuffer = null;
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const frameBuild = await buildEncodedFrames(activeProcessedPaths, {
        width: activeWidth,
        height: activeHeight,
      }, attempt);
      finalFrames = frameBuild.frameBuffers;
      if (finalFrames.length === 0) {
        throw new Error('No frames available after optimization.');
      }

      // Derive fps from the ACTUAL number of encoded frames and the REAL
      // video duration. This guarantees:
      //     svga_duration = frameCount / fps  ==  videoInfo.duration
      // regardless of variable-frame-rate videos, misreported frame rates, or
      // frame subsampling on size retries. Fixes the "6s video plays as 3s"
      // (2x speed) bug that happens when the extracted frame count doesn't
      // line up with duration × nominal_fps.
      const realDuration = Math.max(0.04, Number(videoInfo.duration) || 0);
      const encodeFps = Math.max(1, Math.round(finalFrames.length / realDuration));
      console.log('[Video->SVGA][Timing]', {
        frames: finalFrames.length,
        realDuration: Number(realDuration.toFixed(3)),
        nominalFps: activeFps,
        derivedFps: encodeFps,
        svgaDuration: Number((finalFrames.length / encodeFps).toFixed(3)),
      });

      if (finalFrames.length > 0) {
        console.log('[Video->SVGA][Frames][EncodeInput]', {
          attempt,
          removeBg,
          count: finalFrames.length,
          fps: encodeFps,
          width: activeWidth,
          height: activeHeight,
          sourceCount: frameBuild.sourceCount,
          duplicateSkips: frameBuild.duplicateSkips,
          scene: frameBuild.scene,
          firstFrameBufferBytes: finalFrames[0].imageBuffer.length
        });
      }

      svgaBuffer = await svgaService.encodeSVGA(finalFrames, {
        width: activeWidth,
        height: activeHeight,
        fps: encodeFps,
        opaqueFrames: !(removeBg && (bgColor === 'transparent' || bgColor === 'nobackground')),
        timelineMode: 'frame',
        audioBuffer,
        audioDuration: videoInfo.duration,
      });

      const sizeLimit = sizeGovernance.maxBytes || (50 * 1024 * 1024);
      const sizeRatio = svgaBuffer.length / Math.max(1, sizeGovernance.targetBytes);
      console.log('[Video->SVGA][SizeCheck]', {
        attempt,
        bytes: svgaBuffer.length,
        limit: sizeLimit,
        target: sizeGovernance.targetBytes,
        sizeRatio: Number(toFixedSafe(sizeRatio, 3, '0.000')),
      });

      if (svgaBuffer.length <= sizeLimit) {
        activeFps = encodeFps;
        break;
      }

      if (attempt === maxAttempts - 1) {
        throw new Error(`Unable to keep output within 50MB hard limit after ${maxAttempts} optimization passes.`);
      }

      const retryPlan = compression.getRetryPlan(tier, attempt + 1, activeFps, sizeRatio);
      // Reduce BOTH resolution AND frame count on retries.
      // Frame subsampling is essential for long videos (10s @ 24fps = 241 frames)
      // where resolution reduction alone can't bring size under limit.
      activeWidth = Math.max(64, Math.floor((activeWidth * retryPlan.scaleRatio) / 2) * 2);
      activeHeight = Math.max(64, Math.floor((activeHeight * retryPlan.scaleRatio) / 2) * 2);

      // Subsample frames using keepRatio — evenly distributed to preserve animation flow
      const targetFrameCount = Math.max(2, Math.round(activeProcessedPaths.length * retryPlan.keepRatio));
      if (targetFrameCount < activeProcessedPaths.length) {
        const step = (activeProcessedPaths.length - 1) / (targetFrameCount - 1);
        const subsampled = [];
        for (let si = 0; si < targetFrameCount; si++) {
          const idx = Math.min(activeProcessedPaths.length - 1, Math.round(si * step));
          subsampled.push(activeProcessedPaths[idx]);
        }
        activeProcessedPaths = subsampled;
        // Adjust FPS proportionally to maintain perceived speed
        activeFps = Math.max(8, Math.round(videoInfo.fps * retryPlan.keepRatio));
      }

      console.log('[Video->SVGA][RetryPlan]', {
        attempt: attempt + 1,
        keepRatio: retryPlan.keepRatio,
        scaleRatio: retryPlan.scaleRatio,
        targetFps: activeFps,
        selectedFrames: activeProcessedPaths.length,
        width: activeWidth,
        height: activeHeight,
      });
    }

    compParams.fps = activeFps;
    compParams.width = activeWidth;
    compParams.height = activeHeight;

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Finalizing...', progress: 90 });

    // Lightweight static preview (first frame, downscaled). Used by the client
    // when the SVGA is too large to load into the web player, so the preview
    // never fails outright on big outputs.
    let videoSvgaPreview = null;
    try {
      if (finalFrames[0] && finalFrames[0].imageBuffer) {
        // Full-resolution first frame for a crisp HD static preview
        // (only downscaled if larger than 1440px; small frames stay native).
        const previewPng = await sharp(finalFrames[0].imageBuffer)
          .resize(1440, 1440, { fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        videoSvgaPreview = {
          buffer: previewPng,
          filename: `preview_${Date.now()}.png`,
          mimetype: 'image/png',
        };
      }
    } catch (previewErr) {
      console.warn('[Video->SVGA] Failed to build static preview:', previewErr.message);
    }
    console.log('[Video->SVGA] static preview built:', !!videoSvgaPreview, videoSvgaPreview ? videoSvgaPreview.buffer.length + ' bytes' : '(none)');

    // Store result
    const filename = `animation_${Date.now()}.svga`;
    jobs.set(jobId, {
      id: jobId,
      status: 'complete',
      step: 'Done!',
      progress: 100,
      result: {
        preview: videoSvgaPreview,
        buffer: svgaBuffer,
        filename,
        mimetype: 'application/x-svga',
        size: svgaBuffer.length,
        audioPreview: audioBuffer ? {
          buffer: audioBuffer,
          filename: `audio_${Date.now()}.mp3`,
          mimetype: 'audio/mpeg',
          size: audioBuffer.length,
        } : null,
        sizeInfo: {
          minBytes: sizeGovernance.minBytes,
          preferredMinBytes: sizeGovernance.preferredMinBytes,
          preferredMaxBytes: sizeGovernance.preferredMaxBytes,
          maxBytes: sizeGovernance.maxBytes,
        },
      },
    });

    // Cleanup temp
    ffmpegService.cleanupTempDir(tempDir);

    res.json({
      success: true,
      jobId,
      filename,
      removeBg,
      size: svgaBuffer.length,
      sizeMB: toFixedSafe(svgaBuffer.length / (1024 * 1024), 2),
      hasAudio: !!audioBuffer,
      // Inline first-frame preview (base64) so the client can always show a
      // preview without a second fetch (avoids job-cleanup / caching races).
      previewDataUrl: videoSvgaPreview
        ? `data:image/png;base64,${videoSvgaPreview.buffer.toString('base64')}`
        : null,
      framesProcessed: finalFrames.length,
      sourceFrames: framePaths.length,
      optimizedFrames: selectedRawFramePaths.length,
      backgroundReport: bgReport,
      settings: compParams,
      sizePolicy: {
        minMB: 5,
        preferredMB: '25-30',
        maxMB: 50,
      },
    });

  } catch (err) {
    ffmpegService.cleanupTempDir(tempDir);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message, jobId });
  }
});

/**
 * POST /api/convert/png-animation
 * Convert PNG frames to GIF or SVGA animation
 */
router.post('/convert/png-animation', upload.array('files', 100), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);

  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const format = req.body.format || 'gif'; // 'gif' or 'svga'
    const tier = req.body.sizeTier || 'standard';
    const fps = parseInt(req.body.fps) || 15;
    const tierSettings = compression.getTierSettings(tier);

    jobs.set(jobId, {
      id: jobId,
      status: 'processing',
      step: 'Processing frames...',
      progress: 10,
    });

    // Step 1: Save and process frames
    const framesDir = path.join(tempDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    for (let i = 0; i < req.files.length; i++) {
      const framePath = path.join(framesDir, `frame_${String(i + 1).padStart(4, '0')}.png`);
      await sharp(req.files[i].buffer)
        .resize(tierSettings.resolution, tierSettings.resolution, { fit: 'inside', withoutEnlargement: true })
        .png()
        .toFile(framePath);
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: `Creating ${format.toUpperCase()}...`, progress: 50 });

    let outputBuffer, filename, mimetype;

    if (format === 'gif') {
      // Step 2a: Create GIF
      const outputPath = path.join(tempDir, 'output.gif');
      await ffmpegService.framesToGIF(framesDir, 'frame_', outputPath, {
        fps: Math.min(fps, tierSettings.fpsRange[1]),
        maxWidth: tierSettings.resolution,
      });
      outputBuffer = fs.readFileSync(outputPath);
      filename = `animation_${Date.now()}.gif`;
      mimetype = 'image/gif';
    } else {
      // Step 2b: Create SVGA
      const frames = [];
      for (let i = 0; i < req.files.length; i++) {
        const resized = await sharp(req.files[i].buffer)
          .resize(tierSettings.resolution, tierSettings.resolution, { fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();
        frames.push({ imageBuffer: resized });
      }

      outputBuffer = await svgaService.encodeSVGA(frames, {
        width: tierSettings.resolution,
        height: tierSettings.resolution,
        fps: Math.min(fps, tierSettings.fpsRange[1]),
      });
      filename = `animation_${Date.now()}.svga`;
      mimetype = 'application/octet-stream';
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Finalizing...', progress: 90 });

    // Store result
    jobs.set(jobId, {
      id: jobId,
      status: 'complete',
      step: 'Done!',
      progress: 100,
      result: {
        buffer: outputBuffer,
        filename,
        mimetype,
        size: outputBuffer.length,
      },
    });

    ffmpegService.cleanupTempDir(tempDir);

    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      sizeMB: toFixedSafe(outputBuffer.length / (1024 * 1024), 2),
    });

  } catch (err) {
    ffmpegService.cleanupTempDir(tempDir);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message, jobId });
  }
});

/**
 * GET /api/status/:jobId
 * Check job processing status
 */
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    id: job.id,
    status: job.status,
    step: job.step,
    progress: job.progress,
    error: job.error,
    result: job.result ? {
      filename: job.result.filename,
      size: job.result.size,
      sizeMB: toFixedSafe(job.result.size / (1024 * 1024), 2),
      metadata: job.result.metadata,
      sizeInfo: job.result.sizeInfo,
    } : null,
  });
});

/**
 * GET /api/download/:jobId
 * Download the converted file
 */
router.get('/download/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);

  console.log('Download request for jobId:', req.params.jobId);
  console.log('Available jobs:', Array.from(jobs.keys()));

  if (!job) {
    console.error('Job not found:', req.params.jobId);
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'complete' || !job.result) {
    console.error('Job not complete:', job.status);
    return res.status(400).json({ error: 'Job not complete yet' });
  }

  console.log('Serving file:', {
    filename: job.result.filename,
    mimetype: job.result.mimetype,
    size: job.result.buffer.length
  });

  const isPreviewRequest = req.query.preview === '1';
  const isAudioRequest = req.query.audio === '1';
  const responsePayload = isAudioRequest && job.result.audioPreview
    ? job.result.audioPreview
    : isPreviewRequest && job.result.preview
      ? job.result.preview
      : job.result;

  res.setHeader('Content-Type', responsePayload.mimetype);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Preview requests should be inline for player compatibility.
  if (isPreviewRequest || responsePayload.mimetype.startsWith('image/') || responsePayload.mimetype === 'application/json') {
    res.setHeader('Content-Disposition', `inline; filename="${responsePayload.filename}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${responsePayload.filename}"`);
  }

  res.setHeader('Content-Length', responsePayload.buffer.length);
  res.setHeader('Cache-Control', 'no-cache');

  console.log('Sending buffer of size:', responsePayload.buffer.length);
  res.send(responsePayload.buffer);

  // Cleanup job data after download (optional, free memory)
  if (!cleanupTimers.has(req.params.jobId)) {
    const cleanupTimer = setTimeout(() => {
      console.log('Cleaning up job:', req.params.jobId);
      jobs.delete(req.params.jobId);
      cleanupTimers.delete(req.params.jobId);
    }, 300000);
    cleanupTimers.set(req.params.jobId, cleanupTimer);
  }
});

/**
 * POST /api/convert/compose-svga
 * Stack multiple SVGA files (bottom → top) into one new SVGA
 */
router.post('/convert/compose-svga', upload.array('files', 20), async (req, res) => {
  const jobId = uuidv4();

  try {
    if (!req.files || req.files.length < 1) {
      return res.status(400).json({ error: 'Upload at least one image or .svga file' });
    }

    jobs.set(jobId, {
      id: jobId,
      status: 'processing',
      step: 'Parsing layers...',
      progress: 10,
    });

    const layers = [];
    for (const file of req.files) {
      const name = (file.originalname || '').toLowerCase();
      const isImage = /\.(png|jpe?g|webp|gif)$/.test(name) || (file.mimetype || '').startsWith('image/');
      if (isImage && !name.endsWith('.svga')) {
        const png = await sharp(file.buffer).ensureAlpha().png().toBuffer();
        const meta = await sharp(png).metadata();
        layers.push({
          name: file.originalname,
          staticPng: png,
          width: meta.width || 300,
          height: meta.height || 300,
        });
      } else {
        const movieData = await svgaService.parseSVGA(file.buffer);
        layers.push({
          name: file.originalname,
          movieData,
          images: movieData.images || {},
        });
      }
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Compositing frames...', progress: 40 });

    const fps = parseInt(req.body.fps, 10) || 0;
    let transforms = [];
    try {
      transforms = JSON.parse(req.body.transforms || '[]');
    } catch (_) {
      transforms = [];
    }

    const composed = await svgaRenderer.composeStackedLayers(layers, {
      fps: fps > 0 ? fps : undefined,
      transforms,
    });

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Encoding SVGA...', progress: 75 });

    const outputBuffer = await svgaService.encodeSVGA(composed.frames, {
      width: composed.width,
      height: composed.height,
      fps: composed.fps,
    });

    const filename = `composed_${Date.now()}.svga`;
    jobs.set(jobId, {
      id: jobId,
      status: 'complete',
      progress: 100,
      result: {
        filename,
        mimetype: 'application/octet-stream',
        buffer: outputBuffer,
      },
      createdAt: Date.now(),
      meta: {
        width: composed.width,
        height: composed.height,
        fps: composed.fps,
        frames: composed.frames.length,
        layers: req.files.length,
      },
    });

    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      downloadUrl: `/api/download/${jobId}`,
      meta: jobs.get(jobId).meta,
    });
  } catch (err) {
    console.error('[compose-svga]', err);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message, jobId });
  }
});

function finishJob(jobId, result) {
  jobs.set(jobId, {
    id: jobId,
    status: 'complete',
    progress: 100,
    result,
    createdAt: Date.now(),
  });
}

function resolutionCap(value) {
  if (!value || value === 'original') return 0;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * POST /api/convert/vap-info
 * Probe VAP / alpha MP4 metadata
 */
router.post('/convert/vap-info', upload.single('file'), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video uploaded' });
    }
    const inputPath = path.join(tempDir, 'input' + (path.extname(req.file.originalname || '') || '.mp4'));
    fs.writeFileSync(inputPath, req.file.buffer);
    const info = await vapService.probeVap(inputPath);
    res.json({ success: true, ...info });
  } catch (err) {
    console.error('[vap-info]', err);
    res.status(500).json({ error: err.message || 'Could not read video' });
  } finally {
    ffmpegService.cleanupTempDir(tempDir);
  }
});

/**
 * POST /api/convert/vap
 * VAP/MP4 → SVGA | animated WebP | VAP MP4
 */
router.post('/convert/vap', upload.single('file'), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No video uploaded' });
    }

    const format = String(req.body.format || 'svga').toLowerCase();
    if (!['svga', 'webp', 'vap'].includes(format)) {
      return res.status(400).json({ error: 'Format must be svga, webp, or vap' });
    }

    jobs.set(jobId, { id: jobId, status: 'processing', step: 'Reading video...', progress: 8 });

    const inputPath = path.join(tempDir, 'input' + (path.extname(req.file.originalname || '') || '.mp4'));
    fs.writeFileSync(inputPath, req.file.buffer);
    const info = await vapService.probeVap(inputPath);
    const keepAlpha = req.body.keepAlpha !== '0' && req.body.keepAlpha !== 'false';
    let layout = req.body.layout || info.layout;
    if (!keepAlpha) layout = 'none';
    if (layout === 'auto') layout = info.layout;

    const quality = req.body.quality || 'medium';
    const preset = vapService.qualityPreset(quality);
    const fps = Math.max(1, Math.min(60, parseInt(req.body.fps, 10) || Math.min(info.fps, preset.fpsCap)));
    const resCap = resolutionCap(req.body.resolution);
    const maxDim = resCap || vapService.resolveMaxDim(req.body.resolution, quality);

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting frames...', progress: 25 });
    const rgbaDir = path.join(tempDir, 'rgba');
    const extracted = await vapService.extractRgbaFrames(inputPath, rgbaDir, {
      fps,
      layout,
      maxDim,
    });

    const removeBgParam = String(req.body.removeBg || '').toLowerCase();
    const removeBg = removeBgParam === '1' || removeBgParam === 'true' || removeBgParam === 'yes';
    let encodeDir = rgbaDir;
    let encodePrefix = 'vap_';

    if (format === 'vap' && removeBg && layout === 'none') {
      jobs.set(jobId, { ...jobs.get(jobId), step: 'Removing background...', progress: 48 });
      const processedDir = path.join(tempDir, 'processed');
      let keyColor = String(req.body.bgColor || 'transparent').toLowerCase();
      if (keyColor === 'transparent' || keyColor === 'nobackground' || keyColor === 'auto') {
        keyColor = await vapService.detectKeyColor(extracted.files[0]);
      }
      if (!['white', 'black', 'green'].includes(keyColor)) {
        keyColor = 'white';
      }
      await vapService.punchKeyOnFrames(extracted.files, processedDir, keyColor);
      encodeDir = processedDir;
      encodePrefix = 'processed_';
    }

    if (format === 'svga') {
      jobs.set(jobId, { ...jobs.get(jobId), step: 'Encoding SVGA...', progress: 70 });
      const frames = [];
      for (const file of extracted.files) {
        frames.push({ imageBuffer: fs.readFileSync(file) });
      }
      const outputBuffer = await svgaService.encodeSVGA(frames, {
        width: extracted.width,
        height: extracted.height,
        fps: extracted.fps,
      });
      const filename = `vap_${Date.now()}.svga`;
      finishJob(jobId, {
        filename,
        mimetype: 'application/octet-stream',
        buffer: outputBuffer,
      });
      return res.json({
        success: true,
        jobId,
        filename,
        size: outputBuffer.length,
        downloadUrl: `/api/download/${jobId}`,
        meta: { width: extracted.width, height: extracted.height, fps: extracted.fps, frames: frames.length, layout },
      });
    }

    if (format === 'webp') {
      jobs.set(jobId, { ...jobs.get(jobId), step: 'Encoding WebP...', progress: 70 });
      const outputPath = path.join(tempDir, 'out.webp');
      await ffmpegService.framesToWebPSequence(rgbaDir, 'vap_', outputPath, {
        fps: extracted.fps,
        quality: preset.webpQuality,
        loop: 0,
        lossless: false,
        alphaQuality: keepAlpha ? 100 : 80,
      });
      const outputBuffer = fs.readFileSync(outputPath);
      const filename = `vap_${Date.now()}.webp`;
      finishJob(jobId, {
        filename,
        mimetype: 'image/webp',
        buffer: outputBuffer,
      });
      return res.json({
        success: true,
        jobId,
        filename,
        size: outputBuffer.length,
        downloadUrl: `/api/download/${jobId}`,
        meta: { width: extracted.width, height: extracted.height, fps: extracted.fps, frames: extracted.files.length, layout },
      });
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Encoding VAP MP4...', progress: 70 });
    const outputPath = path.join(tempDir, 'out.mp4');
    const bitrateMbps = Math.max(1, parseInt(req.body.bitrate, 10) || preset.bitrateMbps);
    await vapService.encodeVapMp4(encodeDir, encodePrefix, outputPath, {
      fps: extracted.fps,
      bitrateMbps,
      keepAlpha,
    });
    const outputBuffer = fs.readFileSync(outputPath);
    const filename = `vap_${Date.now()}.mp4`;
    finishJob(jobId, {
      filename,
      mimetype: 'video/mp4',
      buffer: outputBuffer,
    });
    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      downloadUrl: `/api/download/${jobId}`,
      meta: { width: extracted.width, height: extracted.height, fps: extracted.fps, frames: extracted.files.length, layout },
    });
  } catch (err) {
    console.error('[convert/vap]', err);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message || 'VAP conversion failed', jobId });
  } finally {
    ffmpegService.cleanupTempDir(tempDir);
  }
});

/**
 * POST /api/convert/svga-vap
 * SVGA → VAP MP4 (left alpha + right RGB)
 */
router.post('/convert/svga-vap', upload.single('file'), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No SVGA uploaded' });
    }
    jobs.set(jobId, { id: jobId, status: 'processing', step: 'Parsing SVGA...', progress: 10 });
    const movieData = await svgaService.parseSVGA(req.file.buffer);
    const params = movieData.params || {};
    const fps = Math.max(1, Math.min(60, parseInt(req.body.fps, 10) || params.fps || 20));
    const bitrateMbps = Math.max(1, parseInt(req.body.bitrate, 10) || 4);
    const keepAlpha = req.body.keepAlpha !== '0' && req.body.keepAlpha !== 'false';
    const resCap = resolutionCap(req.body.resolution);

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Rendering frames...', progress: 35 });
    const framesDir = path.join(tempDir, 'frames');
    const rendered = await svgaRenderer.renderFramesToDirectory(
      movieData,
      movieData.images || {},
      framesDir
    );

    let encodeDir = framesDir;
    let prefix = 'frame_';
    if (resCap > 0 && (rendered.width > resCap || rendered.height > resCap)) {
      encodeDir = path.join(tempDir, 'scaled');
      fs.mkdirSync(encodeDir, { recursive: true });
      const scale = resCap / Math.max(rendered.width, rendered.height);
      const w = Math.max(2, Math.round(rendered.width * scale));
      const h = Math.max(2, Math.round(rendered.height * scale));
      for (let i = 0; i < rendered.framePaths.length; i++) {
        const dest = path.join(encodeDir, `frame_${String(i + 1).padStart(4, '0')}.png`);
        await sharp(rendered.framePaths[i]).resize(w, h, { fit: 'fill' }).png().toFile(dest);
      }
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Encoding VAP MP4...', progress: 75 });
    const outputPath = path.join(tempDir, 'out.mp4');
    await vapService.encodeVapMp4(encodeDir, prefix, outputPath, {
      fps,
      bitrateMbps,
      keepAlpha,
    });
    const outputBuffer = fs.readFileSync(outputPath);
    const filename = `svga_${Date.now()}.mp4`;
    finishJob(jobId, {
      filename,
      mimetype: 'video/mp4',
      buffer: outputBuffer,
    });
    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      downloadUrl: `/api/download/${jobId}`,
      meta: { fps, bitrateMbps, frames: rendered.totalFrames, keepAlpha },
    });
  } catch (err) {
    console.error('[svga-vap]', err);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message || 'SVGA to VAP failed', jobId });
  } finally {
    ffmpegService.cleanupTempDir(tempDir);
  }
});

/**
 * POST /api/convert/svga-inspect
 */
router.post('/convert/svga-inspect', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No SVGA uploaded' });
    }
    const info = await svgaService.inspectSVGA(req.file.buffer);
    res.json({ success: true, ...info });
  } catch (err) {
    console.error('[svga-inspect]', err);
    res.status(500).json({ error: err.message || 'Could not inspect SVGA' });
  }
});

/**
 * POST /api/convert/svga-patch
 * Replace images, text, hide layers, trim frames, change fps
 */
router.post('/convert/svga-patch', upload.fields([
  { name: 'file', maxCount: 1 },
  { name: 'replacements', maxCount: 40 },
]), async (req, res) => {
  const jobId = uuidv4();
  try {
    const svgaFile = req.files && req.files.file ? req.files.file[0] : null;
    if (!svgaFile) {
      return res.status(400).json({ error: 'No SVGA uploaded' });
    }
    jobs.set(jobId, { id: jobId, status: 'processing', step: 'Patching SVGA...', progress: 30 });

    let keys = [];
    try {
      keys = JSON.parse(req.body.replaceKeys || '[]');
    } catch (_) {
      keys = [];
    }
    const replacementFiles = (req.files && req.files.replacements) || [];
    const replacements = {};
    replacementFiles.forEach((file, i) => {
      const key = keys[i];
      if (key) replacements[key] = file.buffer;
    });

    let hideKeys = [];
    let textOverlays = [];
    try { hideKeys = JSON.parse(req.body.hideKeys || '[]'); } catch (_) {}
    try { textOverlays = JSON.parse(req.body.textOverlays || '[]'); } catch (_) {}

    const outputBuffer = await svgaService.patchSVGA(svgaFile.buffer, {
      replacements,
      hideKeys,
      textOverlays,
      fps: req.body.fps,
      startFrame: req.body.startFrame,
      endFrame: req.body.endFrame,
    });
    const filename = `edited_${Date.now()}.svga`;
    finishJob(jobId, {
      filename,
      mimetype: 'application/octet-stream',
      buffer: outputBuffer,
    });
    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      downloadUrl: `/api/download/${jobId}`,
    });
  } catch (err) {
    console.error('[svga-patch]', err);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message || 'SVGA patch failed', jobId });
  }
});

/**
 * GET /api/health
 * Check system health
 */
router.get('/health', async (req, res) => {
  try {
    const ffmpegAvailable = await ffmpegService.checkFFmpeg();
    res.json({
      status: 'ok',
      ffmpeg: ffmpegAvailable,
      activeJobs: jobs.size,
      uptime: process.uptime(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
