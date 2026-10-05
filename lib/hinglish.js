// lib/hinglish.js
// Converts Hindi Devanagari captions to Romanised Hinglish using OpenRouter (qwen/qwen3.8-27b:free)

async function convertHindiToHinglish(captions, apiKey) {
  if (!apiKey) {
    console.warn("OPENROUTER_API_KEY is not configured, skipping Hinglish conversion");
    return captions;
  }
  if (!Array.isArray(captions) || captions.length === 0) return captions;

  // Process in batches of 25 captions to avoid context limits
  const BATCH_SIZE = 25;
  const resultCaptions = [...captions];

  for (let i = 0; i < captions.length; i += BATCH_SIZE) {
    const batch = captions.slice(i, i + BATCH_SIZE);
    const inputPayload = batch.map((c) => ({ id: c.id, text: c.text }));

    const prompt = `You are an expert at Hindi-to-Hinglish transliteration for social media video subtitles.
Convert each Hindi (Devanagari script) caption text into natural, modern Romanised Hinglish (Latin alphabet).
Rules:
1. Preserve all English words, technical terms, brands, and numbers as-is.
2. Maintain the exact same IDs for each item.
3. Keep the exact same meaning and phrasing style so it fits the timestamps.
4. Output ONLY a valid JSON array of objects: [{"id": string, "text": string}]. No thoughts, no explanations, no markdown blocks.

Input captions:
${JSON.stringify(inputPayload)}`;

    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "Caption Studio"
        },
        body: JSON.stringify({
          model: "qwen/qwen3.8-27b:free",
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("OpenRouter API error:", res.status, errText);
        continue;
      }

      const data = await res.json();
      const content = data.choices?.[0]?.message?.content || "";
      
      // Clean JSON if model wrapped in ```json
      const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        const convertedItems = JSON.parse(jsonMatch[0]);
        for (const item of convertedItems) {
          const cap = resultCaptions.find((c) => c.id === item.id);
          if (cap && item.text) {
            cap.text = item.text.trim();
          }
        }
      }
    } catch (err) {
      console.error("Hinglish conversion batch error:", err.message);
    }
  }

  return resultCaptions;
}

module.exports = { convertHindiToHinglish };
