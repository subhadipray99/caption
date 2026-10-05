// lib/aligner.js
// High-performance word timing & alignment without memory-heavy ONNX models

const crypto = require("crypto");
const { wordTimings, splitChunk } = require("../public/timing");

async function getWordTimestamps(audioPath) {
  // Free tier cloud workers (512MB RAM) cannot hold ONNX whisper models.
  // Returning null allows instant, zero-RAM acoustic weighted phonetic timing.
  return null;
}

function alignTranscriptWithAcoustics(sarvamWords, whisperWords, audioDuration) {
  return null;
}

/**
 * Groups word-level items into clean 2-4 word captions.
 */
function buildCaptionsFromWords(alignedWords, cryptoIdFn) {
  const groups = [];
  let cur = [];
  const MAX_WORDS = 4;
  const MAX_CHARS = 24;

  const len = (g) => g.reduce((sum, w) => sum + w.word.length + 1, -1);
  const PUNCT_END = /[.,!?;:।॥…]$/;

  for (const item of alignedWords) {
    if (cur.length && (cur.length >= MAX_WORDS || len([...cur, item]) > MAX_CHARS)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(item);
    if (PUNCT_END.test(item.word) && cur.length >= 2) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);

  if (groups.length > 1 && groups[groups.length - 1].length === 1 && groups[groups.length - 2].length < MAX_WORDS + 1) {
    groups[groups.length - 2].push(...groups.pop());
  }

  return groups.map((g) => ({
    id: cryptoIdFn ? cryptoIdFn() : crypto.randomBytes(4).toString("hex"),
    start: +(g[0].start).toFixed(3),
    end: +(g[g.length - 1].end).toFixed(3),
    text: g.map((w) => w.word).join(" "),
  }));
}

module.exports = {
  getWordTimestamps,
  alignTranscriptWithAcoustics,
  buildCaptionsFromWords,
};
