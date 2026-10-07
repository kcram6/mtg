import * as store from "./store.js";
import * as github from "./github.js";
import * as scryfall from "./scryfall.js";
import { Scanner } from "./scanner.js";
import { recognizeCard } from "./recognize.js";
import { warmUp as warmUpOcr } from "./ocr.js";
import { resetClient } from "./ai.js";

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const money = (n) => (n == null ? "—" : `$${n.toFixed(2)}`);
const icon = (name, cls = "") => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// Mana cost like "{2}{W}{U/P}" rendered with Scryfall's symbol images.
const manaCost = (cost) =>
  (cost?.match(/\{[^}]+\}/g) ?? [])
    .map((sym) => `<img class="mana" src="https://svgs.scryfall.io/card-symbols/${encodeURIComponent(sym.slice(1, -1).replace(/\//g, ""))}.svg" alt="${esc(sym)}">`)
    .join("");

const deckLabel = (deckId) => store.getDeck(deckId)?.name ?? "Extras";
const deckTag = (deckId) =>
  `<span class="tag ${deckId && store.getDeck(deckId) ? "deck" : ""}">${icon(store.getDeck(deckId) ? "swords" : "inbox")}${esc(deckLabel(deckId))}</span>`;

// ---------- Settings ----------
const SETTINGS_KEY = "mtg-settings";
let settings = { readerMode: "free-first", anthropicKey: "", githubRepo: "", githubToken: "", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };

const form = $("#settings-form");
for (const [k, v] of Object.entries(settings)) if (form.elements[k]) form.elements[k].value = v;
const settingsMsg = (html) => ($("#settings-msg").innerHTML = html);

form.addEventListener("submit", (e) => {
  e.preventDefault();
  settings = { ...settings, ...Object.fromEntries(new FormData(form)) };
  settings.githubRepo = settings.githubRepo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  resetClient();
  settingsMsg(`${icon("check", "accent")}Saved`);
  syncNow();
});

$("#test-github").addEventListener("click", async () => {
  settingsMsg(`${icon("loader", "spin")}Checking…`);
  try {
    const repo = await github.testConnection({ ...settings, ...Object.fromEntries(new FormData(form)) });
    settingsMsg(`${icon("check", "accent")}Connected and synced ${store.getCollection().totalCards} cards to ${esc(repo.full_name)}${repo.private ? " (private)" : " (warning: this repo is public)"}`);
    updateSyncPill();
  } catch (err) {
    settingsMsg(`${icon("alert")}${esc(err.message)}`);
  }
});

$("#export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(store.snapshot(), null, 1)], { type: "application/json" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `mtg-collection-${new Date().toISOString().slice(0, 10)}.json`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------- Navigation ----------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name !== "scan" && scanner.running) stopCamera();
  if (name === "collection") renderCollection();
}
document.querySelectorAll(".tabbar button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function toast(text, iconName = "check", ms = 3000) {
  const t = $("#toast");
  t.innerHTML = `${icon(iconName)}<span>${esc(text)}</span>`;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

document.querySelectorAll("dialog [data-close]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));

// ---------- GitHub sync ----------
let syncing = false, syncTimer = null;
const configured = () => settings.githubRepo && settings.githubToken;

function renderSyncStatus(state, text, iconName) {
  const pill = $("#sync-status");
  pill.className = `pill ${state}`;
  pill.innerHTML = `${icon(iconName, iconName === "loader" ? "spin" : "")}<span>${esc(text)}</span>`;
}

function updateSyncPill() {
  if (syncing) return;
  if (!configured()) return renderSyncStatus("", "Sync off", "cloud-off");
  if (store.changeCount > 0) renderSyncStatus("pending", `${store.changeCount} unsynced`, "cloud");
  else renderSyncStatus("ok", "Synced", "cloud-check");
}

async function syncNow() {
  if (!configured() || syncing) return updateSyncPill();
  syncing = true;
  renderSyncStatus("pending", "Syncing", "loader");
  try {
    await github.sync(settings);
    syncing = false;
    updateSyncPill();
    if ($("#view-collection").classList.contains("active")) renderCollection();
  } catch (err) {
    syncing = false;
    renderSyncStatus("error", "Sync failed", "alert");
    toast(err.message, "alert", 5000);
  }
}

// Batch scans into one commit: sync 20s after the last change.
store.onChange(() => {
  updateSyncPill();
  clearTimeout(syncTimer);
  if (store.changeCount > 0) syncTimer = setTimeout(syncNow, 20000);
});
$("#sync-status").addEventListener("click", () => (configured() ? syncNow() : showView("settings")));
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && store.changeCount > 0) syncNow();
});

// ---------- Deck picker ----------
// Resolves to a deck id, null for Extras, or undefined if dismissed.
function chooseDeck({ title, current }) {
  const dialog = $("#deck-dialog");
  $("#deck-dialog-title").textContent = title;
  const options = [{ id: null, name: "Extras / Uncategorized", count: store.extrasCount(), iconName: "inbox" }].concat(
    store.getDecks().map((d) => ({ ...d, iconName: "swords" })),
  );
  $("#deck-options").innerHTML = options
    .map(
      (o, i) => `<li><button data-i="${i}" class="${o.id === current ? "selected" : ""}">
        <span class="opt-icon">${icon(o.iconName)}</span>
        <span class="opt-name">${esc(o.name)}</span>
        <span class="opt-count">${o.count} card${o.count === 1 ? "" : "s"}</span>
        ${o.id === current ? icon("check", "check") : ""}
      </button></li>`,
    )
    .join("");
  $("#new-deck-name").value = "";
  dialog.showModal();

  return new Promise((resolve) => {
    let result;
    $("#deck-options").onclick = (e) => {
      const btn = e.target.closest("button[data-i]");
      if (!btn) return;
      result = options[btn.dataset.i].id;
      dialog.close();
    };
    $("#new-deck-form").onsubmit = (e) => {
      e.preventDefault();
      const name = $("#new-deck-name").value.trim();
      if (!name) return;
      result = store.createDeck(name).id;
      toast(`Created deck “${name}”`);
      dialog.close();
    };
    dialog.addEventListener("close", () => resolve(result), { once: true });
  });
}

// ---------- Scan destination ----------
let destination = localStorage.getItem("mtg-destination") || null;
if (!store.getDeck(destination)) destination = null;

function setDestination(deckId) {
  destination = deckId;
  localStorage.setItem("mtg-destination", deckId ?? "");
  const deck = store.getDeck(deckId);
  $("#dest-name").textContent = deck ? deck.name : "Extras / Uncategorized";
  $("#dest-btn .dest-icon").innerHTML = icon(deck ? "swords" : "inbox");
}
setDestination(destination);

async function pickDestination() {
  const choice = await chooseDeck({ title: "Where are these cards going?", current: destination });
  if (choice === undefined) return false;
  setDestination(choice);
  return true;
}
$("#dest-btn").addEventListener("click", pickDestination);

// ---------- Feedback ----------
let audio = null;
function beep(ok) {
  if (!audio) return;
  const osc = audio.createOscillator(), gain = audio.createGain();
  osc.frequency.value = ok ? 880 : 220;
  gain.gain.setValueAtTime(0.15, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + (ok ? 0.15 : 0.35));
  osc.connect(gain).connect(audio.destination);
  osc.start();
  osc.stop(audio.currentTime + 0.4);
  navigator.vibrate?.(ok ? 60 : [80, 60, 80]);
}

function flash(kind) {
  const g = $("#guide");
  g.className = kind;
  setTimeout(() => (g.className = ""), 900);

  if (kind === "ok") {
    // Full-screen green flash + check mark; restart the animation for back-to-back scans.
    const s = $("#success");
    s.classList.remove("show");
    void s.offsetWidth;
    s.classList.add("show");
  } else {
    const f = $("#flash");
    f.className = kind;
    requestAnimationFrame(() => requestAnimationFrame(() => (f.className = "")));
  }
}

const STATUS_ICONS = { ok: "check", bad: "alert", warn: "alert", busy: "loader" };
function setStatus(text, kind = "") {
  const el = $("#camera-status");
  el.className = kind;
  el.innerHTML = `${STATUS_ICONS[kind] ? icon(STATUS_ICONS[kind], kind === "busy" ? "spin" : "") : ""}<span>${esc(text)}</span>`;
}

// ---------- Scanning ----------
const recent = []; // this session's scans, newest first

const scanner = new Scanner({
  container: $("#camera"),
  video: $("#video"),
  guide: $("#guide"),
  onStatus: (text) => setStatus(text),
  onCapture: handleCapture,
});

// Called by the scanner for each attempt. In auto mode it keeps retrying
// quietly until the card is read; Claude is asked at most once per card.
async function handleCapture(cardCanvas, { manual, attempt, aiTried }) {
  const hasKey = !!settings.anthropicKey;
  const allowAI = hasKey && (manual || (!aiTried && (attempt >= 2 || settings.readerMode === "ai")));
  $("#guide").className = "busy";
  if (manual || attempt === 1) setStatus("Reading card…", "busy");
  try {
    const result = await recognizeCard(cardCanvas, {
      mode: settings.readerMode,
      apiKey: settings.anthropicKey,
      allowAI,
      deferUncertain: hasKey && !aiTried, // let Claude double-check a shaky read on the next attempt
    });
    const aiUsed = result.aiUsed;

    if (result.status !== "found") {
      if (manual) {
        flash("bad");
        beep(false);
        setStatus("No card recognized. Fill the frame and avoid glare.", "bad");
      } else if (result.noCard) {
        $("#guide").className = "";
        setStatus("Hold a card inside the frame");
        return { outcome: "empty", aiUsed };
      } else {
        setStatus(attempt >= 5 ? "Scanning… try filling the frame and avoiding glare" : "Scanning…", "busy");
      }
      return { outcome: "retry", aiUsed };
    }

    // Scanning the card that was just logged is almost always an accidental
    // re-scan, so don't log it again; the +1 button adds a real second copy.
    const last = recent.find((r) => !r.undone);
    const lastCard = last && store.getCard(store.getEntry(last.entryId)?.scryfall_id);
    if (lastCard && lastCard.name === result.card.name) {
      flash("warn");
      setStatus(`Already logged ${scryfall.frontName(result.card)}. Another copy? Tap +1 below.`, "warn");
      return { outcome: "done", aiUsed };
    }

    const entry = store.addCopy(result.card, { foil: $("#foil").checked, deckId: destination });
    recent.unshift({ entryId: entry.id, via: result.via, exact: result.exact, undone: false });
    flash("ok");
    beep(true);
    setStatus(`${scryfall.frontName(result.card)} added to ${deckLabel(destination)}`, "ok");
    renderRecent();
    return { outcome: "done", aiUsed };
  } catch (err) {
    // e.g. a bad API key or no connection: keep trying with free OCR only.
    setStatus(`Error: ${err.message}`, "bad");
    if (manual) flash("bad");
    return { outcome: "retry", aiUsed: allowAI };
  }
}

async function startCamera() {
  if (!(await pickDestination())) return;
  audio ??= new AudioContext();
  warmUpOcr();
  scryfall.cardNames().catch(() => {}); // preload the name list used for matching
  try {
    await scanner.start();
    $("#start-camera").hidden = true;
    setStatus("Hold a card inside the frame");
  } catch (err) {
    setStatus(`Camera unavailable: ${err.message}`, "bad");
  }
}

function stopCamera() {
  scanner.stop();
  $("#start-camera").hidden = false;
  setStatus("Camera paused");
}

$("#start-camera").addEventListener("click", startCamera);
$("#auto").addEventListener("change", (e) => (scanner.auto = e.target.checked));
$("#scan-now").addEventListener("click", () => (scanner.running ? scanner.capture(undefined, { manual: true }) : startCamera()));

function renderRecent() {
  const live = recent.filter((r) => !r.undone).length;
  $("#session-count").textContent = live ? `${live} this session` : "";
  if (!recent.length) {
    $("#recent").innerHTML = `<li class="empty">Scanned cards will show up here</li>`;
    return;
  }
  $("#recent").innerHTML = recent
    .map((r, i) => {
      const entry = store.getEntry(r.entryId);
      if (!entry && !r.undone) return "";
      const card = store.getCard(entry?.scryfall_id) ?? r.card;
      r.card = card; // keep for display after undo
      const foil = entry?.foil ?? r.foil;
      return `
        <li class="${r.undone ? "undone" : ""}" ${r.undone ? "" : `data-open="${i}"`}>
          <img src="${esc(card.image_small)}" alt="" loading="lazy">
          <div class="info">
            <div class="name">${esc(card.name)}</div>
            <div class="meta">${manaCost(card.mana_cost)} ${esc(store.cardType(card))} · ${esc(card.set_name)} #${esc(card.collector_number)}</div>
            <div class="tags">
              ${deckTag(entry?.deck_id ?? r.deckId)}
              ${foil ? `<span class="tag foil">${icon("sparkle")}Foil</span>` : ""}
              ${r.exact ? "" : `<span class="tag warn">${icon("alert")}Printing guessed</span>`}
              <span class="tag">${r.via === "ai" ? "AI" : "Free OCR"}</span>
            </div>
          </div>
          <div class="price">${money(store.unitPrice(card, foil))}${r.undone ? "" : icon("chevron", "chev-right")}</div>
          ${r.undone ? "" : `<div class="actions">
            <button class="btn sm" data-undo="${i}">${icon("undo")}Undo</button>
            <button class="btn sm" data-plus="${i}">${icon("plus")}1 copy</button>
            <button class="btn sm" data-open="${i}">${icon("pencil")}Edit</button>
          </div>`}
        </li>`;
    })
    .join("");
}

$("#recent").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-undo], button[data-plus]");
  if (!btn) {
    const row = e.target.closest("[data-open]");
    if (row) openCardDetail([recent[row.dataset.open].entryId]);
    return;
  }
  const d = btn.dataset;
  const r = recent[d.undo ?? d.plus];
  const entry = store.getEntry(r.entryId);
  if (d.plus) {
    const copy = store.addAnotherCopy(r.entryId);
    recent.unshift({ ...r, entryId: copy.id });
    flash("ok");
    beep(true);
    setStatus(`Another ${store.getCard(copy.scryfall_id).name} added`, "ok");
  } else {
    Object.assign(r, { foil: entry.foil, deckId: entry.deck_id, undone: true });
    store.removeCopy(r.entryId);
  }
  renderRecent();
});

// ---------- Card detail / edit ----------
// Shows one printing and lets you edit each physical copy (foil, remove) or
// all of them (deck, printing). `detailIds` are the inventory entries shown.
let detailIds = [];

function openCardDetail(entryIds) {
  detailIds = [...entryIds];
  renderDetail();
  $("#card-dialog").showModal();
}

function refreshLists() {
  renderRecent();
  if ($("#view-collection").classList.contains("active")) renderCollection();
}

function renderDetail() {
  const entries = detailIds.map(store.getEntry).filter(Boolean);
  if (!entries.length) return $("#card-dialog").close();
  const card = store.getCard(entries[0].scryfall_id);
  const deckIds = [...new Set(entries.map((e) => e.deck_id))];
  const normal = card.price_usd, foilPrice = card.price_usd_foil ?? card.price_usd_etched;

  $("#card-dialog-title").textContent = card.name;
  $("#card-detail").innerHTML = `
    <div class="detail">
      <img class="detail-img" src="${esc(card.image_normal ?? card.image_small)}" alt="${esc(card.name)}">
      <div class="detail-info">
        <div class="mana-row">${manaCost(card.mana_cost) || '<span class="muted">No mana cost</span>'}</div>
        <div class="detail-type">${esc(card.type_line)}</div>
        <div class="meta">${esc(card.set_name)}</div>
        <div class="meta">${esc(card.set_code?.toUpperCase())} #${esc(card.collector_number)} · ${esc(card.rarity)}</div>
        <div class="price-grid">
          <div><small>Normal</small><strong>${normal ? `$${normal}` : "—"}</strong></div>
          <div><small>Foil</small><strong>${foilPrice ? `$${foilPrice}` : "—"}</strong></div>
        </div>
        <div class="tags">${deckIds.map((id) => deckTag(id)).join("")}</div>
      </div>
    </div>
    <div class="detail-actions">
      <button class="btn" data-act="move">${icon("swords")}Move</button>
      <button class="btn" data-act="printing">${icon("swap")}Printing</button>
      <button class="btn" data-act="add">${icon("plus")}Add copy</button>
      ${card.tcgplayer_url ? `<a class="btn" href="${esc(card.tcgplayer_url)}" target="_blank" rel="noopener">${icon("external")}TCGplayer</a>` : ""}
    </div>
    <div class="section-head detail-section"><h2>Copies</h2><span class="count">${entries.length}</span></div>
    <ul class="copies">
      ${entries
        .map(
          (e, i) => `<li>
            <div class="copy-info">
              <span>Copy ${i + 1}</span>
              <small>${esc(deckLabel(e.deck_id))} · added ${new Date(e.added_at).toLocaleDateString()} · ${money(store.unitPrice(card, e.foil))}</small>
            </div>
            <label class="switch"><input type="checkbox" data-foil="${e.id}" ${e.foil ? "checked" : ""}><span class="track"></span>Foil</label>
            <button class="btn icon-only ghost danger" data-remove="${e.id}" aria-label="Remove this copy" title="Remove this copy">${icon("trash")}</button>
          </li>`,
        )
        .join("")}
    </ul>`;
}

$("#card-detail").addEventListener("change", (e) => {
  const id = e.target.dataset.foil;
  if (!id) return;
  store.setFoil(id, e.target.checked);
  renderDetail();
  refreshLists();
});

$("#card-detail").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const entries = detailIds.map(store.getEntry).filter(Boolean);
  const card = store.getCard(entries[0].scryfall_id);
  if (btn.dataset.remove) {
    if (entries.length === 1 && !confirm(`Remove ${card.name} from your collection?`)) return;
    store.removeCopy(btn.dataset.remove);
    toast("Copy removed");
  } else if (btn.dataset.act === "move") {
    const deckId = await chooseDeck({ title: `Move ${entries.length > 1 ? `${entries.length} copies` : "card"} to…`, current: entries[0].deck_id });
    if (deckId === undefined) return;
    store.moveCopies(detailIds, deckId);
    toast(`Moved to ${deckLabel(deckId)}`);
  } else if (btn.dataset.act === "printing") {
    return pickPrinting(card.name, (printing) => {
      store.changePrinting(detailIds, printing);
      recent.forEach((r) => detailIds.includes(r.entryId) && (r.exact = true));
      renderDetail();
      refreshLists();
    });
  } else if (btn.dataset.act === "add") {
    detailIds.push(store.addAnotherCopy(entries.at(-1).id).id);
    toast(`Added another ${card.name}`);
  } else {
    return;
  }
  renderDetail();
  refreshLists();
});

// ---------- Printing picker ----------
async function pickPrinting(name, onPick) {
  const dialog = $("#printing-dialog"), grid = $("#printing-grid");
  grid.innerHTML = `<p class="muted">${icon("loader", "spin")} Loading printings…</p>`;
  dialog.showModal();
  const prints = await scryfall.printings(name);
  grid.innerHTML = prints
    .map((p, i) => {
      const img = p.image_uris?.small ?? p.card_faces?.[0]?.image_uris?.small;
      const price = p.prices.usd ? `$${p.prices.usd}` : p.prices.usd_foil ? `$${p.prices.usd_foil} foil` : "—";
      return `<button data-i="${i}"><img src="${esc(img)}" alt="" loading="lazy">
        <span>${esc(p.set_name)}</span><span class="muted">${esc(p.set.toUpperCase())} #${esc(p.collector_number)} · ${price}</span></button>`;
    })
    .join("");
  grid.onclick = (e) => {
    const btn = e.target.closest("button[data-i]");
    if (!btn) return;
    dialog.close();
    onPick(prints[btn.dataset.i]);
  };
}

// ---------- Collection ----------
let place = "all"; // "all", "extras", or a deck id
let typeFilter = "all";

function renderPlaceChips() {
  const chips = [
    { id: "all", label: "All", iconName: "layers" },
    { id: "extras", label: "Extras", iconName: "inbox" },
    ...store.getDecks().map((d) => ({ id: d.id, label: d.name, iconName: "swords" })),
  ];
  $("#deck-filter").innerHTML =
    chips.map((c) => `<button class="chip ${c.id === place ? "active" : ""}" data-place="${esc(c.id)}">${icon(c.iconName)}${esc(c.label)}</button>`).join("") +
    `<button class="chip" data-new-deck>${icon("plus")}New deck</button>`;
}

function renderTypeChips(typeCounts) {
  const types = scryfall.CARD_TYPES.concat("Other").filter((t) => typeCounts[t]);
  const total = Object.values(typeCounts).reduce((a, b) => a + b, 0);
  $("#type-filter").innerHTML = total
    ? [["all", "All types", total], ...types.map((t) => [t, t, typeCounts[t]])]
        .map(([id, label, n]) => `<button class="chip small ${id === typeFilter ? "active" : ""}" data-type="${id}">${label} <span class="n">${n}</span></button>`)
        .join("")
    : "";
}

function renderCurve() {
  const deck = store.getDeck(place);
  $("#curve").hidden = !deck;
  if (!deck) return;
  const { buckets, total, average } = store.manaCurve(place);
  const max = Math.max(...buckets, 1);
  const summary = total ? `Avg ${average.toFixed(2)} · ${total} non-land card${total === 1 ? "" : "s"}` : "No non-land cards yet";
  $("#curve-readout").textContent = summary;
  $("#curve-max").textContent = total ? max : "";
  $("#curve-bars").setAttribute("aria-label", `Mana curve: ${buckets.map((n, i) => `${i === 7 ? "7+" : i} mana ${n}`).join(", ")}`);
  $("#curve-bars").innerHTML = buckets
    .map((n, i) => {
      const label = i === 7 ? "7+" : String(i);
      return `<button class="curve-col" data-readout="${label} mana · ${n} card${n === 1 ? "" : "s"}">
        <span class="bar-wrap"><span class="bar" style="height:${(n / max) * 100}%"></span></span>
        <span class="mv">${label}</span>
      </button>`;
    })
    .join("");
  const bars = $("#curve-bars");
  const show = (e) => {
    const col = e.target.closest(".curve-col");
    bars.querySelectorAll(".curve-col").forEach((c) => c.classList.toggle("hot", c === col));
    $("#curve-readout").textContent = col ? col.dataset.readout : summary;
  };
  bars.onpointerover = bars.onfocusin = bars.onclick = show;
  bars.onpointerleave = () => show({ target: document.body });
}

function renderCollection() {
  if (place !== "all" && place !== "extras" && !store.getDeck(place)) place = "all";
  renderPlaceChips();

  const deck = store.getDeck(place);
  $("#deck-head").hidden = !deck;
  if (deck) $("#deck-title").textContent = deck.name;
  renderCurve();

  const { rows, totalCards, totalValue, typeCounts } = store.getCollection(place, typeFilter);
  if (typeFilter !== "all" && !typeCounts[typeFilter]) typeFilter = "all";
  renderTypeChips(typeCounts);
  $("#total-cards").textContent = totalCards;
  $("#total-value").textContent = money(totalValue);

  const q = $("#search").value.trim().toLowerCase();
  const shown = q ? rows.filter((r) => `${r.card.name} ${r.card.set_name} ${r.card.type_line}`.toLowerCase().includes(q)) : rows;

  $("#collection").innerHTML = shown.length
    ? shown
        .map(
          (r, i) => `
      <li data-open="${i}">
        <img src="${esc(r.card.image_small)}" alt="" loading="lazy">
        <div class="info">
          <div class="name"><span class="qty">${r.entryIds.length}×</span>${esc(r.card.name)}</div>
          <div class="meta">${manaCost(r.card.mana_cost)} ${esc(r.card.type_line)}</div>
          <div class="meta">${esc(r.card.set_name)} #${esc(r.card.collector_number)} · ${esc(r.card.rarity)}</div>
          <div class="tags">
            ${place === "all" ? deckTag(r.deckId) : ""}
            ${r.foil ? `<span class="tag foil">${icon("sparkle")}Foil</span>` : ""}
          </div>
        </div>
        <div class="price">${money(r.unitPrice)}${r.entryIds.length > 1 ? `<small>${money((r.unitPrice ?? 0) * r.entryIds.length)}</small>` : ""}${icon("chevron", "chev-right")}</div>
      </li>`,
        )
        .join("")
    : `<li class="empty">${rows.length ? "No matches" : deck ? "No cards in this deck yet. Choose it when you start scanning." : "No cards yet. Head to Scan to add some."}</li>`;

  $("#collection").onclick = (e) => {
    const row = e.target.closest("[data-open]");
    if (row) openCardDetail(shown[row.dataset.open].entryIds);
  };
}

$("#deck-filter").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if ("newDeck" in btn.dataset) {
    const name = prompt("New deck name");
    if (!name?.trim()) return;
    place = store.createDeck(name).id;
  } else {
    place = btn.dataset.place;
  }
  typeFilter = "all";
  renderCollection();
});

$("#type-filter").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-type]");
  if (!btn) return;
  typeFilter = btn.dataset.type;
  renderCollection();
});

$("#rename-deck").addEventListener("click", () => {
  const deck = store.getDeck(place);
  const name = prompt("Rename deck", deck.name);
  if (name?.trim()) {
    store.renameDeck(deck.id, name);
    if (destination === deck.id) setDestination(deck.id);
    renderCollection();
  }
});

$("#delete-deck").addEventListener("click", () => {
  const deck = store.getDeck(place);
  if (!confirm(`Delete “${deck.name}”? Its cards stay in your collection and move to Extras.`)) return;
  store.deleteDeck(deck.id);
  if (destination === deck.id) setDestination(null);
  place = "all";
  renderCollection();
  toast("Deck deleted. Its cards moved to Extras.");
});

$("#search").addEventListener("input", renderCollection);

$("#refresh-prices").addEventListener("click", async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.innerHTML = icon("refresh", "spin");
  try {
    store.updatePrices(await scryfall.fetchMany(store.ownedScryfallIds()));
    renderCollection();
    toast("Prices updated from TCGplayer");
  } catch (err) {
    toast(err.message, "alert");
  } finally {
    btn.disabled = false;
    btn.innerHTML = icon("refresh");
  }
});

// ---------- Start ----------
renderRecent();
updateSyncPill();
syncNow().then(async () => {
  // Cards scanned before mana value / type were stored: fill in their details.
  const missing = store.idsMissingDetails();
  if (missing.length) store.updatePrices(await scryfall.fetchMany(missing).catch(() => []));
});
