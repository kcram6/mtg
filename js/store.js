// The collection lives in this browser (localStorage) and syncs to a JSON file
// in your private GitHub repo. Each physical card is one `inventory` entry, so
// individual copies can later be assigned to decks.
import { toCardRecord } from "./scryfall.js";

const KEY = "mtg-collection";
const empty = () => ({ version: 1, cards: {}, inventory: [], removed: [], decks: [] });

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

export function addCopy(scryfallCard, { foil = false } = {}) {
  const card = toCardRecord(scryfallCard);
  data.cards[card.scryfall_id] = card;
  const now = new Date().toISOString();
  const entry = { id: crypto.randomUUID(), scryfall_id: card.scryfall_id, foil, deck_id: null, added_at: now, updated_at: now };
  data.inventory.push(entry);
  save();
  return entry;
}

export function removeCopy(inventoryId) {
  data.inventory = data.inventory.filter((e) => e.id !== inventoryId);
  data.removed.push(inventoryId);
  save();
}

// Remove one copy of a printing, preferring copies not in a deck.
export function removeOneOf(scryfallId, foil) {
  const matches = data.inventory.filter((e) => e.scryfall_id === scryfallId && e.foil === foil);
  const victim = matches.find((e) => !e.deck_id) ?? matches.at(-1);
  if (victim) removeCopy(victim.id);
}

export function changePrinting(inventoryIds, scryfallCard) {
  const card = toCardRecord(scryfallCard);
  data.cards[card.scryfall_id] = card;
  const now = new Date().toISOString();
  for (const e of data.inventory) {
    if (inventoryIds.includes(e.id)) Object.assign(e, { scryfall_id: card.scryfall_id, updated_at: now });
  }
  save();
}

export function setFoil(inventoryId, foil) {
  const entry = data.inventory.find((e) => e.id === inventoryId);
  Object.assign(entry, { foil, updated_at: new Date().toISOString() });
  save();
}

export function updatePrices(scryfallCards) {
  for (const c of scryfallCards) data.cards[c.id] = toCardRecord(c);
  save();
}

export const getCard = (id) => data.cards[id];
export const getEntry = (id) => data.inventory.find((e) => e.id === id);
export const ownedScryfallIds = () => [...new Set(data.inventory.map((e) => e.scryfall_id))];

export function unitPrice(card, foil) {
  const p = foil ? (card.price_usd_foil ?? card.price_usd_etched ?? card.price_usd) : card.price_usd;
  return p == null ? null : Number(p);
}

// Collection grouped by printing + foil.
export function getCollection() {
  const groups = new Map();
  for (const e of data.inventory) {
    const key = `${e.scryfall_id}|${e.foil}`;
    if (!groups.has(key)) {
      const card = data.cards[e.scryfall_id];
      groups.set(key, { card, foil: e.foil, entryIds: [], unitPrice: unitPrice(card, e.foil) });
    }
    groups.get(key).entryIds.push(e.id);
  }
  const rows = [...groups.values()].sort((a, b) => a.card.name.localeCompare(b.card.name));
  const totalValue = rows.reduce((sum, r) => sum + (r.unitPrice ?? 0) * r.entryIds.length, 0);
  return { rows, totalCards: data.inventory.length, totalValue };
}

// Combine two copies of the collection (e.g. this phone + what's on GitHub).
export function merge(a, b) {
  if (!b) return structuredClone(a);
  const removed = new Set([...a.removed, ...b.removed]);
  const inventory = new Map();
  for (const e of [...b.inventory, ...a.inventory]) {
    if (removed.has(e.id)) continue;
    const prev = inventory.get(e.id);
    if (!prev || e.updated_at > prev.updated_at) inventory.set(e.id, e);
  }
  const cards = { ...b.cards };
  for (const [id, c] of Object.entries(a.cards)) {
    if (!cards[id] || c.prices_updated_at > cards[id].prices_updated_at) cards[id] = c;
  }
  // Drop card records nothing refers to any more.
  const used = new Set([...inventory.values()].map((e) => e.scryfall_id));
  for (const id of Object.keys(cards)) if (!used.has(id)) delete cards[id];

  return { ...empty(), ...b, ...a, cards, inventory: [...inventory.values()], removed: [...removed] };
}

// After a sync: fold the synced copy into whatever changed locally meanwhile.
export function applySynced(synced, changesAtStart) {
  data = merge(data, synced);
  changeCount = Math.max(0, changeCount - changesAtStart);
  save({ changed: false });
}
