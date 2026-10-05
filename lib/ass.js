const { wordTimings } = require("../public/timing");

// Defaults mirror public/app.js DEFAULT_STYLE.
const DEFAULTS = {
  font: "Nirmala UI",
  size: 72, // px at a 1080p reference (scaled by min(width, height) / 1080)
  color: "#FFFFFF",
  highlight: true,
  highlightColor: "#FFD60A",
  outline: 5, // px at 1080p reference
  outlineColor: "#000000",
  background: false,
  bgColor: "#000000",
  bgOpacity: 0.6,
  position: 15, // % of height from bottom
  uppercase: false,
  fontScale: 1.35, // (ascent + descent) / em, measured in the browser
};

const pad = (n, w = 2) => String(n).padStart(w, "0");
function assTime(t) {
  t = Math.max(0, t);
  const cs = Math.round(t * 100);
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs % 100)}`;
}

// #RRGGBB + opacity -> &HAABBGGRR
function assColor(hex, opacity = 1) {
  const h = hex.replace("#", "");
  const a = Math.round((1 - opacity) * 255);
  return `&H${pad(a.toString(16), 2)}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
const inlineColor = (hex) => {
  const h = hex.replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

const escape = (s) => s.replace(/\\/g, "\u29F5").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");

function buildAss(captions, style, width, height) {
  const st = { ...DEFAULTS, ...(style || {}) };
  const unit = Math.min(width, height) / 1080;
  const fontPx = st.size * unit;
  // ASS font size is the line cell height; CSS font-size is the em size. Convert.
  const assSize = Math.round(fontPx * st.fontScale);
  const outline = st.background ? Math.round(fontPx * 0.25) : +(st.outline * unit).toFixed(1);
  const marginV = Math.round((st.position / 100) * height);
  const marginLR = Math.round(width * 0.05);

  const primary = assColor(st.color);
  const outlineCol = st.background ? assColor(st.bgColor, st.bgOpacity) : assColor(st.outlineColor);
  const borderStyle = st.background ? 3 : 1;

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${st.font},${assSize},${primary},${primary},${outlineCol},${outlineCol},-1,0,0,0,100,100,0,0,${borderStyle},${outline},0,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  const hl = inlineColor(st.highlightColor);
  for (const c of [...captions].sort((a, b) => a.start - b.start)) {
    const text = st.uppercase ? c.text.toUpperCase() : c.text;
    if (!text.trim() || c.end <= c.start) continue;
    if (!st.highlight) {
      lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${escape(text)}`);
      continue;
    }
    // One event per word, with the active word coloured.
    const words = wordTimings(text, c.start, c.end);
    words.forEach((w, i) => {
      const body = words
        .map((x, j) => (j === i ? `{\\c${hl}}${escape(x.word)}{\\c${inlineColor(st.color)}}` : escape(x.word)))
        .join(" ");
      const end = i === words.length - 1 ? c.end : w.end;
      lines.push(`Dialogue: 0,${assTime(w.start)},${assTime(end)},Default,,0,0,0,,${body}`);
    });
  }
  return header + lines.join("\n") + "\n";
}

module.exports = { buildAss, DEFAULTS };
