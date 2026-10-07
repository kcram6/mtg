// Claude vision fallback, used when free OCR can't read the card.
// Runs directly from the browser with your own API key (stored only on this device).
const MODEL = "claude-haiku-4-5";

let clientPromise = null;
async function getClient(apiKey) {
  clientPromise ??= import("https://esm.sh/@anthropic-ai/sdk@0.131.0").then(
    ({ default: Anthropic }) => new Anthropic({ apiKey, dangerouslyAllowBrowser: true }),
  );
  return clientPromise;
}

export function resetClient() {
  clientPromise = null;
}

const SCHEMA = {
  type: "object",
  properties: {
    card_found: { type: "boolean" },
    name: { type: ["string", "null"] },
    set_code: { type: ["string", "null"] },
    collector_number: { type: ["string", "null"] },
    is_token: { type: "boolean" },
  },
  required: ["card_found", "name", "set_code", "collector_number", "is_token"],
  additionalProperties: false,
};

const PROMPT = `This is a phone camera photo of someone holding up a Magic: The Gathering card to log it in their collection.

Report:
- name: the card name exactly as printed in the title bar (for double-faced cards, the front face name).
- set_code: the 3-5 character set code in the bottom-left corner (e.g. "C21", "MH3", "WOE"). Null if not printed or not legible.
- collector_number: the collector number in the bottom-left, without the set total (e.g. "263/350" -> "263", "0042" -> "42"). Keep any letter suffix. Null if not legible.
- is_token: true if this is a token card (its type line starts with "Token", e.g. a Treasure, Food, or a 1/1 Goblin token), otherwise false. For tokens, set_code and collector_number are still the ones printed in the bottom-left.
- card_found: false if no Magic card or token is clearly visible or the name is too blurry to read.

Only report text you can actually read. Use null rather than guessing a set code or collector number.`;

export async function readCardWithAI(apiKey, base64Jpeg) {
  const client = await getClient(apiKey);
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    output_config: { format: { type: "json_schema", schema: SCHEMA } },
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: base64Jpeg } },
          { type: "text", text: PROMPT },
        ],
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text;
  if (response.stop_reason === "refusal" || !text) return { card_found: false };
  return JSON.parse(text);
}
