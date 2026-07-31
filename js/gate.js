/**
 * Entry gate: a particle-ring lock screen (password) followed by a typed
 * greeting, in the spirit of theuniverse.kr. Purely cosmetic -- the app keeps
 * booting behind the overlay, so the data is usually ready by the time the
 * visitor gets through. The password lives in client code: this is a curtain,
 * not security.
 */

const PASSWORD = 'earthquake';
const TYPED_LINES = ['Hello visitor.', 'Welcome to Earthquake 4D.'];

const gate = document.getElementById('gate');

// Same-tab reloads skip the ceremony; a fresh tab sees it again.
if (sessionStorage.getItem('gateOpen') === '1') {
  gate.remove();
} else {
  runGate();
}

function runGate() {
  // While the curtain is up, keep the app's global shortcuts (space, arrows)
  // from driving the scene behind it. Capture phase + registered before
  // main.js binds its own window listener.
  window.addEventListener('keydown', (ev) => {
    if (!gate.isConnected) return;
    if (ev.target instanceof Element && ev.target.closest('#gate')) return;
    ev.stopPropagation();
  }, true);

  const stopFx = startRing(document.getElementById('gate-fx'));

  const form = document.getElementById('gate-form');
  const pass = document.getElementById('gate-pass');
  pass.focus();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    if (pass.value.trim().toLowerCase() !== PASSWORD) {
      pass.value = '';
      pass.classList.remove('shake');
      void pass.offsetWidth;               // restart the animation
      pass.classList.add('shake');
      return;
    }
    stopFx();
    document.getElementById('gate-lock').classList.add('hide');
    const hello = document.getElementById('gate-hello');
    hello.classList.remove('hide');
    typeLines(document.getElementById('gate-typed'), TYPED_LINES, () => {
      document.getElementById('gate-enter').classList.remove('hide');
    });
  });

  document.getElementById('gate-enter').addEventListener('click', () => {
    sessionStorage.setItem('gateOpen', '1');
    gate.classList.add('closing');
    setTimeout(() => gate.remove(), 750);
  });
}

/** Character-by-character typing with a natural, slightly uneven rhythm. */
function typeLines(el, lines, onDone) {
  let li = 0;
  let ci = 0;
  const tick = () => {
    if (li >= lines.length) { onDone(); return; }
    const line = lines[li];
    if (ci === 0 && li > 0) el.appendChild(document.createElement('br'));
    if (ci < line.length) {
      el.appendChild(document.createTextNode(line[ci]));
      ci++;
      setTimeout(tick, 45 + Math.random() * 60);
    } else {
      li++; ci = 0;
      setTimeout(tick, 420);               // beat between lines
    }
  };
  setTimeout(tick, 350);
}

/**
 * The slowly revolving ring of green sparks. A triangular radius distribution
 * gives the soft inner hole and frayed outer edge; each spark twinkles on its
 * own phase. Returns a stop() that halts the rAF loop.
 */
function startRing(canvas) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  let w = 0, h = 0, cx = 0, cy = 0, R = 0;

  const resize = () => {
    w = canvas.width = Math.round(innerWidth * dpr);
    h = canvas.height = Math.round(innerHeight * dpr);
    cx = w / 2; cy = h / 2;
    R = Math.min(w, h) * 0.36;
  };
  resize();
  window.addEventListener('resize', resize);

  const N = 1700;
  const parts = Array.from({ length: N }, () => ({
    a: Math.random() * Math.PI * 2,
    // sum of three uniforms ~ bell curve: dense mid-ring, sparse edges
    r: 1 + (Math.random() + Math.random() + Math.random() - 1.5) * 0.36,
    s: (0.6 + Math.random() * 1.4) * dpr,
    tw: Math.random() * Math.PI * 2,
    twSp: 0.0008 + Math.random() * 0.0022,
    sp: (0.02 + Math.random() * 0.06) / 1000,   // rad/ms, slow drift
    hue: 68 + Math.random() * 42,                // yellow-green range
  }));

  let alive = true;
  const frame = (t) => {
    if (!alive) return;
    ctx.clearRect(0, 0, w, h);
    for (const p of parts) {
      const ang = p.a + t * p.sp;
      const x = cx + Math.cos(ang) * R * p.r;
      const y = cy + Math.sin(ang) * R * p.r * 0.96;
      const al = 0.18 + 0.62 * (0.5 + 0.5 * Math.sin(t * p.twSp + p.tw));
      ctx.fillStyle = `hsla(${p.hue}, 75%, 62%, ${al.toFixed(3)})`;
      ctx.fillRect(x, y, p.s, p.s);
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);

  return () => {
    alive = false;
    window.removeEventListener('resize', resize);
    ctx.clearRect(0, 0, w, h);             // the greeting sits on pure black
  };
}
