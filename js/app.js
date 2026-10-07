import * as store from "./store.js";
import * as github from "./github.js";
import * as scryfall from "./scryfall.js";
import { Scanner } from "./scanner.js";
import { recognizeCard } from "./recognize.js";
import { warmUp as warmUpOcr } from "./ocr.js";
import { resetClient } from "./ai.js";
import * as edhrec from "./edhrec.js";
import { estimateBracket, BRACKETS } from "./bracket.js";

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
const SETTING_FIELDS = ["readerMode", "anthropicKey", "githubRepo", "githubToken"];
let settings = { readerMode: "free-first", anthropicKey: "", githubRepo: "", githubToken: "", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };

// Setup link: the settings packed into the URL fragment (#setup=...), which
// browsers never send to the server. Opening it restores everything.
const toBase64Url = (str) => btoa(String.fromCharCode(...new TextEncoder().encode(str))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));

function setupLink() {
  const packed = Object.fromEntries(SETTING_FIELDS.filter((k) => settings[k]).map((k) => [k, settings[k]]));
  return `${location.origin}${location.pathname}#setup=${toBase64Url(JSON.stringify(packed))}`;
}

const restoredFromLink = (() => {
  const match = location.hash.match(/^#setup=([\w-]+)$/);
  if (!match) return false;
  history.replaceState(null, "", location.pathname + location.search); // don't leave secrets in the address bar
  try {
    const restored = JSON.parse(fromBase64Url(match[1]));
    for (const k of SETTING_FIELDS) if (typeof restored[k] === "string") settings[k] = restored[k];
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    return true;
  } catch {
    return false;
  }
})();

// A setup link opened while the app is already showing only changes the
// fragment, which doesn't reload the page; reload so it's applied above.
window.addEventListener("hashchange", () => location.hash.startsWith("#setup=") && location.reload());

// Ask the browser not to clear this app's storage on its own.
navigator.storage?.persist?.().catch(() => {});

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

// Copy or share the setup link so it can be saved in Passwords or Notes.
async function shareSetupLink(e) {
  if (!settings.githubToken && !settings.anthropicKey) return settingsMsg(`${icon("alert")}Save your settings first`);
  const url = setupLink();
  if (e.currentTarget.id === "share-setup" && navigator.share) {
    try {
      await navigator.share({ title: "MTG Collection setup link", url });
      return settingsMsg(`${icon("check", "accent")}Shared. Keep it somewhere private.`);
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    settingsMsg(`${icon("check", "accent")}Setup link copied. Paste it into Passwords or Notes.`);
  } catch {
    prompt("Copy your setup link:", url);
  }
}
$("#copy-setup").addEventListener("click", shareSetupLink);
$("#share-setup").addEventListener("click", shareSetupLink);
$("#share-setup").hidden = !navigator.share;

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
  const wasActive = $(`#view-${name}`).classList.contains("active");
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  document.querySelectorAll(".tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name !== "scan" && scanner.running) stopCamera();
  if (name === "collection") renderCollection();
  if (name === "decks") wasActive || !openDeckId ? showDeckList() : renderDeckPage();
  $("main").scrollTop = 0;
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

async function startCamera({ ask = true } = {}) {
  if (ask && !(await pickDestination())) return;
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

$("#start-camera").addEventListener("click", () => startCamera());
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
              <span class="tag">${{ ai: "AI", manual: "Manual" }[r.via] ?? "Free OCR"}</span>
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

// ---------- Card search sheet ----------
// Type a name, get suggestions (tokens included), tap one. Used both to add a
// card the camera can't read and to add cards to a wishlist.
const searchDialog = $("#search-dialog");
let searchTimer = null, searchSeq = 0, onSearchPick = null;

function openSearch({ title, note, onPick }) {
  $("#search-title").textContent = title;
  $("#manual-dest").innerHTML = note;
  $("#manual-q").value = "";
  $("#manual-results").innerHTML = "";
  onSearchPick = onPick;
  searchDialog.showModal();
  $("#manual-q").focus();
}

$("#manual-q").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 2) return ($("#manual-results").innerHTML = "");
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    const names = await scryfall.autocomplete(q).catch(() => []);
    if (seq !== searchSeq) return; // a newer search finished first
    $("#manual-results").innerHTML = names.length
      ? names.map((n) => `<li><button data-name="${esc(n)}"><span class="opt-icon">${icon("layers")}</span><span class="opt-name">${esc(n)}</span>${icon("chevron", "chev-right")}</button></li>`).join("")
      : `<li class="muted" style="padding:12px">No cards found</li>`;
  }, 250);
});

$("#manual-results").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-name]");
  if (btn) onSearchPick?.(btn.dataset.name);
});

// Add a card the camera can't read: pick it, then pick the printing.
$("#manual-add").addEventListener("click", () =>
  openSearch({
    title: "Add a card",
    note: `Adds to <strong>${esc(deckLabel(destination))}</strong>${$("#foil").checked ? " as foil" : ""}. Change this above the camera.`,
    onPick: (name) =>
      pickPrinting(name, (card) => {
        searchDialog.close();
        const entry = store.addCopy(card, { foil: $("#foil").checked, deckId: destination });
        recent.unshift({ entryId: entry.id, via: "manual", exact: true, undone: false });
        flash("ok");
        beep(true);
        setStatus(`${scryfall.frontName(card)} added to ${deckLabel(destination)}`, "ok");
        renderRecent();
      }),
  }),
);

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

// Legendary cards in a deck can be made its commander.
function commanderButton(entries, card) {
  const deckId = entries[0].deck_id;
  if (!store.getDeck(deckId) || !/\bLegendary\b/.test(card.type_line ?? "")) return "";
  const isCmdr = entries.some((e) => store.isCommander(e));
  return `<div class="detail-commander">
    <button class="btn ${isCmdr ? "" : "primary"}" data-act="commander">${icon("crown")}${isCmdr ? "Remove as commander" : `Make commander of ${esc(deckLabel(deckId))}`}</button>
  </div>`;
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
        <div class="tags">${entries.some((e) => store.isCommander(e)) ? `<span class="tag commander">${icon("crown")}Commander</span>` : ""}${deckIds.map((id) => deckTag(id)).join("")}</div>
      </div>
    </div>
    ${commanderButton(entries, card)}
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
  } else if (btn.dataset.act === "commander") {
    const current = entries.find((e) => store.isCommander(e));
    const target = current ?? entries[0];
    store.setCommander(target.deck_id, target.id, !current);
    toast(current ? "Removed as commander" : `${card.name} is now the commander`, current ? "check" : "crown");
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

// ---------- Sorting ----------
// Price sorts put cards with no price last, whichever direction.
function sortBy(list, mode, { price, name, added }) {
  const byName = (a, b) => name(a).localeCompare(name(b));
  const byPrice = (dir) => (a, b) => {
    const pa = price(a), pb = price(b);
    if (pa == null || pb == null) return (pa == null) - (pb == null) || byName(a, b);
    return dir * (pa - pb) || byName(a, b);
  };
  const cmp = {
    "price-desc": byPrice(-1),
    "price-asc": byPrice(1),
    newest: (a, b) => (added(b) ?? "").localeCompare(added(a) ?? "") || byName(a, b),
    name: byName,
  }[mode];
  return cmp ? [...list].sort(cmp) : list;
}

const savedSort = (key, fallback) => {
  try { return localStorage.getItem(key) || fallback; } catch { return fallback; }
};
const saveSort = (key, value) => {
  try { localStorage.setItem(key, value); } catch {}
};

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

const identityPips = (colors) => manaCost(colors.length ? colors.map((c) => `{${c}}`).join("") : "{C}");
const WUBRG = ["W", "U", "B", "R", "G"];

function renderCommanders(deck) {
  const panel = $("#commander-panel");
  panel.hidden = !deck;
  if (!deck) return;
  const commanders = store.getCommanders(deck.id);
  if (!commanders.length) {
    panel.innerHTML = `<div class="commander-hint">${icon("crown")}<span>No commander yet. Tap a legendary card in this deck and choose <strong>Make commander</strong>.</span></div>`;
    return;
  }
  const identity = [...store.commanderIdentity(deck.id)].sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b));
  panel.innerHTML = commanders
    .map(
      ({ entry, card }) => `<button class="cmdr" data-entry="${entry.id}">
        <img src="${esc(scryfall.artCrop(card) ?? card.image_small)}" alt="">
        <div class="cmdr-info">
          <div class="cmdr-label">${icon("crown")}Commander</div>
          <div class="cmdr-name">${esc(card.name)}</div>
          <div>${identityPips(identity)}</div>
        </div>
      </button>`,
    )
    .join("");
  panel.onclick = (e) => {
    const btn = e.target.closest("[data-entry]");
    if (btn) openCardDetail([btn.dataset.entry]);
  };
}

// Pie of colored mana symbols, in fixed WUBRG order so a color never moves.
const COLOR_NAMES = { W: "White", U: "Blue", B: "Black", R: "Red", G: "Green" };

function renderColors() {
  const deck = store.getDeck(place);
  $("#colors").hidden = !deck;
  if (!deck) return;
  const { counts, total } = store.colorBreakdown(place);
  const slices = WUBRG.filter((c) => counts[c] > 0).map((c) => ({ c, n: counts[c], share: total ? counts[c] / total : 0 }));
  const fmt = (n) => (Number.isInteger(n) ? n : n.toFixed(1));
  const summary = total ? `${fmt(total)} colored symbol${total === 1 ? "" : "s"}` : "No colored spells yet";
  $("#colors-readout").textContent = summary;

  // Pie slices as SVG arcs starting at 12 o'clock.
  const R = 48, C = 50;
  const point = (a) => [C + R * Math.sin(a), C - R * Math.cos(a)];
  let angle = 0;
  $("#colors-pie").innerHTML = slices.length === 1
    ? `<circle data-c="${slices[0].c}" cx="${C}" cy="${C}" r="${R}" fill="var(--c-${slices[0].c})"/>`
    : slices
        .map(({ c, share }) => {
          const a0 = angle, a1 = (angle += share * 2 * Math.PI);
          const [x0, y0] = point(a0), [x1, y1] = point(a1);
          return `<path data-c="${c}" fill="var(--c-${c})" d="M${C},${C} L${x0},${y0} A${R},${R} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${x1},${y1} Z"/>`;
        })
        .join("");
  $("#colors-pie").setAttribute("aria-label", `Color breakdown: ${slices.map((s) => `${COLOR_NAMES[s.c]} ${Math.round(s.share * 100)}%`).join(", ") || "none"}`);

  $("#colors-legend").innerHTML = slices
    .map(
      ({ c, n, share }) => `<li data-c="${c}" data-readout="${COLOR_NAMES[c]} · ${fmt(n)} symbol${n === 1 ? "" : "s"}">
        <span class="swatch" style="background:var(--c-${c})"></span>${manaCost(`{${c}}`)}
        <span class="c-name">${COLOR_NAMES[c]}</span><span class="c-pct">${Math.round(share * 100)}%</span>
      </li>`,
    )
    .join("");

  // Hover or tap a slice or legend row to highlight it and read its count.
  const body = $("#colors .colors-body");
  const show = (e) => {
    const c = e.target.closest?.("[data-c]")?.dataset.c;
    $("#colors-pie").classList.toggle("focus", !!c);
    body.querySelectorAll("[data-c]").forEach((el) => el.classList.toggle("hot", el.dataset.c === c));
    $("#colors-readout").textContent = c ? $(`#colors-legend [data-c="${c}"]`).dataset.readout : summary;
  };
  body.onpointerover = body.onclick = show;
  body.onpointerleave = () => show({ target: document.body });
}

function renderCollection() {
  if (place !== "all" && place !== "extras" && !store.getDeck(place)) place = "all";
  renderPlaceChips();

  const deck = store.getDeck(place);
  $("#deck-head").hidden = !deck;
  if (deck) $("#deck-title").textContent = deck.name;
  renderCommanders(deck);
  renderCurve();
  renderColors();

  const { rows, totalCards, totalValue, typeCounts } = store.getCollection(place, typeFilter);
  if (typeFilter !== "all" && !typeCounts[typeFilter]) typeFilter = "all";
  renderTypeChips(typeCounts);
  $("#cards-label").textContent = deck ? "Deck size" : "Cards";
  $("#total-cards").textContent = deck ? `${store.deckSize(deck.id)} / 100` : totalCards;
  $("#total-value").textContent = money(totalValue);

  const q = $("#search").value.trim().toLowerCase();
  const matches = q ? rows.filter((r) => `${r.card.name} ${r.card.set_name} ${r.card.type_line}`.toLowerCase().includes(q)) : rows;
  // The commander stays pinned to the top of its deck whatever the sort.
  const sorted = sortBy(matches, $("#sort").value, { price: (r) => r.unitPrice, name: (r) => r.card.name, added: (r) => r.addedAt });
  const shown = [...sorted.filter((r) => r.commander), ...sorted.filter((r) => !r.commander)];

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
            ${r.commander ? `<span class="tag commander">${icon("crown")}Commander</span>` : ""}
            ${place === "all" ? deckTag(r.deckId) : ""}
            ${r.foil ? `<span class="tag foil">${icon("sparkle")}Foil</span>` : ""}
            ${scryfall.bracketListsIfLoaded()?.gameChangers.has(r.card.name) ? `<span class="tag gc">Game Changer</span>` : ""}
            ${r.offIdentity ? `<span class="tag warn">${icon("alert")}Outside commander's colors</span>` : ""}
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
$("#sort").value = savedSort("mtg-sort", "name");
$("#sort").addEventListener("change", (e) => {
  saveSort("mtg-sort", e.target.value);
  renderCollection();
});

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

// ---------- Decks tab ----------
let openDeckId = null;
let deckTab = "upgrades";
const recState = { filter: "top", ownedOnly: false, shown: 25, sort: savedSort("mtg-rec-sort", "best") };
const recDetails = new Map(); // Scryfall id -> full Scryfall card (image, price) for recommendations

const sortedIdentity = (deckId) => [...(store.commanderIdentity(deckId) ?? [])].sort((a, b) => WUBRG.indexOf(a) - WUBRG.indexOf(b));
const artStyle = (card) => (card ? `style="--art:url('${esc(scryfall.artCrop(card))}')"` : "");

function showDeckList() {
  openDeckId = null;
  $("#deck-page").hidden = true;
  $("#decks-list").hidden = false;
  const decks = store.getDecks();
  $("#deck-grid").innerHTML =
    decks
      .map((d) => {
        const cmdrs = store.getCommanders(d.id);
        const lead = cmdrs[0]?.card;
        const lists = scryfall.bracketListsIfLoaded();
        const names = store.deckCardList(d.id);
        const bracket = lists && names.length ? estimateBracket(names, lists).bracket : null;
        return `<button class="deck-tile" data-deck="${d.id}" ${artStyle(lead)}>
          ${lead ? `<div class="tile-art"></div>` : `<div class="tile-empty">${icon("swords")}</div>`}
          ${bracket ? `<span class="tile-bracket" title="Estimated Commander bracket">B${bracket}</span>` : ""}
          ${lead ? `<div class="tile-pips">${identityPips(sortedIdentity(d.id))}</div>` : ""}
          <div class="tile-body">
            <div class="tile-name">${esc(d.name)}</div>
            <div class="tile-cmdr">${lead ? esc(cmdrs.map((c) => c.card.name.split(",")[0]).join(" & ")) : "No commander yet"}</div>
            ${(() => { const r = store.deckRecord(d.id); return r.total ? `<div class="tile-record">${r.wins}W–${r.losses}L · ${pctText(r.rate)}</div>` : ""; })()}
            <div class="tile-stats"><span>${store.deckSize(d.id)} / 100</span><span class="accent">${money(store.deckValue(d.id))}</span></div>
          </div>
        </button>`;
      })
      .join("") + `<button class="deck-tile new" data-new-deck><span>${icon("plus")}New deck</span></button>`;
  if (!scryfall.bracketListsIfLoaded() && decks.length) {
    scryfall.bracketLists().then(() => !openDeckId && $("#view-decks").classList.contains("active") && showDeckList(), () => {});
  }
}

async function createDeckFlow() {
  const name = prompt("New deck name");
  if (!name?.trim()) return;
  const deck = store.createDeck(name);
  toast(`Created deck “${deck.name}”`);
  openDeck(deck.id);
}

$("#deck-grid").addEventListener("click", (e) => {
  const tile = e.target.closest(".deck-tile");
  if (!tile) return;
  if ("newDeck" in tile.dataset) return createDeckFlow();
  openDeck(tile.dataset.deck);
});
$("#new-deck-btn").addEventListener("click", createDeckFlow);
$("#deck-back").addEventListener("click", showDeckList);

function openDeck(deckId) {
  openDeckId = deckId;
  deckTab = "upgrades";
  Object.assign(recState, { filter: "top", ownedOnly: false, shown: 25 }); // sort choice is kept
  $("#decks-list").hidden = true;
  $("#deck-page").hidden = false;
  $("main").scrollTop = 0;
  renderDeckPage();
}

function renderDeckPage() {
  const deck = store.getDeck(openDeckId);
  if (!deck) return showDeckList();
  const cmdrs = store.getCommanders(deck.id);
  const lead = cmdrs[0]?.card;
  const wishlist = store.getWishlist(deck.id);
  const wishCost = wishlist.reduce((sum, w) => sum + (Number(w.price_usd) || 0), 0);
  $("#deck-hero").innerHTML = `
    ${lead ? `<div class="hero-art" ${artStyle(lead)}></div>` : ""}
    <div class="hero-body">
      ${lead ? `<div>${identityPips(sortedIdentity(deck.id))}</div>` : ""}
      <h1>${esc(deck.name)}</h1>
      <div class="hero-cmdr">${icon("crown")}${lead ? esc(cmdrs.map((c) => c.card.name).join(" & ")) : "No commander yet"}</div>
      <div class="hero-stats">
        <div><strong>${store.deckSize(deck.id)} / 100</strong>cards</div>
        <div><strong class="accent">${money(store.deckValue(deck.id))}</strong>value</div>
        <div><strong>${money(wishCost)}</strong>wishlist</div>
      </div>
    </div>`;
  $("#wish-count").textContent = wishlist.length || "";
  document.querySelectorAll(".segmented button").forEach((b) => b.classList.toggle("active", b.dataset.tab === deckTab));
  $("#deck-upgrades").hidden = deckTab !== "upgrades";
  $("#deck-wishlist").hidden = deckTab !== "wishlist";
  $("#deck-games").hidden = deckTab !== "games";
  renderRecordBar(deck);
  renderRating(deck);
  if (deckTab === "upgrades") renderUpgrades(deck);
  else if (deckTab === "wishlist") renderWishlist(deck);
  else renderGames(deck);
}

// ---------- Wins & losses ----------
const pctText = (x) => (x == null ? "—" : `${Math.round(x * 100)}%`);

function renderRecordBar(deck) {
  const r = store.deckRecord(deck.id);
  $("#record-bar").innerHTML = `
    <div class="record">
      ${r.total ? `<strong>${r.wins}–${r.losses}</strong><small>${pctText(r.rate)} wins · ${r.total} game${r.total === 1 ? "" : "s"}</small>` : `<strong>No games yet</strong><small>Log your results to track this deck</small>`}
    </div>
    <button class="btn sm win" data-log="win">${icon("trophy")}Won</button>
    <button class="btn sm loss" data-log="loss">${icon("x")}Lost</button>`;
}

$("#record-bar").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-log]");
  if (btn) openGameDialog(btn.dataset.log);
});

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function openGameDialog(result) {
  const f = $("#game-form");
  f.reset();
  f.elements.result.value = result;
  f.elements.players.value = savedSort("mtg-pod-size", "4");
  f.elements.date.value = todayLocal();
  $("#game-dialog-title").textContent = `Log a game · ${deckLabel(openDeckId)}`;
  $("#game-dialog").showModal();
}

$("#game-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const f = e.target;
  const players = Number(f.elements.players.value) || 4;
  saveSort("mtg-pod-size", String(players));
  const result = f.elements.result.value;
  store.logGame(openDeckId, {
    result,
    players,
    notes: f.elements.notes.value,
    playedAt: new Date(`${f.elements.date.value}T12:00`).toISOString(),
  });
  $("#game-dialog").close();
  toast(result === "win" ? "Win logged. Nice!" : "Loss logged", result === "win" ? "trophy" : "check");
  renderDeckPage();
});

function renderGames(deck) {
  const r = store.deckRecord(deck.id);
  if (!r.total) {
    $("#deck-games").innerHTML = `<div class="empty">No games logged yet. Tap <strong>Won</strong> or <strong>Lost</strong> above after a game.</div>`;
    return;
  }
  const last10 = r.games.slice(0, 10).reverse(); // oldest first, so the newest is on the right
  $("#deck-games").innerHTML = `
    <div class="stats">
      <div class="stat"><span class="stat-label">Win rate</span><strong class="accent">${pctText(r.rate)}</strong><span class="stat-label">vs ${pctText(r.expected)} expected by chance</span></div>
      <div class="stat"><span class="stat-label">Record</span><strong>${r.wins}–${r.losses}</strong><span class="stat-label">${r.total} game${r.total === 1 ? "" : "s"}</span></div>
    </div>
    <div class="panel">
      <h2>Last ${last10.length}</h2>
      <div class="last10" aria-label="Last ${last10.length} results, oldest first">${last10.map((g) => `<span class="${g.result === "win" ? "w" : "l"}" title="${new Date(g.played_at).toLocaleDateString()}">${g.result === "win" ? "W" : "L"}</span>`).join("")}</div>
    </div>
    <ul class="games-list">
      ${r.games
        .map(
          (g) => `<li>
            <span class="res ${g.result === "win" ? "w" : "l"}">${icon(g.result === "win" ? "trophy" : "x")}</span>
            <div class="g-info">
              <strong>${g.result === "win" ? "Win" : "Loss"}</strong>
              <small>${new Date(g.played_at).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })} · ${g.players}-player</small>
              ${g.notes ? `<div class="g-notes">${esc(g.notes)}</div>` : ""}
            </div>
            <button class="btn icon-only ghost danger" data-delete-game="${g.id}" aria-label="Delete this game" title="Delete this game">${icon("trash")}</button>
          </li>`,
        )
        .join("")}
    </ul>`;
}

$("#deck-games").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-delete-game]");
  if (!btn || !confirm("Delete this game from the log?")) return;
  store.deleteGame(btn.dataset.deleteGame);
  renderDeckPage();
});

async function renderRating(deck) {
  const el = $("#deck-rating");
  const names = store.deckCardList(deck.id);
  if (!names.length) return (el.innerHTML = "");
  let lists = scryfall.bracketListsIfLoaded();
  if (!lists) {
    el.innerHTML = `<div class="panel rating"><div class="loading">${icon("loader", "spin")}Rating deck…</div></div>`;
    lists = await scryfall.bracketLists().catch(() => null);
    if (openDeckId !== deck.id) return;
    if (!lists) return (el.innerHTML = `<div class="commander-hint">${icon("alert")}<span>Couldn't load the Game Changers list. Try again later.</span></div>`);
  }
  const r = estimateBracket(names, lists);
  const levelIcon = { ok: "check", info: "alert", warn: "alert" };
  el.innerHTML = `
    <div class="panel rating">
      <div class="rating-head">
        <div class="bracket-badge"><small>Bracket</small><strong>${r.bracket}</strong></div>
        <div>
          <div class="rating-title">${r.label}</div>
          <div class="rating-sub">Estimated Commander bracket</div>
        </div>
      </div>
      <div class="bracket-scale">${[1, 2, 3, 4, 5].map((b) => `<span class="${b <= r.bracket ? "on" : ""}"></span>`).join("")}</div>
      <div class="bracket-scale-labels">${[1, 2, 3, 4, 5].map((b) => `<span class="${b === r.bracket ? "on" : ""}">${BRACKETS[b]}</span>`).join("")}</div>
      <ul class="rating-reasons">${r.reasons.map((x) => `<li class="${x.level}">${icon(levelIcon[x.level])}<span>${esc(x.text)}</span></li>`).join("")}</ul>
      ${r.gameChangers.length ? `<div class="tags">${r.gameChangers.map((n) => `<span class="tag gc">${esc(n)}</span>`).join("")}</div>` : ""}
      <p class="attribution">Two-card combos aren't checked here; <a href="https://commanderspellbook.com/find-my-combos/" target="_blank" rel="noopener">check them on Commander Spellbook</a>. Brackets are a starting point for the pregame chat: Exhibition vs Core and Optimized vs cEDH come down to intent and speed.</p>
    </div>`;
}

document.querySelector(".segmented").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-tab]");
  if (!btn) return;
  deckTab = btn.dataset.tab;
  renderDeckPage();
});

$("#deck-scan").addEventListener("click", () => {
  setDestination(openDeckId);
  showView("scan");
  startCamera({ ask: false });
});
$("#deck-cards").addEventListener("click", () => {
  place = openDeckId;
  typeFilter = "all";
  showView("collection");
});

// Where you already own a card, e.g. "Extras" or "Merfolk".
function ownedSummary(name, deckId) {
  const elsewhere = store.ownedCopies(name).filter((e) => e.deck_id !== deckId);
  if (!elsewhere.length) return null;
  const places = [...new Set(elsewhere.map((e) => deckLabel(e.deck_id)))];
  return { entries: elsewhere, label: `You own ${elsewhere.length > 1 ? `${elsewhere.length} · ` : ""}${places.join(", ")}` };
}

// Move one owned copy into the deck, preferring one sitting in Extras.
function moveOwnedHere(name, deckId) {
  const owned = ownedSummary(name, deckId);
  if (!owned) return;
  const copy = owned.entries.find((e) => !store.getDeck(e.deck_id)) ?? owned.entries[0];
  const from = deckLabel(copy.deck_id);
  store.moveCopies([copy.id], deckId);
  toast(`Moved ${name} from ${from}`);
}

const pct = (x) => `${Math.round(x * 100)}%`;

async function renderUpgrades(deck) {
  const el = $("#deck-upgrades");
  const cmdrs = store.getCommanders(deck.id);
  if (!cmdrs.length) {
    el.innerHTML = `<div class="commander-hint">${icon("crown")}<span>Set a commander to get upgrade ideas. Tap <strong>View cards</strong>, open a legendary card and choose <strong>Make commander</strong>.</span></div>`;
    return;
  }
  if (!el.dataset.deck || el.dataset.deck !== deck.id) el.innerHTML = `<div class="loading">${icon("loader", "spin")}Loading recommendations…</div>`;
  el.dataset.deck = deck.id;

  let recs;
  try {
    recs = await edhrec.recommendations(cmdrs.map((c) => c.card.name));
  } catch (err) {
    el.innerHTML = `<div class="commander-hint">${icon("alert")}<span>${esc(err.message)}</span></div>`;
    return;
  }
  if (openDeckId !== deck.id || deckTab !== "upgrades") return;

  const inDeck = store.deckCardNames(deck.id);
  const commanderNames = new Set(cmdrs.map((c) => edhrec.nameKey(c.card.name)));
  let list = recs.cards.filter((c) => !inDeck.has(edhrec.nameKey(c.name)) && !commanderNames.has(edhrec.nameKey(c.name)));
  if (recState.filter === "top") list.sort((a, b) => b.inclusion + b.synergy - (a.inclusion + a.synergy));
  else list = list.filter((c) => c.category === recState.filter).sort((a, b) => b.inclusion - a.inclusion);
  if (recState.ownedOnly) list = list.filter((c) => ownedSummary(c.name, deck.id));

  // Images and prices come from Scryfall, 75 cards per request. Sorting by
  // price needs every suggestion's price, not just the visible ones.
  const priceSort = recState.sort.startsWith("price");
  const needed = priceSort ? list : list.slice(0, recState.shown);
  const missing = needed.map((c) => c.id).filter((id) => id && !recDetails.has(id));
  if (missing.length > 75) el.innerHTML = `<div class="loading">${icon("loader", "spin")}Loading prices…</div>`;
  if (missing.length) {
    el.querySelector(".rec-list")?.classList.add("loading-more");
    const cards = await scryfall.fetchMany(missing).catch(() => []);
    cards.forEach((c) => recDetails.set(c.id, c));
    if (openDeckId !== deck.id || deckTab !== "upgrades") return;
  }
  const recPrice = (c) => {
    const sc = recDetails.get(c.id);
    return sc ? store.unitPrice(scryfall.toCardRecord(sc), false) : null;
  };
  if (priceSort) list = sortBy(list, recState.sort, { price: recPrice, name: (c) => c.name, added: () => null });
  const shown = list.slice(0, recState.shown);

  const chips = [["top", "Top picks"], ...recs.categories.map((c) => [c, c])];
  el.innerHTML = `
    <div class="chips rec-chips">${chips.map(([id, label]) => `<button class="chip small ${recState.filter === id ? "active" : ""}" data-filter="${esc(id)}">${esc(label)}</button>`).join("")}</div>
    <div class="toolbar">
      <label class="switch"><input type="checkbox" id="owned-only" ${recState.ownedOnly ? "checked" : ""}><span class="track"></span>Only cards I own</label>
      <select id="rec-sort" class="sort" aria-label="Sort suggestions">
        ${[["best", "Best match"], ["price-desc", "$ High–Low"], ["price-asc", "$ Low–High"]].map(([v, l]) => `<option value="${v}" ${recState.sort === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <ul class="card-list rec-list">
      ${
        shown.length
          ? shown
              .map((c) => {
                const sc = recDetails.get(c.id);
                const rec = sc ? scryfall.toCardRecord(sc) : null;
                const owned = ownedSummary(c.name, deck.id);
                const wished = store.onWishlist(deck.id, c.name);
                return `<li data-name="${esc(c.name)}">
                  <img src="${esc(rec?.image_small ?? "")}" alt="" loading="lazy">
                  <div class="info">
                    <div class="name">${esc(c.name)}</div>
                    <div class="meta">${rec ? `${manaCost(rec.mana_cost)} ${esc(rec.type_line)}` : ""}</div>
                    <div class="rec-stats"><span>In <b>${pct(c.inclusion)}</b> of decks</span>${c.synergy > 0.01 ? `<span><b>+${pct(c.synergy)}</b> synergy</span>` : ""}</div>
                    <div class="tags">
                      ${c.gameChanger ? `<span class="tag warn">Game Changer</span>` : ""}
                      ${owned ? `<span class="tag owned">${icon("check")}${esc(owned.label)}</span>` : ""}
                    </div>
                  </div>
                  <div class="price">${money(rec ? store.unitPrice(rec, false) : null)}</div>
                  <div class="actions">
                    ${owned ? `<button class="btn sm primary" data-move-here>${icon("swords")}Move here</button>` : ""}
                    <button class="btn sm ${wished ? "on" : ""}" data-wish>${icon("bookmark")}${wished ? "On wishlist" : "Wishlist"}</button>
                    ${rec?.tcgplayer_url ? `<a class="btn sm" href="${esc(rec.tcgplayer_url)}" target="_blank" rel="noopener">${icon("external")}TCGplayer</a>` : ""}
                  </div>
                </li>`;
              })
              .join("")
          : `<li class="empty">${recState.ownedOnly ? "None of these are in your collection yet." : "Nothing left to suggest here. Nice deck!"}</li>`
      }
    </ul>
    <div class="list-foot">
      ${list.length > shown.length ? `<button class="btn" data-more>Show more (${list.length - shown.length})</button>` : ""}
      <div class="attribution">Recommendations from <a href="https://edhrec.com/commanders/${edhrec.slug(cmdrs[0].card.name)}" target="_blank" rel="noopener">EDHREC</a> · prices from TCGplayer via Scryfall</div>
    </div>`;
}

$("#deck-upgrades").addEventListener("click", (e) => {
  const deckId = openDeckId;
  const chip = e.target.closest("[data-filter]");
  if (chip) {
    Object.assign(recState, { filter: chip.dataset.filter, shown: 25 });
    return renderDeckPage();
  }
  if (e.target.closest("[data-more]")) {
    recState.shown += 25;
    return renderDeckPage();
  }
  const row = e.target.closest("li[data-name]");
  if (!row) return;
  const name = row.dataset.name;
  if (e.target.closest("[data-move-here]")) {
    moveOwnedHere(name, deckId);
  } else if (e.target.closest("[data-wish]")) {
    if (store.onWishlist(deckId, name)) store.removeFromWishlist(deckId, name);
    else {
      const card = [...recDetails.values()].find((c) => c.name === name);
      if (!card) return;
      store.addToWishlist(deckId, card);
      toast(`Added ${name} to wishlist`, "bookmark");
    }
  } else return;
  renderDeckPage();
});
$("#deck-upgrades").addEventListener("change", (e) => {
  if (e.target.id === "owned-only") Object.assign(recState, { ownedOnly: e.target.checked, shown: 25 });
  else if (e.target.id === "rec-sort") {
    Object.assign(recState, { sort: e.target.value, shown: 25 });
    saveSort("mtg-rec-sort", e.target.value);
  } else return;
  renderDeckPage();
});

function renderWishlist(deck) {
  const wishSort = savedSort("mtg-wish-sort", "newest");
  const items = sortBy(store.getWishlist(deck.id), wishSort, { price: (w) => store.unitPrice(w, false), name: (w) => w.name, added: (w) => w.added_at });
  const total = items.reduce((sum, w) => sum + (Number(w.price_usd) || 0), 0);
  $("#deck-wishlist").innerHTML = `
    <div class="wish-head">
      <div class="total"><strong>${money(total)}</strong>${items.length} card${items.length === 1 ? "" : "s"} to get</div>
      <select id="wish-sort" class="sort" aria-label="Sort wishlist">
        ${[["newest", "Newest"], ["price-desc", "$ High–Low"], ["price-asc", "$ Low–High"], ["name", "A–Z"]].map(([v, l]) => `<option value="${v}" ${wishSort === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
      <button class="btn primary" data-add-wish>${icon("plus")}Add card</button>
    </div>
    <ul class="card-list">
      ${
        items.length
          ? items
              .map((w) => {
                const owned = ownedSummary(w.name, deck.id);
                return `<li data-name="${esc(w.name)}">
                  <img src="${esc(w.image_small)}" alt="" loading="lazy">
                  <div class="info">
                    <div class="name">${esc(w.name)}</div>
                    <div class="meta">${manaCost(w.mana_cost)} ${esc(w.type_line)}</div>
                    <div class="tags">${owned ? `<span class="tag owned">${icon("check")}${esc(owned.label)}</span>` : ""}</div>
                  </div>
                  <div class="price">${money(store.unitPrice(w, false))}</div>
                  <div class="actions">
                    ${owned ? `<button class="btn sm primary" data-move-here>${icon("swords")}Move here</button>` : ""}
                    ${w.tcgplayer_url ? `<a class="btn sm" href="${esc(w.tcgplayer_url)}" target="_blank" rel="noopener">${icon("external")}TCGplayer</a>` : ""}
                    <button class="btn sm" data-unwish>${icon("x")}Remove</button>
                  </div>
                </li>`;
              })
              .join("")
          : `<li class="empty">Nothing on the wishlist yet. Add cards from <strong>Upgrades</strong> or tap <strong>Add card</strong>.</li>`
      }
    </ul>
    ${items.length ? `<p class="attribution">Cards leave the wishlist automatically when you scan or move a copy into this deck.</p>` : ""}`;
}

$("#deck-wishlist").addEventListener("change", (e) => {
  if (e.target.id !== "wish-sort") return;
  saveSort("mtg-wish-sort", e.target.value);
  renderDeckPage();
});

$("#deck-wishlist").addEventListener("click", (e) => {
  const deckId = openDeckId;
  if (e.target.closest("[data-add-wish]")) {
    return openSearch({
      title: "Add to wishlist",
      note: `For <strong>${esc(deckLabel(deckId))}</strong>`,
      onPick: async (name) => {
        const card = await scryfall.fuzzyNamed(name).catch(() => null);
        if (!card) return toast("Couldn't find that card", "alert");
        store.addToWishlist(deckId, card);
        searchDialog.close();
        toast(`Added ${card.name} to wishlist`, "bookmark");
        renderDeckPage();
      },
    });
  }
  const row = e.target.closest("li[data-name]");
  if (!row) return;
  if (e.target.closest("[data-move-here]")) moveOwnedHere(row.dataset.name, deckId);
  else if (e.target.closest("[data-unwish]")) store.removeFromWishlist(deckId, row.dataset.name);
  else return;
  renderDeckPage();
});

// ---------- Start ----------
if (restoredFromLink) setTimeout(() => toast("Settings restored from your setup link"), 300);
renderRecent();
updateSyncPill();
scryfall.bracketLists().then(() => $("#view-collection").classList.contains("active") && renderCollection(), () => {});
syncNow().then(async () => {
  // Cards scanned before mana value / type were stored: fill in their details.
  const missing = store.idsMissingDetails();
  if (missing.length) store.updatePrices(await scryfall.fetchMany(missing).catch(() => []));
});
