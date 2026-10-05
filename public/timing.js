// Shared caption timing helpers, loaded by both the browser (window.Timing) and Node (require).
(function (root) {
  const PUNCT_END = /[.,!?;:।॥…]$/;

  // Relative character weight to estimate individual word length
  const weight = (w) => [...w].length + 2;

  /**
   * Detects contiguous speech islands (voice activity) separated by pauses (>= 350ms of silence).
   * This guarantees captions appear ONLY while the speaker is talking, leaving the screen
   * completely empty during pauses.
   */
  function extractSpeechIslands(peaksData, windowStart, windowEnd) {
    if (!peaksData || !peaksData.peaks || !peaksData.peaks.length) {
      return [{ start: windowStart, end: windowEnd }];
    }
    const rate = peaksData.rate || 100;
    const peaks = peaksData.peaks;
    const sIdx = Math.max(0, Math.floor(windowStart * rate));
    const eIdx = Math.min(peaks.length - 1, Math.ceil(windowEnd * rate));

    if (eIdx <= sIdx) return [{ start: windowStart, end: windowEnd }];

    // Find local max volume to set an adaptive speech threshold
    let localMax = 0;
    for (let i = sIdx; i <= eIdx; i++) {
      if (peaks[i] > localMax) localMax = peaks[i];
    }
    if (localMax < 6) return [{ start: windowStart, end: windowEnd }];

    const speechThreshold = Math.max(7, Math.floor(localMax * 0.12));
    const pauseMinSamples = Math.floor(0.35 * rate); // 350ms silence constitutes a pause

    const islands = [];
    let inSpeech = false;
    let islandStart = sIdx;

    for (let i = sIdx; i <= eIdx; i++) {
      if (peaks[i] >= speechThreshold && !inSpeech) {
        inSpeech = true;
        islandStart = i;
      } else if (peaks[i] < speechThreshold && inSpeech) {
        // Look ahead: is the speaker truly pausing, or just closing their lips between syllables?
        let isTruePause = true;
        for (let j = i; j < Math.min(eIdx, i + pauseMinSamples); j++) {
          if (peaks[j] >= speechThreshold) {
            isTruePause = false;
            break;
          }
        }
        if (isTruePause) {
          inSpeech = false;
          const trueEnd = Math.min(eIdx, i + 10); // add 100ms natural vocal trail
          const dur = (trueEnd - islandStart) / rate;
          if (dur >= 0.25) { // ignore transient clicks/pops < 250ms
            islands.push({
              start: +(islandStart / rate).toFixed(3),
              end: +(trueEnd / rate).toFixed(3),
            });
          }
        }
      }
    }

    if (inSpeech) {
      const dur = (eIdx - islandStart) / rate;
      if (dur >= 0.2) {
        islands.push({
          start: +(islandStart / rate).toFixed(3),
          end: +(eIdx / rate).toFixed(3),
        });
      }
    }

    return islands.length ? islands : [{ start: windowStart, end: windowEnd }];
  }

  function wordTimings(text, start, end) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const total = words.reduce((s, w) => s + weight(w), 0);
    const dur = Math.max(0.01, end - start);
    let t = start;
    return words.map((w) => {
      const d = (weight(w) / total) * dur;
      const item = { word: w, start: +t.toFixed(3), end: +(t + d).toFixed(3) };
      t += d;
      return item;
    });
  }

  /**
   * Splits text into natural, readable subtitle lines that stay together across continuous speech
   * and cut off cleanly when a pause occurs.
   */
  function splitChunk(chunk, { maxWords = 5, maxChars = 28, peaksData = null } = {}) {
    const fullText = chunk.text.trim();
    if (!fullText) return [];

    // If acoustic peaks are available, split by natural acoustic speech pauses first
    if (peaksData) {
      const islands = extractSpeechIslands(peaksData, chunk.start, chunk.end);

      // If multiple distinct speech islands exist (speaker paused for >= 350ms):
      if (islands.length > 1) {
        // Divide full text into sentence/clause phrases across the speech islands
        const clauses = fullText
          .split(/(?<=[.।!?…])\s+|(?<=[,;:])\s+/)
          .map((s) => s.trim())
          .filter(Boolean);

        const subChunks = [];
        // Map clauses to islands proportionately
        if (clauses.length === islands.length) {
          clauses.forEach((txt, idx) => {
            subChunks.push(...splitTextIntoLines(txt, islands[idx].start, islands[idx].end, { maxWords, maxChars }));
          });
          return subChunks;
        } else {
          // Proportionate word distribution across acoustic speech islands
          const allWords = fullText.split(/\s+/).filter(Boolean);
          const totalWeight = allWords.reduce((s, w) => s + weight(w), 0);
          const totalSpeechDur = islands.reduce((s, isl) => s + (isl.end - isl.start), 0);

          let wordIdx = 0;
          for (let islIdx = 0; islIdx < islands.length; islIdx++) {
            const isl = islands[islIdx];
            const islDurRatio = (isl.end - isl.start) / totalSpeechDur;
            const targetWeight = totalWeight * islDurRatio;

            let curWeight = 0;
            const islWords = [];
            while (wordIdx < allWords.length) {
              const w = allWords[wordIdx];
              curWeight += weight(w);
              islWords.push(w);
              wordIdx++;
              if (islIdx < islands.length - 1 && curWeight >= targetWeight && islWords.length >= 2) {
                break;
              }
            }
            if (islWords.length) {
              subChunks.push(...splitTextIntoLines(islWords.join(" "), isl.start, isl.end, { maxWords, maxChars }));
            }
          }
          return subChunks;
        }
      } else if (islands.length === 1) {
        // Tighten single island boundaries to eliminate dead air before/after speech
        return splitTextIntoLines(fullText, islands[0].start, islands[0].end, { maxWords, maxChars });
      }
    }

    return splitTextIntoLines(fullText, chunk.start, chunk.end, { maxWords, maxChars });
  }

  function splitTextIntoLines(text, start, end, { maxWords = 5, maxChars = 28 } = {}) {
    const words = wordTimings(text, start, end);
    const groups = [];
    let cur = [];
    const len = (g) => g.reduce((s, w) => s + [...w.word].length + 1, -1);

    for (const w of words) {
      if (cur.length && (cur.length >= maxWords || len([...cur, w]) > maxChars)) {
        groups.push(cur);
        cur = [];
      }
      cur.push(w);
      // Natural punctuation breaks (comma, full stop, question mark)
      if (PUNCT_END.test(w.word) && cur.length >= 2) {
        groups.push(cur);
        cur = [];
      }
    }
    if (cur.length) groups.push(cur);

    if (groups.length > 1 && groups[groups.length - 1].length === 1 && groups[groups.length - 2].length < maxWords + 1) {
      groups[groups.length - 2].push(...groups.pop());
    }

    return groups.map((g) => ({
      start: g[0].start,
      end: g[g.length - 1].end,
      text: g.map((w) => w.word).join(" "),
      words: g.map((w) => ({ word: w.word, start: w.start, end: w.end })),
    }));
  }

  const api = { wordTimings, splitChunk, extractSpeechIslands };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Timing = api;
})(typeof window !== "undefined" ? window : globalThis);
