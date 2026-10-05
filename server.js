const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const multer = require("multer");
const ffmpegPath = require("ffmpeg-static");
const { SarvamAIClient } = require("sarvamai");
const { buildCaptions } = require("./lib/captions");
const { buildAss } = require("./lib/ass");
const { getWordTimestamps, alignTranscriptWithAcoustics, buildCaptionsFromWords } = require("./lib/aligner");
const { convertHindiToHinglish } = require("./lib/hinglish");
const { supabase } = require("./lib/supabase");
const {
  isConfigured: r2Configured,
  getUploadPresignedUrl,
  getDownloadPresignedUrl,
  uploadFileToR2,
  downloadFileFromR2,
  deleteFromR2,
} = require("./lib/r2");

try {
  if (fs.existsSync(".env")) {
    process.loadEnvFile();
  }
} catch (e) {
  // On Render/cloud environments, env variables are injected via process.env directly
}
if (!process.env.SARVAM_API_KEY) {
  console.error("SARVAM_API_KEY is not set in .env");
  process.exit(1);
}

const client = new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY });
const PROJECTS_DIR = path.join(__dirname, "projects");
fs.mkdirSync(PROJECTS_DIR, { recursive: true });

const app = express();
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});
app.use(express.json({ limit: "5mb" }));
app.get("/health", (req, res) => res.status(200).json({ status: "ok", uptime: process.uptime(), timestamp: Date.now() }));
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(express.static(path.join(__dirname, "public")));

// ---------- project helpers ----------
const projDir = (id) => path.join(PROJECTS_DIR, id);
const projFile = (id) => path.join(projDir(id), "project.json");
const validId = (id) => /^[a-f0-9]{16}$/.test(id) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

function load(id) {
  return JSON.parse(fs.readFileSync(projFile(id), "utf8"));
}
function save(p) {
  fs.writeFileSync(projFile(p.id), JSON.stringify(p, null, 2));
  // Async mirror to Supabase
  syncToSupabase(p).catch((err) => console.warn("Supabase sync error:", err.message));
}
function update(id, patch) {
  const p = { ...load(id), ...patch };
  save(p);
  return p;
}

async function syncToSupabase(p) {
  if (!process.env.SUPABASE_URL) return;
  const payload = {
    name: p.name,
    status: p.status,
    progress: p.progress || 0,
    language: p.language || null,
    target_lang: p.targetLang || "auto",
    error: p.error || null,
    captions: p.captions || [],
    style: p.style || null,
    video_url: p.videoUrl || null,
    video_storage_path: p.videoR2Key || null,
    export_file_url: p.exportUrl || null,
    exported_at: p.exportedAt ? new Date(p.exportedAt).toISOString() : null,
    updated_at: new Date().toISOString()
  };
  const { error } = await supabase.from("projects").upsert(
    { id: p.id, ...payload },
    { onConflict: "id" }
  );
  if (error) console.warn("Supabase upsert failed:", error.message);
}

function runFfmpeg(args, { cwd, duration, onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-y", ...args], { cwd });
    let tail = "";
    proc.stderr.on("data", (d) => {
      const s = d.toString();
      tail = (tail + s).slice(-4000);
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && duration && onProgress) {
        const t = +m[1] * 3600 + +m[2] * 60 + +m[3];
        onProgress(Math.min(99, Math.round((t / duration) * 100)));
      }
    });
    proc.on("error", reject);
    proc.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error("ffmpeg failed:\n" + tail.split("\n").slice(-6).join("\n")))
    );
  });
}

// Waveform: 100 peaks per second (0-100), from the extracted speech audio.
function computePeaks(dir) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ["-hide_banner", "-i", "audio.mp3", "-f", "s16le", "-ac", "1", "-ar", "8000", "-"], { cwd: dir });
    const peaks = [];
    let max = 0, n = 0, leftover = null;
    proc.stdout.on("data", (buf) => {
      if (leftover) { buf = Buffer.concat([leftover, buf]); leftover = null; }
      const usable = buf.length - (buf.length % 2);
      if (usable < buf.length) leftover = buf.subarray(usable);
      for (let i = 0; i < usable; i += 2) {
        const v = Math.abs(buf.readInt16LE(i));
        if (v > max) max = v;
        if (++n === 80) { peaks.push(max); max = 0; n = 0; }
      }
    });
    proc.stderr.resume();
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error("peak extraction failed"));
      const sorted = peaks.slice().sort((a, b) => a - b);
      const top = Math.max(1, sorted[Math.floor(sorted.length * 0.99)] || 1);
      const norm = peaks.map((v) => Math.min(100, Math.round((v / top) * 100)));
      fs.writeFileSync(path.join(dir, "peaks.json"), JSON.stringify({ rate: 100, peaks: norm }));
      resolve();
    });
  });
}

// ---------- upload ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      req.projectId = crypto.randomUUID();
      fs.mkdirSync(projDir(req.projectId), { recursive: true });
      cb(null, projDir(req.projectId));
    },
    filename: (req, file, cb) => cb(null, "source" + (path.extname(file.originalname) || ".mp4").toLowerCase()),
  }),
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("video/") || file.mimetype.startsWith("audio/")),
});

// Pre-signed direct upload URL generator (Client -> Cloudflare R2 directly)
app.post("/api/uploads/presign", async (req, res) => {
  try {
    const { filename, contentType } = req.body || {};
    const ext = (path.extname(filename || "") || ".mp4").toLowerCase();
    const projectId = crypto.randomUUID();
    const key = `uploads/${projectId}/source${ext}`;
    
    if (r2Configured) {
      const uploadUrl = await getUploadPresignedUrl(key, contentType || "video/mp4", 3600);
      const publicBase = process.env.R2_PUBLIC_DEV_URL ? process.env.R2_PUBLIC_DEV_URL.replace(/\/$/, "") : null;
      const publicUrl = publicBase ? `${publicBase}/${key}` : null;
      return res.json({
        projectId,
        key,
        uploadUrl,
        publicUrl,
        r2: true,
      });
    }

    // Fallback if R2 credentials are not set
    res.json({ projectId, r2: false });
  } catch (err) {
    console.error("Presign error:", err);
    res.status(500).json({ error: "Failed to generate upload URL: " + err.message });
  }
});

// Create project from direct R2 upload
app.post("/api/projects/from-r2", async (req, res) => {
  try {
    const { id, name, key, publicUrl } = req.body;
    if (!id || !key) return res.status(400).json({ error: "id and key required" });
    
    const dir = projDir(id);
    fs.mkdirSync(dir, { recursive: true });
    const ext = (path.extname(key) || ".mp4").toLowerCase();
    const filename = `source${ext}`;
    const localDest = path.join(dir, filename);

    // Stream download from R2 to local worker cache so ffmpeg & Sarvam can process it
    if (r2Configured) {
      await downloadFileFromR2(key, localDest);
    }

    const p = {
      id,
      name: name || "video" + ext,
      video: filename,
      videoR2Key: key,
      videoUrl: publicUrl || null,
      createdAt: Date.now(),
      status: "uploaded",
      progress: 0,
      error: null,
      language: null,
      captions: [],
      style: null,
      exportFile: null,
    };
    save(p);
    res.json(p);
  } catch (err) {
    console.error("Failed to create project from R2:", err);
    res.status(500).json({ error: "Failed to finalize R2 upload: " + err.message });
  }
});

app.post("/api/projects", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please drop a video file." });
  const p = {
    id: req.projectId,
    name: req.file.originalname,
    video: req.file.filename,
    videoR2Key: null,
    videoUrl: null,
    createdAt: Date.now(),
    status: "uploaded",
    progress: 0,
    error: null,
    language: null,
    captions: [],
    style: null,
    exportFile: null,
  };

  // Asynchronously upload local copy to R2 in background
  if (r2Configured) {
    const key = `uploads/${p.id}/${p.video}`;
    const localFile = path.join(projDir(p.id), p.video);
    uploadFileToR2(localFile, key, req.file.mimetype)
      .then(() => {
        p.videoR2Key = key;
        if (process.env.R2_PUBLIC_DEV_URL) {
          p.videoUrl = `${process.env.R2_PUBLIC_DEV_URL.replace(/\/$/, "")}/${key}`;
        }
        save(p);
      })
      .catch((e) => console.warn("Background R2 upload failed:", e.message));
  }

  save(p);
  res.json(p);
});

app.get("/api/projects", (req, res) => {
  const list = fs
    .readdirSync(PROJECTS_DIR)
    .filter((id) => validId(id) && fs.existsSync(projFile(id)))
    .map((id) => {
      const { captions, ...meta } = load(id);
      return { ...meta, captionCount: captions.length };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  res.json(list);
});

app.param("id", (req, res, next, id) => {
  if (!validId(id) || !fs.existsSync(projFile(id))) return res.status(404).json({ error: "Not found" });
  next();
});

app.get("/api/projects/:id", (req, res) => res.json(load(req.params.id)));

app.get("/api/projects/:id/video", (req, res) => res.sendFile(path.join(projDir(req.params.id), load(req.params.id).video)));

app.get("/api/projects/:id/peaks", (req, res) => {
  const f = path.join(projDir(req.params.id), "peaks.json");
  fs.existsSync(f) ? res.sendFile(f) : res.status(404).json({ error: "No waveform" });
});

app.put("/api/projects/:id", (req, res) => {
  const current = load(req.params.id);
  const transcribing = ["uploaded", "extracting", "transcribing"].includes(current.status);
  const patch = {};
  if (Array.isArray(req.body.captions) && !transcribing) patch.captions = req.body.captions;
  if (req.body.style) patch.style = req.body.style;
  res.json(update(req.params.id, patch));
});

app.delete("/api/projects/:id", async (req, res) => {
  fs.rmSync(projDir(req.params.id), { recursive: true, force: true });
  if (process.env.SUPABASE_URL) {
    await supabase.from("projects").delete().eq("id", req.params.id).catch(() => {});
  }
  res.json({ ok: true });
});

// ---------- transcription (Sarvam Batch STT, saaras:v4) ----------
app.post("/api/projects/:id/transcribe", (req, res) => {
  const p = load(req.params.id);
  const targetLang = req.body?.language || "auto";
  if (["extracting", "transcribing", "converting_hinglish"].includes(p.status)) return res.json(p);
  res.json(update(p.id, { status: "extracting", targetLang, progress: 0, error: null }));
  transcribe(p.id, targetLang).catch((err) => {
    console.error("Transcription failed:", err.message);
    update(p.id, { status: "error", error: err.message });
  });
});

async function transcribe(id, targetLang = "auto") {
  const dir = projDir(id);
  const p = load(id);
  const audio = path.join(dir, "audio.mp3");

  // 16 kHz mono speech audio is all the model needs and keeps uploads small.
  await runFfmpeg(["-i", p.video, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", "audio.mp3"], { cwd: dir });
  await computePeaks(dir).catch((e) => console.warn("Waveform failed:", e.message));
  update(id, { status: "transcribing" });

  // For Hinglish, transcribe in Hindi (hi-IN) first
  let sarvamLangCode = "unknown";
  if (targetLang === "hinglish" || targetLang === "hi-IN") {
    sarvamLangCode = "hi-IN";
  } else if (targetLang && targetLang !== "auto") {
    sarvamLangCode = targetLang;
  }

  const job = await client.speechToTextJob.createJob({
    model: "saaras:v4",
    mode: "transcribe",
    languageCode: sarvamLangCode,
    withTimestamps: true,
  });
  await job.uploadFiles([audio], 600);
  await job.start();
  await job.waitUntilComplete(3, 7200);

  const results = await job.getFileResults();
  if (!results.successful.length) {
    throw new Error(results.failed[0]?.error_message || "Sarvam could not transcribe this file.");
  }

  const outDir = path.join(dir, "stt");
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir);
  await job.downloadOutputs(outDir);
  const jsonFile = fs.readdirSync(outDir).find((f) => f.endsWith(".json"));
  if (!jsonFile) throw new Error("No transcript returned.");
  const result = JSON.parse(fs.readFileSync(path.join(outDir, jsonFile), "utf8"));

  const ts = result.timestamps;
  const rawTexts = ts?.words || ts?.chunks;
  
  // High-precision Acoustic Forced Alignment:
  // Use Whisper acoustic frame timestamps to align Sarvam's transcript
  let finalCaptions = null;
  try {
    const sarvamWords = (result.transcript || '').split(/\s+/).filter(Boolean);
    if (sarvamWords.length > 0) {
      const whisperWords = await getWordTimestamps(audio);
      if (whisperWords && whisperWords.length > 0) {
        // Read audio duration from peaks if available
        let audioDuration = null;
        try {
          const pk = JSON.parse(fs.readFileSync(path.join(dir, "peaks.json"), "utf8"));
          if (pk && pk.peaks) audioDuration = +(pk.peaks.length / pk.rate).toFixed(2);
        } catch {}
        const aligned = alignTranscriptWithAcoustics(sarvamWords, whisperWords, audioDuration);
        if (aligned && aligned.length > 0) {
          finalCaptions = buildCaptionsFromWords(aligned, () => crypto.randomBytes(4).toString('hex'));
        }
      }
    }
  } catch (alignErr) {
    console.warn("Acoustic alignment fallback:", alignErr.message);
  }

  // Fallback to phrase-level interpolation if acoustic alignment is unavailable
  if (!finalCaptions || finalCaptions.length === 0) {
    if (!ts || !rawTexts?.length) {
      if (result.transcript && result.transcript.trim()) {
        const chunks = [{ text: result.transcript, start: 0, end: 15 }];
        finalCaptions = buildCaptions(chunks);
      } else {
        throw new Error("No speech detected.");
      }
    } else {
      const chunks = rawTexts.map((text, i) => ({
        text,
        start: ts.start_time_seconds[i] != null ? ts.start_time_seconds[i] : 0,
        end: ts.end_time_seconds[i] != null ? ts.end_time_seconds[i] : 0,
      }));
      finalCaptions = buildCaptions(chunks);
    }
  }

  // If user requested Hinglish, convert Devanagari Hindi to natural Romanised Hinglish script
  if (targetLang === "hinglish") {
    update(id, { status: "converting_hinglish" });
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    try {
      finalCaptions = await convertHindiToHinglish(finalCaptions, openrouterKey);
    } catch (hinglishErr) {
      console.warn("Hinglish conversion warning:", hinglishErr.message);
    }
  }

  update(id, {
    status: "ready",
    progress: 100,
    language: targetLang === "hinglish" ? "Hinglish (Romanised)" : (result.language_code || null),
    captions: finalCaptions,
  });
}

// ---------- export (burn captions into video) ----------
app.post("/api/projects/:id/export", (req, res) => {
  const p = load(req.params.id);
  if (p.status === "exporting") return res.json(p);
  const { width, height, duration, style } = req.body;
  if (!width || !height) return res.status(400).json({ error: "Missing video dimensions." });
  res.json(update(p.id, { status: "exporting", progress: 0, error: null, style: style || p.style }));

  (async () => {
    const dir = projDir(p.id);
    const fresh = load(p.id);
    fs.writeFileSync(path.join(dir, "captions.ass"), buildAss(fresh.captions, fresh.style, width, height));
    const out = "captioned.mp4";
    await runFfmpeg(
      ["-i", fresh.video, "-vf", "ass=captions.ass", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
       "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", out],
      { cwd: dir, duration, onProgress: (progress) => update(p.id, { progress }) }
    );
    let exportUrl = null;
    let exportR2Key = null;
    if (r2Configured) {
      exportR2Key = `exports/${p.id}/captioned.mp4`;
      try {
        await uploadFileToR2(path.join(dir, out), exportR2Key, "video/mp4");
        if (process.env.R2_PUBLIC_DEV_URL) {
          exportUrl = `${process.env.R2_PUBLIC_DEV_URL.replace(/\/$/, "")}/${exportR2Key}`;
        }
      } catch (r2Err) {
        console.warn("Failed to upload export to R2:", r2Err.message);
      }
    }
    update(p.id, {
      status: "ready",
      progress: 100,
      exportFile: out,
      exportR2Key,
      exportUrl,
      exportedAt: Date.now()
    });
  })().catch((err) => {
    console.error("Export failed:", err.message);
    update(p.id, { status: "ready", error: "Export failed: " + err.message });
  });
});

app.get("/api/projects/:id/download", (req, res) => {
  const p = load(req.params.id);
  if (!p.exportFile) return res.status(404).json({ error: "Not exported yet" });
  const base = path.parse(p.name).name;
  res.download(path.join(projDir(p.id), p.exportFile), `${base}_captioned.mp4`);
});

// Reset any jobs interrupted by a server restart.
for (const id of fs.readdirSync(PROJECTS_DIR)) {
  if (!validId(id) || !fs.existsSync(projFile(id))) continue;
  const p = load(id);
  if (["extracting", "transcribing"].includes(p.status)) update(id, { status: "error", error: "Interrupted. Please retry." });
  if (p.status === "exporting") update(id, { status: "ready", error: "Export interrupted. Please retry." });
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Caption Studio running at http://localhost:${PORT}`));
