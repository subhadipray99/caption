// lib/bengalish.js
// Converts Bengali (বাংলা) script captions to natural Romanised Bengalish (Banglish) using OpenRouter
// Tries google/gemma-4-31b-it:free first, with cascade to fallback models on rate limits

async function convertBengaliToBengalish(captions, apiKey) {
  if (!apiKey) {
    console.warn("OPENROUTER_API_KEY is not configured, skipping Bengalish conversion");
    const arr = [...(captions || [])];
    arr.success = false;
    arr.error = "OPENROUTER_API_KEY is not configured";
    arr.captions = arr;
    return arr;
  }
  if (!Array.isArray(captions) || captions.length === 0) {
    const arr = [...(captions || [])];
    arr.success = true;
    arr.captions = arr;
    return arr;
  }

  const primaryModel = process.env.OPENROUTER_MODEL || "google/gemma-4-31b-it:free";
  const modelCascade = [
    primaryModel,
    "nvidia/nemotron-3-ultra-550b-a55b:free",
    "nvidia/nemotron-3.5-lightning:free"
  ].filter((v, i, a) => a.indexOf(v) === i); // remove duplicates

  // Process in batches of 25 captions to avoid context limits
  const BATCH_SIZE = 25;
  const resultCaptions = [...captions];
  let allBatchesSucceeded = true;
  let lastError = null;

  for (let i = 0; i < captions.length; i += BATCH_SIZE) {
    const batch = captions.slice(i, i + BATCH_SIZE);
    const inputPayload = batch.map((c) => ({ id: c.id, text: c.text }));

    const prompt = `You are an expert at Bengali-to-Bengalish (Banglish) transliteration for social media video subtitles.
Convert each Bengali (বাংলা script) caption text into natural, modern Romanised Bengalish (Latin alphabet/English letters) as commonly written by Bengali speakers on social media, WhatsApp, and YouTube.
Rules:
1. Preserve all English words, technical terms, brands, and numbers as-is.
2. Maintain the exact same IDs for each item.
3. Keep the exact same meaning, rhythm, and phrasing style so it fits the timestamps.
4. Use standard phonetic Banglish spelling (e.g., "আমি ভালো আছি" -> "Ami bhalo achi", "কী করছ?" -> "Ki korcho?", "ধন্যবাদ" -> "Dhonnobad", "কেমন আছো?" -> "Kemon acho?", "ভিডিওটা কেমন লাগলো?" -> "Videota kemon laglo?").
5. Output ONLY a valid JSON array of objects: [{"id": string, "text": string}]. No thoughts, no explanations, no markdown blocks.

Input captions:
${JSON.stringify(inputPayload)}`;

    let converted = false;

    for (const model of modelCascade) {
      if (converted) break;
      try {
        const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://buzy.si",
            "X-Title": "Buzy SI"
          },
          body: JSON.stringify({
            model: model,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.1
          })
        });

        if (!res.ok) {
          const errText = await res.text();
          lastError = `Status ${res.status}: ${errText.slice(0, 100)}`;
          console.warn(`OpenRouter model ${model} failed (status ${res.status}): ${errText.slice(0, 150)}. Cascading to next model…`);
          continue;
        }

        const data = await res.json();
        const content = data.choices?.[0]?.message?.content || "";

        // Extract JSON array
        const jsonMatch = content.match(/\[\s*\{[\s\S]*\}\s*\]/);
        if (jsonMatch) {
          const convertedItems = JSON.parse(jsonMatch[0]);
          for (const item of convertedItems) {
            const cap = resultCaptions.find((c) => c.id === item.id);
            if (cap && item.text) {
              cap.text = item.text.trim();
            }
          }
          console.log(`Bengalish transliteration successful using ${model}`);
          converted = true;
          break;
        } else {
          lastError = `Model ${model} output was not valid JSON array`;
          console.warn(`Model ${model} output was not valid JSON array, cascading…`);
        }
      } catch (err) {
        lastError = err.message;
        console.warn(`Model ${model} error: ${err.message}. Cascading…`);
      }
    }

    if (!converted) {
      allBatchesSucceeded = false;
      console.warn(`Failed to convert batch starting at index ${i} to Bengalish across all cascade models.`);
    }
  }

  resultCaptions.success = allBatchesSucceeded;
  if (!allBatchesSucceeded) {
    resultCaptions.error = lastError || "All OpenRouter models failed to transliterate to Bengalish.";
  }
  resultCaptions.captions = resultCaptions;
  return resultCaptions;
}

module.exports = { convertBengaliToBengalish };
