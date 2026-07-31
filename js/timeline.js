/**
 * The scrubbable timeline: a log-scaled monthly event histogram that doubles as
 * the seek bar. The played span is drawn bright, the future dim, and in rolling
 * window mode the active window is shaded so you can see what is on screen.
 */

const DAY_MS = 86400000;

export const MIN_SPAN_DAYS = 7;

export class Timeline {
  constructor({ track, canvas, head, gripA, gripB, meta, epochMs, totalDays,
                onSeek, onRange }) {
    this.track = track;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.head = head;
    this.gripA = gripA;
    this.gripB = gripB;
    this.epochMs = epochMs;
    this.totalDays = totalDays;
    this.onSeek = onSeek;
    this.onRange = onRange;

    this.now = 0;
    this.windowDays = null;
    this.range = [0, totalDays];

    const h = meta.histogram ?? { counts: [] };
    this.setHistogram(h, false);

    // Year gridlines: every 5 years across the catalogue span.
    const y0 = h.start_year ?? 1975;
    const yEnd = new Date(epochMs + totalDays * DAY_MS).getUTCFullYear();
    this.years = [];
    for (let y = Math.ceil(y0 / 5) * 5; y <= yEnd; y += 5) {
      this.years.push({ year: y, d: (Date.UTC(y, 0, 1) - epochMs) / DAY_MS });
    }

    this.bindDrag();
    this.observeSize();
  }

  /* ── geometry ─────────────────────────────────────────────── */

  frac(days) { return Math.min(1, Math.max(0, days / this.totalDays)); }

  observeSize() {
    const resize = () => {
      const r = this.track.getBoundingClientRect();
      this.w = Math.max(1, Math.round(r.width));
      this.h = Math.max(1, Math.round(r.height));
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.paint();
    };
    new ResizeObserver(resize).observe(this.track);
    resize();
  }

  /* ── interaction ──────────────────────────────────────────── */

  /** Pointer x -> days since epoch, clamped to the catalogue. */
  daysAt(clientX) {
    const r = this.track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    return f * this.totalDays;
  }

  bindDrag() {
    // Seeking on the track itself.
    const seek = (ev) => this.onSeek(this.daysAt(ev.clientX));
    this.track.addEventListener('pointerdown', (ev) => {
      if (ev.target !== this.track && ev.target !== this.canvas) return;   // a grip
      this.track.setPointerCapture(ev.pointerId);
      this.dragging = true;
      seek(ev);
    });
    this.track.addEventListener('pointermove', (ev) => { if (this.dragging) seek(ev); });
    const stop = (ev) => {
      this.dragging = false;
      if (this.track.hasPointerCapture?.(ev.pointerId)) this.track.releasePointerCapture(ev.pointerId);
    };
    this.track.addEventListener('pointerup', stop);
    this.track.addEventListener('pointercancel', stop);

    // Dragging either end of the period.
    const bindGrip = (grip, edge) => {
      grip.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation();
        grip.setPointerCapture(ev.pointerId);
        grip.classList.add('dragging');
        this.gripEdge = edge;
      });
      grip.addEventListener('pointermove', (ev) => {
        if (this.gripEdge !== edge) return;
        const d = this.daysAt(ev.clientX);
        const [a, b] = this.range;
        this.onRange(edge === 0
          ? [Math.min(d, b - MIN_SPAN_DAYS), b]
          : [a, Math.max(d, a + MIN_SPAN_DAYS)]);
      });
      const end = (ev) => {
        this.gripEdge = null;
        grip.classList.remove('dragging');
        if (grip.hasPointerCapture?.(ev.pointerId)) grip.releasePointerCapture(ev.pointerId);
      };
      grip.addEventListener('pointerup', end);
      grip.addEventListener('pointercancel', end);
    };
    if (this.gripA) bindGrip(this.gripA, 0);
    if (this.gripB) bindGrip(this.gripB, 1);
  }

  /* ── paint ────────────────────────────────────────────────── */

  set(nowDays, windowDays, range) {
    this.now = nowDays;
    this.windowDays = windowDays;
    if (range) this.range = range;
    this.head.style.left = `${(this.frac(nowDays) * 100).toFixed(3)}%`;
    if (this.gripA) this.gripA.style.left = `${(this.frac(this.range[0]) * 100).toFixed(3)}%`;
    if (this.gripB) this.gripB.style.left = `${(this.frac(this.range[1]) * 100).toFixed(3)}%`;
    this.paint();
  }

  paint() {
    const { ctx, w, h } = this;
    if (!w) return;
    ctx.clearRect(0, 0, w, h);

    const pad = 13;                       // room for the year strip
    const plot = h - pad;
    const norm = Math.log1p(this.maxCount);
    const headX = this.frac(this.now) * w;
    const [rA, rB] = this.range;

    // Rolling-window shading.
    if (this.windowDays != null) {
      const x0 = this.frac(Math.max(rA, this.now - this.windowDays)) * w;
      ctx.fillStyle = 'rgba(53,214,245,.09)';
      ctx.fillRect(x0, 0, Math.max(1, headX - x0), plot);
    }

    // Histogram bars. Three tiers: outside the selected period, inside but not
    // yet played, and played.
    for (const b of this.bins) {
      if (b.count === 0) continue;
      const x = this.frac(b.d0) * w;
      const bw = Math.max(0.9, this.frac(b.d1) * w - x);
      const bh = Math.max(1, (Math.log1p(b.count) / norm) * (plot - 3));
      const outside = b.d1 <= rA || b.d0 >= rB;
      ctx.fillStyle = outside
        ? 'rgba(120,140,168,.13)'
        : b.d0 < this.now
          ? 'rgba(53,214,245,.75)'
          : 'rgba(150,175,205,.24)';
      ctx.fillRect(x, plot - bh, bw, bh);
    }

    // Dim the excluded spans so the period reads at a glance.
    ctx.fillStyle = 'rgba(5,7,13,.5)';
    const xA = this.frac(rA) * w;
    const xB = this.frac(rB) * w;
    if (xA > 0) ctx.fillRect(0, 0, xA, plot);
    if (xB < w) ctx.fillRect(xB, 0, w - xB, plot);

    // Baseline.
    ctx.fillStyle = 'rgba(140,165,200,.22)';
    ctx.fillRect(0, plot - 0.5, w, 1);

    // Year ticks + labels.
    ctx.font = '9px ui-monospace, Consolas, monospace';
    ctx.textBaseline = 'bottom';
    for (const y of this.years) {
      const x = this.frac(y.d) * w;
      ctx.fillStyle = 'rgba(140,165,200,.16)';
      ctx.fillRect(x, 0, 1, plot);
      ctx.fillStyle = 'rgba(120,140,168,.85)';
      ctx.textAlign = x < 18 ? 'left' : x > w - 18 ? 'right' : 'center';
      ctx.fillText(String(y.year), Math.min(Math.max(x, 1), w - 1), h - 2);
    }

    // Source handoff: the detection threshold changes here, so the bar height
    // drops for reasons that have nothing to do with seismicity.
    if (this.handoffDays != null) {
      const x = this.frac(this.handoffDays) * w;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(192,132,252,.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, plot);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Mark where the catalogue switches source (days since epoch). */
  setHandoff(days) {
    this.handoffDays = days;
    this.paint();
  }

  /** Swap the monthly histogram (the seek bar serves both catalogues). */
  setHistogram(histogram, repaint = true) {
    const h = histogram ?? { counts: [] };
    this.bins = h.counts.map((count, i) => {
      const y = h.start_year + Math.floor((h.start_month - 1 + i) / 12);
      const m = (h.start_month - 1 + i) % 12;
      return {
        count,
        d0: (Date.UTC(y, m, 1) - this.epochMs) / DAY_MS,
        d1: (Date.UTC(m === 11 ? y + 1 : y, (m + 1) % 12, 1) - this.epochMs) / DAY_MS,
      };
    });
    this.maxCount = Math.max(1, ...this.bins.map((b) => b.count));
    if (repaint) this.paint();
  }
}
