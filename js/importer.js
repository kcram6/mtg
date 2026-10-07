// Parses a pasted decklist (Moxfield, Archidekt, MTGO/Arena-style text) into
// { qty, name, set, number, commander } lines.
//   1 Sol Ring
//   1x Sol Ring (C21) 263 *F*
//   1 Atraxa, Praetors' Voice *CMDR*
//   Commander            <- section headers; cards under it are commanders
//   1 Swords to Plowshares [Removal]
const SECTION = /^(?:\/\/\s*)?(commanders?|deck|main ?(?:board|deck)?|sideboard|maybe ?board|considering|tokens?|companion)\s*(?:\(\d+\))?:?$/i;
const SKIPPED_SECTIONS = /^(sideboard|maybe ?board|considering|tokens?)$/i;
const LINE = /^(\d+)\s*x?\s+(.+?)$/i;

export function parseDecklist(text) {
  const cards = [];
  const skipped = [];
  let section = "deck";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const header = line.match(SECTION);
    if (header) {
      section = header[1].toLowerCase().replace(/\s/g, "");
      continue;
    }
    if (line.startsWith("//")) continue;
    if (SKIPPED_SECTIONS.test(section)) continue;

    const m = line.match(LINE);
    if (!m) {
      skipped.push(line);
      continue;
    }
    let rest = m[2];
    const commander = section.startsWith("commander") || /\*CMDR\*/i.test(rest);
    rest = rest
      .replace(/\s*\*[A-Z]+\*/gi, "") // *CMDR*, *F* (foil) and similar markers
      .replace(/\s*\[[^\]]*\]/g, "") // [Category] tags
      .replace(/\s*\^[^^]*\^/g, "") // ^Tag^ markers
      .trim();
    const printing = rest.match(/^(.+?)\s+\(([A-Za-z0-9]{2,6})\)(?:\s+([\w★-]+))?$/);
    const name = (printing ? printing[1] : rest).trim();
    if (!name) continue;
    cards.push({
      qty: Number(m[1]),
      name,
      set: printing?.[2]?.toLowerCase() ?? null,
      number: printing?.[3] ?? null,
      commander,
    });
  }
  return { cards, skipped };
}
