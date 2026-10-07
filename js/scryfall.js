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
    cmc: c.cmc ?? c.card_faces?.[0]?.cmc ?? 0, // mana value, for the mana curve
    card_type: mainType(c.type_line),
    colors: c.colors ?? c.card_faces?.[0]?.colors ?? [],
    color_identity: c.color_identity,
    image_small: images.small,
    image_normal: images.normal,
    image_art: images.art_crop,
    price_usd: c.prices?.usd ?? null,
    price_usd_foil: c.prices?.usd_foil ?? null,
    price_usd_etched: c.prices?.usd_etched ?? null,
    tcgplayer_url: c.purchase_uris?.tcgplayer ?? null,
    prices_updated_at: new Date().toISOString(),
  };
}

// The card's main type, for cataloging. Multi-type cards are filed under the
// type that matters most in play: an Artifact Creature is a Creature, an
// Artifact Land is a Land. Double-faced cards use their front face.
export const CARD_TYPES = ["Creature", "Planeswalker", "Battle", "Instant", "Sorcery", "Artifact", "Enchantment", "Land", "Token"];
export function mainType(typeLine = "") {
  const front = typeLine.split(" // ")[0].split(" — ")[0];
  if (/\bToken\b/.test(front)) return "Token";
  if (/\bLand\b/.test(front)) return "Land";
  return CARD_TYPES.find((t) => new RegExp(`\\b${t}\\b`).test(front)) ?? "Other";
}

// Just the artwork, for banners. Older records only stored the full card image,
// whose URL differs only by size folder.
export const artCrop = (card) => card?.image_art ?? card?.image_normal?.replace("/normal/", "/art_crop/");

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

// Token names (~800) aren't in the catalog above; fetch them separately and
// cache them the same way.
const TOKENS_KEY = "mtg-token-names";
let tokenNamesPromise = null;
export function tokenNames() {
  tokenNamesPromise ??= (async () => {
    try {
      const cached = JSON.parse(localStorage.getItem(TOKENS_KEY));
      if (cached && Date.now() - cached.at < 7 * 864e5) return cached.names;
    } catch {}
    const names = [];
    let path = `/cards/search?q=${encodeURIComponent("t:token game:paper")}&unique=cards&include_extras=true`;
    while (path) {
      const res = await scryfall(path);
      names.push(...(res?.data ?? []).map((c) => c.name));
      path = res?.has_more ? res.next_page.replace(BASE, "") : null;
    }
    try {
      localStorage.setItem(TOKENS_KEY, JSON.stringify({ at: Date.now(), names }));
    } catch {}
    return names;
  })();
  tokenNamesPromise.catch(() => (tokenNamesPromise = null));
  return tokenNamesPromise;
}

// Every card name matching a Scryfall search (follows pagination).
async function allNames(query, extra = "") {
  const names = [];
  let path = `/cards/search?q=${encodeURIComponent(query)}&unique=cards${extra}`;
  while (path) {
    const res = await scryfall(path);
    names.push(...(res?.data ?? []).map((c) => c.name));
    path = res?.has_more ? res.next_page.replace(BASE, "") : null;
  }
  return names;
}

// Card lists used to estimate a deck's Commander bracket: the official Game
// Changers, extra-turn cards, and mass land denial (Scryfall's card tags).
// Cached for a week.
const BRACKET_KEY = "mtg-bracket-lists";
let bracketPromise = null, bracketLoaded = null;
export function bracketLists() {
  bracketPromise ??= (async () => {
    let lists = null;
    try {
      const cached = JSON.parse(localStorage.getItem(BRACKET_KEY));
      if (cached && Date.now() - cached.at < 7 * 864e5) lists = cached;
    } catch {}
    if (!lists) {
      lists = {
        at: Date.now(),
        gameChangers: await allNames("is:gamechanger"),
        extraTurns: await allNames("otag:extra-turn f:commander"),
        massLandDenial: await allNames("otag:mass-land-denial f:commander"),
      };
      try {
        localStorage.setItem(BRACKET_KEY, JSON.stringify(lists));
      } catch {}
    }
    bracketLoaded = {
      gameChangers: new Set(lists.gameChangers),
      extraTurns: new Set(lists.extraTurns),
      massLandDenial: new Set(lists.massLandDenial),
    };
    return bracketLoaded;
  })();
  bracketPromise.catch(() => (bracketPromise = null));
  return bracketPromise;
}
// The lists if they've already loaded (for tagging cards without waiting).
export const bracketListsIfLoaded = () => bracketLoaded;

// Commander is singleton, but a few cards say "A deck can have any number of
// cards named ..." (or "up to seven/nine"). Name -> allowed copies, cached for a week.
const LIMITS_KEY = "mtg-copy-limits";
const WORD_NUMBERS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
let limitsPromise = null, limitsLoaded = null;
export function copyLimits() {
  limitsPromise ??= (async () => {
    let limits = null;
    try {
      const cached = JSON.parse(localStorage.getItem(LIMITS_KEY));
      if (cached && Date.now() - cached.at < 7 * 864e5) limits = cached.limits;
    } catch {}
    if (!limits) {
      limits = {};
      const res = await scryfall(`/cards/search?q=${encodeURIComponent('fo:"a deck can have" f:commander')}`);
      for (const c of res?.data ?? []) {
        const text = c.oracle_text ?? (c.card_faces ?? []).map((f) => f.oracle_text).join(" ");
        const m = text.match(/deck can have (any number of|up to (\w+)) cards named/i);
        if (m) limits[c.name] = m[2] ? (WORD_NUMBERS[m[2].toLowerCase()] ?? Number(m[2])) : null; // null = any number
      }
      try {
        localStorage.setItem(LIMITS_KEY, JSON.stringify({ at: Date.now(), limits }));
      } catch {}
    }
    limitsLoaded = new Map(Object.entries(limits).map(([k, v]) => [k, v ?? Infinity]));
    return limitsLoaded;
  })();
  limitsPromise.catch(() => (limitsPromise = null));
  return limitsPromise;
}
export const copyLimitsIfLoaded = () => limitsLoaded ?? new Map();

// Name suggestions while typing, tokens included.
export async function autocomplete(query) {
  const res = await scryfall(`/cards/autocomplete?q=${encodeURIComponent(query)}&include_extras=true`);
  return res?.data ?? [];
}

// All paper printings of a card, newest first (first page of up to 175 is plenty).
// Tokens live in their own sets and are only returned when asked for, so a
// name with no regular printings is retried as a token.
const printsCache = new Map();
export async function printings(name, { token = false } = {}) {
  const key = `${token}|${name}`;
  if (!printsCache.has(key)) {
    const q = token ? `!"${name}" t:token game:paper` : `!"${name}" game:paper`;
    const res = await scryfall(`/cards/search?q=${encodeURIComponent(q)}&unique=prints&order=released${token ? "&include_extras=true" : ""}`);
    printsCache.set(key, res?.data ?? []);
  }
  const prints = printsCache.get(key);
  return prints.length || token ? prints : printings(name, { token: true });
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
