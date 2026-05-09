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

const svgaService = require('../services/svga');
const svgaRenderer = require('../services/svgaRenderer');
const ffmpegService = require('../services/ffmpeg');
const compression = require('../services/compression');

// Multer memory storage (no permanent files)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
});

// Job storage (in-memory for localhost)
const jobs = new Map();

/**
 * POST /api/upload
 * Upload a file and get a job_id
 */
router.post('/upload', upload.single('file'), (req, res) => {
  try {
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
 * Convert SVGA animation to WebP or GIF
 */
router.post('/convert/svga', upload.single('file'), async (req, res) => {
  const jobId = uuidv4();
  const tempDir = ffmpegService.createTempDir(jobId);

  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('SVGA Conversion started:', {
      jobId,
      filename: req.file.originalname,
      size: req.file.size,
      format: req.body.format,
      tier: req.body.sizeTier
    });

    const format = req.body.format || 'webp';
    const tier = req.body.sizeTier || 'standard';
    const tierSettings = compression.getTierSettings(tier);

    // Update job status
    jobs.set(jobId, {
      id: jobId,
      status: 'processing',
      step: 'Parsing SVGA...',
      progress: 10,
    });

    // Step 1: Parse SVGA
    console.log('Step 1: Parsing SVGA...');
    const movieData = await svgaService.parseSVGA(req.file.buffer);
    const metadata = svgaService.getMetadata(movieData);
    console.log('SVGA Metadata:', metadata);

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting frames...', progress: 30 });

    // Step 2: Render frames with canvas (proper transforms)
    console.log('Step 2: Rendering frames with canvas...');
    const renderedFrames = await svgaRenderer.renderAllFrames(movieData, movieData.images || {});

    console.log(`Rendered ${renderedFrames.length} frames`);

    if (renderedFrames.length === 0) {
      throw new Error('No frames could be rendered from SVGA file. The file may be corrupted or empty.');
    }

    // Step 2: Save frames as PNGs (only if not JSON)
    let outputBuffer, filename, mimetype;

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

      outputBuffer = Buffer.from(JSON.stringify(cleanMovieData, null, 2));
      filename = `metadata_${Date.now()}.json`;
      mimetype = 'application/json';
    } else {
      console.log(`Step 3: Converting to ${format.toUpperCase()}...`);
      const framesDir = path.join(tempDir, 'frames');
      fs.mkdirSync(framesDir, { recursive: true });

      console.log(`Saving ${renderedFrames.length} rendered frames...`);

      // Save rendered frames as PNGs
      for (let i = 0; i < renderedFrames.length; i++) {
        const framePath = path.join(framesDir, `frame_${String(i + 1).padStart(4, '0')}.png`);
        try {
          // Resize if needed
          await sharp(renderedFrames[i].buffer)
            .resize(tierSettings.resolution, tierSettings.resolution, {
              fit: 'inside',
              withoutEnlargement: true,
              background: { r: 0, g: 0, b: 0, alpha: 0 }
            })
            .png()
            .toFile(framePath);
        } catch (err) {
          console.warn(`Failed to save frame ${i}:`, err.message);
        }
      }

      console.log(`Saved ${renderedFrames.length} frames`);

      jobs.set(jobId, { ...jobs.get(jobId), step: `Converting to ${format.toUpperCase()}...`, progress: 60 });

      // Step 3: Convert to requested format
      const outputPath = path.join(tempDir, `output.${format}`);
      const fps = Math.min(metadata.fps, tierSettings.fpsRange[1]);

      console.log(`Step 3: Creating ${format} with fps=${fps}...`);
      if (format === 'gif') {
        await ffmpegService.framesToGIF(framesDir, 'frame_', outputPath, {
          fps,
          maxWidth: tierSettings.resolution,
        });
      } else {
        await ffmpegService.framesToWebPSequence(framesDir, 'frame_', outputPath, {
          fps,
          quality: tierSettings.quality,
        });
      }

      console.log('Reading output file...');
      outputBuffer = fs.readFileSync(outputPath);
      filename = `converted_${Date.now()}.${format}`;
      mimetype = format === 'gif' ? 'image/gif' : 'image/webp';
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
      },
    });

    ffmpegService.cleanupTempDir(tempDir);

    console.log('SVGA Conversion complete:', {
      jobId,
      filename,
      size: outputBuffer.length,
      framesProcessed: renderedFrames.length
    });

    res.json({
      success: true,
      jobId,
      filename,
      size: outputBuffer.length,
      sizeMB: (outputBuffer.length / (1024 * 1024)).toFixed(2),
      framesProcessed: renderedFrames.length,
      metadata,
    });

  } catch (err) {
    console.error('SVGA Conversion error:', err);
    ffmpegService.cleanupTempDir(tempDir);
    jobs.set(jobId, { id: jobId, status: 'error', error: err.message });
    res.status(500).json({ error: err.message, stack: err.stack, jobId });
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
    const removeBg = removeBgParam === 'true' || removeBgParam === true;
    let bgColor = req.body.bgColor || 'white';
    // We want 'none' to stay 'none' to bypass background removal
    if (!removeBg) {
      bgColor = 'none';
    }

    const similarity = parseFloat(req.body.similarity) || 0.25;
    const blend = parseFloat(req.body.blend) || 0.1;
    const tierSettings = compression.getTierSettings(tier);

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
    if (videoInfo.duration > 15) {
      throw new Error('Video too long. Maximum 10 seconds allowed.');
    }

    const compParams = compression.getCompressionParams(tier, videoInfo.width, videoInfo.height, videoInfo.duration, videoInfo.fps);
    
    // Original FPS Maintain if removeBg is false
    if (!removeBg) {
      compParams.fps = videoInfo.fps;
    }

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting frames...', progress: 15 });

    // Step 2: Extract frames
    const rawFramesDir = path.join(tempDir, 'raw_frames');
    const framePaths = await ffmpegService.extractFrames(inputPath, rawFramesDir, {
      fps: compParams.fps,
      maxWidth: compParams.width,
      pixFmt: removeBg ? 'rgba' : 'rgb24'
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
    const processedPaths = await ffmpegService.removeBackgroundBatch(framePaths, processedDir, {
      bgColor,
      similarity,
      blend,
    });
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
    const frames = [];
    const isUltra = tier === 'ultra';

    for (const framePath of processedPaths) {
      const buffer = fs.readFileSync(framePath);
      
      let sharpObj = sharp(buffer);
      
      if (removeBg) {
        sharpObj = sharpObj.ensureAlpha() // Ensure alpha channel is present
          .resize(compParams.width, compParams.height, { 
            fit: 'contain', 
            background: { r: 0, g: 0, b: 0, alpha: 0 },
            kernel: isUltra ? sharp.kernel.lanczos3 : sharp.kernel.lanczos2
          });
      } else {
        sharpObj = sharpObj.resize(compParams.width, compParams.height, {
          fit: 'contain',
          kernel: isUltra ? sharp.kernel.lanczos3 : sharp.kernel.lanczos2
        });

        // Force an opaque RGB pipeline for fidelity mode.
        sharpObj = sharpObj
          .toColorspace('srgb')
          .removeAlpha();
      }

      if (isUltra || !removeBg) {
        // Ultra Fidelity or No Background Removal: No palette, lossless-like PNG
        sharpObj = sharpObj.png({ 
          compressionLevel: 9, 
          adaptiveFiltering: true,
          palette: false, // Use PNG-24/32
          quality: 100
        });
      } else {
        // Standard/High: Palette-based optimization
        sharpObj = sharpObj.png({ 
          compressionLevel: 9, 
          palette: true, 
          colors: 256,
          quality: tier === 'high' ? 90 : 80 
        });
      }

      const resized = await sharpObj.toBuffer();
      frames.push({ imageBuffer: resized });
    }
    if (frames.length > 0) {
      console.log('[Video->SVGA][Frames][EncodeInput]', {
        removeBg,
        count: frames.length,
        firstFrameBufferBytes: frames[0].imageBuffer.length
      });
    }

    // Step 5: Optional Audio extraction
    let audioBuffer = null;
    const includeAudio = req.body.includeAudio === 'true' || req.body.includeAudio === true;

    if (includeAudio && videoInfo.hasAudio) {
      jobs.set(jobId, { ...jobs.get(jobId), step: 'Extracting audio...', progress: 85 });
      const audioPath = path.join(tempDir, 'audio.mp3');
      const audioSuccess = await ffmpegService.extractAudio(inputPath, audioPath);
      if (audioSuccess && fs.existsSync(audioPath)) {
        audioBuffer = fs.readFileSync(audioPath);
      }
    }

    const svgaBuffer = await svgaService.encodeSVGA(frames, {
      width: compParams.width,
      height: compParams.height,
      fps: compParams.fps,
      opaqueFrames: !removeBg,
      audioBuffer,
      audioDuration: videoInfo.duration,
    });

    jobs.set(jobId, { ...jobs.get(jobId), step: 'Finalizing...', progress: 90 });

    // Store result
    const filename = `animation_${Date.now()}.svga`;
    jobs.set(jobId, {
      id: jobId,
      status: 'complete',
      step: 'Done!',
      progress: 100,
      result: {
        buffer: svgaBuffer,
        filename,
        mimetype: 'application/octet-stream',
        size: svgaBuffer.length,
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
      sizeMB: (svgaBuffer.length / (1024 * 1024)).toFixed(2),
      framesProcessed: frames.length,
      settings: compParams,
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
      sizeMB: (outputBuffer.length / (1024 * 1024)).toFixed(2),
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
      sizeMB: (job.result.size / (1024 * 1024)).toFixed(2),
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

  res.setHeader('Content-Type', job.result.mimetype);
  res.setHeader('Access-Control-Allow-Origin', '*');

  // Allow inline viewing for images, force download for others
  if (job.result.mimetype.startsWith('image/') || job.result.mimetype === 'application/json') {
    res.setHeader('Content-Disposition', `inline; filename="${job.result.filename}"`);
  } else {
    res.setHeader('Content-Disposition', `attachment; filename="${job.result.filename}"`);
  }

  res.setHeader('Content-Length', job.result.buffer.length);
  res.setHeader('Cache-Control', 'no-cache');

  console.log('Sending buffer of size:', job.result.buffer.length);
  res.send(job.result.buffer);

  // Cleanup job data after download (optional, free memory)
  setTimeout(() => {
    console.log('Cleaning up job:', req.params.jobId);
    jobs.delete(req.params.jobId);
  }, 60000); // Delete after 1 minute
});

/**
 * GET /api/health
 * Check system health
 */
router.get('/health', async (req, res) => {
  const ffmpegAvailable = await ffmpegService.checkFFmpeg();
  res.json({
    status: 'ok',
    ffmpeg: ffmpegAvailable,
    activeJobs: jobs.size,
    uptime: process.uptime(),
  });
});

module.exports = router;
