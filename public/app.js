/* Caption Studio client */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

// Mirrors lib/ass.js DEFAULTS so preview == export.
const DEFAULT_STYLE = {
  font: "Nirmala UI",
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
};
const BUSY = ["extracting", "transcribing", "converting_hinglish", "exporting"];
const BUSY_TEXT = {
  extracting: "Extracting audio track…",
  transcribing: "Transcribing speech…<br><small>Generating accurate word timestamps.</small>",
  converting_hinglish: "Transliterating to Hinglish…<br><small>Converting script to Romanized text.</small>",
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
  if (!res.ok) throw new Error(data.error || res.statusText);
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
    if ((prev === "extracting" || prev === "transcribing" || prev === "converting_hinglish" || prev === "uploaded") && status === "ready") {
      state.captions = p.captions || [];
      state.undo = [];
      loadPeaks();
      renderAll();
      if (state.captions.length) toast(`${state.captions.length} captions generated (${p.language || "ready"})`);
    }
    if (prev === "extracting" && (status === "transcribing" || status === "converting_hinglish")) loadPeaks();
    // Export finished.
    if (p.exportedAt && p.exportedAt !== state.lastExportedAt) {
      state.lastExportedAt = p.exportedAt;
      location.href = p.exportUrl || `${API_BASE}/api/projects/${p.id}/download`;
    }
    Object.assign(state.current, { ...p, captions: undefined });
  }

  if (status === "extracting" || status === "transcribing" || status === "converting_hinglish") {
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
  $("#exportBtn").textContent = status === "exporting" ? "Exporting…" : "Export video";
  $("#srtBtn").disabled = !state.captions.length;
  $("#retryBtn").hidden = !(ready || status === "error");
}

async function startTranscribe() {
  if (!state.current) return;
  if (state.captions.length && !confirm("Re-transcribe? This replaces your current captions.")) return;
  await flushSave();
  const language = $("#langSelect")?.value || "auto";
  const p = await api(`/api/projects/${state.current.id}/transcribe`, {
    method: "POST",
    body: JSON.stringify({ language })
  });
  state.current.status = "extracting";
  applyStatus(p);
  loadProjects();
}
$("#startTranscribeBtn").onclick = startTranscribe;
$("#retryBtn").onclick = startTranscribe;

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
  Object.assign(captionBox.style, {
    fontFamily: `"${st.font}", sans-serif`,
    fontSize: fontPx + "px",
    lineHeight: fs,
    bottom: st.position + "%",
    color: st.color,
    webkitTextStroke: st.background ? "0" : `${st.outline * unit * 2}px ${st.outlineColor}`,
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
  font: $("#sFont"), size: $("#sSize"), position: $("#sPos"), color: $("#sColor"),
  highlight: $("#sHighlight"), highlightColor: $("#sHlColor"), uppercase: $("#sUpper"),
  background: $("#sBg"), bgColor: $("#sBgColor"), outline: $("#sOutline"), bgOpacity: $("#sBgOp"),
};
function syncStyleControls() {
  const st = state.style;
  for (const [k, el] of Object.entries(ctl)) {
    if (el.type === "checkbox") el.checked = !!st[k];
    else if (k === "bgOpacity") el.value = Math.round(st[k] * 100);
    else el.value = st[k];
  }
  $("#oSize").textContent = st.size;
  $("#oPos").textContent = st.position + "%";
  $("#oOutline").textContent = st.outline;
  $("#oBgOp").textContent = Math.round(st.bgOpacity * 100) + "%";
  $("#fOutline").hidden = st.background;
  $("#fBgOp").hidden = !st.background;
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

// ---------------- boot ----------------
syncStyleControls();
loadProjects().then(() => { if (state.projects[0]) openProject(state.projects[0].id); });
