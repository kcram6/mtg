// Free "database": the collection is saved as collection.json in a private
// GitHub repo, so every sync is a commit and you get full history for free.
import * as store from "./store.js";

const FILE = "collection.json";

function request(settings, method, body) {
  return fetch(`https://api.github.com/repos/${settings.githubRepo}/contents/${FILE}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${settings.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body && JSON.stringify(body),
  });
}

const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const fromBase64 = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, "")), (c) => c.charCodeAt(0)));

// Turn GitHub's errors into something actionable.
async function githubError(res) {
  const detail = (await res.json().catch(() => ({}))).message ?? "";
  if (res.status === 401) return new Error("GitHub token is invalid or was deleted. Create a new one and paste it in Settings.");
  if (res.status === 403) return new Error("GitHub token can't write to the repo. Edit the token: Repository permissions → Contents → Read and write.");
  if (res.status === 404) return new Error("Repo not found. Check the repo name, and that the token has access to it.");
  return new Error(`GitHub ${res.status}: ${detail}`);
}

async function fetchRemote(settings) {
  const res = await request(settings, "GET");
  if (res.status === 404) return { remote: null, sha: undefined };
  if (!res.ok) throw await githubError(res);
  const file = await res.json();
  return { remote: JSON.parse(fromBase64(file.content)), sha: file.sha };
}

export async function sync(settings) {
  if (!settings.githubToken || !settings.githubRepo) throw new Error("GitHub isn't set up yet (see Settings)");

  for (let attempt = 0; attempt < 3; attempt++) {
    const changesAtStart = store.changeCount;
    const { remote, sha } = await fetchRemote(settings);
    const merged = store.merge(store.snapshot(), remote);

    const res = await request(settings, "PUT", {
      message: `Update collection (${merged.inventory.length} cards)`,
      content: toBase64(JSON.stringify(merged, null, 1)),
      sha,
    });
    if (res.ok) {
      store.applySynced(merged, changesAtStart);
      return;
    }
    // 409/422: someone else (another device) updated the file first; merge again.
    if (res.status !== 409 && res.status !== 422) throw await githubError(res);
  }
  throw new Error("Sync kept conflicting; try again");
}

// Checks the repo is reachable, then does a real sync, which is the only way
// to be sure the token can write (GitHub reports the account's access, not the token's).
export async function testConnection(settings) {
  const res = await fetch(`https://api.github.com/repos/${settings.githubRepo}`, {
    headers: { Authorization: `Bearer ${settings.githubToken}`, Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw await githubError(res);
  const repo = await res.json();
  await sync(settings);
  return repo;
}
