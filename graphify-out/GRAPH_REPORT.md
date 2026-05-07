# Graph Report - .  (2026-05-05)

## Corpus Check
- Corpus is ~6,748 words - fits in a single context window. You may not need a graph.

## Summary
- 59 nodes · 82 edges · 6 communities detected
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 3 edges (avg confidence: 0.8)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_PNG Editor Canvas|PNG Editor Canvas]]
- [[_COMMUNITY_UI & File Handling|UI & File Handling]]
- [[_COMMUNITY_FFmpeg Video Processing|FFmpeg Video Processing]]
- [[_COMMUNITY_Compression & Quality|Compression & Quality]]
- [[_COMMUNITY_Platform Features|Platform Features]]
- [[_COMMUNITY_SVGA Parser|SVGA Parser]]

## God Nodes (most connected - your core abstractions)
1. `runFFmpeg()` - 7 edges
2. `showToast()` - 5 edges
3. `getTierSettings()` - 5 edges
4. `getCompressionParams()` - 5 edges
5. `addImageToCanvas()` - 4 edges
6. `AnimSuite Pro Platform` - 4 edges
7. `setFile()` - 3 edges
8. `renderLayersList()` - 3 edges
9. `resetAnimations()` - 3 edges
10. `exportAnimation()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `applyEffect()` --calls--> `showToast()`  [INFERRED]
  public/js/editor.js → public/js/app.js
- `editorPlay()` --calls--> `showToast()`  [INFERRED]
  public/js/editor.js → public/js/app.js
- `exportAnimation()` --calls--> `showToast()`  [INFERRED]
  public/js/editor.js → public/js/app.js

## Communities (8 total, 0 thin omitted)

### Community 0 - "PNG Editor Canvas"
Cohesion: 0.24
Nodes (10): addImageToCanvas(), deleteLayer(), editorReset(), exportAnimation(), handleEditorDrop(), handleEditorFileSelect(), initEditor(), renderLayersList() (+2 more)

### Community 1 - "UI & File Handling"
Cohesion: 0.21
Nodes (7): handleDrop(), handleFileSelect(), setFile(), showToast(), startConversion(), applyEffect(), editorPlay()

### Community 2 - "FFmpeg Video Processing"
Cohesion: 0.27
Nodes (8): checkFFmpeg(), extractFrames(), framesToGIF(), framesToWebP(), framesToWebPSequence(), removeBackground(), removeBackgroundBatch(), runFFmpeg()

### Community 3 - "Compression & Quality"
Cohesion: 0.62
Nodes (6): calculateBitrate(), calculateFPS(), calculateResolution(), checkSizeRequirement(), getCompressionParams(), getTierSettings()

### Community 4 - "Platform Features"
Cohesion: 0.38
Nodes (7): AnimSuite Pro Platform, Background Removal Feature, Local Processing (No Cloud), PNG Animation Editor, Output Size Control (5MB/10MB/15MB), SVGA to WebP Converter, Video to SVGA Converter

### Community 5 - "SVGA Parser"
Cohesion: 0.47
Nodes (3): encodeSVGA(), loadProto(), parseSVGA()

## Knowledge Gaps
- **2 isolated node(s):** `Background Removal Feature`, `Local Processing (No Cloud)`
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `showToast()` connect `UI & File Handling` to `PNG Editor Canvas`?**
  _High betweenness centrality (0.083) - this node is a cross-community bridge._
- **Why does `exportAnimation()` connect `PNG Editor Canvas` to `UI & File Handling`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **Why does `applyEffect()` connect `UI & File Handling` to `PNG Editor Canvas`?**
  _High betweenness centrality (0.022) - this node is a cross-community bridge._
- **Are the 3 inferred relationships involving `showToast()` (e.g. with `applyEffect()` and `editorPlay()`) actually correct?**
  _`showToast()` has 3 INFERRED edges - model-reasoned connections that need verification._
- **What connects `Background Removal Feature`, `Local Processing (No Cloud)` to the rest of the system?**
  _2 weakly-connected nodes found - possible documentation gaps or missing edges._