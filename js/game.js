// Life counter for 2-4 players: life, commander damage, poison, commander tax,
// monarch and initiative. Players can play one of your decks (its commander's
// art becomes their background, and the result is logged to that deck).
// The game is saved as you play, so closing the app doesn't lose it.
import * as store from "./store.js";
import * as scryfall from "./scryfall.js";

const KEY = "mtg-game";
let ui = null; // { icon, esc, toast, onLogged }
let game = null;
let wakeLock = null;

const $ = (sel) => document.querySelector(sel);
const save = () => {
  try {
    game ? localStorage.setItem(KEY, JSON.stringify(game)) : localStorage.removeItem(KEY);
  } catch {}
};

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

// ---------- Rules ----------
const isOut = (p) => p.life <= 0 || p.poison >= 10 || Object.values(p.cmdDmg).some((d) => d >= 21);
const outReason = (p) =>
  p.life <= 0 ? "Out of life" : p.poison >= 10 ? "10 poison" : Object.values(p.cmdDmg).some((d) => d >= 21) ? "21 commander damage" : "";

function commanderOf(deckId) {
  return store.getDeck(deckId) ? store.getCommanders(deckId)[0]?.card : null;
}

// ---------- Setup (Play tab) ----------
let seatCount = 4;

export function renderSetup() {
  const decks = store.getDecks();
  const saved = load();
  $("#resume-game").innerHTML = saved
    ? `<div class="panel resume">
        <div><strong>Game in progress</strong><small>${saved.players.map((p) => ui.esc(p.name)).join(", ")} · started ${new Date(saved.startedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div>
        <button class="btn primary" data-resume>${ui.icon("heart")}Resume</button>
      </div>`
    : "";
  document.querySelectorAll("#seat-count .chip").forEach((c) => c.classList.toggle("active", Number(c.dataset.n) === seatCount));

  const previous = [...document.querySelectorAll("#player-setup .player-row")].map((row) => ({
    name: row.querySelector("input").value,
    deck: row.querySelector("select").value,
  }));
  $("#player-setup").innerHTML = Array.from({ length: seatCount }, (_, i) => {
    const prev = previous[i];
    const name = prev?.name ?? (i === 0 ? "You" : `Player ${i + 1}`);
    const deck = prev?.deck ?? "";
    return `<div class="player-row">
      <span class="seat-dot seat-${i}">${i + 1}</span>
      <input value="${ui.esc(name)}" aria-label="Player ${i + 1} name" autocomplete="off">
      <select aria-label="Player ${i + 1} deck">
        <option value="">Guest deck</option>
        ${decks.map((d) => `<option value="${d.id}" ${d.id === deck ? "selected" : ""}>${ui.esc(d.name)}</option>`).join("")}
      </select>
    </div>`;
  }).join("");
}

function startGame() {
  const life = Number($("#start-life").value) || 40;
  const players = [...document.querySelectorAll("#player-setup .player-row")].map((row, i) => ({
    name: row.querySelector("input").value.trim() || `Player ${i + 1}`,
    deckId: row.querySelector("select").value || null,
    life,
    poison: 0,
    casts: 0, // times the commander was cast from the command zone (tax = 2 each)
    cmdDmg: {}, // damage taken from each other player's commander, by seat
  }));
  game = { players, startingLife: life, monarch: null, initiative: null, startedAt: new Date().toISOString() };
  save();
  openTable();
}

// ---------- Table ----------
function openTable() {
  $("#table").hidden = false;
  document.body.classList.add("playing");
  renderTable();
  requestWakeLock();
}

function closeTable() {
  $("#table").hidden = true;
  document.body.classList.remove("playing");
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  renderSetup();
}

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && game && !$("#table").hidden) requestWakeLock();
});

function renderTable() {
  const n = game.players.length;
  $("#table-grid").className = `table-grid seats-${n}`;
  $("#table-grid").innerHTML = game.players
    .map((p, i) => {
      const cmdr = commanderOf(p.deckId);
      const art = cmdr ? `style="--art:url('${scryfall.artCrop(cmdr)}')"` : "";
      // Seats across the table face the other way.
      const flip = (n === 2 && i === 0) || (n === 3 && i < 2) || (n === 4 && i < 2);
      const maxCmd = Math.max(0, ...Object.values(p.cmdDmg));
      return `<div class="seat seat-${i} ${flip ? "flip" : ""} ${isOut(p) ? "out" : ""}" data-i="${i}" ${art}>
        <div class="seat-art"></div>
        <button class="half minus" data-delta="-1" aria-label="${ui.esc(p.name)} loses 1 life"></button>
        <button class="half plus" data-delta="1" aria-label="${ui.esc(p.name)} gains 1 life"></button>
        <div class="seat-body">
          <div class="seat-head">
            <span class="seat-name">${ui.esc(p.name)}</span>
            ${game.monarch === i ? `<span class="badge-pill">${ui.icon("crown")}Monarch</span>` : ""}
            ${game.initiative === i ? `<span class="badge-pill">${ui.icon("trending")}Initiative</span>` : ""}
          </div>
          <div class="life-wrap"><span class="sign">−</span><span class="life">${p.life}</span><span class="sign">+</span></div>
          <div class="delta" data-delta-for="${i}"></div>
          <div class="out-label">${outReason(p)}</div>
          <button class="seat-counters" data-counters="${i}">
            <span title="Poison">☠ ${p.poison}</span>
            <span title="Commander tax">Tax +${p.casts * 2}</span>
            <span title="Most commander damage taken from one commander">Cmdr ${maxCmd}</span>
          </button>
        </div>
      </div>`;
    })
    .join("");
}

// Running total of recent changes, e.g. "−7", fading after a pause.
const deltas = {};
function showDelta(i, change) {
  const d = (deltas[i] ??= { total: 0, timer: null });
  d.total += change;
  clearTimeout(d.timer);
  d.timer = setTimeout(() => {
    d.total = 0;
    const el = document.querySelector(`[data-delta-for="${i}"]`);
    if (el) el.textContent = "";
  }, 1600);
  const el = document.querySelector(`[data-delta-for="${i}"]`);
  if (el) el.textContent = d.total > 0 ? `+${d.total}` : d.total < 0 ? `−${-d.total}` : "";
}

function changeLife(i, change) {
  const p = game.players[i];
  p.life += change;
  save();
  const seat = document.querySelector(`.seat[data-i="${i}"]`);
  seat.querySelector(".life").textContent = p.life;
  seat.classList.toggle("out", isOut(p));
  seat.querySelector(".out-label").textContent = outReason(p);
  showDelta(i, change);
}

// Tap = ±1; hold to keep counting (faster after a moment).
let holdTimer = null;
function startHold(i, step) {
  changeLife(i, step);
  let count = 0;
  const tick = () => {
    changeLife(i, step);
    count++;
    holdTimer = setTimeout(tick, count > 10 ? 60 : 140);
  };
  holdTimer = setTimeout(tick, 450);
}
const stopHold = () => clearTimeout(holdTimer);

// ---------- Counters sheet (poison, tax, commander damage, monarch, initiative) ----------
let countersFor = null;

function openCounters(i) {
  countersFor = i;
  renderCounters();
  // Players across the table get the sheet at their edge, facing them.
  const flipped = document.querySelector(`.seat[data-i="${i}"]`)?.classList.contains("flip");
  $("#counters-dialog").classList.toggle("flipped", !!flipped);
  $("#counters-dialog").showModal();
}

function renderCounters() {
  const i = countersFor;
  const p = game.players[i];
  const step = (field, label, value, sub) => `<div class="counter-row">
      <div><strong>${label}</strong>${sub ? `<small>${sub}</small>` : ""}</div>
      <button class="btn icon-only" data-step="${field}" data-by="-1" aria-label="Decrease ${label}">−</button>
      <span class="counter-value">${value}</span>
      <button class="btn icon-only" data-step="${field}" data-by="1" aria-label="Increase ${label}">+</button>
    </div>`;
  $("#counters-title").textContent = p.name;
  $("#counters-body").innerHTML = `
    ${step("poison", "Poison", p.poison, p.poison >= 10 ? "10 or more: out" : "Out at 10")}
    ${step("casts", "Commander tax", `+${p.casts * 2}`, `Cast from the command zone ${p.casts} time${p.casts === 1 ? "" : "s"}`)}
    <h2 class="counters-sub">Commander damage taken</h2>
    ${game.players
      .map((o, j) => {
        if (j === i) return "";
        const cmdr = commanderOf(o.deckId);
        const dmg = p.cmdDmg[j] ?? 0;
        return step(`cmd:${j}`, ui.esc(o.name), dmg, `${cmdr ? ui.esc(cmdr.name.split(",")[0]) + " · " : ""}${dmg >= 21 ? "21 or more: out" : "also changes life"}`);
      })
      .join("")}
    <div class="counter-toggles">
      <button class="btn ${game.monarch === i ? "on" : ""}" data-toggle="monarch">${ui.icon("crown")}${game.monarch === i ? "Is the monarch" : "Make monarch"}</button>
      <button class="btn ${game.initiative === i ? "on" : ""}" data-toggle="initiative">${ui.icon("trending")}${game.initiative === i ? "Has the initiative" : "Take initiative"}</button>
    </div>`;
}

function stepCounter(field, by) {
  const p = game.players[countersFor];
  if (field === "poison") p.poison = Math.max(0, p.poison + by);
  else if (field === "casts") p.casts = Math.max(0, p.casts + by);
  else if (field.startsWith("cmd:")) {
    const from = field.slice(4);
    const before = p.cmdDmg[from] ?? 0;
    const after = Math.max(0, before + by);
    p.cmdDmg[from] = after;
    p.life -= after - before; // commander damage is also life loss
  }
  save();
  renderCounters();
  renderTable();
}

// ---------- Game menu / ending ----------
function endGame(winner) {
  const logged = [];
  if (winner !== null) {
    game.players.forEach((p, i) => {
      if (!store.getDeck(p.deckId)) return;
      store.logGame(p.deckId, {
        result: i === winner ? "win" : "loss",
        players: game.players.length,
        notes: `Life counter: ${game.players[winner].name} won`,
      });
      logged.push(store.getDeck(p.deckId).name);
    });
  }
  game = null;
  save();
  $("#end-dialog").close();
  closeTable();
  ui.toast(logged.length ? `Logged to ${logged.join(", ")}` : "Game ended", logged.length ? "trophy" : "check", 4000);
  ui.onLogged?.();
}

// ---------- Wiring ----------
export function initGame(helpers) {
  ui = helpers;
  game = load();

  $("#seat-count").addEventListener("click", (e) => {
    const chip = e.target.closest("[data-n]");
    if (!chip) return;
    seatCount = Number(chip.dataset.n);
    renderSetup();
  });
  $("#start-game").addEventListener("click", () => {
    if (load() && !confirm("Start a new game? The game in progress will be discarded.")) return;
    startGame();
  });
  $("#resume-game").addEventListener("click", (e) => {
    if (!e.target.closest("[data-resume]")) return;
    game = load();
    if (game) openTable();
  });

  const grid = $("#table-grid");
  grid.addEventListener("pointerdown", (e) => {
    const half = e.target.closest("[data-delta]");
    if (!half) return;
    e.preventDefault();
    startHold(Number(half.closest(".seat").dataset.i), Number(half.dataset.delta));
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => grid.addEventListener(ev, stopHold));
  grid.addEventListener("contextmenu", (e) => e.preventDefault());
  grid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-counters]");
    if (btn) openCounters(Number(btn.dataset.counters));
  });

  $("#counters-body").addEventListener("click", (e) => {
    const stepBtn = e.target.closest("[data-step]");
    if (stepBtn) return stepCounter(stepBtn.dataset.step, Number(stepBtn.dataset.by));
    const toggle = e.target.closest("[data-toggle]");
    if (!toggle) return;
    const key = toggle.dataset.toggle; // "monarch" or "initiative"
    game[key] = game[key] === countersFor ? null : countersFor;
    save();
    renderCounters();
    renderTable();
  });

  $("#table-menu").addEventListener("click", () => $("#menu-dialog").showModal());
  $("#menu-dialog").addEventListener("click", (e) => {
    const act = e.target.closest("[data-menu]")?.dataset.menu;
    if (!act) return;
    $("#menu-dialog").close();
    if (act === "exit") closeTable();
    else if (act === "reset" && confirm("Reset everyone to the starting life and clear all counters?")) {
      game.players.forEach((p) => Object.assign(p, { life: game.startingLife, poison: 0, casts: 0, cmdDmg: {} }));
      Object.assign(game, { monarch: null, initiative: null });
      save();
      renderTable();
    } else if (act === "end") {
      $("#end-body").innerHTML =
        game.players
          .map((p, i) => `<li><button data-winner="${i}"><span class="seat-dot seat-${i}">${i + 1}</span><span class="opt-name">${ui.esc(p.name)}</span>${store.getDeck(p.deckId) ? `<span class="opt-count">${ui.esc(store.getDeck(p.deckId).name)}</span>` : ""}</button></li>`)
          .join("") + `<li><button data-winner="none"><span class="opt-name muted">No result (don't log)</span></button></li>`;
      $("#end-dialog").showModal();
    }
  });
  $("#end-body").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-winner]");
    if (btn) endGame(btn.dataset.winner === "none" ? null : Number(btn.dataset.winner));
  });

  renderSetup();
}
