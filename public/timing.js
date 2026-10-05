// Shared caption timing helpers, loaded by both the browser (window.Timing) and Node (require).
(function (root) {
  const PUNCT_END = /[.,!?;:।॥…]$/;

  // Sarvam returns phrase-level timestamps only. We estimate per-word timing by
  // spreading the phrase duration across words, weighted by syllables/characters.
  const weight = (w) => [...w].length + 2;

  /**
   * Refines a phrase start/end timestamp using acoustic peaks from the audio waveform.
   * Eliminates leading and trailing silence so captions start when speech begins.
   */
  function refineChunkWithWaveform(chunkStart, chunkEnd, peaksData) {
    if (!peaksData || !peaksData.peaks || !peaksData.peaks.length) {
      return { start: chunkStart, end: chunkEnd };
    }
    const rate = peaksData.rate || 100;
    const peaks = peaksData.peaks;
    const startIdx = Math.max(0, Math.floor(chunkStart * rate));
    const endIdx = Math.min(peaks.length - 1, Math.ceil(chunkEnd * rate));

    if (endIdx <= startIdx) return { start: chunkStart, end: chunkEnd };

    // Find local peak volume in this segment
    let localMax = 0;
    for (let i = startIdx; i <= endIdx; i++) {
      if (peaks[i] > localMax) localMax = peaks[i];
    }
    if (localMax < 6) return { start: chunkStart, end: chunkEnd };

    const speechThreshold = Math.max(7, Math.floor(localMax * 0.15));

    // Find actual start of voice energy
    let trueStart = chunkStart;
    for (let i = startIdx; i <= endIdx; i++) {
      if (peaks[i] >= speechThreshold) {
        trueStart = Math.max(chunkStart, i / rate);
        break;
      }
    }

    // Find actual end of voice energy
    let trueEnd = chunkEnd;
    for (let i = endIdx; i >= startIdx; i--) {
      if (peaks[i] >= speechThreshold) {
        trueEnd = Math.min(chunkEnd, (i + 15) / rate); // add 150ms natural speech release
        break;
      }
    }

    if (trueEnd <= trueStart) return { start: chunkStart, end: chunkEnd };
    return {
      start: +trueStart.toFixed(3),
      end: +trueEnd.toFixed(3)
    };
  }

  function wordTimings(text, start, end) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const total = words.reduce((s, w) => s + weight(w), 0);
    const dur = Math.max(0.01, end - start);
    let t = start;
    return words.map((w) => {
      const d = (weight(w) / total) * dur;
      const item = { word: w, start: t, end: t + d };
      t += d;
      return item;
    });
  }

  // Split long phrases into short, readable caption lines (CapCut-style).
  function splitChunk(chunk, { maxWords = 4, maxChars = 24, peaksData = null } = {}) {
    // 1. Refine phrase boundary using acoustic audio peaks if available
    let { start, end } = chunk;
    if (peaksData) {
      const refined = refineChunkWithWaveform(start, end, peaksData);
      start = refined.start;
      end = refined.end;
    }

    // 2. Generate weighted word timings
    const words = wordTimings(chunk.text, start, end);
    const groups = [];
    let cur = [];
    const len = (g) => g.reduce((s, w) => s + [...w.word].length + 1, -1);

    for (const w of words) {
      if (cur.length && (cur.length >= maxWords || len([...cur, w]) > maxChars)) {
        groups.push(cur);
        cur = [];
      }
      cur.push(w);
      if (PUNCT_END.test(w.word) && cur.length >= 2) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);

    // Avoid a lonely single word at the end of a phrase.
    if (groups.length > 1 && groups[groups.length - 1].length === 1 && groups[groups.length - 2].length < maxWords + 1) {
      groups[groups.length - 2].push(...groups.pop());
    }

    return groups.map((g) => ({
      start: g[0].start,
      end: g[g.length - 1].end,
      text: g.map((w) => w.word).join(" "),
      words: g.map((w) => ({ word: w.word, start: +w.start.toFixed(3), end: +w.end.toFixed(3) }))
    }));
  }

  const api = { wordTimings, splitChunk, refineChunkWithWaveform };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Timing = api;
})(typeof window !== "undefined" ? window : globalThis);
