// Free "database": the collection is saved as collection.json in a private
// GitHub repo, so every sync is a commit and you get full history for free.
//
// Uses GitHub's Git data API (blobs, trees, commits, refs) — the same
// machinery as `git push` — rather than the simpler "contents" endpoint,
// which caps reads at 1 MB and has had outages where every write fails.
import * as store from "./store.js";

const FILE = "collection.json";

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
  let message = `GitHub ${res.status}: ${detail}`;
  if (res.status === 401) message = "GitHub token is invalid or was deleted. Create a new one and paste it in Settings.";
  else if (res.status === 403) message = "GitHub token can't write to the repo. Edit the token: Repository permissions → Contents → Read and write.";
  else if (res.status === 404) message = "Repo not found. Check the repo name, and that the token has access to it.";
  else if (res.status >= 500) message = `GitHub is having trouble (error ${res.status}). Your cards are safe on this device; sync will retry.`;
  return Object.assign(new Error(message), { status: res.status });
}

async function gh(settings, method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${settings.githubRepo}${path}`, {
    method,
    cache: "no-store",
    headers: {
      Authorization: `Bearer ${settings.githubToken}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body && JSON.stringify(body),
  });
  if (!res.ok) throw await githubError(res);
  return res.json();
}

// The branch tip, its tree, and the current collection.json (if any).
async function readRemote(settings) {
  const { default_branch: branch } = await gh(settings, "GET", "");
  let ref;
  try {
    ref = await gh(settings, "GET", `/git/ref/heads/${branch}`);
  } catch (err) {
    if (err.status === 409 || err.status === 404) return { branch, empty: true, remote: null }; // repo has no commits yet
    throw err;
  }
  const head = ref.object.sha;
  const commit = await gh(settings, "GET", `/git/commits/${head}`);
  const tree = await gh(settings, "GET", `/git/trees/${commit.tree.sha}`);
  const entry = tree.tree.find((t) => t.path === FILE);
  const remote = entry ? JSON.parse(fromBase64((await gh(settings, "GET", `/git/blobs/${entry.sha}`)).content)) : null;
  return { branch, head, treeSha: commit.tree.sha, blobSha: entry?.sha, remote };
}

// A brand-new repo with no commits can't take Git data writes; create the
// first commit through the contents endpoint instead.
async function createFirstCommit(settings, content, message) {
  await gh(settings, "PUT", `/contents/${FILE}`, { message, content: toBase64(content) });
}

export async function sync(settings) {
  if (!settings.githubToken || !settings.githubRepo) throw new Error("GitHub isn't set up yet (see Settings)");

  for (let attempt = 0; attempt < 3; attempt++) {
    const changesAtStart = store.changeCount;
    const r = await readRemote(settings);
    const merged = store.merge(store.snapshot(), r.remote);
    const content = JSON.stringify(merged);
    const message = `Update collection (${merged.inventory.length} cards)`;

    if (r.empty) {
      await createFirstCommit(settings, content, message);
      store.applySynced(merged, changesAtStart);
      return;
    }

    const blob = await gh(settings, "POST", "/git/blobs", { content: toBase64(content), encoding: "base64" });
    if (blob.sha !== r.blobSha) {
      const tree = await gh(settings, "POST", "/git/trees", {
        base_tree: r.treeSha,
        tree: [{ path: FILE, mode: "100644", type: "blob", sha: blob.sha }],
      });
      const commit = await gh(settings, "POST", "/git/commits", { message, tree: tree.sha, parents: [r.head] });
      try {
        await gh(settings, "PATCH", `/git/refs/heads/${r.branch}`, { sha: commit.sha, force: false });
      } catch (err) {
        // 422: another device committed first (not a fast-forward); merge again.
        if (err.status === 422) continue;
        throw err;
      }
    }
    store.applySynced(merged, changesAtStart);
    return;
  }
  throw new Error("Sync kept conflicting; try again");
}

// Checks the repo is reachable, then does a real sync, which is the only way
// to be sure the token can write (GitHub reports the account's access, not the token's).
export async function testConnection(settings) {
  const repo = await gh(settings, "GET", "");
  await sync(settings);
  return repo;
}
