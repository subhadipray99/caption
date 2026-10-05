const { SarvamAIClient } = require("sarvamai");

if (typeof process.loadEnvFile === "function") {
  process.loadEnvFile();
}

const apiKey = process.env.SARVAM_API_KEY;

if (!apiKey) {
  console.error("Error: SARVAM_API_KEY is not set in environment or .env file.");
  process.exit(1);
}

const client = new SarvamAIClient({
  apiSubscriptionKey: apiKey,
});

async function main() {
  const response = await client.chat.completions({
    model: "sarvam-105b-conversations",
    messages: [
      {
        role: "user",
        content: "Hello! Say hi in one brief sentence.",
      },
    ],
  });

  console.log(response.choices[0].message.content);
}

main().catch((error) => {
  console.error("API call error:", error.message || error);
  process.exit(1);
});
