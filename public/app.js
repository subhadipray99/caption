/* Caption Studio client */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Mirrors lib/ass.js DEFAULTS so preview == export.
const DEFAULT_STYLE = {
  font: "Montserrat",
  size: 72,
  color: "#FFFFFF",
  highlight: true,
  highlightColor: "#FFD60A",
  outline: 5,
  outlineColor: "#000000",
  background: false,
  bgColor: "#000000",
  bgOpacity: 0.6,
  position: 15,
  uppercase: false,
  letterSpacing: 1,
  lineSpacing: 1.25,
  wordSpacing: 0,
  shadow: 0,
  shadowColor: "#000000",
  bold: true,
  italic: false,
  alignment: "center",
};

const PRESETS = {
  hormozi: {
    font: "Anton",
    size: 78,
    color: "#FFFFFF",
    highlight: true,
    highlightColor: "#FFD60A",
    outline: 6,
    outlineColor: "#000000",
    background: false,
    uppercase: true,
    letterSpacing: 1,
    lineSpacing: 1.2,
    wordSpacing: 2,
    shadow: 0,
    shadowColor: "#000000",
    bold: true,
    italic: false,
    alignment: "center",
  },
  minimal: {
    font: "Montserrat",
    size: 68,
    color: "#FFFFFF",
    highlight: true,
    highlightColor: "#38BDF8",
    outline: 0,
    outlineColor: "#000000",
    background: false,
    uppercase: false,
    letterSpacing: 2,
    lineSpacing: 1.3,
    wordSpacing: 1,
    shadow: 4,
    shadowColor: "#000000",
    bold: true,
    italic: false,
    alignment: "center",
  },
  cyber: {
    font: "JetBrains Mono",
    size: 70,
    color: "#FFFFFF",
    highlight: true,
    highlightColor: "#00FFCC",
    outline: 4,
    outlineColor: "#050505",
    background: false,
    uppercase: true,
    letterSpacing: 2,
    lineSpacing: 1.25,
    wordSpacing: 0,
    shadow: 6,
    shadowColor: "#00FFCC",
    bold: true,
    italic: false,
    alignment: "center",
  },
  cinematic: {
    font: "Playfair Display",
    size: 66,
    color: "#FFF8E7",
    highlight: true,
    highlightColor: "#FBBF24",
    outline: 1,
    outlineColor: "#000000",
    background: false,
    uppercase: false,
    letterSpacing: 2,
    lineSpacing: 1.35,
    wordSpacing: 2,
    shadow: 3,
    shadowColor: "#000000",
    bold: true,
    italic: true,
    alignment: "center",
  },
  boxed: {
    font: "Poppins",
    size: 64,
    color: "#FFFFFF",
    highlight: true,
    highlightColor: "#FFD60A",
    outline: 0,
    outlineColor: "#000000",
    background: true,
    bgColor: "#09090b",
    bgOpacity: 0.75,
    uppercase: false,
    letterSpacing: 1,
    lineSpacing: 1.25,
    wordSpacing: 0,
    shadow: 0,
    shadowColor: "#000000",
    bold: true,
    italic: false,
    alignment: "center",
  },
};
const BUSY = ["extracting", "transcribing", "converting_hinglish", "converting_bengalish", "exporting"];
const BUSY_TEXT = {
  extracting: "Extracting audio track…",
  transcribing: "Transcribing speech…<br><small>Generating accurate word timestamps.</small>",
  converting_hinglish: "Transliterating to Hinglish…<br><small>Converting script to Romanized text.</small>",
  converting_bengalish: "Transliterating to Bengalish…<br><small>Converting script to Romanized text.</small>",
};

const state = {
  projects: [],
  current: null, // project metadata
  captions: [],
  style: { ...DEFAULT_STYLE },
  selectedId: null,
  pps: 100, // timeline pixels per second
  peaks: null,
  undo: [],
  lastExportedAt: null,
};

const video = $("#video");
const player = $("#player");
const captionBox = $("#captionBox");
const tlScroll = $("#tlScroll");
const tlContent = $("#tlContent");
const captionTrack = $("#captionTrack");
const waveCanvas = $("#wave");

// ---------------- utils ----------------
const uid = () => Math.random().toString(16).slice(2, 10);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const duration = () => (isFinite(video.duration) ? video.duration : 0);
function fmt(t, cs = true) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const c = Math.floor((t % 1) * 100);
  const base = (h ? h + ":" : "") + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  return cs ? base + "." + String(c).padStart(2, "0") : base;
}
const API_BASE = window.API_BASE || "";
async function api(path, opts = {}) {
  const url = path.startsWith("http") ? path : `${API_BASE}${path}`;
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
  }
  // Attach user auth token if session exists
  try {
    const session = await BuzyAuth.getSession();
    if (session?.access_token) {
      headers["Authorization"] = `Bearer ${session.access_token}`;
    }
  } catch {}

  const res = await fetch(url, {
    ...opts,
    headers,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || res.statusText);
    err.status = res.status;
    err.code = data.code;
    err.data = data;
    throw err;
  }
  return data;
}
let toastTimer;
function toast(msg) {
  const el = $("#exportStatus");
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { if (el.textContent === msg) el.textContent = ""; }, 2500);
}
const sorted = () => state.captions.sort((a, b) => a.start - b.start);
const capById = (id) => state.captions.find((c) => c.id === id);
const capAt = (t) => state.captions.find((c) => t >= c.start && t < c.end);

// ---------------- persistence ----------------
let saveTimer;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!state.current) return;
  try {
    await api(`/api/projects/${state.current.id}`, {
      method: "PUT",
      body: JSON.stringify({ captions: state.captions, style: state.style }),
    });
  } catch (e) { toast("Save failed: " + e.message); }
}
function pushUndo() {
  state.undo.push(JSON.stringify(state.captions));
  if (state.undo.length > 100) state.undo.shift();
}
function commit(mutator) {
  pushUndo();
  mutator();
  sorted();
  scheduleSave();
  renderAll();
}
function undo() {
  const prev = state.undo.pop();
  if (!prev) return toast("Nothing to undo");
  state.captions = JSON.parse(prev);
  if (!capById(state.selectedId)) state.selectedId = null;
  scheduleSave();
  renderAll();
}

// ---------------- files ----------------
async function loadProjects() {
  state.projects = await api("/api/projects");
  renderFiles();
}
function renderFiles() {
  const ul = $("#fileList");
  ul.innerHTML = "";
  for (const p of state.projects) {
    const li = document.createElement("li");
    li.className = "file-item" + (state.current?.id === p.id ? " active" : "");
    let sub = `${p.captionCount} captions`;
    if (p.status === "extracting" || p.status === "transcribing") sub = "Transcribing…";
    if (p.status === "exporting") sub = `Exporting ${p.progress}%`;
    if (p.status === "error") sub = "Failed";
    li.innerHTML = `
      <div class="file-thumb">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>
        </svg>
      </div>
      <div class="file-meta"><div class="file-name"></div><div class="file-sub ${p.status === "error" ? "err" : ""}">${sub}</div></div>
      <button class="file-del" title="Delete video">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
        </svg>
      </button>`;
    li.querySelector(".file-name").textContent = p.name;
    li.querySelector(".file-name").title = p.name;
    li.onclick = () => openProject(p.id);
    li.querySelector(".file-del").onclick = async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name}" and its captions?`)) return;
      await api(`/api/projects/${p.id}`, { method: "DELETE" });
      if (state.current?.id === p.id) closeProject();
      loadProjects();
    };
    ul.appendChild(li);
  }
}

async function uploadFile(file) {
  if (!file || !(file.type.startsWith("video/") || file.type.startsWith("audio/"))) return toast("Please drop a video file");
  const bar = $("#uploadProgress");
  bar.hidden = false;
  const barFill = bar.firstElementChild;
  barFill.style.width = "0%";

  try {
    // 1. Check if direct R2 presigned upload is available
    let presign = null;
    try {
      presign = await api("/api/uploads/presign", {
        method: "POST",
        body: JSON.stringify({ filename: file.name, contentType: file.type || "video/mp4" }),
      });
    } catch (e) {
      console.warn("Presign request failed, falling back to direct server upload:", e);
    }

    if (presign && presign.uploadUrl) {
      // 2. Upload directly to Cloudflare R2 from browser (0 server bandwidth)
      await new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", presign.uploadUrl);
        if (file.type) xhr.setRequestHeader("Content-Type", file.type);
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) barFill.style.width = (e.loaded / e.total) * 90 + "%";
        };
        xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("R2 upload status " + xhr.status)));
        xhr.onerror = () => reject(new Error("R2 direct upload network error (check bucket CORS)"));
        xhr.send(file);
      });

      barFill.style.width = "95%";

      // 3. Inform server to link the R2 object & prepare local cache
      const p = await api("/api/projects/from-r2", {
        method: "POST",
        body: JSON.stringify({
          id: presign.projectId,
          name: file.name,
          key: presign.key,
          publicUrl: presign.publicUrl,
        }),
      });

      bar.hidden = true;
      barFill.style.width = "0";
      await loadProjects();
      await openProject(p.id);
      toast("Video uploaded! Choose language and click Start.");
      return;
    }
  } catch (r2Err) {
    console.warn("Direct R2 upload failed or CORS blocked. Falling back to server multipart upload:", r2Err);
  }

  // Fallback: Upload to server multipart endpoint
  const fd = new FormData();
  fd.append("video", file);
  const xhr = new XMLHttpRequest();
  xhr.open("POST", "/api/projects");
  xhr.upload.onprogress = (e) => { if (e.lengthComputable) barFill.style.width = (e.loaded / e.total) * 100 + "%"; };
  xhr.onload = async () => {
    bar.hidden = true;
    barFill.style.width = "0";
    if (xhr.status !== 200) return toast("Upload failed");
    const p = JSON.parse(xhr.responseText);
    await loadProjects();
    await openProject(p.id);
    toast("Video placed! Choose language and click Start.");
  };
  xhr.onerror = () => { bar.hidden = true; toast("Upload failed"); };
  xhr.send(fd);
}

$("#fileInput").onchange = (e) => { uploadFile(e.target.files[0]); e.target.value = ""; };
let dragDepth = 0;
window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("drag"); });
window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("drag"); } });
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("drag");
  uploadFile(e.dataTransfer.files[0]);
});

// ---------------- project ----------------
async function openProject(id) {
  if (state.current?.id === id) return;
  await flushSave();
  const p = await api(`/api/projects/${id}`);
  state.current = p;
  state.captions = p.captions || [];
  state.style = { ...DEFAULT_STYLE, ...(p.style || {}) };
  state.selectedId = null;
  state.undo = [];
  state.peaks = null;
  state.lastExportedAt = p.exportedAt || null;
  $("#stageEmpty").hidden = true;
  player.hidden = false;
  video.src = p.videoUrl || `${API_BASE}/api/projects/${id}/video`;
  $("#projectTitle").innerHTML = "";
  const b = document.createElement("b");
  b.textContent = p.name;
  $("#projectTitle").appendChild(b);
  syncStyleControls();
  applyStatus(p);
  loadPeaks();
  renderFiles();
  renderAll();
}
function closeProject() {
  state.current = null;
  state.captions = [];
  video.removeAttribute("src");
  video.load();
  player.hidden = true;
  $("#stageEmpty").hidden = false;
  $("#projectTitle").textContent = "";
  $("#transcribeControls").hidden = true;
  applyStatus(null);
  renderAll();
}
async function loadPeaks() {
  if (!state.current) return;
  try { state.peaks = await api(`/api/projects/${state.current.id}/peaks`); } catch { state.peaks = null; }
  drawWave();
}

function applyStatus(p) {
  const busy = $("#busy");
  const status = p?.status;
  const prev = state.current?.status;
  const ctrl = $("#transcribeControls");

  if (p) {
    ctrl.hidden = false;
    const isWorking = BUSY.includes(status);
    $("#startTranscribeBtn").disabled = isWorking;
    $("#langSelect").disabled = isWorking;
    if (status === "uploaded") {
      $("#startTranscribeBtn").innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg> <span>Start Captioning</span>`;
    } else if (isWorking) {
      $("#startTranscribeBtn").innerHTML = `<div class="spinner" style="width:14px;height:14px;border-width:2px;"></div> <span>Processing…</span>`;
    } else {
      $("#startTranscribeBtn").innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> <span>Re-transcribe</span>`;
    }
  } else {
    ctrl.hidden = true;
  }

  if (p && state.current && p.id === state.current.id) {
    // Transcription finished: pull captions in.
    if ((prev === "extracting" || prev === "transcribing" || prev === "converting_hinglish" || prev === "converting_bengalish" || prev === "uploaded") && status === "ready") {
      state.captions = p.captions || [];
      state.undo = [];
      loadPeaks();
      renderAll();
      if (state.captions.length) toast(`${state.captions.length} captions generated (${p.language || "ready"})`);
    }
    if (prev === "extracting" && (status === "transcribing" || status === "converting_hinglish" || status === "converting_bengalish")) loadPeaks();
    // Export finished.
    if (p.exportedAt && p.exportedAt !== state.lastExportedAt) {
      state.lastExportedAt = p.exportedAt;
      location.href = p.exportUrl || `${API_BASE}/api/projects/${p.id}/download`;
    }
    Object.assign(state.current, { ...p, captions: undefined });
  }

  if (status === "extracting" || status === "transcribing" || status === "converting_hinglish" || status === "converting_bengalish") {
    busy.hidden = false;
    $("#busyText").innerHTML = BUSY_TEXT[status] || "Processing…";
    busy.querySelector(".spinner").hidden = false;
  } else if (status === "error") {
    busy.hidden = false;
    busy.querySelector(".spinner").hidden = true;
    $("#busyText").innerHTML = "";
    const msg = document.createElement("div");
    msg.textContent = "Transcription failed: " + (p.error || "unknown error");
    const btn = document.createElement("button");
    btn.className = "btn primary small";
    btn.style.marginTop = "10px";
    btn.textContent = "Retry";
    btn.onclick = retranscribe;
    $("#busyText").append(msg, btn);
  } else {
    busy.hidden = true;
  }

  const exportEl = $("#exportStatus");
  if (status === "exporting") exportEl.textContent = `Exporting… ${p.progress || 0}%`;
  else if (p?.error && status === "ready") exportEl.textContent = p.error;
  else if (p?.exportFile && status === "ready") exportEl.innerHTML = `<a href="/api/projects/${p.id}/download">Download last export</a>`;
  else if (!p) exportEl.textContent = "";

  const ready = status === "ready";
  $("#exportBtn").disabled = !ready || !state.captions.length;
  $("#exportBtn").innerHTML = status === "exporting"
    ? `<div class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></div> <span>Exporting…</span>`
    : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m22 8-6 4 6 4V8Z"/><rect width="14" height="12" x="2" y="6" rx="2" ry="2"/></svg> <span>Export<span class="export-text-long"> Video</span></span>`;
  $("#srtBtn").disabled = !state.captions.length;
  $("#retryBtn").hidden = !(ready || status === "error");

  // Detect if Hinglish or Bengalish conversion was requested but captions remain in native script
  const isHinglishTarget = p?.targetLang === "hinglish" || (p?.language && p.language.includes("Hinglish"));
  const hasDevanagari = (state.captions || []).some(c => /[ऀ-ॿ]/.test(c.text || ""));
  const isHinglishFailed = Boolean(p && (p.hinglishFailed || (isHinglishTarget && hasDevanagari)));

  const isBengalishTarget = p?.targetLang === "bengalish" || (p?.language && p.language.includes("Bengalish"));
  const hasBengali = (state.captions || []).some(c => /[\u0980-\u09FF]/.test(c.text || ""));
  const isBengalishFailed = Boolean(p && (p.bengalishFailed || (isBengalishTarget && hasBengali)));

  const isTranslitFailed = isHinglishFailed || isBengalishFailed;
  const langName = isBengalishTarget ? "Bengalish" : "Hinglish";
  const origScript = isBengalishTarget ? "Bengali" : "Hindi";

  const alertCard = $("#hinglishAlertCard");
  const stageBanner = $("#stageHinglishBanner");

  if (isTranslitFailed && ready) {
    if (alertCard) {
      alertCard.hidden = false;
      const titleSpan = alertCard.querySelector(".hinglish-alert-title span");
      if (titleSpan) titleSpan.textContent = `${langName} Incomplete`;
      const descP = alertCard.querySelector(".hinglish-alert-desc");
      if (descP) descP.textContent = `Speech was transcribed in ${origScript}. Transliteration was interrupted.`;
      const cardBtn = $("#retryHinglishBtn");
      if (cardBtn && !cardBtn.disabled) {
        cardBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> <span>${langName} could not be generated, give it another try? [free]</span>`;
      }
    }
    if (stageBanner) {
      stageBanner.hidden = false;
      const bannerSpan = stageBanner.querySelector("span:not(button span)");
      if (bannerSpan) bannerSpan.textContent = `Captions in ${origScript}`;
      const stageBtn = $("#retryHinglishStageBtn");
      if (stageBtn && !stageBtn.disabled) {
        stageBtn.innerHTML = `<span>${langName} could not be generated, give it another try? [free]</span>`;
      }
    }
  } else {
    if (alertCard) alertCard.hidden = true;
    if (stageBanner) stageBanner.hidden = true;
  }
}

async function startTranscribe() {
  if (!state.current) return;
  if (state.captions.length && !confirm("Re-transcribe? This replaces your current captions.")) return;
  await flushSave();
  const language = $("#langSelect")?.value || "auto";
  const durSec = duration();
  try {
    const p = await api(`/api/projects/${state.current.id}/transcribe`, {
      method: "POST",
      body: JSON.stringify({ language, duration: durSec })
    });
    state.current.status = "extracting";
    applyStatus(p);
    loadProjects();
    loadUserBalance();
  } catch (err) {
    if (err.status === 402 || err.code === "INSUFFICIENT_MINUTES") {
      openBillingModal(err.data?.requiredMinutes);
      return;
    }
    toast(err.message || "Failed to start transcription");
  }
}
$("#startTranscribeBtn").onclick = startTranscribe;
$("#retryBtn").onclick = startTranscribe;

async function retryTransliteration() {
  if (!state.current) return;
  const isBengalish = state.current.targetLang === "bengalish" || (state.current.language && state.current.language.includes("Bengalish"));
  const langName = isBengalish ? "Bengalish" : "Hinglish";
  const endpoint = isBengalish ? `/api/projects/${state.current.id}/retry-bengalish` : `/api/projects/${state.current.id}/retry-hinglish`;

  const cardBtn = $("#retryHinglishBtn");
  const stageBtn = $("#retryHinglishStageBtn");

  const setBusy = (busy) => {
    if (cardBtn) {
      cardBtn.disabled = busy;
      cardBtn.innerHTML = busy
        ? `<div class="spinner" style="width:13px;height:13px;border-width:2px;margin-right:6px;"></div> <span>Translating to ${langName} [free]…</span>`
        : `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg> <span>${langName} could not be generated, give it another try? [free]</span>`;
    }
    if (stageBtn) {
      stageBtn.disabled = busy;
      stageBtn.innerHTML = busy
        ? `<div class="spinner" style="width:12px;height:12px;border-width:2px;margin-right:4px;"></div> <span>Translating [free]…</span>`
        : `<span>${langName} could not be generated, give it another try? [free]</span>`;
    }
  };

  setBusy(true);
  toast(`Translating speech to ${langName} [free]…`);

  try {
    const updated = await api(endpoint, {
      method: "POST"
    });
    state.current = updated;
    state.captions = updated.captions || [];
    state.undo = [];
    applyStatus(updated);
    renderAll();
    toast(`${langName} captions generated successfully!`);
  } catch (err) {
    console.error(`Retry ${langName} error:`, err);
    toast(err.message || `${langName} transliteration could not finish. Please try again.`);
    if (state.current) {
      const p = await api(`/api/projects/${state.current.id}`).catch(() => null);
      if (p) {
        state.current = p;
        state.captions = p.captions || state.captions;
        applyStatus(p);
        renderAll();
      }
    }
  } finally {
    setBusy(false);
  }
}
const retryHinglish = retryTransliteration;

const retryHinglishBtn = $("#retryHinglishBtn");
if (retryHinglishBtn) retryHinglishBtn.onclick = retryTransliteration;
const retryHinglishStageBtn = $("#retryHinglishStageBtn");
if (retryHinglishStageBtn) retryHinglishStageBtn.onclick = retryTransliteration;

// Poll while anything is processing.
let isPolling = false;
setInterval(async () => {
  const anyBusy = state.projects.some((p) => BUSY.includes(p.status)) || (state.current && BUSY.includes(state.current.status));
  if (!anyBusy || isPolling) return;
  isPolling = true;
  try {
    await loadProjects();
    if (state.current) {
      const p = await api(`/api/projects/${state.current.id}`);
      applyStatus(p);
    }
  } catch {}
  finally {
    isPolling = false;
  }
}, 3000);

// ---------------- player layout ----------------
function layoutPlayer() {
  if (!video.videoWidth) return;
  const stage = $("#stage");
  const cs = getComputedStyle(stage);
  const W = stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const H = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  const ar = video.videoWidth / video.videoHeight;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  player.style.width = w + "px";
  player.style.height = h + "px";
  renderOverlay(true);
}
new ResizeObserver(() => { layoutPlayer(); renderTimeline(); }).observe($("#stage"));
video.addEventListener("loadedmetadata", () => {
  layoutPlayer();
  $("#durTime").textContent = fmt(duration());
  renderTimeline();
});

// ---------------- caption overlay ----------------
const fontScaleCache = {};
function fontScale(font) {
  if (fontScaleCache[font]) return fontScaleCache[font];
  const ctx = document.createElement("canvas").getContext("2d");
  ctx.font = `700 100px "${font}"`;
  const m = ctx.measureText("Hg");
  const r = m.fontBoundingBoxAscent && m.fontBoundingBoxDescent ? (m.fontBoundingBoxAscent + m.fontBoundingBoxDescent) / 100 : 1.3;
  return (fontScaleCache[font] = +r.toFixed(3));
}

let overlayKey = "";
function renderOverlay(force = false) {
  if (!video.videoWidth) return;
  const t = video.currentTime;
  const st = state.style;
  const cap = capAt(t);
  let wordIdx = -1;
  let words = null;
  if (cap && st.highlight) {
    words = Timing.wordTimings(st.uppercase ? cap.text.toUpperCase() : cap.text, cap.start, cap.end);
    wordIdx = words.findIndex((w) => t >= w.start && t < w.end);
    if (wordIdx < 0) wordIdx = words.length - 1;
  }
  const key = cap ? `${cap.id}|${cap.text}|${wordIdx}` : "";
  if (!force && key === overlayKey) return;
  overlayKey = key;

  const s = player.clientHeight / video.videoHeight; // display scale
  const unit = (Math.min(video.videoWidth, video.videoHeight) / 1080) * s;
  const fontPx = st.size * unit;
  const fs = fontScale(st.font);
  const letterSpacePx = (st.letterSpacing || 0) * unit;
  const wordSpacePx = (st.wordSpacing || 0) * unit;
  const lineH = st.lineSpacing || fs;
  const hasShadow = !st.background && (st.shadow > 0);
  const shadowPx = (st.shadow || 0) * unit;

  Object.assign(captionBox.style, {
    fontFamily: `"${st.font}", sans-serif`,
    fontSize: fontPx + "px",
    lineHeight: String(lineH),
    letterSpacing: letterSpacePx + "px",
    wordSpacing: wordSpacePx + "px",
    fontWeight: st.bold === false ? "500" : "800",
    fontStyle: st.italic ? "italic" : "normal",
    textAlign: st.alignment || "center",
    bottom: st.position + "%",
    color: st.color,
    webkitTextStroke: st.background ? "0" : `${(st.outline || 0) * unit * 2}px ${st.outlineColor || "#000"}`,
    textShadow: hasShadow ? `0 ${shadowPx * 0.8}px ${shadowPx * 1.5}px ${st.shadowColor || "#000000"}` : "none",
    paintOrder: "stroke fill",
  });
  captionBox.classList.toggle("boxed", st.background);
  captionBox.innerHTML = "";
  if (!cap) return;

  const line = document.createElement("span");
  line.className = "line";
  if (st.background) {
    const a = Math.round(st.bgOpacity * 255).toString(16).padStart(2, "0");
    line.style.background = st.bgColor + a;
    line.style.boxShadow = `0 0 0 ${fontPx * 0.25}px ${st.bgColor + a}`;
  }
  const text = st.uppercase ? cap.text.toUpperCase() : cap.text;
  const list = words || text.split(/\s+/).filter(Boolean).map((word) => ({ word }));
  list.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "w";
    span.textContent = w.word;
    if (i === wordIdx) span.style.color = st.highlightColor;
    line.appendChild(span);
    if (i < list.length - 1) line.appendChild(document.createTextNode(" "));
  });
  captionBox.appendChild(line);
}

// ---------------- playback ----------------
function togglePlay() {
  if (!video.src) return;
  video.paused ? video.play() : video.pause();
}
$("#playBtn").onclick = togglePlay;
video.addEventListener("click", togglePlay);
video.addEventListener("play", () => { $("#playIcon").setAttribute("d", "M6 5h4v14H6zM14 5h4v14h-4z"); tick(); });
video.addEventListener("pause", () => $("#playIcon").setAttribute("d", "M8 5v14l11-7z"));
video.addEventListener("seeked", onTime);
video.addEventListener("timeupdate", () => { if (video.paused) onTime(); });
function tick() {
  onTime();
  if (!video.paused) requestAnimationFrame(tick);
}
let lastActiveRow = null;
function onTime() {
  const t = video.currentTime;
  $("#curTime").textContent = fmt(t);
  const x = t * state.pps;
  $("#playhead").style.left = x + "px";
  if (!video.paused) {
    const view = tlScroll.scrollLeft;
    if (x > view + tlScroll.clientWidth - 80 || x < view) tlScroll.scrollLeft = x - 80;
  }
  renderOverlay();
  // Highlight active row in the captions list.
  const cap = capAt(t);
  const row = cap ? document.querySelector(`.cap-row[data-id="${cap.id}"]`) : null;
  if (row !== lastActiveRow) {
    lastActiveRow?.classList.remove("active");
    row?.classList.add("active");
    lastActiveRow = row;
    const editing = document.activeElement?.closest?.(".caption-list");
    if (row && !editing && !video.paused) row.scrollIntoView({ block: "nearest" });
  }
}
function seek(t) {
  video.currentTime = clamp(t, 0, duration());
  onTime();
}

// ---------------- timeline ----------------
function renderTimeline() {
  const d = duration();
  const width = Math.max(tlScroll.clientWidth, d * state.pps + 200);
  tlContent.style.width = width + "px";
  renderRuler(d);
  renderBlocks();
  drawWave();
  onTime();
}
function renderRuler(d) {
  const ruler = $("#ruler");
  ruler.innerHTML = "";
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const step = steps.find((s) => s * state.pps >= 70) || 600;
  const minor = step / 5;
  const frag = document.createDocumentFragment();
  for (let t = 0; t <= d + step; t += step) {
    const el = document.createElement("div");
    el.className = "tick";
    el.style.left = t * state.pps + "px";
    el.textContent = step < 1 ? fmt(t) : fmt(t, false);
    frag.appendChild(el);
    if (minor * state.pps >= 8) {
      for (let k = 1; k < 5; k++) {
        const m = document.createElement("div");
        m.className = "tick minor";
        m.style.left = (t + k * minor) * state.pps + "px";
        frag.appendChild(m);
      }
    }
  }
  ruler.appendChild(frag);
}
function renderBlocks() {
  captionTrack.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of state.captions) frag.appendChild(makeBlock(c));
  captionTrack.appendChild(frag);
}
function makeBlock(c) {
  const el = document.createElement("div");
  el.className = "cap-block" + (c.id === state.selectedId ? " selected" : "");
  el.dataset.id = c.id;
  el.innerHTML = `<span class="handle l"></span><span class="txt"></span><span class="handle r"></span>`;
  el.querySelector(".txt").textContent = c.text;
  el.title = c.text;
  positionBlock(el, c);
  return el;
}
function positionBlock(el, c) {
  el.style.left = c.start * state.pps + "px";
  el.style.width = Math.max(4, (c.end - c.start) * state.pps) + "px";
}
function drawWave() {
  const w = tlScroll.clientWidth;
  const h = 60;
  const dpr = devicePixelRatio || 1;
  waveCanvas.style.left = tlScroll.scrollLeft + "px";
  waveCanvas.style.width = w + "px";
  waveCanvas.width = w * dpr;
  waveCanvas.height = h * dpr;
  const ctx = waveCanvas.getContext("2d");
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  if (!state.peaks) return;
  const { rate, peaks } = state.peaks;
  ctx.fillStyle = "#2563eb";
  const x0 = tlScroll.scrollLeft;
  for (let x = 0; x < w; x++) {
    const t0 = (x0 + x) / state.pps, t1 = (x0 + x + 1) / state.pps;
    const i0 = Math.floor(t0 * rate), i1 = Math.max(i0 + 1, Math.floor(t1 * rate));
    if (i0 >= peaks.length) break;
    let m = 0;
    for (let i = i0; i < i1 && i < peaks.length; i++) if (peaks[i] > m) m = peaks[i];
    const bh = Math.max(1, (m / 100) * (h - 4));
    ctx.fillRect(x, (h - bh) / 2, 1, bh);
  }
}
tlScroll.addEventListener("scroll", drawWave);

$("#zoom").oninput = (e) => {
  const center = (tlScroll.scrollLeft + tlScroll.clientWidth / 2) / state.pps;
  state.pps = +e.target.value;
  renderTimeline();
  tlScroll.scrollLeft = center * state.pps - tlScroll.clientWidth / 2;
};
tlScroll.addEventListener("wheel", (e) => {
  if (e.ctrlKey) {
    e.preventDefault();
    const z = $("#zoom");
    z.value = clamp(+z.value * (e.deltaY < 0 ? 1.15 : 0.87), +z.min, +z.max);
    z.oninput({ target: z });
  } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
    tlScroll.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });

const timeFromEvent = (e) => (e.clientX - tlContent.getBoundingClientRect().left) / state.pps;

// Scrub on ruler / empty track / waveform.
tlContent.addEventListener("mousedown", (e) => {
  if (e.button !== 0 || e.target.closest(".cap-block")) return;
  select(null);
  seek(timeFromEvent(e));
  const move = (ev) => seek(timeFromEvent(ev));
  const up = () => { window.removeEventListener("mousemove", move); window.removeEventListener("mouseup", up); };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// Drag / trim caption blocks.
captionTrack.addEventListener("mousedown", (e) => {
  const el = e.target.closest(".cap-block");
  if (!el || e.button !== 0 || el.classList.contains("editing")) return;
  e.preventDefault();
  const c = capById(el.dataset.id);
  const mode = e.target.classList.contains("l") ? "l" : e.target.classList.contains("r") ? "r" : "move";
  const list = sorted();
  const i = list.indexOf(c);
  const minT = i > 0 ? list[i - 1].end : 0;
  const maxT = i < list.length - 1 ? list[i + 1].start : duration() || c.end + 3600;
  const orig = { start: c.start, end: c.end };
  const x0 = e.clientX;
  const clickT = timeFromEvent(e);
  let moved = false;
  select(c.id, false);

  const move = (ev) => {
    const dt = (ev.clientX - x0) / state.pps;
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) { moved = true; pushUndo(); }
    if (mode === "l") c.start = clamp(orig.start + dt, minT, c.end - 0.1);
    else if (mode === "r") c.end = clamp(orig.end + dt, c.start + 0.1, maxT);
    else {
      const len = orig.end - orig.start;
      c.start = clamp(orig.start + dt, minT, maxT - len);
      c.end = c.start + len;
    }
    c.start = Math.round(c.start * 1000) / 1000;
    c.end = Math.round(c.end * 1000) / 1000;
    positionBlock(el, c);
    updateRowTime(c);
    if (mode === "l") seek(c.start);
    else if (mode === "r") seek(Math.max(c.start, c.end - 0.05));
    renderOverlay(true);
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (moved) { scheduleSave(); renderCaptionList(); }
    else seek(clickT);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
});

// Inline edit on double-click.
captionTrack.addEventListener("dblclick", (e) => {
  const el = e.target.closest(".cap-block");
  if (!el) return;
  startInlineEdit(el);
});
function startInlineEdit(el) {
  const c = capById(el.dataset.id);
  const txt = el.querySelector(".txt");
  el.classList.add("editing");
  txt.contentEditable = "plaintext-only";
  txt.focus();
  const r = document.createRange();
  r.selectNodeContents(txt);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  const finish = (save) => {
    txt.removeEventListener("blur", onBlur);
    txt.removeEventListener("keydown", onKey);
    txt.contentEditable = "false";
    el.classList.remove("editing");
    const val = txt.textContent.replace(/\s+/g, " ").trim();
    if (save && val && val !== c.text) commit(() => { c.text = val; });
    else txt.textContent = c.text;
  };
  const onBlur = () => finish(true);
  const onKey = (ev) => {
    ev.stopPropagation();
    if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
    if (ev.key === "Escape") finish(false);
  };
  txt.addEventListener("blur", onBlur);
  txt.addEventListener("keydown", onKey);
}

function select(id, scroll = true) {
  state.selectedId = id;
  $$(".cap-block.selected").forEach((b) => b.classList.remove("selected"));
  $$(".cap-row.selected").forEach((b) => b.classList.remove("selected"));
  if (!id) return;
  document.querySelector(`.cap-block[data-id="${id}"]`)?.classList.add("selected");
  const row = document.querySelector(`.cap-row[data-id="${id}"]`);
  row?.classList.add("selected");
  if (scroll) row?.scrollIntoView({ block: "nearest" });
}

// ---------------- caption list (sidebar) ----------------
function renderCaptionList() {
  const ul = $("#captionList");
  $("#captionsEmpty").hidden = state.captions.length > 0;
  ul.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const c of state.captions) {
    const li = document.createElement("li");
    li.className = "cap-row" + (c.id === state.selectedId ? " selected" : "");
    li.dataset.id = c.id;
    li.innerHTML = `<div class="cap-time"></div><textarea rows="1" spellcheck="false"></textarea>`;
    li.querySelector(".cap-time").textContent = `${fmt(c.start)} → ${fmt(c.end)}`;
    const ta = li.querySelector("textarea");
    ta.value = c.text;
    let undoPushed = false;
    ta.addEventListener("focus", () => { undoPushed = false; select(c.id, false); seek(c.start + 0.01); });
    ta.addEventListener("input", () => {
      if (!undoPushed) { pushUndo(); undoPushed = true; }
      c.text = ta.value.replace(/\n/g, " ");
      autosize(ta);
      const blk = document.querySelector(`.cap-block[data-id="${c.id}"] .txt`);
      if (blk) blk.textContent = c.text;
      renderOverlay(true);
      scheduleSave();
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); ta.blur(); } });
    li.addEventListener("mousedown", (e) => { if (e.target !== ta) { select(c.id, false); seek(c.start + 0.01); } });
    frag.appendChild(li);
  }
  ul.appendChild(frag);
  requestAnimationFrame(() => ul.querySelectorAll("textarea").forEach(autosize));
  lastActiveRow = null;
}
function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
function updateRowTime(c) {
  const el = document.querySelector(`.cap-row[data-id="${c.id}"] .cap-time`);
  if (el) el.textContent = `${fmt(c.start)} → ${fmt(c.end)}`;
}

function renderAll() {
  renderTimeline();
  renderCaptionList();
  renderOverlay(true);
  $("#srtBtn").disabled = !state.captions.length;
  $("#exportBtn").disabled = state.current?.status !== "ready" || !state.captions.length;
}

// ---------------- editing actions ----------------
function targetCaption() {
  const sel = capById(state.selectedId);
  return sel || capAt(video.currentTime);
}
function splitAtPlayhead() {
  const t = video.currentTime;
  const c = capAt(t);
  if (!c) return toast("Place the playhead inside a caption to split");
  const words = Timing.wordTimings(c.text, c.start, c.end);
  if (words.length < 2) return toast("Need at least two words to split");
  let k = words.findIndex((w) => (w.start + w.end) / 2 >= t);
  if (k < 0) k = words.length - 1;
  k = clamp(k, 1, words.length - 1);
  const b = { id: uid(), start: Math.round(t * 1000) / 1000, end: c.end, text: words.slice(k).map((w) => w.word).join(" ") };
  if (b.start - c.start < 0.05 || c.end - b.start < 0.05) return toast("Too close to the edge to split");
  commit(() => {
    c.end = b.start;
    c.text = words.slice(0, k).map((w) => w.word).join(" ");
    state.captions.push(b);
    state.selectedId = b.id;
  });
}
function mergeWithNext() {
  const c = targetCaption();
  if (!c) return toast("Select a caption to merge");
  const list = sorted();
  const next = list[list.indexOf(c) + 1];
  if (!next) return toast("No next caption to merge with");
  commit(() => {
    c.end = next.end;
    c.text = `${c.text} ${next.text}`;
    state.captions = state.captions.filter((x) => x !== next);
    state.selectedId = c.id;
  });
}
function deleteSelected() {
  const c = capById(state.selectedId);
  if (!c) return toast("Select a caption to delete");
  const list = sorted();
  const next = list[list.indexOf(c) + 1];
  commit(() => {
    state.captions = state.captions.filter((x) => x !== c);
    state.selectedId = next?.id || null;
  });
}
function addAtPlayhead() {
  if (!state.current) return;
  const t = video.currentTime;
  if (capAt(t)) return toast("Move the playhead to an empty spot");
  const next = sorted().find((c) => c.start > t);
  const end = Math.min(t + 1.5, next ? next.start : duration() || t + 1.5);
  if (end - t < 0.2) return toast("Not enough room here");
  const c = { id: uid(), start: Math.round(t * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: "New caption" };
  commit(() => { state.captions.push(c); state.selectedId = c.id; });
  const el = document.querySelector(`.cap-block[data-id="${c.id}"]`);
  if (el) startInlineEdit(el);
}
$("#splitBtn").onclick = splitAtPlayhead;
$("#mergeBtn").onclick = mergeWithNext;
$("#deleteBtn").onclick = deleteSelected;
$("#addBtn").onclick = addAtPlayhead;
$("#undoBtn").onclick = undo;

document.addEventListener("keydown", (e) => {
  const tag = e.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target.isContentEditable) return;
  const k = e.key.toLowerCase();
  if (e.code === "Space") { e.preventDefault(); togglePlay(); }
  else if ((e.ctrlKey || e.metaKey) && k === "z") { e.preventDefault(); undo(); }
  else if (k === "delete" || k === "backspace") { e.preventDefault(); deleteSelected(); }
  else if (k === "s") splitAtPlayhead();
  else if (k === "m") mergeWithNext();
  else if (k === "a") addAtPlayhead();
  else if (k === "enter" && state.selectedId) {
    const el = document.querySelector(`.cap-block[data-id="${state.selectedId}"]`);
    if (el) { e.preventDefault(); startInlineEdit(el); }
  }
  else if (k === "arrowleft") seek(video.currentTime - (e.shiftKey ? 1 : 1 / 30));
  else if (k === "arrowright") seek(video.currentTime + (e.shiftKey ? 1 : 1 / 30));
});

// ---------------- style panel ----------------
const ctl = {
  font: $("#sFont"),
  size: $("#sSize"),
  position: $("#sPos"),
  color: $("#sColor"),
  highlight: $("#sHighlight"),
  highlightColor: $("#sHlColor"),
  uppercase: $("#sUpper"),
  background: $("#sBg"),
  bgColor: $("#sBgColor"),
  bgOpacity: $("#sBgOp"),
  outline: $("#sOutline"),
  outlineColor: $("#sOutlineColor"),
  letterSpacing: $("#sLetterSpacing"),
  lineSpacing: $("#sLineSpacing"),
  wordSpacing: $("#sWordSpacing"),
  shadow: $("#sShadow"),
  shadowColor: $("#sShadowColor"),
  bold: $("#sBold"),
  italic: $("#sItalic"),
};

function syncStyleControls() {
  const st = state.style;
  for (const [k, el] of Object.entries(ctl)) {
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!st[k];
    else if (k === "bgOpacity") el.value = Math.round((st[k] ?? 0.6) * 100);
    else el.value = st[k] ?? "";
  }
  if ($("#oSize")) $("#oSize").textContent = st.size;
  if ($("#oPos")) $("#oPos").textContent = st.position + "%";
  if ($("#oOutline")) $("#oOutline").textContent = st.outline ?? 0;
  if ($("#oBgOp")) $("#oBgOp").textContent = Math.round((st.bgOpacity ?? 0.6) * 100) + "%";
  if ($("#oLetterSpacing")) $("#oLetterSpacing").textContent = (st.letterSpacing ?? 0) + "px";
  if ($("#oLineSpacing")) $("#oLineSpacing").textContent = (st.lineSpacing ?? 1.25);
  if ($("#oWordSpacing")) $("#oWordSpacing").textContent = (st.wordSpacing ?? 0) + "px";
  if ($("#oShadow")) $("#oShadow").textContent = (st.shadow ?? 0) + "px";

  if ($("#fOutline")) $("#fOutline").hidden = !!st.background;
  if ($("#fShadow")) $("#fShadow").hidden = !!st.background;
  if ($("#fBgOp")) $("#fBgOp").hidden = !st.background;

  // Sync alignment segmented control
  $$("#alignControl .seg-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.align === (st.alignment || "center"));
  });
}
for (const [k, el] of Object.entries(ctl)) {
  el.addEventListener("input", () => {
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.type === "range") v = +v;
    if (k === "bgOpacity") v = v / 100;
    state.style[k] = v;
    syncStyleControls();
    renderOverlay(true);
    if (state.current) scheduleSave();
  });
}
$("#resetStyle").onclick = () => {
  state.style = { ...DEFAULT_STYLE };
  syncStyleControls();
  renderOverlay(true);
  if (state.current) scheduleSave();
};

// Alignment segmented buttons
$$("#alignControl .seg-btn").forEach((btn) => {
  btn.onclick = () => {
    state.style.alignment = btn.dataset.align;
    syncStyleControls();
    renderOverlay(true);
    if (state.current) scheduleSave();
  };
});

// Style preset chips
$$(".preset-chip").forEach((chip) => {
  chip.onclick = () => {
    $$(".preset-chip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    const pName = chip.dataset.preset;
    if (PRESETS[pName]) {
      state.style = { ...state.style, ...PRESETS[pName] };
      syncStyleControls();
      renderOverlay(true);
      if (state.current) scheduleSave();
      toast(`Applied ${chip.querySelector(".preset-name")?.textContent || pName} style!`);
    }
  };
});

// ---------------- mobile navigation ----------------
$$("#mobileBottomNav .m-nav-btn").forEach((btn) => {
  btn.onclick = () => {
    $$("#mobileBottomNav .m-nav-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    const view = btn.dataset.view;
    if (view === "player") {
      document.body.classList.remove("mobile-drawer-open");
    } else {
      document.body.classList.add("mobile-drawer-open");
      // Switch active sidebar tab and panel
      $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === view));
      $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === view));
    }
  };
});

// ---------------- tabs ----------------
$$(".tab").forEach((t) => (t.onclick = () => {
  $$(".tab").forEach((x) => x.classList.toggle("active", x === t));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.dataset.panel === t.dataset.tab));
  if (t.dataset.tab === "captions") requestAnimationFrame(() => $$("#captionList textarea").forEach(autosize));
}));

// ---------------- export ----------------
$("#exportBtn").onclick = async () => {
  if (!state.current || !video.videoWidth) return;
  await flushSave();
  const style = { ...state.style, fontScale: fontScale(state.style.font) };
  try {
    const p = await api(`/api/projects/${state.current.id}/export`, {
      method: "POST",
      body: JSON.stringify({ width: video.videoWidth, height: video.videoHeight, duration: duration(), style }),
    });
    applyStatus(p);
    loadProjects();
  } catch (e) { toast(e.message); }
};

$("#srtBtn").onclick = () => {
  const ts = (t) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  const srt = sorted().map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text}\n`).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([srt], { type: "text/plain" }));
  a.download = (state.current?.name || "captions").replace(/\.[^.]+$/, "") + ".srt";
  a.click();
  URL.revokeObjectURL(a.href);
};

window.addEventListener("beforeunload", () => { if (saveTimer) flushSave(); });

// ---------------- billing & minute recharge (Razorpay) ----------------
let currentCurrency = "INR";
let selectedAmount = 50;
let selectedMinutes = 100;

async function loadUserBalance() {
  try {
    const data = await api("/api/billing/balance");
    const creditBalanceText = $("#creditBalanceText");
    const modalBalanceVal = $("#modalBalanceVal");
    const sidebarBalanceVal = $("#sidebarBalanceVal");
    const creditBtn = $("#creditBtn");

    const mins = (data && data.loggedIn) ? Math.round(data.balanceMinutes) : 10;
    const label = `${mins} mins`;

    if (creditBalanceText) creditBalanceText.textContent = label;
    if (modalBalanceVal) modalBalanceVal.textContent = mins;
    if (sidebarBalanceVal) sidebarBalanceVal.textContent = mins;
    if (creditBtn) creditBtn.title = `${mins} minutes available. Click to add more.`;
  } catch (e) {
    console.warn("loadUserBalance error:", e);
  }
}

function updateBillingSummary() {
  const billingSummaryText = $("#billingSummaryText");
  if (billingSummaryText) {
    if (currentCurrency === "INR") {
      billingSummaryText.textContent = `₹${selectedAmount} for ${selectedMinutes.toLocaleString()} Minutes`;
    } else {
      billingSummaryText.textContent = `$${selectedAmount} for ${selectedMinutes.toLocaleString()} Minutes`;
    }
  }
}

function selectCurrency(curr) {
  currentCurrency = curr;
  const tabInrBtn = $("#tabInrBtn");
  const tabUsdBtn = $("#tabUsdBtn");
  const panelInr = $("#panelInr");
  const panelUsd = $("#panelUsd");
  const inrCustomAmount = $("#inrCustomAmount");
  const usdCustomAmount = $("#usdCustomAmount");
  const balanceRateTag = $("#balanceRateTag");

  if (curr === "INR") {
    tabInrBtn?.classList.add("active");
    tabInrBtn?.setAttribute("aria-selected", "true");
    tabUsdBtn?.classList.remove("active");
    tabUsdBtn?.setAttribute("aria-selected", "false");
    if (panelInr) { panelInr.hidden = false; panelInr.classList.add("active"); }
    if (panelUsd) { panelUsd.hidden = true; panelUsd.classList.remove("active"); }
    if (balanceRateTag) balanceRateTag.textContent = "₹0.50 / min";

    if (!inrCustomAmount?.value) {
      const card = $("#inrPackagesGrid .package-card");
      if (card) {
        $$("#inrPackagesGrid .package-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        selectedAmount = Number(card.dataset.amount);
        selectedMinutes = Number(card.dataset.minutes);
      }
    }
  } else {
    tabUsdBtn?.classList.add("active");
    tabUsdBtn?.setAttribute("aria-selected", "true");
    tabInrBtn?.classList.remove("active");
    tabInrBtn?.setAttribute("aria-selected", "false");
    if (panelUsd) { panelUsd.hidden = false; panelUsd.classList.add("active"); }
    if (panelInr) { panelInr.hidden = true; panelInr.classList.remove("active"); }
    if (balanceRateTag) balanceRateTag.textContent = "$1 / 120 mins";

    if (!usdCustomAmount?.value) {
      const card = $("#usdPackagesGrid .package-card");
      if (card) {
        $$("#usdPackagesGrid .package-card").forEach((c) => c.classList.remove("selected"));
        card.classList.add("selected");
        selectedAmount = Number(card.dataset.amount);
        selectedMinutes = Number(card.dataset.minutes);
      }
    }
  }
  updateBillingSummary();
}

function openBillingModal(requiredMins = null) {
  const modal = $("#billingModal");
  if (!modal) {
    console.warn("billingModal not found in DOM");
    return;
  }
  loadUserBalance();
  if (requiredMins) {
    toast(`Video requires ~${requiredMins} minutes. Please top up your balance.`);
  }
  if (typeof modal.showModal === "function") {
    try { modal.showModal(); } catch (e) { modal.setAttribute("open", ""); }
  } else {
    modal.setAttribute("open", "");
  }
}

function closeBillingModal() {
  const modal = $("#billingModal");
  if (modal) {
    if (typeof modal.close === "function" && modal.open) {
      try { modal.close(); } catch (e) { modal.removeAttribute("open"); }
    } else {
      modal.removeAttribute("open");
    }
  }
}

function initBilling() {
  const creditBtn = $("#creditBtn");
  const closeBillingModalBtn = $("#closeBillingModalBtn");
  const billingModal = $("#billingModal");
  const tabInrBtn = $("#tabInrBtn");
  const tabUsdBtn = $("#tabUsdBtn");
  const inrCustomAmount = $("#inrCustomAmount");
  const usdCustomAmount = $("#usdCustomAmount");
  const inrCustomCalc = $("#inrCustomCalc");
  const usdCustomCalc = $("#usdCustomCalc");
  const payNowBtn = $("#payNowBtn");

  // Attach event listeners for currency switcher
  if (tabInrBtn) tabInrBtn.onclick = () => selectCurrency("INR");
  if (tabUsdBtn) tabUsdBtn.onclick = () => selectCurrency("USD");

  // INR Package Cards
  $$("#inrPackagesGrid .package-card").forEach((card) => {
    card.onclick = () => {
      $$("#inrPackagesGrid .package-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      if (inrCustomAmount) inrCustomAmount.value = "";
      if (inrCustomCalc) inrCustomCalc.textContent = "Min ₹50 (100 mins)";
      selectedAmount = Number(card.dataset.amount);
      selectedMinutes = Number(card.dataset.minutes);
      updateBillingSummary();
    };
  });

  // USD Package Cards
  $$("#usdPackagesGrid .package-card").forEach((card) => {
    card.onclick = () => {
      $$("#usdPackagesGrid .package-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      if (usdCustomAmount) usdCustomAmount.value = "";
      if (usdCustomCalc) usdCustomCalc.textContent = "Min $1 (120 mins)";
      selectedAmount = Number(card.dataset.amount);
      selectedMinutes = Number(card.dataset.minutes);
      updateBillingSummary();
    };
  });

  // Custom INR input
  inrCustomAmount?.addEventListener("input", () => {
    const val = Number(inrCustomAmount.value);
    $$("#inrPackagesGrid .package-card").forEach((c) => c.classList.remove("selected"));
    if (val >= 50) {
      const mins = Math.floor(val * 2);
      selectedAmount = val;
      selectedMinutes = mins;
      if (inrCustomCalc) inrCustomCalc.innerHTML = `→ <strong>${mins.toLocaleString()}</strong> mins`;
      updateBillingSummary();
    } else if (val > 0) {
      if (inrCustomCalc) inrCustomCalc.textContent = "Min ₹50 (100 mins)";
    } else {
      if (inrCustomCalc) inrCustomCalc.textContent = "Min ₹50 (100 mins)";
    }
  });

  // Custom USD input
  usdCustomAmount?.addEventListener("input", () => {
    const val = Number(usdCustomAmount.value);
    $$("#usdPackagesGrid .package-card").forEach((c) => c.classList.remove("selected"));
    if (val >= 1) {
      let mins;
      if (val === 1) mins = 120;
      else if (val === 3) mins = 380;
      else if (val === 5) mins = 700;
      else if (val === 10) mins = 1500;
      else mins = Math.floor(val * 130);
      selectedAmount = val;
      selectedMinutes = mins;
      if (usdCustomCalc) usdCustomCalc.innerHTML = `→ <strong>${mins.toLocaleString()}</strong> mins`;
      updateBillingSummary();
    } else if (val > 0) {
      if (usdCustomCalc) usdCustomCalc.textContent = "Min $1 (120 mins)";
    } else {
      if (usdCustomCalc) usdCustomCalc.textContent = "Min $1 (120 mins)";
    }
  });

  // Modal triggers & backdrop click
  if (creditBtn) creditBtn.onclick = () => openBillingModal();
  const sidebarAddMinsBtn = $("#sidebarAddMinsBtn");
  if (sidebarAddMinsBtn) sidebarAddMinsBtn.onclick = () => openBillingModal();
  if (closeBillingModalBtn) closeBillingModalBtn.onclick = () => closeBillingModal();
  if (billingModal) {
    billingModal.onclick = (e) => {
      if (e.target === billingModal) closeBillingModal();
    };
  }

  // Razorpay checkout initiator
  if (payNowBtn) {
    payNowBtn.onclick = async () => {
      try {
        const session = await BuzyAuth.getSession();
        if (!session) {
          toast("Please sign in to purchase minutes.");
          window.location.href = "/account?mode=login";
          return;
        }

        if (currentCurrency === "INR" && selectedAmount < 50) {
          toast("Minimum recharge for INR is ₹50.");
          return;
        }
        if (currentCurrency === "USD" && selectedAmount < 1) {
          toast("Minimum recharge for USD is $1.");
          return;
        }

        payNowBtn.disabled = true;
        payNowBtn.innerHTML = `<span>Preparing Checkout…</span>`;

        // 1. Create order on backend
        const order = await api("/api/billing/create-order", {
          method: "POST",
          body: JSON.stringify({
            currency: currentCurrency,
            amount: selectedAmount,
          }),
        });

        if (!window.Razorpay) {
          throw new Error("Razorpay checkout SDK failed to load. Please check your internet connection.");
        }

        const options = {
          key: order.keyId,
          amount: order.amount,
          currency: order.currency,
          name: "Buzy SI",
          description: `${order.minutes} Transcription Minutes`,
          image: "logo.png",
          order_id: order.orderId,
          prefill: {
            email: session.user?.email || "",
          },
          theme: {
            color: "#ffd60a",
          },
          modal: {
            ondismiss: function () {
              // Re-open billing modal so user can retry or adjust pack
              openBillingModal();
              payNowBtn.disabled = false;
              payNowBtn.innerHTML = `<span>Recharge Now</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
            },
          },
          handler: async function (response) {
            try {
              toast("Payment received, crediting minutes…");
              const verifyRes = await api("/api/billing/verify-payment", {
                method: "POST",
                body: JSON.stringify({
                  orderId: response.razorpay_order_id || order.orderId,
                  paymentId: response.razorpay_payment_id,
                  signature: response.razorpay_signature,
                }),
              });

              if (verifyRes.success) {
                toast(`Success! ${verifyRes.minutesCredited} minutes credited to your account.`);
                await loadUserBalance();
                closeBillingModal();
              } else {
                toast("Payment verification error. Please contact support.");
              }
            } catch (vErr) {
              console.error("Verification error:", vErr);
              toast("Verification error: " + vErr.message);
            } finally {
              payNowBtn.disabled = false;
              payNowBtn.innerHTML = `<span>Recharge Now</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
            }
          },
        };

        // User requirement: In USD mode, keep ONLY PayPal wallet mode within Razorpay
        if (order.currency === "USD") {
          const displayConfig = {
            blocks: {
              paypal_block: {
                name: "Pay via PayPal",
                instruments: [
                  {
                    method: "wallet",
                    wallets: ["paypal"],
                  },
                  {
                    method: "paypal",
                  },
                ],
              },
            },
            sequence: ["block.paypal_block"],
            preferences: {
              show_default_blocks: false,
            },
          };
          options.config = { display: displayConfig };
          options.display = displayConfig;
        }

        // Close the billing modal before opening Razorpay checkout so it doesn't block pointer events
        closeBillingModal();
        payNowBtn.disabled = false;
        payNowBtn.innerHTML = `<span>Recharge Now</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;

        const rzpInstance = new window.Razorpay(options);
        rzpInstance.on("payment.failed", function (resp) {
          console.error("Razorpay payment failed:", resp.error);
          toast("Payment failed: " + (resp.error.description || resp.error.reason));
          openBillingModal();
        });

        rzpInstance.open();
      } catch (err) {
        console.error("Payment initiation error:", err);
        toast(err.message || "Could not start payment. Please try again.");
        payNowBtn.disabled = false;
        payNowBtn.innerHTML = `<span>Recharge Now</span><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>`;
      }
    };
  }
}

// ---------------- boot ----------------
syncStyleControls();
initBilling();
loadUserBalance();
loadProjects().then(() => { if (state.projects[0]) openProject(state.projects[0].id); });
