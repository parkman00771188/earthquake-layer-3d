/**
 * 일본 주변 지진 4D — application entry point.
 *
 * Wires the data payload, the three.js scene, the timeline and the control panel
 * together. Rendering is on-demand: a frame is drawn while playing, while the
 * camera moves, or whenever a control changes.
 */

import * as THREE from 'three';
import { OrbitControls } from '../vendor/OrbitControls.js';

import { loadData, loadChanges } from './data.js';
import { makeProjection, SCALE } from './projection.js';
import { QuakeLayer, MAG_SIZE_DEFAULTS } from './quakeLayer.js';
import { RefLayer } from './refLayer.js';
import { AxisLabels } from './labels.js';
import { Timeline, MIN_SPAN_DAYS } from './timeline.js';
import { Picker } from './picking.js';
import { SelectionMarker } from './marker.js';
import { EventFeed, ChangeFeed } from './feed.js';
import * as store from './store.js';
import {
  DEPTH_STOPS, MAG_STOPS, TIME_STOPS, cssGradient,
} from './palette.js';
import {
  LANGS, applyI18n, detectLang, fmtDate, fmtDays, getLang, numFmt, setLang, t,
} from './i18n.js';

const $ = (id) => document.getElementById(id);
let nf = new Intl.NumberFormat('ko-KR');

/** Rolling-window lengths, as [days, label]. The slider indexes this list so
 *  every stop is a round number instead of an artefact of the step size. */
const WINDOW_PRESETS = [
  [7, '1주'], [14, '2주'], [30, '1개월'], [90, '3개월'], [180, '6개월'],
  [270, '9개월'], [365, '1년'], [730, '2년'], [1825, '5년'],
  [3650, '10년'], [7300, '20년'],
];

/** Panel controls whose raw value is persisted verbatim. */
const SAVED_INPUTS = [
  'in-window', 'in-fade', 'in-glow',
  'in-mag-lo', 'in-mag-hi', 'in-depth-lo', 'in-depth-hi',
  'in-exag', 'in-size', 'in-sharp', 'in-opacity', 'in-land',
  'in-msize-all', ...Array.from({ length: 10 }, (_, i) => `in-msize-${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ck-band-${i + 1}`),
  'ck-additive', 'ck-coast', 'ck-admin', 'ck-plates', 'ck-box', 'ck-ocean',
  'ck-spin', 'ck-loop',
  'sel-speed',
];

const DAY_MS = 86400000;

async function boot() {
  let data;
  try {
    data = await loadData((msg, frac) => {
      $('loader-msg').textContent = msg;
      $('loader-fill').style.width = `${(frac * 100).toFixed(1)}%`;
    });
  } catch (err) {
    console.error(err);
    $('loader').classList.add('done');
    showFailure(err);
    return;
  }
  const app = new App(data);
  window.__app = app;                     // console/debug access
  app.start();
}

/** Where you are decides the language, before anything is rendered. */
function initLang() {
  setLang(detectLang(), { persist: false });
  nf = numFmt();
}

/**
 * Explain a load failure in terms of the thing that is actually wrong.
 *
 * The generic "you must use a local server" advice is only right for a transport
 * failure. When the payload files disagree with each other, that advice sends
 * the user chasing the wrong problem.
 */
function showFailure(err) {
  const msg = String(err?.message ?? err);
  const isTransport = err instanceof TypeError            // fetch() rejected outright
    || /HTTP \d{3}/.test(msg)
    || location.protocol === 'file:';

  $('fail').hidden = false;
  $('fail-msg').textContent = msg;

  if (err?.kind === 'stale-build') {
    $('fail-title').textContent = '데이터 파일이 서로 맞지 않습니다';
    $('fail-hint').innerHTML =
      '빌드가 중간에 끊겼을 때 생깁니다. <code>update.bat --build-only</code> 를 실행해 '
      + '데이터를 다시 만든 뒤 <b>Ctrl+F5</b> 로 새로고침하세요. '
      + '(수집한 원본 <code>data/raw/catalog.csv</code> 는 그대로이므로 다시 받을 필요는 없습니다.)';
  } else if (isTransport) {
    $('fail-title').textContent = '데이터를 불러올 수 없습니다';
    $('fail-hint').innerHTML =
      '이 사이트는 로컬 서버에서 열어야 합니다. <code>serve.bat</code> 을 실행한 뒤 '
      + '<code>http://localhost:8080</code> 으로 접속하세요. '
      + '(<code>file://</code> 로는 동작하지 않습니다.)';
  } else {
    $('fail-title').textContent = '데이터를 불러올 수 없습니다';
    $('fail-hint').innerHTML =
      '<code>update.bat --build-only</code> 로 데이터를 다시 만들어 보세요. '
      + '문제가 계속되면 브라우저 개발자 콘솔(F12)의 오류 메시지를 확인하세요.';
  }
}

/* ══════════════════════════════════════════════════════════════ */

class App {
  constructor(data) {
    this.data = data;
    this.meta = data.meta;
    this.proj = makeProjection(data.meta);
    this.saved = store.load();

    const T = data.totalDays;
    const [ra, rb] = sanitizeRange(this.saved.range, T);
    this.state = {
      mode: this.saved.mode ?? 'accumulate',
      windowDays: 365,
      rangeStart: ra,
      rangeEnd: rb,
      // Open on the fully accumulated cloud unless a position was remembered.
      now: clamp(this.saved.now ?? rb, ra, rb),
      playing: false,
      speed: 365,
      loop: true,
      exag: 1.6,
      colorMode: this.saved.colorMode ?? 0,
      mapStyle: this.saved.mapStyle ?? 'sat',
    };
    this.view = 'japan';               // 'japan' | 'globe'; Japan is the opener

    this.persist = store.debounce(() => this.saveNow(), 450);

    this.buildScene();
    this.buildTimeline();
    this.buildFeeds();
    this.restoreInputs();
    this.bindUI();
    this.fillMeta();
    if (!this.restoreCamera()) this.applyPreset('iso');
    this.dirty = true;
  }

  /* ── event lists ────────────────────────────────────────── */

  buildFeeds() {
    this.feed = new EventFeed({
      root: $('feed'),
      list: $('feed-list'),
      empty: $('feed-empty'),
      countEl: $('feed-count'),
      toggle: $('feed-toggle'),
      layer: this.quakes,
      data: this.data,
      limit: 10,
      onPick: (i) => this.focusEvent(i),
    });
    this.feed.onToggle = (open) => {
      $('feed-toggle').setAttribute('aria-expanded', String(open));
      this.recenter();
      this.persist();
    };
    // Tablets and portrait screens open with the list folded away: it would
    // otherwise eat a third of a screen that is mostly map.
    const tabletish = window.innerWidth <= 1280
      || window.innerHeight >= window.innerWidth;
    if (this.saved.feedOpen ?? !tabletish) { /* stays open */ } else {
      this.feed.setOpen(false);
    }

    this.changeFeed = new ChangeFeed({
      root: $('upd'),
      summary: $('upd-summary'),
      list: $('upd-list'),
      toggle: $('upd-toggle'),
      onPick: (i) => this.focusEvent(i),
    });
    loadChanges().then((c) => this.changeFeed.setData(c));
  }

  /**
   * Centre a specific event: make sure it is inside the drawn range, mark it in
   * 3D and open its detail card. The playhead only moves when the event is not
   * already on screen, so clicking a row in the rolling list does not rewind.
   */
  focusEvent(i) {
    const s = this.state;
    // The feed serves whichever catalogue is active, so the index belongs to
    // the active layer -- mixing them up reads garbage off the other arrays.
    const onGlobe = this.view === 'globe' && this.globe?.layer;
    const layer = onGlobe ? this.globe.layer : this.quakes;
    const days = onGlobe ? layer.tDays[i] : this.data.days(i);

    // Picking from the mobile list should land you on the map, looking at it.
    if (document.body.classList.contains('m-list')) this.setMobileList(false);

    if (days < s.rangeStart || days > s.rangeEnd) {
      // Widen the period just enough to contain it.
      this.setRange([Math.min(s.rangeStart, days - 1), Math.max(s.rangeEnd, days + 1)]);
      markChip($('span-presets'), () => false);
    }
    if (!layer.isDrawn(i)) {
      this.setPlaying(false);
      s.now = clamp(days, s.rangeStart, s.rangeEnd);
      this.syncTime();
    }

    this.feed.setSelected(i);

    if (onGlobe) {
      // Swing the globe around to the epicentre; the detail card is a
      // Japan-catalogue affair (places, source links) so it stays closed.
      const ev = layer.events;
      const la = (ev.lat[i] * Math.PI) / 180;
      const lo = (ev.lon[i] * Math.PI) / 180;
      const cam = this.globe.camera;
      const d = cam.position.length();
      const c = Math.cos(la);
      cam.position.set(d * c * Math.cos(lo), d * Math.sin(la), -d * c * Math.sin(lo));
      this.globe.controls.update();
      this.dirty = true;
      return;
    }

    this.marker.show(i, this.quakes.positions);
    this.showCard(i);
    this.flyTo(this.worldPos(i));
    markChip($('view-presets'), () => false);   // no longer a preset framing
    this.dirty = true;
  }

  /* ── persistence ────────────────────────────────────────── */

  /** Push remembered raw values into the DOM before the handlers are bound,
   *  so binding alone brings the scene up in the saved state. */
  restoreInputs() {
    const saved = this.saved.inputs;
    if (saved) {
      for (const id of SAVED_INPUTS) {
        const el = $(id);
        const v = saved[id];
        if (!el || v == null) continue;
        if (el.type === 'checkbox') el.checked = !!v;
        else el.value = v;
      }
    }
    // Phones start with the panel tucked away; a remembered choice wins.
    if (this.saved.panelCollapsed ?? (window.innerWidth < 700)) {
      $('panel').classList.add('collapsed');
    }
    // Chips are shortcuts, not state: mark the matching one without firing it.
    // (The depth chips are matched at the end of bindUI, once the dual-range
    // values have been restored.)
    markChip($('span-presets'), (b) => b.dataset.span === this.saved.spanPreset);
  }

  restoreCamera() {
    const c = this.saved.camera;
    if (!Array.isArray(c?.p) || !Array.isArray(c?.t)) return false;
    if (![...c.p, ...c.t].every(Number.isFinite)) return false;
    this.camera.position.fromArray(c.p);
    this.controls.target.fromArray(c.t);
    this.controls.update();
    markChip($('view-presets'), () => false);
    this.dirty = true;
    return true;
  }

  saveNow() {
    const inputs = {};
    for (const id of SAVED_INPUTS) {
      const el = $(id);
      if (el) inputs[id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    store.save({
      inputs,
      mode: this.state.mode,
      colorMode: this.state.colorMode,
      mapStyle: this.state.mapStyle,
      range: [this.state.rangeStart, this.state.rangeEnd],
      now: this.state.now,
      spanPreset: $('span-presets').querySelector('button.on')?.dataset.span ?? null,
      panelCollapsed: $('panel').classList.contains('collapsed'),
      feedOpen: this.feed?.isOpen ?? true,
      camera: {
        p: this.camera.position.toArray(),
        t: this.controls.target.toArray(),
      },
    });
  }

  /* ── scene ──────────────────────────────────────────────── */

  buildScene() {
    const canvas = $('stage');
    this.canvas = canvas;

    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x05070d, 1);

    // No scene fog: the point shader does not sample it, so fogging the
    // reference lines alone would read as an inconsistency.
    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 600);

    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, {
      enableDamping: true, dampingFactor: 0.07,
      rotateSpeed: 0.62, zoomSpeed: 0.85, panSpeed: 0.7,
      minDistance: 1.2, maxDistance: 260,
      autoRotateSpeed: 0.42,
    });
    this.controls.addEventListener('change', () => { this.dirty = true; });
    // Touching the camera yourself cancels any glide in progress.
    this.controls.addEventListener('start', () => { this.fly = null; });

    // Everything lives in one group whose Y scale is the depth exaggeration.
    // Keeping the group free of rotation/translation lets the picker map
    // vertices to world space with a single multiply.
    this.world = new THREE.Group();
    this.world.scale.y = this.state.exag;
    this.scene.add(this.world);

    this.quakes = new QuakeLayer(this.data, this.proj);
    this.world.add(this.quakes.points);

    this.ref = new RefLayer(this.data.basemap, this.proj, this.meta,
      () => { this.dirty = true; });        // repaint when the texture arrives
    this.ref.maxAnisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.world.add(this.ref.group);

    this.marker = new SelectionMarker({ color: 0xffffff });
    this.marker.setPixelRatio(this.renderer.getPixelRatio());
    this.world.add(this.marker.points);

    this.labels = new AxisLabels($('labels'), this.proj, this.world);
    this.labels.setGraticule(this.ref.lonTicks, this.ref.latTicks);

    this.picker = new Picker(canvas, this.camera, this.world, this.quakes);

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindPointer();
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.recenter();
    this.quakes.setViewportHeight(h * this.renderer.getPixelRatio());
    this.globe?.resize(w, h, this.renderer.getPixelRatio());
    this.dirty = true;
  }

  /* ── view switching (Japan box <-> whole-Earth globe) ────── */

  async setView(v) {
    if (v === this.view) return;
    this.view = v;
    const globeMode = v === 'globe';
    document.body.classList.toggle('globe-mode', globeMode);
    // The headline names whichever catalogue is on screen.
    $('app-title').textContent = t(globeMode ? '지구 전체 지진' : '일본 주변 지진');
    document.title = `${$('app-title').textContent} 4D`;
    this.controls.enabled = !globeMode;

    if (globeMode) {
      this.closeCard?.();
      if (!this.globe) {
        // Lazy: the globe module and its data cost nothing until first use.
        const { GlobeView } = await import('./globe.js');
        this.globe = new GlobeView(this.renderer, this.canvas);
        this.globe.resize(window.innerWidth, window.innerHeight,
          this.renderer.getPixelRatio());
        this.globe.setInsets(this.viewInsets());
        this.globe.load($('globe-status'), this.quakes.uniforms,
          this.data.totalDays, () => this.onGlobeReady());
      }
      this.globe.setActive(true);
      this.globe.controls.autoRotate = $('ck-spin').checked;
      if (this.globe.layer) this.useGlobeData(true);
    } else {
      this.globe?.setActive(false);
      this.useGlobeData(false);
      this.recenter();
    }
    this.dirty = true;
  }

  /* ── mobile shell: drawer, bottom sheets, period popup ──── */

  /* ── language ───────────────────────────────────────────── */

  bindLang() {
    const build = (root) => {
      root.innerHTML = LANGS.map(([code, label]) =>
        `<button data-l="${code}"${code === getLang() ? ' class="on"' : ''}>${label}</button>`)
        .join('');
    };
    const pick = (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      setLang(btn.dataset.l);
      nf = numFmt();
      for (const id of ['seg-lang', 'mi-lang']) {
        markChip($(id), (b) => b.dataset.l === getLang());
      }
      this.refreshTexts();
    };
    for (const id of ['seg-lang', 'mi-lang']) {
      build($(id));
      $(id).addEventListener('click', pick);
    }
  }

  /**
   * Re-render everything whose text is built in JS. applyI18n() has already
   * swapped the static markup by the time this runs.
   */
  refreshTexts() {
    document.title = `${t(this.view === 'globe' ? '지구 전체 지진' : '일본 주변 지진')} 4D`;
    $('app-title').textContent = t(this.view === 'globe' ? '지구 전체 지진' : '일본 주변 지진');
    // Bounce the controls that own dynamic labels through their handlers.
    for (const id of ['in-window', 'in-glow']) {
      $(id).dispatchEvent(new Event('input', { bubbles: true }));
    }
    $('row-fade').querySelector('span').textContent =
      t(this.state.mode === 'window' ? '꼬리 진하기' : '과거 지진 진하기');
    $('mode-hint').textContent = t(this.state.mode === 'window'
      ? '현재 시점에서 뒤로 정해진 기간만 표시합니다. 지진의 이동과 여진 전개를 보기에 좋습니다.'
      : '시작부터 현재 시점까지 모든 지진이 남습니다. 점이 쌓이며 밀집 구역이 드러납니다.');
    $('land-hint').textContent =
      t('면 채우기는 Natural Earth 육지 마스크, 위성사진은 NASA Blue Marble 영상입니다.');
    this.renderLegend();
    this.fillMeta();
    this.syncTime();
    this.updateStats();
    this.feed?.render(true);
    this.fillInfo();
  }

  /** Gesture list + coverage line inside the ⓘ popup. */
  fillInfo() {
    const touch = window.matchMedia('(pointer: coarse)').matches;
    const items = touch
      ? ['한 손가락 드래그: 회전', '두 손가락 벌리기/오므리기: 확대·축소',
         '두 손가락 드래그: 화면 이동', '점 탭: 지진 상세 정보']
      : ['마우스 드래그: 회전 · 휠: 확대 · 우클릭 드래그: 이동', '점 탭: 지진 상세 정보'];
    $('mi-gestures').innerHTML = items.map((k) => `<li>${t(k)}</li>`).join('');

    const m = this.meta;
    $('mi-meta').textContent =
      `${t('수록 기간')}: ${m.time_start.slice(0, 10)} ~ ${m.time_end.slice(0, 10)}\n`
      + `${t('갱신 시각')}: ${(m.generated_utc ?? '').replace('T', ' ').slice(0, 16)} UTC`;
  }

  bindMobile() {
    $('m-list-close').addEventListener('click', () => this.setMobileList(false));

    /* info popup */
    const info = $('minfo');
    const openInfo = (on) => { info.hidden = !on; if (on) this.fillInfo(); };
    $('m-info').addEventListener('click', () => openInfo(true));
    $('mi-close').addEventListener('click', () => openInfo(false));
    info.addEventListener('click', (ev) => { if (ev.target === info) openInfo(false); });

    /* floating layer / filter buttons -> bottom sheets */
    $('fab-layer').addEventListener('click', () => this.toggleSheet('layer'));
    $('fab-filter').addEventListener('click', () => this.toggleSheet('filter'));
    $('m-sheet-close').addEventListener('click', () => this.toggleSheet(null));
    $('m-sheet-tabs').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (btn) this.toggleSheet(btn.dataset.s, true);
    });
    // Tapping the map dismisses whichever sheet is up.
    this.canvas.addEventListener('pointerdown', () => {
      if (document.body.classList.contains('m-sheet')) this.toggleSheet(null);
    });

    /* drawer */
    const drawer = $('mdrawer');
    const openDrawer = (on) => { drawer.hidden = !on; };
    $('m-menu').addEventListener('click', () => openDrawer(true));
    $('dr-close').addEventListener('click', () => openDrawer(false));
    drawer.addEventListener('click', (ev) => { if (ev.target === drawer) openDrawer(false); });
    seg($('dr-view'), (v) => { this.setView(v); markChip($('seg-view'), (b) => b.dataset.v === v); },
      'globe');
    drawer.addEventListener('click', (ev) => {
      const item = ev.target.closest('.dr-item');
      if (!item) return;
      openDrawer(false);
      const go = item.dataset.go;
      if (go === 'list') this.setMobileList(true);
      else if (go === 'update') this.runUpdate();
      else this.toggleSheet(go);
    });

    /* period popup */
    const pop = $('mperiod');
    $('m-edit-period').addEventListener('click', () => {
      $('mp-a').value = fmtISO(this.daysToDate(this.state.rangeStart));
      $('mp-b').value = fmtISO(this.daysToDate(this.state.rangeEnd));
      $('mp-a').min = $('mp-b').min = fmtISO(this.daysToDate(0));
      $('mp-a').max = $('mp-b').max = fmtISO(this.daysToDate(this.data.totalDays));
      markChip($('mp-chips'), () => false);
      pop.hidden = false;
    });
    const closePop = () => { pop.hidden = true; };
    $('mp-close').addEventListener('click', closePop);
    pop.addEventListener('click', (ev) => { if (ev.target === pop) closePop(); });
    $('mp-chips').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button');
      if (!btn) return;
      markChip($('mp-chips'), (b) => b === btn);
      const total = this.data.totalDays;
      const d = btn.dataset.days === 'all' ? total : +btn.dataset.days;
      $('mp-a').value = fmtISO(this.daysToDate(Math.max(0, total - d)));
      $('mp-b').value = fmtISO(this.daysToDate(total));
    });
    $('mp-apply').addEventListener('click', () => {
      const a = Date.parse(`${$('mp-a').value}T00:00:00Z`);
      const b = Date.parse(`${$('mp-b').value}T00:00:00Z`);
      if (Number.isFinite(a) && Number.isFinite(b)) {
        this.setRange([this.dateToDays(new Date(a)), this.dateToDays(new Date(b))]);
        this.state.now = this.state.rangeEnd;
        this.syncTime();
        markChip($('span-presets'), () => false);
      }
      closePop();
    });

    /* update button */
    $('m-update').addEventListener('click', () => this.runUpdate());
  }

  /**
   * One bottom sheet at a time. Passing null closes; tapping the button of an
   * already-open sheet closes it too, unless `force` (the in-sheet tabs, which
   * should only ever switch).
   */
  toggleSheet(which, force = false) {
    const body = document.body;
    const open = !!which && (force || !body.classList.contains(`m-sheet-${which}`));
    body.classList.remove('m-sheet', 'm-sheet-layer', 'm-sheet-filter');
    if (open) body.classList.add('m-sheet', `m-sheet-${which}`);
    for (const b of $('m-sheet-tabs').querySelectorAll('button')) {
      b.classList.toggle('on', open && b.dataset.s === which);
    }
    if (open) $('panel').querySelector('.panel-scroll').scrollTop = 0;
  }

  setMobileList(on) {
    document.body.classList.toggle('m-list', on);
    if (on) {
      this.toggleSheet(null);
      this.feed.setOpen(true);
      this.feed.render(true);
    }
    this.resize();
  }

  /**
   * Refresh the catalogue. Served from a local `serve.py`, this asks the
   * server to run the fetch/build scripts for real; on a static host (GitHub
   * Pages) there is nothing to run, so it re-fetches the published payload
   * with a cache-busting reload instead.
   */
  async runUpdate() {
    const btn = $('m-update');
    const txt = $('m-update-txt');
    if (btn.classList.contains('busy')) return;
    btn.classList.add('busy');
    const scope = this.view === 'globe' ? 'global' : 'japan';
    try {
      txt.textContent = t('갱신 중…');
      const r = await fetch(`api/update?scope=${scope}`, { method: 'POST' });
      if (!r.ok) throw new Error(String(r.status));
      const out = await r.json();
      txt.textContent = t(out.ok ? '갱신 완료 · 새로고침' : '갱신 실패');
      if (out.ok) setTimeout(() => location.reload(), 1200);
    } catch {
      // Static host: the freshest thing available is whatever was published.
      txt.textContent = t('최신 데이터 확인 중…');
      location.reload();
    } finally {
      btn.classList.remove('busy');
    }
  }

  /** First arrival of the worldwide cloud: apply the current panel state. */
  onGlobeReady() {
    this.globe.setCoastVisible($('ck-coast').checked);
    this.globe.setPlatesVisible($('ck-plates').checked);
    this.globe.setOceanVisible($('ck-ocean').checked);
    this.globe.setMapStyle(this.state.mapStyle);
    this.globe.setLandOpacity(+$('in-land').value / 100);
    this.syncTime();
    if (this.view === 'globe') this.useGlobeData(true);
  }

  /** Point the shared feed / stats / timeline at the active catalogue. */
  useGlobeData(globe) {
    const g = this.globe;
    if (globe && g?.layer) {
      this.globeData ??= {
        events: g.layer.events,
        dateAt: (i) => new Date(this.data.epochMs + g.layer.events.t[i] * 1000),
        placeOf: (i) => {
          const la = g.layer.events.lat[i];
          const lo = g.layer.events.lon[i];
          return `${Math.abs(la).toFixed(1)}°${la >= 0 ? 'N' : 'S'} `
            + `${Math.abs(lo).toFixed(1)}°${lo >= 0 ? 'E' : 'W'}`;
        },
      };
      this.feed.layer = g.layer;
      this.feed.data = this.globeData;
      $('stat-total').textContent = nf.format(g.layer.count);
      this.timeline.setHistogram(g.meta.histogram);
    } else {
      this.feed.layer = this.quakes;
      this.feed.data = this.data;
      $('stat-total').textContent = nf.format(this.data.events.count);
      this.timeline.setHistogram(this.meta.histogram);
    }
    this.feed.setSelected(null);
    this.feed.lastKey = '';
    this.feed.render(true);
    this.updateStats();
  }

  /**
   * The canvas fills the window but the panel and timeline sit on top of it, so
   * the geometric centre of the canvas is not the centre of what you can see.
   * A pure principal-point shift (fullWidth/Height equal to the canvas, so the
   * field of view is untouched) moves the scene into the clear area. Raycasting
   * and label projection both go through the projection matrix, so they follow.
   */
  recenter() {
    const { width, height, left, right, bottom } = this.viewInsets();
    // A positive X offset shifts the scene left; the panel on the right and the
    // event list on the left pull opposite ways, so use the difference.
    this.camera.setViewOffset(width, height, (right - left) / 2, bottom / 2, width, height);
    this.camera.updateProjectionMatrix();
    this.globe?.setInsets({ width, height, left, right, bottom });
    this.dirty = true;
  }

  /** Pixel area of the canvas that the overlaid UI does not cover. */
  viewInsets() {
    const width = window.innerWidth;
    const shown = (el) => el && getComputedStyle(el).display !== 'none';

    const panel = $('panel');
    // On phones the panel is a temporary sheet over the map, not a fixture
    // the camera should dodge -- shifting the scene 88vw would hide it.
    const overlay = width < 700;
    const panelOver = !overlay && shown(panel) && !panel.classList.contains('collapsed');
    const feed = $('feed');
    const feedOver = !overlay && shown(feed) && !feed.classList.contains('collapsed');

    return {
      width,
      height: window.innerHeight,
      left: feedOver ? feed.getBoundingClientRect().right : 0,
      right: panelOver ? panel.getBoundingClientRect().width : 0,
      bottom: $('timeline').getBoundingClientRect().height,
    };
  }

  /** Vertical centre of the cloud at the current exaggeration. */
  focusY(f = 0.42) { return -this.proj.depthMax * SCALE * this.state.exag * f; }

  /** World-space position of an event, accounting for the depth exaggeration. */
  worldPos(i, out = new THREE.Vector3()) {
    const p = this.quakes.positions;
    return out.set(p[i * 3], p[i * 3 + 1] * this.state.exag, p[i * 3 + 2]);
  }

  /**
   * Glide the camera to look at `target`, keeping the current viewing direction
   * so the move reads as travel rather than a cut. Never zooms out: if you are
   * already closer than the default framing, the distance is left alone.
   */
  flyTo(target, ms = 800) {
    const span = Math.max(this.proj.width, this.proj.height);
    const dir = this.camera.position.clone().sub(this.controls.target);
    const dist = Math.min(dir.length(), span * 0.6);
    dir.normalize().multiplyScalar(Math.max(dist, 0.6));

    this.fly = {
      fromTarget: this.controls.target.clone(),
      toTarget: target.clone(),
      fromPos: this.camera.position.clone(),
      toPos: target.clone().add(dir),
      start: performance.now(),
      ms,
    };
    this.dirty = true;
  }

  /** Advance an in-flight camera move; returns true while still animating. */
  stepFly() {
    if (!this.fly) return false;
    const k = Math.min(1, (performance.now() - this.fly.start) / this.fly.ms);
    // easeInOutQuad -- starts and lands gently.
    const e = k < 0.5 ? 2 * k * k : 1 - 2 * (1 - k) * (1 - k);
    this.controls.target.lerpVectors(this.fly.fromTarget, this.fly.toTarget, e);
    this.camera.position.lerpVectors(this.fly.fromPos, this.fly.toPos, e);
    if (k >= 1) this.fly = null;
    return true;
  }

  applyPreset(name) {
    this.fly = null;
    const p = this.proj;
    const span = Math.max(p.width, p.height);
    const t = new THREE.Vector3(0, this.focusY(), 0);
    let dir;
    let dist = span * 1.62;

    switch (name) {
      case 'top':
        t.set(0, 0, 0);
        dir = new THREE.Vector3(0, 1, 0.0001);
        dist = span * 1.6;
        break;
      case 'south':                                   // looking north: lon × depth
        dir = new THREE.Vector3(0, 0.16, 1);
        dist = span * 1.72;
        break;
      case 'east':                                    // looking west: lat × depth
        dir = new THREE.Vector3(1, 0.16, 0);
        dist = span * 1.72;
        break;
      case 'trench':                                  // oblique on the Japan Trench
        t.set(p.x(141.5), -240 * SCALE * this.state.exag, p.z(38.5));
        dir = new THREE.Vector3(0.86, 0.34, 0.38);
        dist = span * 1.32;
        break;
      default:                                        // iso
        dir = new THREE.Vector3(0.6, 0.44, 0.67);
        dist = span * 1.78;
    }

    this.controls.target.copy(t);
    this.camera.position.copy(t).add(dir.normalize().multiplyScalar(dist));
    this.controls.update();
    this.dirty = true;
  }

  /* ── timeline ───────────────────────────────────────────── */

  buildTimeline() {
    this.timeline = new Timeline({
      track: $('tl-track'),
      canvas: $('tl-canvas'),
      head: $('tl-head'),
      gripA: $('tl-grip-a'),
      gripB: $('tl-grip-b'),
      meta: this.meta,
      epochMs: this.data.epochMs,
      totalDays: this.data.totalDays,
      onSeek: (days) => {
        const s = this.state;
        s.now = clamp(days, s.rangeStart, s.rangeEnd);
        this.setPlaying(false);
        this.syncTime();
      },
      onRange: (r) => {
        this.setRange(r);
        markChip($('span-presets'), () => false);   // no longer a preset
      },
    });
  }

  /* ── period ─────────────────────────────────────────────── */

  daysToDate(days) { return new Date(this.data.epochMs + days * DAY_MS); }
  dateToDays(d) { return (d.getTime() - this.data.epochMs) / DAY_MS; }

  setRange([a, b]) {
    const T = this.data.totalDays;
    const s = this.state;
    s.rangeStart = clamp(a, 0, T - MIN_SPAN_DAYS);
    s.rangeEnd = clamp(b, s.rangeStart + MIN_SPAN_DAYS, T);
    s.now = clamp(s.now, s.rangeStart, s.rangeEnd);
    this.syncDates();
    this.syncTime();
    this.persist();
  }

  syncDates() {
    $('in-date-a').value = fmtISO(this.daysToDate(this.state.rangeStart));
    $('in-date-b').value = fmtISO(this.daysToDate(this.state.rangeEnd));
  }

  /* ── UI wiring ──────────────────────────────────────────── */

  bindUI() {
    const s = this.state;

    /* every panel interaction schedules a save */
    for (const ev of ['input', 'change']) {
      $('panel').addEventListener(ev, () => this.persist());
    }
    $('panel').addEventListener('click', () => this.persist());
    this.controls.addEventListener('end', () => this.persist());
    window.addEventListener('pagehide', () => this.saveNow());

    /* period */
    const T = this.data.totalDays;
    const dA = $('in-date-a'), dB = $('in-date-b');
    dA.min = dB.min = fmtISO(this.daysToDate(0));
    dA.max = dB.max = fmtISO(this.daysToDate(T));
    this.syncDates();
    const onDate = () => {
      const a = Date.parse(dA.value + 'T00:00:00Z');
      const b = Date.parse(dB.value + 'T00:00:00Z');
      if (!Number.isFinite(a) || !Number.isFinite(b)) return;
      this.setRange([this.dateToDays(new Date(a)), this.dateToDays(new Date(b))]);
      markChip($('span-presets'), () => false);
    };
    dA.addEventListener('change', onDate);
    dB.addEventListener('change', onDate);

    chips($('span-presets'), (btn) => {
      const span = { all: T, '10y': 3652, '1y': 365, '30d': 30, '7d': 7 }[btn.dataset.span] ?? T;
      this.setRange([T - span, T]);
      this.state.now = this.state.rangeEnd;
      this.syncTime();
    });

    /* view scope: the whole-Earth globe opens; Japan is one click away */
    seg($('seg-view'), (v) => { this.setView(v); }, 'globe');

    this.bindLang();
    this.bindMobile();

    $('m-filter-reset').addEventListener('click', () => {
      const set = (id, v) => {
        const el = $(id);
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      set('in-mag-lo', $('in-mag-lo').min);
      set('in-mag-hi', $('in-mag-hi').max);
      set('in-depth-lo', 0);
      set('in-depth-hi', $('in-depth-hi').max);
      for (let m = 1; m <= 10; m++) {
        const el = $(`ck-band-${m}`);
        if (!el.checked) {
          el.checked = true;
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
      this.setRange([0, this.data.totalDays]);
      this.state.now = this.state.rangeEnd;
      this.syncTime();
      markChip($('span-presets'), (b) => b.dataset.span === 'all');
    });

    /* mode */
    seg($('seg-mode'), (v) => {
      s.mode = v;
      const win = v === 'window';
      $('row-window').classList.toggle('hide', !win);
      $('mode-hint').textContent = t(win
        ? '현재 시점에서 뒤로 정해진 기간만 표시합니다. 지진의 이동과 여진 전개를 보기에 좋습니다.'
        : '시작부터 현재 시점까지 모든 지진이 남습니다. 점이 쌓이며 밀집 구역이 드러납니다.');
      $('row-fade').querySelector('span').textContent = t(win ? '꼬리 진하기' : '과거 지진 진하기');
      this.syncTime();
    }, s.mode);

    /* sliders */
    slider('in-window', (i) => {
      const [days, label] = WINDOW_PRESETS[clamp(i, 0, WINDOW_PRESETS.length - 1)];
      s.windowDays = days;
      $('out-window').textContent = t(label);
      this.syncTime();
    });
    slider('in-fade', (v) => {
      this.quakes.uniforms.uFade.value = v / 100;
      $('out-fade').textContent = `${v}%`;
      this.dirty = true;
    });
    slider('in-glow', (v) => {
      this.quakes.uniforms.uGlowDays.value = v;
      $('out-glow').textContent = v === 0 ? t('없음(강조 안 함)') : fmtDays(v);
      this.syncTime();
    });
    slider('in-exag', (v) => {
      s.exag = v;
      this.world.scale.y = v;
      $('out-exag').textContent = `${v.toFixed(1)}×`;
      this.dirty = true;
    });
    slider('in-size', (v) => {
      this.quakes.uniforms.uSizeScale.value = v;
      $('out-size').textContent = `${v.toFixed(2)}×`;
      this.dirty = true;
    });
    slider('in-msize-all', (v) => {
      this.quakes.uniforms.uMagScale.value = v;
      $('out-msize-all').textContent = `${v.toFixed(2)}×`;
      this.renderMagKey();
      this.dirty = true;
    });
    for (let m = 1; m <= 10; m++) {
      slider(`in-msize-${m}`, (v) => {
        this.quakes.uniforms.uMagSizes.value[m - 1] = v;
        // Up to 3 decimals, trailing zeros trimmed: "1.1", "0.001", "19.2".
        $(`out-msize-${m}`).textContent = String(+v.toFixed(3));
        this.renderMagKey();
        this.dirty = true;
      });
    }
    // -/+ nudge buttons flanking every single-handle slider (one native step
    // per click). Dual-range tracks are left alone: with two handles there is
    // no unambiguous target for a nudge.
    for (const row of document.querySelectorAll('.mag-sizes label, #panel label.row')) {
      const input = row.querySelector('input[type=range]');
      if (!input) continue;
      const mk = (txt, dir) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'msize-btn';
        b.textContent = txt;
        b.addEventListener('click', (ev) => {
          ev.preventDefault();
          // data-nudge lets ultra-fine sliders (step 0.001) move a useful
          // amount per click instead of an imperceptible single step.
          const n = +input.dataset.nudge || 1;
          if (dir > 0) input.stepUp(n); else input.stepDown(n);
          input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        return b;
      };
      const wrap = document.createElement('div');
      wrap.className = 'nudge';
      input.replaceWith(wrap);
      wrap.append(mk('−', -1), input, mk('+', +1));
    }

    $('btn-msize-reset').addEventListener('click', () => {
      const set = (id, v) => {
        const el = $(id);
        el.value = v;
        // Bubbles so the panel-level persist listener sees the change too.
        el.dispatchEvent(new Event('input', { bubbles: true }));
      };
      MAG_SIZE_DEFAULTS.forEach((d, i) => set(`in-msize-${i + 1}`, d));
      set('in-msize-all', 0.7);
    });
    slider('in-sharp', (v) => {
      // 100% = hard-edged disc, 0% = wide glow.
      this.quakes.uniforms.uSoft.value = 1 - v / 100;
      $('out-sharp').textContent = `${v}%`;
      this.dirty = true;
    });
    slider('in-opacity', (v) => {
      this.quakes.uniforms.uOpacity.value = v / 100;
      $('out-opacity').textContent = `${v}%`;
      this.dirty = true;
    });

    /* dual range filters — clamp so the handles cannot cross */
    const savedIn = this.saved.inputs ?? {};
    const magLo = $('in-mag-lo'), magHi = $('in-mag-hi');
    // Snap the bounds outward onto the slider's own 0.1 grid. A range input
    // silently rounds `value` to `min + n*step`, so a min like ISC's 1.95 would
    // shift the whole grid by 0.05 and make the true maximum unreachable --
    // quietly filtering out the single largest earthquake. The 1e-6 nudges
    // absorb float error (7.8 * 10 is 78.00000000000001).
    const mMin = Math.floor(this.meta.mag_min * 10 + 1e-6) / 10;
    const mMax = Math.ceil(this.meta.mag_max * 10 - 1e-6) / 10;
    for (const el of [magLo, magHi]) { el.min = mMin; el.max = mMax; }
    // Widening min/max can silently clamp a restored value, so re-apply it.
    magLo.value = savedIn['in-mag-lo'] ?? mMin;
    magHi.value = savedIn['in-mag-hi'] ?? mMax;
    const syncMag = () => {
      let lo = +magLo.value, hi = +magHi.value;
      if (lo > hi) { if (document.activeElement === magLo) hi = lo; else lo = hi; }
      magLo.value = lo; magHi.value = hi;
      this.quakes.uniforms.uMinMag.value = lo;
      this.quakes.uniforms.uMaxMag.value = hi;
      $('out-mag').textContent = `${lo.toFixed(1)} – ${hi.toFixed(1)}`;
      fillTrack(magLo.parentElement, lo, hi, mMin, mMax);
      this.updateStats();
      this.dirty = true;
    };
    magLo.addEventListener('input', syncMag);
    magHi.addEventListener('input', syncMag);

    const depLo = $('in-depth-lo'), depHi = $('in-depth-hi');
    const dMax = this.proj.depthMax;
    for (const el of [depLo, depHi]) { el.max = dMax; }
    depLo.value = savedIn['in-depth-lo'] ?? 0;
    depHi.value = savedIn['in-depth-hi'] ?? dMax;
    const syncDepth = () => {
      let lo = +depLo.value, hi = +depHi.value;
      if (lo > hi) { if (document.activeElement === depLo) hi = lo; else lo = hi; }
      depLo.value = lo; depHi.value = hi;
      this.quakes.uniforms.uMinDepth.value = lo;
      this.quakes.uniforms.uMaxDepth.value = hi;
      $('out-depth').textContent = `${lo} – ${hi}`;
      fillTrack(depLo.parentElement, lo, hi, 0, dMax);
      this.updateStats();
      this.dirty = true;
    };
    depLo.addEventListener('input', syncDepth);
    depHi.addEventListener('input', syncDepth);

    /* magnitude-band toggles */
    for (let m = 1; m <= 10; m++) {
      check(`ck-band-${m}`, (on) => {
        this.quakes.setMagBand(m, on);
        this.updateStats();
        this.feed?.render(true);
        this.renderMagKey();
        this.dirty = true;
      });
    }

    chips($('depth-presets'), (btn) => {
      depLo.value = btn.dataset.lo;
      depHi.value = Math.min(+btn.dataset.hi, dMax);
      syncDepth();
    });

    /* colour + toggles */
    seg($('seg-color'), (v) => {
      this.state.colorMode = +v;
      this.quakes.uniforms.uColorMode.value = +v;
      this.renderLegend();
      this.dirty = true;
    }, String(s.colorMode));
    check('ck-additive', (on) => { this.quakes.setAdditive(on); this.dirty = true; });
    check('ck-coast', (on) => {
      this.ref.setCoastVisible(on);
      this.globe?.setCoastVisible(on);
      this.dirty = true;
    });
    check('ck-admin', (on) => { this.ref.setAdminVisible(on); this.dirty = true; });
    check('ck-plates', (on) => {
      this.ref.setPlatesVisible(on);
      this.globe?.setPlatesVisible(on);
      this.dirty = true;
    });

    /* map layer: off / flat fill / satellite imagery */
    seg($('seg-mapstyle'), (v) => {
      this.state.mapStyle = v;
      this.ref.setMapStyle(v);
      this.globe?.setMapStyle(v);
      $('row-land').classList.toggle('hide', v === 'off');
      $('row-ocean').classList.toggle('hide', v !== 'sat');
      this.dirty = true;
    }, this.saved.mapStyle ?? 'sat');
    check('ck-ocean', (on) => {
      this.ref.setOceanVisible(on);
      this.globe?.setOceanVisible(on);
      this.dirty = true;
    });
    slider('in-land', (v) => {
      this.ref.setLandOpacity(v / 100);
      this.globe?.setLandOpacity(v / 100);
      $('out-land').textContent = `${v}%`;
      this.dirty = true;
    });
    $('land-hint').textContent =
      t('면 채우기는 Natural Earth 육지 마스크, 위성사진은 NASA Blue Marble 영상입니다.');
    check('ck-box', (on) => {
      this.ref.setCageVisible(on);
      this.labels.setVisible(on);
      this.dirty = true;
    });
    check('ck-spin', (on) => {
      this.controls.autoRotate = on;
      if (this.globe) this.globe.controls.autoRotate = on;
      this.dirty = true;
    });

    chips($('view-presets'), (btn) => this.applyPreset(btn.dataset.v));

    /* playback */
    $('btn-play').addEventListener('click', () => this.setPlaying(!s.playing));
    $('btn-reset').addEventListener('click', () => {
      s.now = s.rangeStart; this.setPlaying(false); this.syncTime();
    });
    $('btn-forget').addEventListener('click', () => {
      store.clear();
      $('saved-note').textContent = '저장된 설정을 지웠습니다. 새로고침하면 기본값으로 시작합니다.';
      this.persist = () => {};      // stop re-saving before the reload
    });
    $('sel-speed').addEventListener('change', (e) => { s.speed = +e.target.value; });
    s.speed = +$('sel-speed').value;   // apply the restored selection, not the default
    check('ck-loop', (on) => { s.loop = on; });

    /* panel + card */
    $('panel-toggle').addEventListener('click', () => {
      $('panel').classList.toggle('collapsed');
      // Re-centre once the slide-out transition has settled.
      setTimeout(() => this.recenter(), 340);
    });
    const closeCard = () => {
      $('card').hidden = true;
      this.marker.hide();
      this.feed.setSelected(null);
      this.dirty = true;
    };
    $('card-close').addEventListener('click', closeCard);
    this.closeCard = closeCard;

    /* keyboard */
    window.addEventListener('keydown', (ev) => {
      if (ev.target.matches('input, select, textarea')) return;
      if (this.view !== 'japan') return;   // globe mode: only orbit, no playback keys
      const step = ev.shiftKey ? 365 : 30;
      if (ev.code === 'Space') { ev.preventDefault(); this.setPlaying(!s.playing); }
      else if (ev.key === 'ArrowRight') { this.nudge(+step); }
      else if (ev.key === 'ArrowLeft') { this.nudge(-step); }
      else if (ev.key === 'r' || ev.key === 'R') { this.applyPreset('iso'); }
      else if (ev.key === 'Escape') { this.closeCard(); }
    });

    // Run the filter handlers once so uniforms, readouts and the filled track
    // segments all reflect whatever values were restored above.
    this.renderLegend();
    syncMag();
    syncDepth();
    markChip($('depth-presets'), (b) => +b.dataset.lo === +depLo.value
      && Math.min(+b.dataset.hi, dMax) === +depHi.value);
  }

  nudge(days) {
    const s = this.state;
    this.setPlaying(false);
    s.now = clamp(s.now + days, s.rangeStart, s.rangeEnd);
    this.syncTime();
  }

  setPlaying(on) {
    const s = this.state;
    // Starting from the end of the period means "replay", so rewind first.
    if (on && s.now >= s.rangeEnd - 0.5) s.now = s.rangeStart;
    s.playing = on;
    const btn = $('btn-play');
    btn.textContent = on ? '❙❙' : '▶';
    btn.classList.toggle('playing', on);
    btn.setAttribute('aria-label', on ? '일시정지' : '재생');
    this.dirty = true;
  }

  fillMeta() {
    const m = this.meta;
    $('meta-span').textContent =
      `${m.time_start.slice(0, 10)} → ${m.time_end.slice(0, 10)}`;
    $('meta-built').textContent = m.generated_utc.replace('T', ' ').slice(0, 16) + ' UTC';
    $('stat-total').textContent = nf.format(m.count);

    const spans = m.source_spans ?? [];
    const isc = spans.find((s) => s.source === 'isc');
    const usgs = spans.find((s) => s.source === 'usgs');

    $('dr-src').textContent = `데이터: ISC(JMA) + USGS\n`
      + `수록: ${m.time_start.slice(0, 10)} ~ ${m.time_end.slice(0, 10)}\n`
      + `갱신: ${(m.generated_utc ?? '').replace('T', ' ').slice(0, 16)} UTC`;
    const built = (m.generated_utc ?? '').slice(11, 16);
    if (built) $('m-update-txt').textContent = `업데이트 ${built}`;
    $('head-sub').textContent = isc
      ? `M${isc.mag_min.toFixed(1)}+ · ${m.time_start.slice(0, 4)}–`
        + `${m.time_end.slice(0, 4)} · ISC(JMA) + USGS`
      : `M${m.minmagnitude.toFixed(1)}+ · ${m.time_start.slice(0, 4)}–`
        + `${m.time_end.slice(0, 4)} · USGS ANSS ComCat`;

    // Source list + the completeness caveat the handoff creates.
    const rows = spans.map((s) => {
      const name = s.source === 'isc' ? 'ISC (JMA 포함)' : 'USGS ComCat';
      return `<div class="kv"><span>${name}</span><b>${nf.format(s.count)}건 · `
        + `M${s.mag_min.toFixed(1)}+</b></div>`
        + `<div class="kv"><span></span><b>${s.first.slice(0, 10)} → ${s.last.slice(0, 10)}</b></div>`;
    }).join('');
    $('meta-sources').innerHTML = rows;

    if (isc && usgs) {
      $('meta-caveat').hidden = false;
      $('meta-caveat').innerHTML =
        `<b>${m.handoff}</b> 이후로는 소스가 USGS로 바뀌어 하한이 `
        + `M${isc.mag_min.toFixed(1)} → M${usgs.mag_min.toFixed(1)} 로 올라갑니다. `
        + '시간바의 보라색 점선이 그 경계이고, 그 뒤로 막대가 낮아지는 것은 지진이 줄어서가 '
        + '아니라 <b>작은 지진이 수록되지 않기 때문</b>입니다. ISC가 JMA 데이터를 더 '
        + '공개하면 <code>update.bat --detect-handoff</code> 로 경계를 앞당길 수 있습니다.';
    }

    if (m.handoff) {
      const days = (Date.parse(m.handoff + 'T00:00:00Z') - this.data.epochMs) / DAY_MS;
      if (days > 0 && days < this.data.totalDays) this.timeline.setHandoff(days);
    }

    this.renderMagKey();
  }

  /**
   * Size reference for the legend, generated from the same curve the vertex
   * shader uses. Hard-coding the dots would silently lie as soon as the
   * catalogue's minimum magnitude changes.
   */
  renderMagKey() {
    const scale = this.quakes.uniforms.uMagScale.value;
    const magSize = (m) => this.quakes.magSizeAt(m) * scale;
    const lo = Math.ceil(this.meta.mag_min);
    const hi = Math.floor(this.meta.mag_max);
    const marks = [];
    for (let m = lo; m <= hi; m++) marks.push(m);

    // Diameters are normalised to the largest mark: with sizes spanning three
    // orders of magnitude, any fixed px scale saturates and the top dots all
    // look identical. Relative scale keeps every step distinguishable.
    const bands = this.quakes.uniforms.uMagBand.value;
    const maxSz = Math.max(...marks.map(magSize), 1e-6);

    $('legend-mags').innerHTML = marks.map((m, i) => {
      const sz = magSize(m);
      const px = sz <= 0 ? 0 : Math.max(2, 20 * sz / maxSz).toFixed(1);
      const label = i === marks.length - 1 ? `M${m}+` : `M${m}`;
      const off = sz <= 0 || bands[m - 1] !== 1;
      return `<span${off ? ' style="opacity:.35"' : ''}><i style="--d:${px}px"></i>${label}</span>`;
    }).join('');
  }

  renderLegend() {
    const mode = this.state.colorMode;
    const ramp = $('legend-ramp');
    const ticksEl = $('legend-ticks');
    const put = (stops, marks, fmt) => {
      const lo = stops[0][0], hi = stops[stops.length - 1][0];
      ramp.style.background = cssGradient(stops);
      ramp.style.display = '';
      ticksEl.innerHTML = marks
        .map((v) => `<span style="left:${((v - lo) / (hi - lo) * 100).toFixed(2)}%">${fmt(v)}</span>`)
        .join('');
    };

    if (mode === 0) {
      $('legend-title').textContent = t('깊이 (km)');
      put(DEPTH_STOPS, [0, 70, 150, 300, 700], (v) => v);
    } else if (mode === 1) {
      $('legend-title').textContent = t('규모 (M)');
      put(MAG_STOPS, [3, 5, 6, 7, 9], (v) => v);
    } else if (mode === 2) {
      $('legend-title').textContent = t('경과 시간');
      const y0 = +this.meta.time_start.slice(0, 4);
      const y1 = +this.meta.time_end.slice(0, 4);
      put(TIME_STOPS, [0, 0.25, 0.5, 0.75, 1],
        (f) => Math.round(y0 + (y1 - y0) * f));
    } else {
      $('legend-title').textContent = t('밀도 (균일 색)');
      ramp.style.display = 'none';
      ticksEl.innerHTML = '<span style="left:0">겹칠수록 밝아집니다 — 발광 합성 권장</span>';
    }
  }

  /* ── time + stats ───────────────────────────────────────── */

  syncTime() {
    const s = this.state;
    const win = s.mode === 'window' ? s.windowDays : null;
    this.quakes.setTime(s.now, win, s.rangeStart);
    this.globe?.layer?.setTime(s.now, win, s.rangeStart);
    this.timeline.set(s.now, win, [s.rangeStart, s.rangeEnd]);

    const at = this.daysToDate(s.now);
    $('tl-date').textContent = fmtDate(at);
    const fromDays = win == null ? s.rangeStart : Math.max(s.rangeStart, s.now - win);
    $('tl-range').textContent =
      `${fmtISO(this.daysToDate(fromDays))} → ${fmtISO(at)} UTC · `
      + `${t(win == null ? '누적' : '이동 구간')}`;
    // The header carries the selected period on phones, where the sub-line
    // about sources has no room and the range is what you keep adjusting.
    $('m-span').textContent = `${fmtISO(this.daysToDate(s.rangeStart))} ~ `
      + `${fmtISO(this.daysToDate(s.rangeEnd))}`;

    this.statsDue = true;
    this.dirty = true;
  }

  updateStats() {
    const layer = this.view === 'globe' && this.globe?.layer
      ? this.globe.layer : this.quakes;
    const { count, peak, energy } = layer.summarize();
    $('stat-visible').textContent = nf.format(count);
    $('stat-max').textContent = peak ? `M${peak.mag.toFixed(1)}` : '–';

    if (window.innerWidth <= 700) {
      $('dr-visible').textContent = nf.format(count);
      $('dr-max').textContent = peak ? `M${peak.mag.toFixed(1)}` : '–';
    }

    this.feed?.render();
    this.statsDue = false;
  }


  /* ── pointer ────────────────────────────────────────────── */

  bindPointer() {
    const tip = $('tip');
    let hoverAt = 0;
    let downX = 0, downY = 0;

    this.canvas.addEventListener('pointermove', (ev) => {
      // A pick sweeps the whole visible range, so it is throttled hard and
      // skipped during playback where the range is changing every frame anyway.
      if (this.view !== 'japan') { tip.hidden = true; return; }
      if (this.state.playing) { tip.hidden = true; return; }
      const t = performance.now();
      if (t - hoverAt < 110) return;
      hoverAt = t;

      const i = this.picker.pick(ev.clientX, ev.clientY);
      if (i == null) { tip.hidden = true; this.canvas.style.cursor = ''; return; }

      const e = this.data.events;
      tip.hidden = false;
      tip.style.left = `${ev.clientX}px`;
      tip.style.top = `${ev.clientY}px`;
      tip.innerHTML = `<b>M${e.mag[i].toFixed(1)}</b> · ${Math.round(e.depth[i])}km`
        + ` · ${fmtISO(this.data.dateAt(i))}`;
      this.canvas.style.cursor = 'pointer';
    });

    this.canvas.addEventListener('pointerleave', () => { tip.hidden = true; });

    this.canvas.addEventListener('pointerdown', (ev) => {
      downX = ev.clientX; downY = ev.clientY;
    });
    this.canvas.addEventListener('pointerup', (ev) => {
      // Anything beyond a few pixels of travel was an orbit drag, not a click.
      if (this.view !== 'japan') return;
      if (Math.hypot(ev.clientX - downX, ev.clientY - downY) > 5) return;
      const i = this.picker.pick(ev.clientX, ev.clientY);
      if (i == null) return;
      this.marker.show(i, this.quakes.positions);
      this.feed.setSelected(i);
      this.showCard(i);
      this.dirty = true;
    });
  }

  showCard(i) {
    const e = this.data.events;
    const at = this.data.dateAt(i);
    const jst = new Date(at.getTime() + 9 * 3600000);
    const src = this.data.sourceOf(i);

    $('card').hidden = false;
    $('card-mag').textContent = `M${e.mag[i].toFixed(1)}`;
    $('card-magtype').textContent = this.data.magTypeOf(i) || '규모';
    $('card-place').textContent = this.data.placeOf(i) || '(이름 없음)';
    $('card-utc').textContent = `${fmtISO(at)} ${fmtClock(at)}`;
    $('card-jst').textContent = `${fmtISO(jst)} ${fmtClock(jst)}`;
    $('card-depth').textContent = `${e.depth[i].toFixed(1)} km`;
    $('card-loc').textContent = `${e.lat[i].toFixed(3)}°N ${e.lon[i].toFixed(3)}°E`;

    const link = $('card-link');
    const url = this.data.urlOf(i);
    if (url) {
      link.href = url;
      link.textContent = src === 'isc' ? 'ISC 상세 페이지 ↗' : 'USGS 상세 페이지 ↗';
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  }

  /* ── loop ───────────────────────────────────────────────── */

  start() {
    this.syncTime();
    this.updateStats();
    this.clock = new THREE.Clock();
    let statAt = 0;

    const frame = () => {
      requestAnimationFrame(frame);
      const dt = Math.min(0.1, this.clock.getDelta());
      const s = this.state;

      if (s.playing) {
        s.now += s.speed * dt;
        if (s.now >= s.rangeEnd) {
          if (s.loop) s.now = s.rangeStart;
          else { s.now = s.rangeEnd; this.setPlaying(false); }
        }
        this.syncTime();
      }

      // The globe runs its own scene/camera and animates continuously; it
      // shares the playhead, filters and stats with the Japan view.
      if (this.view === 'globe' && this.globe) {
        const tg = performance.now();
        if (this.statsDue && tg - statAt > 110) { statAt = tg; this.updateStats(); }
        this.globe.sync(this.quakes, s);
        this.globe.update(dt);
        this.renderer.render(this.globe.scene, this.globe.camera);
        return;
      }

      if (this.controls.autoRotate) this.dirty = true;
      if (this.marker.tick(dt)) this.dirty = true;
      if (this.stepFly()) this.dirty = true;
      this.controls.update();

      const t = performance.now();
      if (this.statsDue && t - statAt > 110) { statAt = t; this.updateStats(); }

      if (this.dirty) {
        this.dirty = false;
        this.labels.update(this.camera, this.viewInsets());
        this.renderer.render(this.scene, this.camera);
      }
    };
    frame();

    requestAnimationFrame(() => {
      $('loader').classList.add('done');
      setTimeout(() => $('loader').remove(), 600);
      setTimeout(() => this.maybeShowGestureGuide(), 800);
    });
  }

  /**
   * First-visit touch primer: animated pinch-to-zoom and two-finger-pan cards
   * over the map. Touch devices and tablet-or-smaller widths only, once.
   */
  maybeShowGestureGuide() {
    const KEY = 'jq4d.gestureGuideSeen';
    const touchy = window.matchMedia('(pointer: coarse)').matches
      || window.innerWidth <= 1024;
    if (!touchy) return;
    try { if (localStorage.getItem(KEY)) return; } catch { /* private mode */ }

    const el = $('gguide');
    el.hidden = false;
    const close = () => {
      el.hidden = true;
      try { localStorage.setItem(KEY, '1'); } catch { /* nothing to do */ }
    };
    $('gg-close').addEventListener('click', close);
    el.addEventListener('pointerdown', (ev) => {
      if (ev.target === el) close();       // tapping the dim backdrop works too
    });
  }
}

/* ══════════════════════════════════════════════════════════════ */
/* small DOM helpers                                              */

/** Segmented control. `initial` selects a button by data-v and fires once. */
function seg(root, onPick, initial) {
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    onPick(btn.dataset.v);
  });
  const start = (initial != null && root.querySelector(`button[data-v="${initial}"]`))
    || root.querySelector('button.on')
    || root.querySelector('button');
  if (start) {
    root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === start));
    onPick(start.dataset.v);
  }
}

/** Chip row. Never fires on bind -- chips are shortcuts, not state. */
function chips(root, onPick) {
  root.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button');
    if (!btn) return;
    root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
    onPick(btn);
  });
}

/** Highlight whichever chip satisfies `test`, clearing the rest. */
function markChip(root, test) {
  if (!root) return;
  root.querySelectorAll('button').forEach((b) => b.classList.toggle('on', !!test(b)));
}

/** Clamp a persisted range to something usable for this catalogue. */
function sanitizeRange(range, total) {
  if (!Array.isArray(range) || range.length !== 2 || !range.every(Number.isFinite)) {
    return [0, total];
  }
  const a = clamp(Math.min(range[0], range[1]), 0, total - MIN_SPAN_DAYS);
  const b = clamp(Math.max(range[0], range[1]), a + MIN_SPAN_DAYS, total);
  return [a, b];
}

function slider(id, onInput) {
  const el = $(id);
  const fire = () => onInput(+el.value);
  el.addEventListener('input', fire);
  fire();
}

function check(id, onChange) {
  const el = $(id);
  el.addEventListener('change', () => onChange(el.checked));
  onChange(el.checked);
}

/** Paint the selected span of a dual-range track. */
function fillTrack(track, lo, hi, min, max) {
  const f = (v) => ((v - min) / (max - min)) * 100;
  track.style.setProperty('--lo', `${f(lo).toFixed(2)}%`);
  track.style.setProperty('--hi', `${(100 - f(hi)).toFixed(2)}%`);
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const pad = (n) => String(n).padStart(2, '0');

const fmtISO = (d) =>
  `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const fmtClock = (d) => `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
const fmtDateKo = (d) =>
  `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`;

// Started last so every helper above is initialised before the app builds.
initLang();
boot();
