// Scryfall API: free card data + TCGplayer prices (Scryfall's USD prices come
// from TCGplayer and refresh daily). No API key needed. https://scryfall.com/docs/api
const BASE = "https://api.scryfall.com";

// Scryfall rate limits: ~10 requests/second in general, 2/second for the
// search, named and collection endpoints. Requests go through a queue so we
// never exceed them.
let queue = Promise.resolve();
let lastRequest = 0;
function scryfall(path, options = {}) {
  const gap = /^\/cards\/(search|named|collection)/.test(path) ? 500 : 100;
  const run = async () => {
    const wait = lastRequest + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequest = Date.now();
    const res = await fetch(BASE + path, {
      ...options,
      headers: { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (res.status === 404) return null;
    if (res.status === 429) throw new Error("Scryfall is rate-limiting us; wait a minute and try again");
    if (!res.ok) throw new Error(`Scryfall error ${res.status}`);
    return res.json();
  };
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}

// Flatten a Scryfall card object into the fields we store.
export function toCardRecord(c) {
  const images = c.image_uris ?? c.card_faces?.[0]?.image_uris ?? {};
  return {
    scryfall_id: c.id,
    oracle_id: c.oracle_id ?? c.card_faces?.[0]?.oracle_id,
    name: c.name,
    set_code: c.set,
    set_name: c.set_name,
    collector_number: c.collector_number,
    rarity: c.rarity,
    type_line: c.type_line,
    mana_cost: c.mana_cost ?? c.card_faces?.[0]?.mana_cost ?? "",
    color_identity: c.color_identity,
    image_small: images.small,
    image_normal: images.normal,
    price_usd: c.prices?.usd ?? null,
    price_usd_foil: c.prices?.usd_foil ?? null,
    price_usd_etched: c.prices?.usd_etched ?? null,
    tcgplayer_url: c.purchase_uris?.tcgplayer ?? null,
    prices_updated_at: new Date().toISOString(),
  };
}

export const frontName = (c) => c.card_faces?.[0]?.name ?? c.name;

export const fuzzyNamed = (name, set) =>
  scryfall(`/cards/named?fuzzy=${encodeURIComponent(name)}${set ? `&set=${encodeURIComponent(set)}` : ""}`);

export const bySetAndNumber = (set, num) =>
  scryfall(`/cards/${encodeURIComponent(set.toLowerCase())}/${encodeURIComponent(num)}`);

// Every card name in Magic (~30k), cached on the device for a week, so OCR
// text can be matched locally without hitting the API.
const NAMES_KEY = "mtg-card-names";
let namesPromise = null;
export function cardNames() {
  namesPromise ??= (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(NAMES_KEY));
      if (cached && Date.now() - cached.at < 7 * 864e5) return cached.names;
    } catch {}
    const { data } = await scryfall("/catalog/card-names");
    try {
      localStorage.setItem(NAMES_KEY, JSON.stringify({ at: Date.now(), names: data }));
    } catch {} // storage full: just re-download next session
    return data;
  })();
  namesPromise.catch(() => (namesPromise = null));
  return namesPromise;
}

// All paper printings of a card, newest first (first page of up to 175 is plenty).
const printsCache = new Map();
export async function printings(name) {
  if (!printsCache.has(name)) {
    const q = `!"${name}" game:paper`;
    const res = await scryfall(`/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released`);
    printsCache.set(name, res?.data ?? []);
  }
  return printsCache.get(name);
}

// Fresh data for many cards at once (Scryfall allows 75 per request).
export async function fetchMany(scryfallIds) {
  const results = [];
  for (let i = 0; i < scryfallIds.length; i += 75) {
    const identifiers = scryfallIds.slice(i, i + 75).map((id) => ({ id }));
    const res = await scryfall("/cards/collection", { method: "POST", body: JSON.stringify({ identifiers }) });
    results.push(...(res?.data ?? []));
  }
  return results;
}
