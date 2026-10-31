const { wordTimings } = require("../public/timing");

// Defaults mirror public/app.js DEFAULT_STYLE.
const DEFAULTS = {
  font: "Montserrat",
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
  letterSpacing: 1, // px at 1080p
  lineSpacing: 1.25,
  wordSpacing: 0,
  shadow: 0,
  shadowColor: "#000000",
  bold: true,
  italic: false,
  alignment: "center",
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
function assColor(hex = "#000000", opacity = 1) {
  const h = (hex || "#000000").replace("#", "");
  const a = Math.round((1 - opacity) * 255);
  return `&H${pad(a.toString(16), 2)}${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}
const inlineColor = (hex = "#FFFFFF") => {
  const h = (hex || "#FFFFFF").replace("#", "");
  return `&H${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}&`.toUpperCase();
};

const escape = (s) => s.replace(/\\/g, "\u29F5").replace(/\{/g, "(").replace(/\}/g, ")").replace(/\n/g, " ");

// Non-Latin & Indic Script Definitions mapped to bundled Noto Sans fonts
const SCRIPT_FONTS = [
  { test: /[\u0900-\u097F]/, styleName: "Devanagari", font: "Noto Sans Devanagari" }, // Hindi, Marathi, Nepali, Sanskrit
  { test: /[\u0980-\u09FF]/, styleName: "Bengali", font: "Noto Sans Bengali" },       // Bengali, Assamese
  { test: /[\u0B80-\u0BFF]/, styleName: "Tamil", font: "Noto Sans Tamil" },           // Tamil
  { test: /[\u0C00-\u0C7F]/, styleName: "Telugu", font: "Noto Sans Telugu" },         // Telugu
  { test: /[\u0A80-\u0AFF]/, styleName: "Gujarati", font: "Noto Sans Gujarati" },     // Gujarati
  { test: /[\u0C80-\u0CFF]/, styleName: "Kannada", font: "Noto Sans Kannada" },       // Kannada
  { test: /[\u0D00-\u0D7F]/, styleName: "Malayalam", font: "Noto Sans Malayalam" },   // Malayalam
  { test: /[\u0A00-\u0A7F]/, styleName: "Gurmukhi", font: "Noto Sans Gurmukhi" },     // Punjabi
  { test: /[\u0600-\u06FF]/, styleName: "Arabic", font: "Noto Sans Arabic" },         // Arabic, Urdu
];

function detectScript(text) {
  if (!text) return null;
  for (const s of SCRIPT_FONTS) {
    if (s.test.test(text)) return s;
  }
  return null;
}

function buildAss(captions, style, width, height) {
  const st = { ...DEFAULTS, ...(style || {}) };
  const unit = Math.min(width, height) / 1080;
  const fontPx = st.size * unit;
  // ASS font size is the line cell height; CSS font-size is the em size. Convert.
  const assSize = Math.round(fontPx * (st.fontScale || 1.35));
  const outline = st.background ? Math.round(fontPx * 0.25) : +( (st.outline || 0) * unit).toFixed(1);
  const shadow = st.background ? 0 : +( (st.shadow || 0) * unit).toFixed(1);
  const spacing = Math.round((st.letterSpacing || 0) * unit);
  const marginV = Math.round((st.position / 100) * height);
  const marginLR = Math.round(width * 0.05);

  const primary = assColor(st.color);
  const outlineCol = st.background ? assColor(st.bgColor, st.bgOpacity) : assColor(st.outlineColor);
  const shadowCol = assColor(st.shadowColor || "#000000");
  const borderStyle = st.background ? 3 : 1;
  const boldVal = st.bold === false ? 0 : -1;
  const italicVal = st.italic ? -1 : 0;
  const alignVal = st.alignment === "left" ? 1 : (st.alignment === "right" ? 3 : 2);

  // Normalize base font (e.g., Windows "Nirmala UI" -> "Noto Sans Devanagari")
  let baseFont = st.font || "Montserrat";
  if (baseFont === "Nirmala UI") {
    baseFont = "Noto Sans Devanagari";
  }

  // Pre-generate styles for all supported scripts so libass always has exact font definitions
  const scriptStyles = SCRIPT_FONTS.map(
    (s) =>
      `Style: ${s.styleName},${s.font},${assSize},${primary},${primary},${outlineCol},${shadowCol},${boldVal},${italicVal},0,0,100,100,${spacing},0,${borderStyle},${outline},${shadow},${alignVal},${marginLR},${marginLR},${marginV},1`
  ).join("\n");

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${baseFont},${assSize},${primary},${primary},${outlineCol},${shadowCol},${boldVal},${italicVal},0,0,100,100,${spacing},0,${borderStyle},${outline},${shadow},${alignVal},${marginLR},${marginLR},${marginV},1
${scriptStyles}

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  const hl = inlineColor(st.highlightColor);
  for (const c of [...captions].sort((a, b) => a.start - b.start)) {
    const text = st.uppercase ? c.text.toUpperCase() : c.text;
    if (!text.trim() || c.end <= c.start) continue;

    const lineScript = detectScript(text);
    const lineStyle = lineScript ? lineScript.styleName : "Default";
    const activeFont = lineScript ? lineScript.font : baseFont;

    if (!st.highlight) {
      if (lineScript) {
        lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},${lineStyle},,0,0,0,,${escape(text)}`);
      } else {
        const words = text.split(" ");
        const body = words
          .map((w) => {
            const ws = detectScript(w);
            return ws ? `{\\fn${ws.font}}${escape(w)}{\\fn${baseFont}}` : escape(w);
          })
          .join(" ");
        lines.push(`Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Default,,0,0,0,,${body}`);
      }
      continue;
    }

    // One event per word, with the active word coloured and script-matched font
    const words = wordTimings(text, c.start, c.end);
    words.forEach((w, i) => {
      const body = words
        .map((x, j) => {
          const ws = detectScript(x.word);
          let prefix = "";
          let suffix = "";
          if (ws && ws.styleName !== lineStyle) {
            prefix = `{\\fn${ws.font}}`;
            suffix = `{\\fn${activeFont}}`;
          }
          const esc = escape(x.word);
          if (j === i) {
            return `${prefix}{\\c${hl}}${esc}{\\c${inlineColor(st.color)}}${suffix}`;
          }
          return `${prefix}${esc}${suffix}`;
        })
        .join(" ");
      const end = i === words.length - 1 ? c.end : w.end;
      lines.push(`Dialogue: 0,${assTime(w.start)},${assTime(end)},${lineStyle},,0,0,0,,${body}`);
    });
  }
  return header + lines.join("\n") + "\n";
}

module.exports = { buildAss, DEFAULTS };
