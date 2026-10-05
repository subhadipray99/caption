// Shared caption timing helpers, loaded by both the browser (window.Timing) and Node (require).
(function (root) {
  const PUNCT_END = /[.,!?;:।॥…]$/;

  // Sarvam returns phrase-level timestamps only. We estimate per-word timing by
  // spreading the phrase duration across words, weighted by word length.
  const weight = (w) => [...w].length + 2;

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
  function splitChunk(chunk, { maxWords = 4, maxChars = 24 } = {}) {
    const words = wordTimings(chunk.text, chunk.start, chunk.end);
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
    }));
  }

  const api = { wordTimings, splitChunk };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Timing = api;
})(typeof window !== "undefined" ? window : globalThis);
