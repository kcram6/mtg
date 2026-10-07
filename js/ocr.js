// Free, on-device text recognition with Tesseract.js (loaded from a <script>
// tag as the global `Tesseract`). The first use downloads ~10 MB of language
// data, which the browser then caches.
let workerPromise = null;

function getWorker() {
  workerPromise ??= Tesseract.createWorker("eng");
  return workerPromise;
}

// Start loading in the background so the first scan isn't slow.
export function warmUp() {
  getWorker().catch(() => {});
}

// mode "line" for a single line of text (card name), "block" for several lines.
export async function readText(canvas, mode = "line") {
  const worker = await getWorker();
  await worker.setParameters({ tessedit_pageseg_mode: mode === "line" ? "7" : "6" });
  const { data } = await worker.recognize(canvas);
  return { text: data.text.trim(), confidence: data.confidence };
}

// Crop a region of the card (given as fractions of its width/height), upscale,
// convert to high-contrast grayscale, and invert if the text is light-on-dark.
export function cropForOcr(cardCanvas, { x0, x1, y0, y1 }, targetHeight) {
  const sx = cardCanvas.width * x0, sy = cardCanvas.height * y0;
  const sw = cardCanvas.width * (x1 - x0), sh = cardCanvas.height * (y1 - y0);
  const scale = targetHeight / sh;

  const out = document.createElement("canvas");
  out.width = Math.round(sw * scale);
  out.height = Math.round(targetHeight);
  const ctx = out.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(cardCanvas, sx, sy, sw, sh, 0, 0, out.width, out.height);

  const img = ctx.getImageData(0, 0, out.width, out.height);
  const px = img.data;
  let min = 255, max = 0, sum = 0;
  const gray = new Uint8ClampedArray(px.length / 4);
  for (let i = 0; i < gray.length; i++) {
    const g = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    gray[i] = g;
    min = Math.min(min, g);
    max = Math.max(max, g);
    sum += g;
  }
  const invert = sum / gray.length < 110; // dark title bar -> light text
  const range = Math.max(1, max - min);
  for (let i = 0; i < gray.length; i++) {
    let v = ((gray[i] - min) / range) * 255;
    if (invert) v = 255 - v;
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
