// Camera + automatic capture. Watches the card-shaped guide on screen and
// fires `onCapture(cardCanvas)` once a new card has been held still.
const CARD_RATIO = 63 / 88; // width / height of a Magic card
const SAMPLE_W = 24, SAMPLE_H = 34; // tiny grayscale thumbnail used for motion detection
const STILL = 6; // avg pixel change below this = holding steady
const MOVED = 25; // avg pixel change above this = card swapped / big movement
const DIFFERENT = 14; // how different from the last scan a scene must be to scan again
const STILL_FRAMES = 4; // ~0.6s of steadiness at the tick rate below
const TICK_MS = 150;

export class Scanner {
  constructor({ container, video, guide, onCapture, onStatus }) {
    Object.assign(this, { container, video, guide, onCapture, onStatus });
    this.auto = true;
    this.busy = false;
    this.stream = null;
    this.sampleCanvas = Object.assign(document.createElement("canvas"), { width: SAMPLE_W, height: SAMPLE_H });
    this.reset();
    new ResizeObserver(() => this.layoutGuide()).observe(container);
  }

  reset() {
    this.prev = null;
    this.stillCount = 0;
    this.lastScanned = null; // sample of the last scene we scanned
    this.movedSinceScan = true;
    this.emptyScenes = []; // backgrounds where no card was found, so we don't re-scan them
  }

  async start() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    this.layoutGuide();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.reset();
  }

  get running() {
    return !!this.stream;
  }

  layoutGuide() {
    const cw = this.container.clientWidth, ch = this.container.clientHeight;
    let h = ch * 0.85, w = h * CARD_RATIO;
    if (w > cw * 0.85) [w, h] = [cw * 0.85, (cw * 0.85) / CARD_RATIO];
    Object.assign(this.guide.style, { width: `${w}px`, height: `${h}px` });
  }

  // The guide's rectangle in video pixel coordinates (the video uses object-fit: cover).
  guideInVideo() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    const c = this.container.getBoundingClientRect(), g = this.guide.getBoundingClientRect();
    const scale = Math.max(c.width / vw, c.height / vh);
    const ox = (vw * scale - c.width) / 2, oy = (vh * scale - c.height) / 2;
    return { x: (g.left - c.left + ox) / scale, y: (g.top - c.top + oy) / scale, w: g.width / scale, h: g.height / scale };
  }

  sample() {
    const r = this.guideInVideo();
    const ctx = this.sampleCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, SAMPLE_W, SAMPLE_H);
    const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    const gray = new Float32Array(SAMPLE_W * SAMPLE_H);
    for (let i = 0; i < gray.length; i++) gray[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    return gray;
  }

  static diff(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
    return sum / a.length;
  }

  tick() {
    if (!this.video.videoWidth) return;
    const cur = this.sample();
    const motion = this.prev ? Scanner.diff(cur, this.prev) : 255;
    this.prev = cur;

    if (motion > MOVED) this.movedSinceScan = true;
    this.stillCount = motion < STILL ? this.stillCount + 1 : 0;

    if (this.busy || !this.auto) return;
    if (this.stillCount < STILL_FRAMES) {
      if (motion >= STILL) this.onStatus("Hold the card steady inside the frame");
      return;
    }
    const isNew =
      this.movedSinceScan &&
      (!this.lastScanned || Scanner.diff(cur, this.lastScanned) > DIFFERENT) &&
      !this.emptyScenes.some((s) => Scanner.diff(cur, s) < DIFFERENT);
    if (isNew) this.capture(cur);
  }

  // Grab the area inside the guide at full camera resolution and hand it off.
  async capture(sample = this.sample()) {
    if (this.busy) return;
    this.busy = true;
    this.lastScanned = sample;
    this.movedSinceScan = false;
    const r = this.guideInVideo();
    const card = document.createElement("canvas");
    card.width = Math.round(r.w);
    card.height = Math.round(r.h);
    card.getContext("2d").drawImage(this.video, r.x, r.y, r.w, r.h, 0, 0, card.width, card.height);
    try {
      const found = await this.onCapture(card);
      if (!found) {
        this.emptyScenes.push(sample);
        if (this.emptyScenes.length > 5) this.emptyScenes.shift();
      }
    } finally {
      this.busy = false;
    }
  }
}
