const crypto = require("crypto");
const { splitChunk } = require("../public/timing");

const newId = () => crypto.randomBytes(4).toString("hex");

// Turn Sarvam phrase chunks into short caption lines.
function buildCaptions(chunks) {
  const out = [];
  for (const chunk of chunks) {
    if (!chunk.text || !chunk.text.trim()) continue;
    for (const c of splitChunk(chunk)) {
      out.push({ id: newId(), start: round(c.start), end: round(c.end), text: c.text });
    }
  }
  // Guarantee no overlaps and a minimum on-screen time.
  for (let i = 0; i < out.length; i++) {
    if (out[i].end - out[i].start < 0.3) out[i].end = round(out[i].start + 0.3);
    if (out[i + 1] && out[i].end > out[i + 1].start) out[i].end = out[i + 1].start;
  }
  return out;
}

const round = (n) => Math.round(n * 1000) / 1000;

module.exports = { buildCaptions };
