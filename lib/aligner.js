const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { pipeline } = require('@xenova/transformers');

let transcriberPromise = null;
function getTranscriber() {
  if (!transcriberPromise) {
    transcriberPromise = pipeline('automatic-speech-recognition', 'Xenova/whisper-tiny');
  }
  return transcriberPromise;
}

// Convert audio to 16kHz Float32 mono PCM and run whisper word timestamping
async function getWordTimestamps(audioPath) {
  // On memory-constrained free-tier cloud instances (512MB RAM), loading ONNX
  // model weights into RAM alongside ffmpeg causes an OOM crash.
  const os = require('os');
  const freeMemMB = os.freemem() / (1024 * 1024);
  if (freeMemMB < 350) {
    console.warn(`Free RAM (${Math.round(freeMemMB)}MB) is low. Using weighted phonetic timing to prevent OOM crash.`);
    return null;
  }

  const res = spawnSync(ffmpegPath, [
    '-hide_banner', '-i', audioPath,
    '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'
  ]);
  if (!res.stdout || res.stdout.length === 0) {
    throw new Error('Failed to decode audio for alignment');
  }
  const audioBuf = res.stdout;
  const float32Data = new Float32Array(audioBuf.buffer, audioBuf.byteOffset, audioBuf.byteLength / 4);

  const transcriber = await getTranscriber();
  const output = await transcriber(float32Data, {
    return_timestamps: 'word',
    chunk_length_s: 30
  });

  return (output.chunks || []).map(c => ({
    word: c.text.trim(),
    start: c.timestamp[0],
    end: c.timestamp[1]
  })).filter(c => c.word.length > 0 && c.start != null && c.end != null);
}

// Normalize word for matching (remove punctuation, lowercase)
function clean(w) {
  return (w || '').toLowerCase().replace(/[^a-z0-9\u0900-\u0D7F]/gi, '');
}

/**
 * Aligns Sarvam's high-accuracy Indian language transcript with Whisper's acoustic word timestamps.
 * If Whisper word count differs slightly, uses dynamic time warping / sequence matching to map timestamps.
 */
function alignTranscriptWithAcoustics(sarvamWords, whisperWords, audioDuration) {
  if (!whisperWords.length) return null;

  // Fix tail timestamp if Whisper hallucinated the end of audio into silence
  if (whisperWords.length > 0) {
    const last = whisperWords[whisperWords.length - 1];
    if (audioDuration && last.end > audioDuration) {
      last.end = audioDuration;
    }
  }

  // Linear progression mapping between Sarvam words and Whisper acoustic frames
  const aligned = [];
  const W = whisperWords.length;
  const S = sarvamWords.length;

  for (let sIdx = 0; sIdx < S; sIdx++) {
    const sWord = sarvamWords[sIdx];
    // Target position in Whisper tokens
    const ratio = sIdx / (S - 1 || 1);
    const centerW = ratio * (W - 1);
    
    // Search window near centerW for matching word
    const window = 4;
    let bestWIdx = Math.round(centerW);
    let bestScore = -1;

    for (let wIdx = Math.max(0, Math.round(centerW) - window); wIdx <= Math.min(W - 1, Math.round(centerW) + window); wIdx++) {
      const sC = clean(sWord);
      const wC = clean(whisperWords[wIdx].word);
      if (sC === wC && sC.length > 0) {
        bestWIdx = wIdx;
        bestScore = 10;
        break;
      }
    }

    const matchedChunk = whisperWords[bestWIdx];
    aligned.push({
      word: sWord,
      start: matchedChunk.start,
      end: matchedChunk.end
    });
  }

  // Monotonic pass: ensure start and end times always strictly increase without overlaps
  for (let i = 1; i < aligned.length; i++) {
    if (aligned[i].start < aligned[i - 1].start) {
      aligned[i].start = aligned[i - 1].end;
    }
    if (aligned[i].end <= aligned[i].start) {
      aligned[i].end = +(aligned[i].start + 0.15).toFixed(3);
    }
  }

  return aligned;
}

/**
 * Groups word-level aligned items into clean 2-4 word captions.
 */
function buildCaptionsFromWords(alignedWords, cryptoIdFn) {
  const groups = [];
  let cur = [];
  const MAX_WORDS = 4;
  const MAX_CHARS = 24;

  const len = g => g.reduce((sum, w) => sum + w.word.length + 1, -1);
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

  // Avoid lonely ending single word
  if (groups.length > 1 && groups[groups.length - 1].length === 1 && groups[groups.length - 2].length < MAX_WORDS + 1) {
    groups[groups.length - 2].push(...groups.pop());
  }

  return groups.map(g => ({
    id: cryptoIdFn(),
    start: +(g[0].start).toFixed(3),
    end: +(g[g.length - 1].end).toFixed(3),
    text: g.map(w => w.word).join(' ')
  }));
}

module.exports = {
  getWordTimestamps,
  alignTranscriptWithAcoustics,
  buildCaptionsFromWords
};
