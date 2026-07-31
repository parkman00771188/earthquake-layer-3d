/**
 * The rolling event list: the N most recent earthquakes at or before the
 * playhead, newest first, honouring the active magnitude/depth filters and the
 * selected period.
 *
 * Because the arrays are time-sorted, "most recent N" is just a backward walk
 * from the end of the draw range -- no sorting or searching. Rebuilds are gated
 * on the newest included index so scrubbing does not thrash the DOM.
 */

import { DEPTH_STOPS, MAG_STOPS, rampColor } from './palette.js';

const pad = (n) => String(n).padStart(2, '0');

export class EventFeed {
  constructor({ root, list, empty, countEl, toggle, layer, data, onPick, limit = 50 }) {
    this.root = root;
    this.list = list;
    this.empty = empty;
    this.countEl = countEl;
    this.layer = layer;
    this.data = data;
    this.onPick = onPick;
    this.limit = limit;

    this.lastKey = '';
    this.indices = [];
    this.selected = null;

    toggle.addEventListener('click', () => this.setOpen(root.classList.contains('collapsed')));

    // One delegated handler for every row, present and future.
    list.addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (li) this.onPick(+li.dataset.i);
    });
  }

  setOpen(open) {
    this.root.classList.toggle('collapsed', !open);
    if (open) this.render(true);
    this.onToggle?.(open);
  }

  get isOpen() { return !this.root.classList.contains('collapsed'); }

  setSelected(index) {
    this.selected = index;
    for (const li of this.list.children) {
      li.classList.toggle('on', +li.dataset.i === index);
    }
  }

  /** Collect the newest `limit` drawn events, newest first. */
  collect() {
    const { mag, depth } = this.data.events;
    const [lo, hi] = this.layer.range;
    const { mLo, mHi, dLo, dHi } = this.layer.bounds();

    const out = [];
    for (let i = hi - 1; i >= lo && out.length < this.limit; i--) {
      const m = mag[i];
      if (m < mLo || m > mHi) continue;
      const d = depth[i];
      if (d < dLo || d > dHi) continue;
      out.push(i);
    }
    return out;
  }

  render(force = false) {
    if (!this.isOpen) return;

    const next = this.collect();
    // The head index plus the count identify the window cheaply.
    const key = `${next[0] ?? -1}:${next.length}`;
    if (!force && key === this.lastKey) return;
    this.lastKey = key;
    this.indices = next;

    this.countEl.textContent = next.length
      ? `${next.length}${next.length >= this.limit ? '+' : ''}건`
      : '0건';

    if (!next.length) {
      this.list.replaceChildren();
      this.empty.hidden = false;
      return;
    }
    this.empty.hidden = true;

    const { mag, depth } = this.data.events;
    const rows = next.map((i) => {
      const d = this.data.dateAt(i);
      const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
        + ` ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
      const place = this.data.placeOf(i);
      return `<li data-i="${i}"${i === this.selected ? ' class="on"' : ''}>`
        + `<span class="f-mag" style="--c:${rampColor(MAG_STOPS, mag[i])}">`
        + `${mag[i].toFixed(1)}</span>`
        + `<span class="f-main"><span class="f-time">${stamp}</span>`
        + `<span class="f-place">${escapeHtml(place)}</span></span>`
        + `<span class="f-depth"><i style="background:${rampColor(DEPTH_STOPS, depth[i])}"></i>`
        + `${Math.round(depth[i])}<em>km</em></span>`
        + '</li>';
    });
    this.list.innerHTML = rows.join('');
  }
}

/**
 * Renders the "what changed in the last update" list from data/changes.json.
 * Separate from EventFeed because the entries are pre-resolved server-side and
 * carry field-level diffs rather than live catalogue state.
 */
export class ChangeFeed {
  constructor({ root, summary, list, toggle, onPick }) {
    this.root = root;
    this.summary = summary;
    this.list = list;
    this.onPick = onPick;
    this.data = null;

    toggle.addEventListener('click', () => {
      const open = root.classList.toggle('open');
      toggle.textContent = open ? '접기' : '내역 보기';
    });
    list.addEventListener('click', (ev) => {
      const li = ev.target.closest('li[data-i]');
      if (li) this.onPick(+li.dataset.i);
    });
  }

  setData(changes) {
    this.data = changes;
    if (!changes?.available) {
      this.summary.textContent = '갱신 기록이 없습니다 (아직 update를 실행하지 않음).';
      this.root.classList.add('quiet');
      return;
    }

    const c = changes.counts ?? {};
    const when = (changes.run_utc ?? '').replace('T', ' ').slice(0, 16);
    // A bulk scan lists no individual additions -- a million rows is not news.
    if (changes.initial_import && !(changes.revised ?? []).length) {
      this.summary.textContent =
        `${when} UTC · 전체 수집 ${fmt(c.added)}건 (개별 목록 없음)`;
      this.root.classList.add('quiet');
      return;
    }

    const parts = [`신규 ${fmt(c.added)}건`, `수정 ${fmt(c.revised)}건`];
    if (c.removed) parts.push(`대체 ${fmt(c.removed)}건`);
    if (c.metadata_only) parts.push(`메타데이터만 ${fmt(c.metadata_only)}건`);
    this.summary.textContent = `${when} UTC · ${parts.join(' · ')}`;

    const rows = [];
    for (const e of changes.added ?? []) {
      rows.push(this.row(e, 'new', '신규'));
    }
    for (const e of changes.revised ?? []) {
      const diff = Object.entries(e.fields ?? {})
        .map(([k, [a, b]]) => `<span class="c-diff"><b>${FIELD_KO[k] ?? k}</b> `
          + `${escapeHtml(String(a)) || '–'} → ${escapeHtml(String(b)) || '–'}</span>`)
        .join('');
      rows.push(this.row(e, 'rev', '수정', diff));
    }

    this.list.innerHTML = rows.join('')
      || '<li class="c-none">변경된 지진이 없습니다.</li>';
    if (changes.truncated) {
      this.list.innerHTML += '<li class="c-none">목록이 길어 일부만 표시했습니다. '
        + '전체는 <code>update.bat --changes</code>.</li>';
    }
    this.root.classList.remove('quiet');
  }

  row(e, cls, tag, extra = '') {
    return `<li data-i="${e.i}" class="c-${cls}">`
      + `<span class="c-tag">${tag}</span>`
      + `<span class="c-mag">M${Number(e.mag).toFixed(1)}</span>`
      + `<span class="c-when">${(e.time ?? '').replace('T', ' ').slice(0, 16)}</span>`
      + `<span class="c-place">${escapeHtml(e.place ?? '')}</span>`
      + extra
      + '</li>';
  }
}

const FIELD_KO = {
  mag: '규모', depth: '깊이', latitude: '위도', longitude: '경도',
  time: '발생시각', magType: '규모종류', place: '지명',
};

const fmt = (n) => (n ?? 0).toLocaleString('ko-KR');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
