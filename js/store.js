// The collection lives in this browser (localStorage) and syncs to a JSON file
// in your private GitHub repo. Each physical card is one `inventory` entry with
// a `deck_id` (null = Extras / Uncategorized).
import { toCardRecord, mainType } from "./scryfall.js";

const KEY = "mtg-collection";
const empty = () => ({ version: 1, cards: {}, inventory: [], removed: [], decks: [] });
const now = () => new Date().toISOString();

let data = load();
let listeners = [];
export let changeCount = Number(localStorage.getItem(KEY + "-changes") || 0); // edits not yet synced

function load() {
  try {
    return { ...empty(), ...JSON.parse(localStorage.getItem(KEY)) };
  } catch {
    return empty();
  }
}

function save({ changed = true } = {}) {
  if (changed) changeCount++;
  localStorage.setItem(KEY, JSON.stringify(data));
  localStorage.setItem(KEY + "-changes", String(changeCount));
  listeners.forEach((fn) => fn());
}

export const onChange = (fn) => listeners.push(fn);
export const snapshot = () => structuredClone(data);

// ---------- Cards ----------
export function addCopy(scryfallCard, { foil = false, deckId = null } = {}) {
  const card = toCardRecord(scryfallCard);
  data.cards[card.scryfall_id] = card;
  const t = now();
  const entry = { id: crypto.randomUUID(), scryfall_id: card.scryfall_id, foil, deck_id: deckId, added_at: t, updated_at: t };
  data.inventory.push(entry);
  fulfillWishlist(deckId, card.name);
  save();
  return entry;
}

// Another physical copy of the same printing, foil-ness and deck as an existing entry.
export function addAnotherCopy(inventoryId) {
  const source = data.inventory.find((e) => e.id === inventoryId);
  const t = now();
  const entry = { ...source, id: crypto.randomUUID(), added_at: t, updated_at: t };
  data.inventory.push(entry);
  save();
  return entry;
}

export function removeCopy(inventoryId) {
  data.inventory = data.inventory.filter((e) => e.id !== inventoryId);
  data.removed.push(inventoryId);
  save();
}

function updateEntries(inventoryIds, changes) {
  const t = now();
  for (const e of data.inventory) if (inventoryIds.includes(e.id)) Object.assign(e, changes, { updated_at: t });
  save();
}

export function changePrinting(inventoryIds, scryfallCard) {
  const card = toCardRecord(scryfallCard);
  data.cards[card.scryfall_id] = card;
  updateEntries(inventoryIds, { scryfall_id: card.scryfall_id });
}

export const setFoil = (inventoryId, foil) => updateEntries([inventoryId], { foil });
export function moveCopies(inventoryIds, deckId) {
  for (const e of data.inventory) if (inventoryIds.includes(e.id)) fulfillWishlist(deckId, data.cards[e.scryfall_id].name);
  updateEntries(inventoryIds, { deck_id: deckId });
}

export function updatePrices(scryfallCards) {
  for (const c of scryfallCards) data.cards[c.id] = toCardRecord(c);
  save();
}

export const getCard = (id) => data.cards[id];
export const cardType = (card) => card.card_type ?? mainType(card.type_line);
// Cards saved before mana value / type were stored; refresh these from Scryfall.
export const idsMissingDetails = () => Object.keys(data.cards).filter((id) => data.cards[id].cmc === undefined);
export const getEntry = (id) => data.inventory.find((e) => e.id === id);
export const ownedScryfallIds = () => [...new Set(data.inventory.map((e) => e.scryfall_id))];

export function unitPrice(card, foil) {
  const p = foil ? (card.price_usd_foil ?? card.price_usd_etched ?? card.price_usd) : card.price_usd;
  return p == null ? null : Number(p);
}

// ---------- Decks ----------
export function createDeck(name) {
  const t = now();
  const deck = { id: crypto.randomUUID(), name: name.trim(), created_at: t, updated_at: t };
  data.decks.push(deck);
  save();
  return deck;
}

export function renameDeck(id, name) {
  Object.assign(getDeck(id), { name: name.trim(), updated_at: now() });
  save();
}

// Deleting a deck keeps its cards; they move to Extras.
export function deleteDeck(id) {
  const t = now();
  for (const e of data.inventory) if (e.deck_id === id) Object.assign(e, { deck_id: null, updated_at: t });
  data.decks = data.decks.filter((d) => d.id !== id);
  data.removed.push(id);
  save();
}

// ---------- Wishlists ----------
// Cards you want for a deck. Stored on the deck; an item is removed
// automatically once a copy of that card is added to the deck.
const sameName = (a, b) => a.split(" // ")[0].toLowerCase() === b.split(" // ")[0].toLowerCase();

export const getWishlist = (deckId) => getDeck(deckId)?.wishlist ?? [];
export const onWishlist = (deckId, name) => getWishlist(deckId).some((w) => sameName(w.name, name));

export function addToWishlist(deckId, scryfallCard) {
  const deck = getDeck(deckId);
  const item = { ...toCardRecord(scryfallCard), added_at: now() };
  deck.wishlist = getWishlist(deckId).filter((w) => !sameName(w.name, item.name)).concat(item);
  deck.updated_at = now();
  save();
}

export function removeFromWishlist(deckId, name) {
  const deck = getDeck(deckId);
  deck.wishlist = getWishlist(deckId).filter((w) => !sameName(w.name, name));
  deck.updated_at = now();
  save();
}

function fulfillWishlist(deckId, name) {
  const deck = getDeck(deckId);
  if (!deck?.wishlist?.some((w) => sameName(w.name, name))) return;
  deck.wishlist = deck.wishlist.filter((w) => !sameName(w.name, name));
  deck.updated_at = now();
}

// Your copies of a card anywhere in the collection (any printing).
export const ownedCopies = (name) => data.inventory.filter((e) => sameName(data.cards[e.scryfall_id]?.name ?? "", name));

export const deckValue = (deckId) =>
  data.inventory.filter((e) => e.deck_id === deckId).reduce((sum, e) => sum + (unitPrice(data.cards[e.scryfall_id], e.foil) ?? 0), 0);

export const deckCardNames = (deckId) =>
  new Set(data.inventory.filter((e) => e.deck_id === deckId).map((e) => data.cards[e.scryfall_id].name.split(" // ")[0].toLowerCase()));

// ---------- Commanders ----------
// A deck's commander is a specific copy in that deck; up to two (partners).
// Copies that have since left the deck don't count.
export function getCommanders(deckId) {
  const deck = getDeck(deckId);
  return (deck?.commanders ?? [])
    .map((id) => data.inventory.find((e) => e.id === id))
    .filter((e) => e && e.deck_id === deckId)
    .map((entry) => ({ entry, card: data.cards[entry.scryfall_id] }));
}

export function setCommander(deckId, entryId, isCommander) {
  const deck = getDeck(deckId);
  const current = getCommanders(deckId).map((c) => c.entry.id).filter((id) => id !== entryId);
  deck.commanders = isCommander ? [...current, entryId].slice(-2) : current;
  deck.updated_at = now();
  save();
}

export const isCommander = (entry) => getCommanders(entry.deck_id).some((c) => c.entry.id === entry.id);

// The colors a deck may use: the union of its commanders' color identities.
export function commanderIdentity(deckId) {
  const commanders = getCommanders(deckId);
  return commanders.length ? new Set(commanders.flatMap((c) => c.card.color_identity ?? [])) : null;
}

const outsideIdentity = (card, identity) => !!identity && (card.color_identity ?? []).some((c) => !identity.has(c));

// Unknown deck ids (e.g. deleted on another device) count as Extras.
export const getDeck = (id) => (id ? data.decks.find((d) => d.id === id) : undefined);
const deckOf = (e) => (getDeck(e.deck_id) ? e.deck_id : null);

export function getDecks() {
  return data.decks
    .map((d) => {
      const entries = data.inventory.filter((e) => e.deck_id === d.id);
      return { ...d, count: entries.length };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// Cards that count toward a Commander deck's 100 (tokens don't).
export const deckSize = (deckId) =>
  data.inventory.filter((e) => e.deck_id === deckId && cardType(data.cards[e.scryfall_id]) !== "Token").length;

export const extrasCount = () => data.inventory.filter((e) => deckOf(e) === null).length;

// ---------- Views ----------
const inPlace = (e, place) => {
  const deckId = deckOf(e);
  return place === "all" || (place === "extras" ? deckId === null : deckId === place);
};

// place: "all", "extras", or a deck id. type: "all" or a main card type.
// Rows are grouped by printing + foil + deck.
export function getCollection(place = "all", type = "all") {
  const groups = new Map();
  const typeCounts = {};
  const commanderIds = new Set(getDecks().flatMap((d) => getCommanders(d.id).map((c) => c.entry.id)));
  const identities = new Map(getDecks().map((d) => [d.id, commanderIdentity(d.id)]));
  for (const e of data.inventory) {
    if (!inPlace(e, place)) continue;
    const t = cardType(data.cards[e.scryfall_id]);
    typeCounts[t] = (typeCounts[t] ?? 0) + 1;
    if (type !== "all" && t !== type) continue;
    const deckId = deckOf(e);
    const commander = commanderIds.has(e.id);
    const key = `${e.scryfall_id}|${e.foil}|${deckId}|${commander}`;
    if (!groups.has(key)) {
      const card = data.cards[e.scryfall_id];
      const offIdentity = t !== "Token" && outsideIdentity(card, identities.get(deckId));
      groups.set(key, { card, foil: e.foil, deckId, commander, offIdentity, entryIds: [], unitPrice: unitPrice(card, e.foil) });
    }
    groups.get(key).entryIds.push(e.id);
  }
  const rows = [...groups.values()].sort((a, b) => b.commander - a.commander || a.card.name.localeCompare(b.card.name));
  const totalCards = rows.reduce((n, r) => n + r.entryIds.length, 0);
  const totalValue = rows.reduce((sum, r) => sum + (r.unitPrice ?? 0) * r.entryIds.length, 0);
  return { rows, totalCards, totalValue, typeCounts };
}

// Mana curve: number of non-land cards at each mana value (7 = "7+"). Tokens
// aren't part of the deck, so they're left out too.
export function manaCurve(place) {
  const buckets = Array(8).fill(0);
  let total = 0, sum = 0;
  for (const e of data.inventory) {
    if (!inPlace(e, place)) continue;
    const card = data.cards[e.scryfall_id];
    if (["Land", "Token"].includes(cardType(card))) continue;
    const mv = card.cmc ?? 0;
    buckets[Math.min(7, Math.floor(mv))]++;
    total++;
    sum += mv;
  }
  return { buckets, total, average: total ? sum / total : 0 };
}

// ---------- Sync support ----------
// Combine two copies of the collection (e.g. this phone + what's on GitHub).
// The newest version of each card copy / deck wins; deletions always stick.
function mergeById(listA, listB, removed) {
  const out = new Map();
  for (const item of [...listB, ...listA]) {
    if (removed.has(item.id)) continue;
    const prev = out.get(item.id);
    if (!prev || item.updated_at > prev.updated_at) out.set(item.id, item);
  }
  return [...out.values()];
}

export function merge(a, b) {
  if (!b) return structuredClone(a);
  const removed = new Set([...a.removed, ...(b.removed ?? [])]);
  const inventory = mergeById(a.inventory, b.inventory ?? [], removed);
  const decks = mergeById(a.decks ?? [], b.decks ?? [], removed);

  const cards = { ...b.cards };
  for (const [id, c] of Object.entries(a.cards)) {
    if (!cards[id] || c.prices_updated_at > cards[id].prices_updated_at) cards[id] = c;
  }
  // Drop card records nothing refers to any more.
  const used = new Set(inventory.map((e) => e.scryfall_id));
  for (const id of Object.keys(cards)) if (!used.has(id)) delete cards[id];

  return { ...empty(), ...b, ...a, cards, inventory, decks, removed: [...removed] };
}

// After a sync: fold the synced copy into whatever changed locally meanwhile.
export function applySynced(synced, changesAtStart) {
  data = merge(data, synced);
  changeCount = Math.max(0, changeCount - changesAtStart);
  save({ changed: false });
}
