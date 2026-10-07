// Turns a photo of a card into a Scryfall card.
//   1. Free OCR reads the name bar; it's matched against every card name, on-device.
//   2. Free OCR reads the bottom info line (set code / collector number) to pick the printing.
//   3. If OCR can't identify the card, fall back to Claude (a fraction of a cent).
import * as scryfall from "./scryfall.js";
import { readText, cropForOcr } from "./ocr.js";
import { readCardWithAI } from "./ai.js";

// Regions of a standard card, as fractions of its width/height. The name bar
// is tried at a few vertical offsets because the card won't sit perfectly in
// the on-screen frame.
const NAME_BARS = [
  { x0: 0.05, x1: 0.78, y0: 0.035, y1: 0.115 },
  { x0: 0.06, x1: 0.78, y0: 0.06, y1: 0.14 },
  { x0: 0.05, x1: 0.78, y0: 0.015, y1: 0.095 },
];
const BOTTOM_INFO = { x0: 0.02, x1: 0.98, y0: 0.86, y1: 1.0 };

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").replace(/\s+/g, " ").trim();

function similarity(a, b) {
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

// Card names indexed by their (front-face) normalized form.
let nameIndex = null;
async function getNameIndex() {
  if (!nameIndex) {
    const names = await scryfall.cardNames();
    nameIndex = names.map((name) => ({ name, key: normalize(name.split(" // ")[0]) }));
  }
  return nameIndex;
}

function bestNameMatch(index, guess) {
  const g = normalize(guess);
  let best = null, bestScore = 0;
  for (const entry of index) {
    if (Math.abs(entry.key.length - g.length) > Math.max(3, g.length * 0.3)) continue;
    const score = similarity(g, entry.key);
    if (score > bestScore) [best, bestScore] = [entry, score];
  }
  const needed = g.length <= 6 ? 0.85 : 0.75; // short names need a closer match
  return bestScore >= needed ? { name: best.name, score: bestScore } : null;
}

// OCR picks up stray marks from mana symbols and the frame, e.g. "(Sol Ring ge i".
// Return the cleaned text plus versions with trailing words dropped.
function nameCandidates(text) {
  const words = text.replace(/[’‘`]/g, "'").replace(/[^A-Za-z ,'\-]/g, " ").split(/\s+/).filter(Boolean);
  while (words.length && words[0].replace(/\W/g, "").length <= 1) words.shift();
  while (words.length && words.at(-1).replace(/\W/g, "").length <= 2) words.pop();
  const out = [];
  for (let n = words.length; n >= Math.max(1, words.length - 2); n--) {
    const s = words.slice(0, n).join(" ").replace(/[,\-]+$/, "");
    if (s.length >= 3) out.push(s);
  }
  return out;
}

async function identifyNameWithOcr(cardCanvas) {
  const index = await getNameIndex();
  let best = null;
  for (const region of NAME_BARS) {
    // "block" mode reads this crop far more reliably than "line" mode, but may
    // return extra lines of border noise, so each line is tried on its own.
    const { text } = await readText(cropForOcr(cardCanvas, region, 64), "block");
    for (const line of text.split("\n")) {
      // Prefer the full text: each dropped word costs 10%, so "Lightning Bote" ->
      // Lightning Bolt beats "Lightning" -> Blightning.
      nameCandidates(line).forEach((guess, dropped) => {
        const match = bestNameMatch(index, guess);
        if (match) match.score *= 1 - 0.1 * dropped;
        if (match && (!best || match.score > best.score)) best = match;
      });
    }
    if (best?.score >= 0.9) break; // confident; skip the other offsets
  }
  return best; // { name, score } or null
}

// Pick the printing whose set code and/or collector number appear in the
// OCR'd bottom text. Returns null when it can't tell.
async function identifyPrintingWithOcr(cardCanvas, prints) {
  const { text } = await readText(cropForOcr(cardCanvas, BOTTOM_INFO, 120), "block");
  const tokens = new Set(text.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean));
  const numbers = new Set([...tokens].filter((t) => /^\d+[A-Z]?$/.test(t)).map((t) => t.replace(/^0+(?=\d)/, "")));

  let best = null, bestScore = 0, tie = false;
  for (const p of prints) {
    const score =
      (tokens.has(p.set.toUpperCase()) ? 2 : 0) + (numbers.has(p.collector_number.toUpperCase()) ? 2 : 0);
    if (score > bestScore) [best, bestScore, tie] = [p, score, false];
    else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore >= 2 && !tie ? best : null;
}

// When the printing can't be read, guess the newest regular printing rather
// than a promo, Secret Lair, The List reprint, or showcase variant.
function mostLikelyPrinting(prints) {
  const unusual = (p) =>
    p.promo || p.variation || p.full_art || ["plst", "sld"].includes(p.set) ||
    ["promo", "box", "memorabilia", "funny", "token"].includes(p.set_type) ||
    (p.frame_effects ?? []).some((e) => ["showcase", "extendedart", "etched", "inverted"].includes(e)) ||
    p.border_color === "borderless";
  return prints.find((p) => !unusual(p)) ?? prints[0];
}

async function identifyWithAI(apiKey, cardCanvas) {
  const reading = await readCardWithAI(apiKey, toJpegBase64(cardCanvas, 1000));
  if (!reading.card_found || !reading.name) return null;

  const { name, set_code: set, collector_number } = reading;
  const num = collector_number?.replace(/^0+(?=\d)/, "");
  if (set && num) {
    const card = await scryfall.bySetAndNumber(set, num);
    if (card && similarity(normalize(name), normalize(scryfall.frontName(card))) >= 0.75) return { card, exact: true };
  }
  const card = (set && (await scryfall.fuzzyNamed(name, set))) || (await scryfall.fuzzyNamed(name));
  return card ? { card, exact: false } : null;
}

function toJpegBase64(canvas, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(canvas.width, canvas.height));
  const out = document.createElement("canvas");
  out.width = Math.round(canvas.width * scale);
  out.height = Math.round(canvas.height * scale);
  out.getContext("2d").drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.85).split(",")[1];
}

// Returns { status: "found", card, exact, via: "ocr" | "ai" } or { status: "not-found" }.
// `exact` is false when the printing (set) is a best guess.
export async function recognizeCard(cardCanvas, { mode, apiKey }) {
  let ocrResult = null;
  if (mode !== "ai") {
    const match = await identifyNameWithOcr(cardCanvas);
    if (match) {
      const prints = await scryfall.printings(match.name);
      if (prints.length) {
        const printing = await identifyPrintingWithOcr(cardCanvas, prints);
        ocrResult = { status: "found", card: printing ?? mostLikelyPrinting(prints), exact: !!printing, via: "ocr" };
        // A near-exact name read is trusted. A looser one could be the wrong
        // card, so have Claude double-check when a key is available.
        if (match.score >= 0.9 || !apiKey) return ocrResult;
      }
    }
  }
  if (!apiKey) return { status: "not-found" };

  const result = await identifyWithAI(apiKey, cardCanvas);
  if (result) return { status: "found", ...result, via: "ai" };
  return ocrResult ?? { status: "not-found" };
}
