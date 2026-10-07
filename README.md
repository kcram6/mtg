# MTG Collection

A phone-friendly web app for tracking a Magic: The Gathering collection. Point your phone's camera at a card and it's logged automatically, along with its TCGplayer price.

Everything runs in the browser and is hosted free on GitHub Pages. There's no server.

## How it works

| Piece | What it does | Cost |
|---|---|---|
| **Camera scanning** | Hold a card inside the on-screen frame. When it's steady, the app reads it and logs it with a beep and a green flash. Then show the next card. | Free |
| **Free OCR** ([Tesseract.js](https://tesseract.projectnaptha.com/)) | Reads the card name and the set code and collector number on your phone, then matches them against every Magic card name. | Free |
| **Claude Haiku fallback** | Used only when the free OCR can't read a card (old frames, heavy glare, unusual layouts). | About 0.2¢ per card it handles |
| **[Scryfall](https://scryfall.com/docs/api)** | Card data, images and USD prices. Scryfall's prices come from TCGplayer and update daily. | Free |
| **[EDHREC](https://edhrec.com)** | Upgrade suggestions for each deck's commander: the most-played and highest-synergy cards. | Free |
| **GitHub sync** | Your collection is saved as `collection.json` in a private GitHub repo, so every sync is a commit with full history. | Free |

If the app can't tell which printing a card is (common with older cards that have no set code), it logs the most likely regular printing and marks it **printing guessed**. Tap **Change printing** to pick the right one.

## One-time setup

### 1. Host the app (GitHub Pages)
1. Push this folder to a GitHub repo, for example `mtg`.
2. In the repo, go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, then select `main` and `/ (root)`.
3. After about a minute the app is live at `https://<your-username>.github.io/mtg/`. Open it on your phone, and use **Share → Add to Home Screen** to make it feel like an app.

### 2. Create the data repo
Create a **private** repo, for example `mtg-data`. It can be empty; the app creates `collection.json` on the first sync.

### 3. Create a GitHub token
At **GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token**:
- Repository access: **Only select repositories** → `mtg-data`
- Permissions: **Contents → Read and write**

### 4. (Optional) Add an Anthropic API key for the AI fallback
In the [Anthropic Console](https://console.anthropic.com/), create a key, then set a **monthly spend limit** (for example $5) under Billing as a safety net.

### 5. Fill in the app's Settings tab
Enter the data repo (`your-username/mtg-data`), the GitHub token and, optionally, the API key, then tap **Save** and **Test GitHub**.

The token and key are stored **only in that browser** (localStorage). They're never in the code or the repo.

### 6. Save a setup link
In Settings, tap **Copy link** (or **Share to…**) under **Setup link** and save it in the Passwords app or Notes. If the browser ever clears the app's data, open that link: your settings come back, and your cards reload from GitHub. The settings live after the `#` in the link, which browsers never send to any server, but anyone holding the link can use your keys, so keep it private.

Tip: on iPhone, use the app from the **Home Screen**. Safari clears data for websites that haven't been visited in 7 days, but Home Screen apps are exempt.

## Tips for scanning
- Good, even lighting, with no glare across the name bar or bottom-left corner.
- Fill the frame with the card.
- Set the **Foil** toggle before scanning a run of foils.
- Before scanning, choose where the cards go: an existing deck, a new deck, or Extras / Uncategorized.
- Scanning the same card twice in a row is treated as an accident and isn't logged again. Tap **+1** on the card to add a real second copy.
- Tokens scan like any other card and are filed under the **Token** type (they're left out of mana curves).
- If a card won't scan, tap **Can't scan it? Search by name**, pick the card, then pick its printing.
- Sync happens automatically about 20 seconds after your last scan, or tap the sync pill at the top.

## Running locally
Any static file server works, for example:
```sh
python3 -m http.server 8000
```
Then open http://localhost:8000. The camera works on `localhost`. On a phone you need the HTTPS GitHub Pages URL.

## Roadmap
- [x] Camera scanning, collection and prices
- [x] Decks: choose a deck (or Extras) before scanning, move cards, rename/delete decks
- [x] Card types and mana values, with type filters and a mana curve per deck
- [x] Commanders: mark a deck's commander (or two partners), see its color identity, flag cards outside it
- [x] Decks tab: deck tiles with commander art; per-deck upgrade suggestions from EDHREC (flagging cards you already own) and a wishlist
