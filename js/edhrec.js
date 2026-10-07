// Commander recommendations from EDHREC (free JSON, browser-accessible).
// Each commander page lists the cards most played with it, grouped by type,
// with how many decks run each card and a synergy score.
const BASE = "https://json.edhrec.com/pages/commanders/";
const SPECIAL = new Set(["New Cards", "Top Cards", "Game Changers", "High Synergy Cards"]);
// Every deck runs basics; they aren't useful upgrade suggestions.
const BASIC = /^(Snow-Covered )?(Plains|Island|Swamp|Mountain|Forest|Wastes)$/;

// "Atraxa, Praetors' Voice" -> "atraxa-praetors-voice". Double-faced cards use the front face.
export const slug = (name) =>
  name
    .split(" // ")[0]
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’,.!?:"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

export const nameKey = (name) => name.split(" // ")[0].toLowerCase();

async function fetchPage(pageSlug) {
  const res = await fetch(`${BASE}${pageSlug}.json`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`EDHREC error ${res.status}`);
  return res.json();
}

function parse(page) {
  const lists = page.container?.json_dict?.cardlists ?? [];
  const cards = new Map();
  for (const list of lists) {
    for (const c of list.cardviews ?? []) {
      if (BASIC.test(c.name)) continue;
      const card = cards.get(c.name) ?? {
        id: c.id, // a Scryfall id
        name: c.name,
        category: null,
        topCard: false,
        gameChanger: false,
        synergy: c.synergy ?? 0,
        inclusion: c.potential_decks ? c.num_decks / c.potential_decks : 0,
        decks: c.num_decks ?? 0,
      };
      if (list.header === "Top Cards") card.topCard = true;
      else if (list.header === "Game Changers") card.gameChanger = true;
      else if (!SPECIAL.has(list.header) && !card.category) card.category = list.header;
      cards.set(c.name, card);
    }
  }
  const categories = lists.map((l) => l.header).filter((h) => !SPECIAL.has(h));
  return { cards: [...cards.values()], categories };
}

// Partner pairs have their own page (names sorted and joined); fall back to
// the first commander alone if EDHREC has no page for the pair.
const cache = new Map();
export function recommendations(commanderNames) {
  const slugs = commanderNames.map(slug).sort();
  const key = slugs.join("-");
  if (!cache.has(key)) {
    const promise = (async () => {
      const page = (await fetchPage(key)) ?? (slugs.length > 1 ? await fetchPage(slugs[0]) : null);
      if (!page) throw new Error("EDHREC doesn't have recommendations for this commander yet");
      return parse(page);
    })();
    promise.catch(() => cache.delete(key));
    cache.set(key, promise);
  }
  return cache.get(key);
}
