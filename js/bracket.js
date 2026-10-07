// Estimates a deck's Commander bracket from its cards, following the official
// Commander Brackets (Feb 2026 update):
//   Game Changers: none in 1-2, up to 3 in 3, unlimited in 4-5
//   Mass land denial: only in 4-5
//   Extra turns: chaining only in 4-5
//   Two-card infinite combos: none in 1-2, not before turn 6 in 3
// Bracket 1 vs 2 and 4 vs 5 depend on intent and speed, which cards can't
// show, so a deck with nothing flagged is rated 2 and anything above 3 is 4.
export const BRACKETS = { 1: "Exhibition", 2: "Core", 3: "Upgraded", 4: "Optimized", 5: "cEDH" };

// How many extra-turn cards make chaining them likely.
const CHAIN_RISK = 3;

export function estimateBracket(cardNames, lists) {
  const names = [...new Set(cardNames)];
  const gameChangers = names.filter((n) => lists.gameChangers.has(n)).sort();
  const extraTurns = names.filter((n) => lists.extraTurns.has(n)).sort();
  const massLandDenial = names.filter((n) => lists.massLandDenial.has(n)).sort();

  let bracket = 2;
  const reasons = [];
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  if (gameChangers.length === 0) reasons.push({ level: "ok", text: "No Game Changers" });
  else if (gameChangers.length <= 3) {
    bracket = Math.max(bracket, 3);
    reasons.push({ level: "info", text: `${plural(gameChangers.length, "Game Changer")}. Bracket 3 allows up to 3.` });
  } else {
    bracket = 4;
    reasons.push({ level: "warn", text: `${plural(gameChangers.length, "Game Changer")}. More than 3 means Bracket 4.` });
  }

  if (massLandDenial.length) {
    bracket = 4;
    reasons.push({ level: "warn", text: `Mass land denial (${massLandDenial.join(", ")}) is only for Bracket 4+.` });
  } else reasons.push({ level: "ok", text: "No mass land denial" });

  if (extraTurns.length >= CHAIN_RISK) {
    bracket = 4;
    reasons.push({ level: "warn", text: `${plural(extraTurns.length, "extra-turn card")}. Chaining extra turns is for Bracket 4+.` });
  } else if (extraTurns.length) {
    reasons.push({ level: "info", text: `${plural(extraTurns.length, "extra-turn card")} (${extraTurns.join(", ")}). Fine below Bracket 4 if you don't chain them.` });
  } else reasons.push({ level: "ok", text: "No extra-turn cards" });

  return { bracket, label: BRACKETS[bracket], gameChangers, extraTurns, massLandDenial, reasons };
}
