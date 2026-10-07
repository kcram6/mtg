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

// ---------- Settings ----------
const SETTINGS_KEY = "mtg-settings";
let settings = { readerMode: "free-first", anthropicKey: "", githubRepo: "", githubToken: "", ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") };

const form = $("#settings-form");
for (const [k, v] of Object.entries(settings)) if (form.elements[k]) form.elements[k].value = v;

form.addEventListener("submit", (e) => {
  e.preventDefault();
  settings = { ...settings, ...Object.fromEntries(new FormData(form)) };
  settings.githubRepo = settings.githubRepo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  resetClient();
  $("#settings-msg").textContent = "Saved.";
  syncNow();
});

$("#test-github").addEventListener("click", async () => {
  const msg = $("#settings-msg");
  msg.textContent = "Checking…";
  try {
    const repo = await github.testConnection({ ...settings, ...Object.fromEntries(new FormData(form)) });
    msg.textContent = `✅ Connected to ${repo.full_name}${repo.private ? " (private)" : " — warning: this repo is public"}`;
  } catch (err) {
    msg.textContent = `❌ ${err.message}`;
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
  document.querySelectorAll("nav button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  if (name !== "scan" && scanner.running) stopCamera();
  if (name === "collection") renderCollection();
}
document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showView(b.dataset.view)));

function toast(text, ms = 3000) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------- GitHub sync ----------
let syncing = false, syncTimer = null;
const configured = () => settings.githubRepo && settings.githubToken;

function renderSyncStatus(state, text) {
  const pill = $("#sync-status");
  pill.className = `pill ${state}`;
  pill.textContent = text;
}

function updateSyncPill() {
  if (syncing) return;
  if (!configured()) return renderSyncStatus("pending", "Sync off");
  if (store.changeCount > 0) renderSyncStatus("pending", `${store.changeCount} unsynced`);
  else renderSyncStatus("ok", "Synced ✓");
}

async function syncNow() {
  if (!configured() || syncing) return updateSyncPill();
  syncing = true;
  renderSyncStatus("pending", "Syncing…");
  try {
    await github.sync(settings);
    syncing = false;
    updateSyncPill();
    if ($("#view-collection").classList.contains("active")) renderCollection();
  } catch (err) {
    syncing = false;
    renderSyncStatus("error", "Sync failed");
    toast(err.message, 5000);
  }
}

// Batch scans into one commit: sync 20s after the last change.
store.onChange(() => {
  updateSyncPill();
  clearTimeout(syncTimer);
  if (store.changeCount > 0) syncTimer = setTimeout(syncNow, 20000);
});
$("#sync-status").addEventListener("click", syncNow);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && store.changeCount > 0) syncNow();
});

// ---------- Sounds ----------
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
  const f = $("#flash"), g = $("#guide");
  f.className = kind;
  g.className = kind;
  requestAnimationFrame(() => requestAnimationFrame(() => (f.className = "")));
  setTimeout(() => (g.className = ""), 900);
}

// ---------- Scanning ----------
const recent = []; // this session's scans, newest first
const setStatus = (text) => ($("#camera-status").textContent = text);

const scanner = new Scanner({
  container: $("#camera"),
  video: $("#video"),
  guide: $("#guide"),
  onStatus: setStatus,
  onCapture: handleCapture,
});

async function handleCapture(cardCanvas) {
  $("#guide").className = "busy";
  setStatus("Reading card…");
  try {
    const result = await recognizeCard(cardCanvas, { mode: settings.readerMode, apiKey: settings.anthropicKey });
    if (result.status !== "found") {
      flash("bad");
      beep(false);
      setStatus(
        settings.anthropicKey
          ? "No card recognized. Fill the frame with the card and avoid glare."
          : "No card recognized. Adjust the card and tap Scan now (or add an API key in Settings for AI backup).",
      );
      return false;
    }
    const foil = $("#foil").checked;
    const entry = store.addCopy(result.card, { foil });
    recent.unshift({ entryId: entry.id, via: result.via, exact: result.exact, undone: false });
    flash("ok");
    beep(true);
    setStatus(`✅ ${scryfall.frontName(result.card)} logged. Next card!`);
    renderRecent();
    return true;
  } catch (err) {
    flash("bad");
    beep(false);
    setStatus(`Error: ${err.message}`);
    return true; // don't treat as an empty scene; the user can tap Scan now to retry
  }
}

async function startCamera() {
  audio ??= new AudioContext();
  warmUpOcr();
  scryfall.cardNames().catch(() => {}); // preload the name list used for matching
  try {
    await scanner.start();
    $("#start-camera").hidden = true;
    setStatus("Hold a card inside the frame");
  } catch (err) {
    setStatus(`Camera unavailable: ${err.message}`);
  }
}

function stopCamera() {
  scanner.stop();
  $("#start-camera").hidden = false;
  setStatus("Camera paused");
}

$("#start-camera").addEventListener("click", startCamera);
$("#auto").addEventListener("change", (e) => (scanner.auto = e.target.checked));
$("#scan-now").addEventListener("click", () => (scanner.running ? scanner.capture() : startCamera()));

function renderRecent() {
  const live = recent.filter((r) => !r.undone).length;
  $("#session-count").textContent = live ? `(${live} this session)` : "";
  $("#recent").innerHTML = recent
    .map((r, i) => {
      const entry = store.getEntry(r.entryId);
      if (!entry && !r.undone) return "";
      const card = store.getCard(entry?.scryfall_id) ?? r.card;
      r.card = card; // keep for display after undo
      const price = store.unitPrice(card, entry?.foil ?? r.foil);
      return `
        <li class="${r.undone ? "undone" : ""}">
          <img src="${esc(card.image_small)}" alt="" loading="lazy">
          <div class="info">
            <div class="name">${esc(card.name)}${entry?.foil ? '<span class="badge foil">foil</span>' : ""}</div>
            <div class="meta">${esc(card.set_name)} · #${esc(card.collector_number)}
              ${r.exact ? "" : '<span class="badge warn">printing guessed</span>'}
              <span class="badge">${r.via === "ai" ? "AI" : "free OCR"}</span></div>
            ${r.undone ? "" : `<div class="actions">
              <button data-undo="${i}">Undo</button>
              <button data-reprint="${i}">Change printing</button>
              <button data-foil="${i}">${entry.foil ? "Not foil" : "Foil"}</button>
            </div>`}
          </div>
          <div class="price">${money(price)}</div>
        </li>`;
    })
    .join("");
}

$("#recent").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const r = recent[btn.dataset.undo ?? btn.dataset.reprint ?? btn.dataset.foil];
  const entry = store.getEntry(r.entryId);
  if (btn.dataset.undo) {
    r.foil = entry.foil;
    store.removeCopy(r.entryId);
    r.undone = true;
    renderRecent();
  } else if (btn.dataset.reprint) {
    pickPrinting(store.getCard(entry.scryfall_id).name, (card) => {
      store.changePrinting([r.entryId], card);
      r.exact = true;
      renderRecent();
    });
  } else if (btn.dataset.foil) {
    store.setFoil(r.entryId, !entry.foil);
    renderRecent();
  }
});

// ---------- Printing picker ----------
const dialog = $("#printing-dialog");
$("#close-dialog").addEventListener("click", () => dialog.close());

async function pickPrinting(name, onPick) {
  const grid = $("#printing-grid");
  grid.innerHTML = '<p class="muted">Loading printings…</p>';
  dialog.showModal();
  const prints = await scryfall.printings(name);
  grid.innerHTML = prints
    .map((p, i) => {
      const img = p.image_uris?.small ?? p.card_faces?.[0]?.image_uris?.small;
      return `<button data-i="${i}"><img src="${esc(img)}" alt="" loading="lazy">
        <span>${esc(p.set_name)}</span><span class="muted">${esc(p.set.toUpperCase())} #${esc(p.collector_number)} · ${p.prices.usd ? "$" + p.prices.usd : p.prices.usd_foil ? "$" + p.prices.usd_foil + " foil" : "—"}</span></button>`;
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
function renderCollection() {
  const { rows, totalCards, totalValue } = store.getCollection();
  $("#total-cards").textContent = totalCards;
  $("#total-value").textContent = money(totalValue);

  const q = $("#search").value.trim().toLowerCase();
  const shown = q
    ? rows.filter((r) => `${r.card.name} ${r.card.set_name} ${r.card.type_line}`.toLowerCase().includes(q))
    : rows;

  $("#collection").innerHTML = shown.length
    ? shown
        .map((r, i) => `
      <li>
        <img src="${esc(r.card.image_small)}" alt="" loading="lazy">
        <div class="info">
          <div class="name"><span class="qty">${r.entryIds.length}×</span>${esc(r.card.name)}${r.foil ? '<span class="badge foil">foil</span>' : ""}</div>
          <div class="meta">${esc(r.card.set_name)} · #${esc(r.card.collector_number)} · ${esc(r.card.rarity)}</div>
          <div class="actions">
            <button data-remove="${i}">Remove one</button>
            <button data-reprint="${i}">Change printing</button>
            ${r.card.tcgplayer_url ? `<a href="${esc(r.card.tcgplayer_url)}" target="_blank" rel="noopener">TCGplayer ↗</a>` : ""}
          </div>
        </div>
        <div class="price">${money(r.unitPrice)}<div class="meta">${r.entryIds.length > 1 ? money((r.unitPrice ?? 0) * r.entryIds.length) : ""}</div></div>
      </li>`)
        .join("")
    : `<p class="muted">${rows.length ? "No matches." : "No cards yet. Head to Scan to add some!"}</p>`;

  $("#collection").onclick = (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    const r = shown[btn.dataset.remove ?? btn.dataset.reprint];
    if (btn.dataset.remove) {
      store.removeOneOf(r.card.scryfall_id, r.foil);
      renderCollection();
    } else {
      pickPrinting(r.card.name, (card) => {
        store.changePrinting(r.entryIds, card);
        renderCollection();
      });
    }
  };
}
$("#search").addEventListener("input", renderCollection);

$("#refresh-prices").addEventListener("click", async (e) => {
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Refreshing…";
  try {
    store.updatePrices(await scryfall.fetchMany(store.ownedScryfallIds()));
    renderCollection();
    toast("Prices updated from TCGplayer (via Scryfall)");
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Refresh prices";
  }
});

// ---------- Start ----------
updateSyncPill();
syncNow(); // pull the latest from GitHub on open
