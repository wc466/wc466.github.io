import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// ---------------------------------------------------------------- personal links
// Fill these in; buttons with an empty value are hidden.
const CONFIG = {
  linkedin: '',            // e.g. 'https://www.linkedin.com/in/your-handle'
};
for (const el of document.querySelectorAll('[data-todo]')) {
  const v = CONFIG[el.dataset.todo];
  if (v) el.href = v; else el.remove();
}

const manifest = await fetch('assets/data/manifest.json').then(r => r.json());
const css = getComputedStyle(document.documentElement);
const cssColor = name => new THREE.Color(css.getPropertyValue(name).trim());

// ---------------------------------------------------------------- data
const cache = new Map();
function loadCloud(meta) {
  if (!cache.has(meta.file)) {
    cache.set(meta.file, fetch(meta.file).then(r => r.arrayBuffer()).then(buf => {
      const n = meta.count;
      const q = new Int16Array(buf, 0, n * 3);
      const pos = new Float32Array(n * 3);
      for (let i = 0; i < pos.length; i++) pos[i] = q[i] / 100;
      const labels = meta.labels ? new Uint8Array(buf, n * 6, n) : null;
      return { pos, labels, n };
    }));
  }
  return cache.get(meta.file);
}

function makePoints({ pos, n }, colorFn, size) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    colorFn(i, pos[3 * i], pos[3 * i + 1], pos[3 * i + 2], c);
    col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = new THREE.PointsMaterial({ size, vertexColors: true, sizeAttenuation: true });
  return new THREE.Points(geo, mat);
}

// three-stop gradient for elevation colouring
function ramp(stops) {
  const cs = stops.map(s => new THREE.Color(s));
  return (t, out) => {
    t = Math.min(1, Math.max(0, t)) * (cs.length - 1);
    const i = Math.min(cs.length - 2, Math.floor(t));
    return out.copy(cs[i]).lerp(cs[i + 1], t - i);
  };
}

// Resolve once an element is within ~1 screen of the viewport, so each demo only downloads its data
// when the visitor scrolls toward it (keeps the first page load light on phones).
function whenNear(el) {
  return new Promise(resolve => {
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { io.disconnect(); resolve(); } },
      { rootMargin: '100% 0px' });
    io.observe(el);
  });
}

// ---------------------------------------------------------------- viewer
class Viewer {
  constructor(el, { cam, target, fov = 50, autoRotate = false, zoom = true }) {
    this.el = el;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    el.appendChild(this.renderer.domElement);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(fov, 1, 0.05, 500);
    this.camera.up.set(0, 0, 1);                    // LiDAR frame: z is up
    this.camera.position.set(...cam);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(...target);
    this.controls.enableDamping = true;
    this.controls.autoRotate = autoRotate;
    this.controls.autoRotateSpeed = 0.35;
    // Don't hijack page scrolling: wheel-zoom only after the user grabs the viewer.
    this.controls.enableZoom = false;
    if (zoom) {
      el.addEventListener('pointerdown', () => { this.controls.enableZoom = true; });
      el.addEventListener('pointerleave', () => { this.controls.enableZoom = false; });
    }
    this.controls.update();
    this.ticks = [];
    this.visible = false;
    new ResizeObserver(() => this.resize()).observe(el);
    new IntersectionObserver(([e]) => { this.visible = e.isIntersecting; }, { rootMargin: '100px' }).observe(el);
    this.resize();
    const loop = t => {
      requestAnimationFrame(loop);
      if (!this.visible) return;
      this.ticks.forEach(f => f(t));
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }
  resize() {
    const { clientWidth: w, clientHeight: h } = this.el;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
  done() { this.el.querySelector('.loading')?.remove(); }
}

function boxLines(xmin, xmax, ymin, ymax, zmin, zmax, color, opacity = 0.9) {
  const g = new THREE.BoxGeometry(xmax - xmin, ymax - ymin, zmax - zmin);
  const l = new THREE.LineSegments(new THREE.EdgesGeometry(g),
    new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  l.position.set((xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2);
  return l;
}

function vehicleMarker(scale = 1) {
  // a small arrow on the ground at the sensor origin pointing along +x
  const shape = new THREE.Shape();
  shape.moveTo(0.9, 0); shape.lineTo(-0.5, 0.55); shape.lineTo(-0.2, 0); shape.lineTo(-0.5, -0.55); shape.closePath();
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape),
    new THREE.MeshBasicMaterial({ color: cssColor('--accent'), side: THREE.DoubleSide }));
  m.position.z = -1.9;
  m.scale.setScalar(scale);
  return m;
}

// ---------------------------------------------------------------- hero
if (document.getElementById('hero-view')) {
  const v = new Viewer(document.getElementById('hero-view'),
    { cam: [-26, -30, 16], target: [4, 0, -2], fov: 45, autoRotate: true, zoom: false });
  v.controls.enablePan = false;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) v.controls.autoRotate = false;
  // shift the scan right on wide screens so the text sits on empty space
  const shift = () => { v.camera.setViewOffset(1000, 1000, innerWidth > 900 ? -220 : 0, innerWidth > 900 ? 0 : 160, 1000, 1000); };
  // light page: deep colours that fade into the background with range
  const r = ramp(['#17325f', '#2f6fdb', '#0e8f7e', '#6cc9b8']);
  const bg = cssColor('--bg');
  loadCloud(manifest.scene).then(d => {
    v.scene.add(makePoints(d, (i, x, y, z, c) => {
      r((z + 2.3) / 4.5, c);
      c.lerp(bg, Math.min(0.6, Math.hypot(x, y) / 70));
    }, 0.11));
    v.scene.add(vehicleMarker());
    v.done();
  });
  v.resize = (orig => function () { orig.call(this); shift(); this.camera.updateProjectionMatrix(); })(v.resize);
  v.resize();
}

// ---------------------------------------------------------------- 1. cost map stepper
const STAGES = [
  { k: 'density', label: '1 · density', cap: 'Points per 5 cm cell of the 5-frame stack (log scale). Note the dark gaps 6–8 m ahead: nothing came back from inside the holes.' },
  { k: 'fine', label: '2 · fine elevation', cap: 'Mean height per 5 cm cell. Empty cells are filled with their nearest observed neighbour (a CUDA kernel in the original code).' },
  { k: 'coarse', label: '3 · terrain trend', cap: 'Mean height on a coarse 2 m grid, cubic-interpolated back to 5 cm. This is the "expected" ground, slopes included. (The dark strip on the left is outside the coarse grid, so it is never scored.)' },
  { k: 'disc', label: '4 · residual', cap: 'Fine minus trend (blue = below, red = above). Cells beyond ±12 cm are highlighted in yellow — the far walls of the holes light up.' },
  { k: 'occl', label: '5 · LiDAR shadow', cap: 'Grey = observed, black = no returns. Orange = empty cells within 40 cm in front of a flagged wall: the occlusion a hole casts toward the sensor.' },
  { k: 'final', label: '6 · cost map', cap: 'Residual ∪ shadow, isolated cells eroded away, then dilated by 2 cells as a safety margin. Red cells are untraversable.' },
];
if (document.getElementById('stage-tabs')) {
  const cm = manifest.costmap;
  const tabs = document.getElementById('stage-tabs');
  const img = document.getElementById('cm-img');
  const cap = document.getElementById('stage-caption');
  const slider = document.getElementById('cm-slider');
  const label = document.getElementById('cm-frames');
  const play = document.getElementById('cm-play');
  const spark = document.getElementById('cm-spark');
  let stage = 5, win = cm.best ?? 16, timer = null;
  slider.max = cm.windows.length - 1;

  STAGES.forEach((s, i) => {
    const b = document.createElement('button');
    b.textContent = s.label;
    b.setAttribute('role', 'tab');
    b.onclick = () => { stage = i; update(); };
    tabs.appendChild(b);
  });

  const maxF = Math.max(...cm.windows.map(w => w.flagged_cells), 1);
  const bw = 420 / cm.windows.length;
  spark.innerHTML = cm.windows.map((w, i) => {
    const h = Math.max(1.5, (w.flagged_cells / maxF) * 42);
    return `<rect data-i="${i}" x="${i * bw + 1}" y="${46 - h}" width="${bw - 2}" height="${h}" rx="1.5"/>`;
  }).join('');
  spark.addEventListener('click', e => { const i = e.target.dataset?.i; if (i) { win = +i; stop(); update(); } });

  function update() {
    const s = STAGES[stage], w = cm.windows[win];
    img.src = `assets/img/costmap/w${String(win).padStart(2, '0')}_${s.k}.png`;
    cap.textContent = s.cap;
    slider.value = win;
    label.textContent = `frames ${w.frames[0]}–${w.frames[1]} · ${w.flagged_cells} cells flagged`;
    [...tabs.children].forEach((b, i) => { b.classList.toggle('on', i === stage); b.setAttribute('aria-selected', i === stage); });
    [...spark.children].forEach((r, i) => r.setAttribute('fill', i === win ? 'var(--hazard)' : '#2a3a4c'));
  }
  function stop() { clearInterval(timer); timer = null; play.textContent = '▶'; }
  slider.oninput = () => { win = +slider.value; stop(); update(); };
  play.onclick = () => {
    if (timer) return stop();
    play.textContent = '❚❚';
    timer = setInterval(() => { win = (win + 1) % cm.windows.length; update(); }, 260);
  };
  update();

  // warm the cache so scrubbing is smooth
  const warm = () => cm.windows.forEach((_, i) => STAGES.forEach(s => {
    new Image().src = `assets/img/costmap/w${String(i).padStart(2, '0')}_${s.k}.png`;
  }));
  whenNear(img).then(() => setTimeout(warm, 800));
}

// ---------------------------------------------------------------- 1b. stacked cloud
if (document.getElementById('negobs-view')) {
  const el = document.getElementById('negobs-view');
  const v = new Viewer(el, { cam: [0.2, -4.2, 0.6], target: [6.6, 0.4, -2], fov: 50 });
  const hazard = cssColor('--hazard');
  const r = ramp(['#2d3b4d', '#7d8ea3', '#c9d6e3']);
  whenNear(el).then(() => loadCloud(manifest.costmap.cloud)).then(d => {
    let zmin = Infinity, zmax = -Infinity;
    for (let i = 2; i < d.pos.length; i += 3) { zmin = Math.min(zmin, d.pos[i]); zmax = Math.max(zmax, d.pos[i]); }
    const pts = makePoints(d, (i, x, y, z, c) => {
      if (d.labels[i]) c.copy(hazard); else r((z - zmin) / (zmax - zmin), c);
    }, 0.04);
    v.scene.add(pts);
    v.scene.add(vehicleMarker(0.45));
    v.done();
    const w = manifest.costmap.windows[manifest.costmap.best];
    document.getElementById('negobs-cap').textContent =
      `frames ${w.frames[0]}–${w.frames[1]} · ${d.n.toLocaleString()} points · drag to orbit, click then scroll to zoom`;
  });
}

// ---------------------------------------------------------------- 2. ICP
if (document.getElementById('icp-view')) {
  const icp = manifest.icp;
  const el = document.getElementById('icp-view');
  const v = new Viewer(el, { cam: [-3.5, -0.5, 16], target: [6, 0, -2], fov: 50 });
  const palette = ['#c792ea', '#6aa8ff', '#3ee0c5', '#ffd166', '#ff6b6b'];   // oldest -> newest
  const slider = document.getElementById('icp-slider');
  const runBtn = document.getElementById('icp-run');
  const legend = document.getElementById('icp-legend');
  const picker = document.getElementById('icp-runs');

  const [x0, x1, y0, y1, z0, z1] = icp.roi;
  v.scene.add(boxLines(x0, x1, y0, y1, z0, z1, 0xffffff, 0.5));
  v.scene.add(vehicleMarker());

  const group = new THREE.Group();
  v.scene.add(group);
  let objs = [], dots = [], poses = [], token = 0;
  const qI = new THREE.Quaternion(), tmpQ = new THREE.Quaternion(), tmpT = new THREE.Vector3(), one = new THREE.Vector3(1, 1, 1);

  function setBlend(a) {
    objs.forEach((o, i) => {
      tmpQ.slerpQuaternions(qI, poses[i].q, a);
      tmpT.copy(poses[i].t).multiplyScalar(a);
      o.matrix.compose(tmpT, tmpQ, one);
      o.matrixWorldNeedsUpdate = true;
      // sensor origin of scan i, i.e. where the vehicle was
      dots[i].position.set(tmpT.x, tmpT.y, -1.85);
      dots[i].material.opacity = a;
    });
  }

  async function loadRun(ri) {
    const run = icp.runs[ri], my = ++token;
    [...picker.children].forEach((b, i) => b.classList.toggle('on', i === ri));
    legend.innerHTML = run.frames.map((f, i) => `<i style="--c:${palette[i]}"></i>${f.frame}`).join(' ');
    el.insertAdjacentHTML('beforeend', '<div class="loading mono">loading 5 scans…</div>');
    const ds = await Promise.all(run.frames.map(loadCloud));
    if (my !== token) return;
    group.clear();
    objs = []; dots = []; poses = [];
    ds.forEach((d, i) => {
      const col = new THREE.Color(palette[i]);
      const p = makePoints(d, (_, x, y, z, c) => { c.copy(col); }, 0.06);
      p.matrixAutoUpdate = false;
      const m = new THREE.Matrix4().fromArray(run.frames[i].pose).transpose(); // row-major -> three.js
      const q = new THREE.Quaternion(), t = new THREE.Vector3(), s = new THREE.Vector3();
      m.decompose(t, q, s);
      poses.push({ q, t });
      objs.push(p);
      group.add(p);
      const dot = new THREE.Mesh(new THREE.CircleGeometry(0.09, 20),
        new THREE.MeshBasicMaterial({ color: col, transparent: true }));
      dots.push(dot);
      group.add(dot);
    });
    v.done();
    slider.value = 0;
    runBtn.textContent = 'Run ICP ▶';
    setBlend(0);

    // stats
    document.getElementById('stat-drift').textContent = `${run.travel.toFixed(2)} m`;
    document.getElementById('icp-travel-cap').textContent = `${run.travel.toFixed(2)} m`;
    document.getElementById('stat-err').textContent = `${(run.wall_err * 100).toFixed(1)} cm`;
    const counts = [...run.roi_counts].reverse();                      // newest first
    const cum = counts.map((_, i) => counts.slice(0, i + 1).reduce((a, b) => a + b, 0));
    document.getElementById('stat-density').textContent = `${(cum.at(-1) / counts[0]).toFixed(1)}×`;
    document.getElementById('icp-bars').innerHTML = '<div class="title mono">points in detection region</div>' +
      cum.map((c, i) => `<div class="row mono"><span>${i ? `+${i} older` : 'newest'}</span>
        <div><div class="bar" style="width:${(c / cum.at(-1) * 100).toFixed(1)}%;--c:${palette[4 - i]}"></div></div>
        <span>${(c / 1000).toFixed(1)}k</span></div>`).join('');
  }

  icp.runs.forEach((r, i) => {
    const b = document.createElement('button');
    b.textContent = `${r.frames[0].frame}–${r.frames.at(-1).frame} · ${r.title}`;
    b.onclick = () => loadRun(i);
    picker.appendChild(b);
  });

  slider.oninput = () => setBlend(slider.value / 1000);
  let anim = null;
  runBtn.onclick = () => {
    const from = +slider.value, to = from > 500 ? 0 : 1000, t0 = performance.now();
    runBtn.textContent = to ? 'Reset ◀' : 'Run ICP ▶';
    cancelAnimationFrame(anim);
    const step = now => {
      const k = Math.min(1, (now - t0) / 1600), ease = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      slider.value = from + (to - from) * ease;
      setBlend(slider.value / 1000);
      if (k < 1) anim = requestAnimationFrame(step);
    };
    anim = requestAnimationFrame(step);
  };
  whenNear(el).then(() => loadRun(0));
}

// ---------------------------------------------------------------- 3. ground segmentation
if (document.getElementById('ground-view')) {
  const g = { ...manifest.ground, diff: manifest.ground_diff };
  const el = document.getElementById('ground-view');
  const v = new Viewer(el, { cam: [-34, -26, 22], target: [4, 0, -2], fov: 50 });
  const gc = cssColor('--ground'), nc = cssColor('--nonground');
  const diffCols = ['#33404f', '#33404f', '#6aa8ff', '#ff4d5e', '#1a222c'].map(c => new THREE.Color(c));
  const objs = {};
  const fmt = n => n.toLocaleString();
  const set = (i, num, lbl) => {
    document.getElementById(`g-${i}`).textContent = num;
    document.getElementById(`g-${i}l`).textContent = lbl;
  };
  const legend = document.getElementById('ground-legend');
  function show(k) {
    Object.entries(objs).forEach(([kk, o]) => { o.visible = kk === k; });
    const m = g[k];
    if (k === 'diff') {
      legend.innerHTML = '<i style="--c:#ff4d5e"></i>only GndNet: ground <i style="--c:#6aa8ff"></i>only SqueezeSegV3: ground <i style="--c:#33404f"></i>agree';
      set(1, `${(100 * m.agree).toFixed(1)}%`, 'of matched points get the same label from both methods');
      set(2, fmt(m.only_gndnet), 'points GndNet calls ground that SqueezeSegV3 rejects');
      set(3, fmt(m.only_v3), 'points SqueezeSegV3 calls ground that GndNet rejects');
    } else {
      legend.innerHTML = '<i style="--c:var(--ground)"></i>ground <i style="--c:var(--nonground)"></i>non-ground';
      set(1, fmt(m.ground), 'points labelled ground');
      set(2, fmt(m.nonground), 'points labelled non-ground');
      set(3, `${(100 * m.ground / (m.ground + m.nonground)).toFixed(0)}%`, 'ground share of the scan');
    }
    document.querySelectorAll('#ground-toggle button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
  }
  whenNear(el).then(() => Promise.all(Object.keys(g).map(k => loadCloud(g[k]).then(d => {
    objs[k] = makePoints(d, (i, x, y, z, c) => {
      const fade = Math.max(0.3, 1 - Math.hypot(x, y) / 70);
      if (k === 'diff') c.copy(diffCols[d.labels[i]]).multiplyScalar(d.labels[i] >= 2 && d.labels[i] < 4 ? 1 : fade);
      else c.copy(d.labels[i] ? gc : nc).multiplyScalar(fade);
    }, 0.08);
    v.scene.add(objs[k]);
  })))).then(() => { v.scene.add(vehicleMarker()); v.done(); show('v3'); });
  document.querySelectorAll('#ground-toggle button').forEach(b => b.onclick = () => show(b.dataset.k));
}

// ---------------------------------------------------------------- 4. live Patchwork-style segmentation
// Smallest-eigenvalue eigenvector of a symmetric 3x3 covariance (cyclic Jacobi), oriented z-up.
function planeNormal(xx, xy, xz, yy, yz, zz) {
  const a = [[xx, xy, xz], [xy, yy, yz], [xz, yz, zz]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 10; sweep++) {
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-12) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = (th >= 0 ? 1 : -1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { const kp = a[k][p], kq = a[k][q]; a[k][p] = c * kp - s * kq; a[k][q] = s * kp + c * kq; }
      for (let k = 0; k < 3; k++) { const pk = a[p][k], qk = a[q][k]; a[p][k] = c * pk - s * qk; a[q][k] = s * pk + c * qk; }
      for (let k = 0; k < 3; k++) { const kp = v[k][p], kq = v[k][q]; v[k][p] = c * kp - s * kq; v[k][q] = s * kp + c * kq; }
    }
  }
  let i = 0;
  if (a[1][1] < a[i][i]) i = 1;
  if (a[2][2] < a[i][i]) i = 2;
  const sgn = v[2][i] < 0 ? -1 : 1;
  return [sgn * v[0][i], sgn * v[1][i], sgn * v[2][i]];
}

// PCA plane through the centroid of pos[idx[0..n)]
function fitPlane(pos, idx, n) {
  let mx = 0, my = 0, mz = 0;
  for (let k = 0; k < n; k++) { const j = 3 * idx[k]; mx += pos[j]; my += pos[j + 1]; mz += pos[j + 2]; }
  mx /= n; my /= n; mz /= n;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let k = 0; k < n; k++) {
    const j = 3 * idx[k], x = pos[j] - mx, y = pos[j + 1] - my, z = pos[j + 2] - mz;
    xx += x * x; xy += x * y; xz += x * z; yy += y * y; yz += y * z; zz += z * z;
  }
  return { c: [mx, my, mz], n: planeNormal(xx, xy, xz, yy, yz, zz) };
}

function segmentCZM(pos, count, { rings, sectors, thr, seeded, rmin = 2.7, rmax = 80 }) {
  const nb = rings * sectors, bin = new Int32Array(count), start = new Int32Array(nb + 1);
  for (let i = 0; i < count; i++) {
    const x = pos[3 * i], y = pos[3 * i + 1], r = Math.hypot(x, y);
    if (r < rmin || r >= rmax) { bin[i] = -1; continue; }
    const ri = Math.floor((r - rmin) / (rmax - rmin) * rings);
    const si = Math.floor((Math.atan2(y, x) + Math.PI) / (2 * Math.PI) * sectors) % sectors;
    bin[i] = ri * sectors + si;
    start[bin[i] + 1]++;
  }
  for (let b = 0; b < nb; b++) start[b + 1] += start[b];
  const order = new Int32Array(count), fill = start.slice(0, nb);
  for (let i = 0; i < count; i++) if (bin[i] >= 0) order[fill[bin[i]]++] = i;

  const label = new Uint8Array(count), tmp = new Int32Array(count);
  let fits = 0;
  const dist = (pl, j) => Math.abs((pos[3 * j] - pl.c[0]) * pl.n[0] + (pos[3 * j + 1] - pl.c[1]) * pl.n[1] + (pos[3 * j + 2] - pl.c[2]) * pl.n[2]);
  for (let b = 0; b < nb; b++) {
    const idx = order.subarray(start[b], start[b + 1]), n = idx.length;
    if (n < 10) continue;
    let pl;
    if (!seeded) {
      pl = fitPlane(pos, idx, n); fits++;
    } else {
      // seeds: points within 30 cm of the mean of the lowest 10 % (Patchwork's R-GPF idea)
      const zs = Float32Array.from(idx, j => pos[3 * j + 2]).sort();
      const k = Math.max(10, Math.floor(n / 10));
      let low = 0;
      for (let t = 0; t < k; t++) low += zs[t];
      low /= k;
      let m = 0;
      for (const j of idx) if (pos[3 * j + 2] < low + 0.3) tmp[m++] = j;
      for (let it = 0; it < 3 && m >= 3; it++) {
        pl = fitPlane(pos, tmp, m); fits++;
        m = 0;
        for (const j of idx) if (dist(pl, j) < thr) tmp[m++] = j;
      }
      if (m < 3) continue;
      pl = fitPlane(pos, tmp, m); fits++;
      if (pl.n[2] < 0.7) continue;                 // uprightness: reject steep "ground" (walls)
    }
    for (const j of idx) if (dist(pl, j) < thr) label[j] = 1;
  }
  return { label, fits };
}

if (document.getElementById('pw-view')) {
  const el = document.getElementById('pw-view');
  const v = new Viewer(el, { cam: [-30, -24, 22], target: [6, 0, -2], fov: 50 });
  const gc = cssColor('--ground'), nc = cssColor('--nonground'), tmp = new THREE.Color();
  const ui = id => document.getElementById(id);
  const ctl = { rings: ui('pw-rings'), sectors: ui('pw-sectors'), thr: ui('pw-thr'), seeded: ui('pw-seeded') };
  const presets = [
    ['Plain PCA · 10 rings', { rings: 10, sectors: 1, thr: 0.1, seeded: false }],
    ['+ 16 sectors', { rings: 10, sectors: 16, thr: 0.1, seeded: false }],
    ['+ seeded refinement', { rings: 10, sectors: 16, thr: 0.15, seeded: true }],
  ];
  const pbox = ui('pw-presets');
  presets.forEach(([name, p]) => {
    const b = document.createElement('button');
    b.textContent = name;
    b.onclick = () => { setControls(p); run(); };
    pbox.appendChild(b);
  });
  function setControls(p) {
    ctl.rings.value = p.rings; ctl.sectors.value = p.sectors; ctl.thr.value = p.thr; ctl.seeded.checked = p.seeded;
  }
  const params = () => ({ rings: +ctl.rings.value, sectors: +ctl.sectors.value, thr: +ctl.thr.value, seeded: ctl.seeded.checked });

  let data = null, points = null, grid = null, pending = false;
  function drawGrid({ rings, sectors }, rmin = 2.7, rmax = 80) {
    if (grid) { v.scene.remove(grid); grid.geometry.dispose(); }
    const seg = [], z = -1.95;
    for (let i = 0; i <= rings; i++) {
      const r = rmin + (rmax - rmin) * i / rings;
      for (let a = 0; a < 128; a++) {
        const t0 = a / 128 * 2 * Math.PI, t1 = (a + 1) / 128 * 2 * Math.PI;
        seg.push(r * Math.cos(t0), r * Math.sin(t0), z, r * Math.cos(t1), r * Math.sin(t1), z);
      }
    }
    if (sectors > 1) for (let s = 0; s < sectors; s++) {
      const t = -Math.PI + s / sectors * 2 * Math.PI;
      seg.push(rmin * Math.cos(t), rmin * Math.sin(t), z, rmax * Math.cos(t), rmax * Math.sin(t), z);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(seg, 3));
    grid = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color: 0x6aa8ff, transparent: true, opacity: 0.22 }));
    v.scene.add(grid);
  }
  function run() {
    if (!data || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const p = params();
      ui('pw-rings-v').textContent = p.rings;
      ui('pw-sectors-v').textContent = p.sectors;
      ui('pw-thr-v').textContent = `${p.thr.toFixed(2)} m`;
      const t0 = performance.now();
      const { label, fits } = segmentCZM(data.pos, data.n, p);
      const ms = performance.now() - t0;
      const col = points.geometry.attributes.color;
      let g = 0, low = 0, lowG = 0;
      for (let i = 0; i < data.n; i++) {
        const x = data.pos[3 * i], y = data.pos[3 * i + 1], z = data.pos[3 * i + 2];
        tmp.copy(label[i] ? gc : nc).multiplyScalar(Math.max(0.3, 1 - Math.hypot(x, y) / 70));
        col.setXYZ(i, tmp.r, tmp.g, tmp.b);
        g += label[i];
        if (z < -1.6) { low++; lowG += label[i]; }
      }
      col.needsUpdate = true;
      drawGrid(p);
      ui('pw-share').textContent = `${(100 * g / data.n).toFixed(0)}%`;
      ui('pw-low').textContent = `${(100 * lowG / low).toFixed(0)}%`;
      ui('pw-ms').textContent = `${ms.toFixed(0)} ms`;
      ui('pw-bins').textContent = fits.toLocaleString();
      const cur = JSON.stringify(p);
      [...pbox.children].forEach((b, i) => b.classList.toggle('on', JSON.stringify(presets[i][1]) === cur));
    });
  }
  Object.values(ctl).forEach(c => c.addEventListener('input', run));
  setControls(presets[2][1]);
  whenNear(el).then(() => loadCloud(manifest.patchwork)).then(d => {
    data = d;
    points = makePoints(d, (i, x, y, z, c) => c.copy(nc), 0.08);
    v.scene.add(points);
    v.scene.add(vehicleMarker());
    v.done();
    run();
  });
}

// ---------------------------------------------------------------- 5. Patchwork (ROS) sequence
if (document.getElementById('pwros-view')) {
  const pw = manifest.pwseq;
  const el = document.getElementById('pwros-view');
  const v = new Viewer(el, { cam: [-22, -20, 18], target: [8, 0, -2], fov: 50 });
  const gc = cssColor('--ground'), nc = cssColor('--nonground'), out = new THREE.Color('#2a3440');
  // Patchwork verdict colours: upright, flat-enough, too-high, too-tilted, globally-too-high
  const stCol = { 0: '#3ee0c5', 1: '#4fbf7a', 2: '#6aa8ff', 3: '#ff4d5e', 4: '#c792ea' };
  const slider = document.getElementById('pwros-slider'), play = document.getElementById('pwros-play');
  const showPatches = document.getElementById('pwros-patches');
  slider.max = pw.frames.length - 1;
  v.scene.add(vehicleMarker());

  // one triangle mesh per verdict, rebuilt per frame from patch geometry
  const patchGroup = new THREE.Group();
  v.scene.add(patchGroup);
  const z = -pw.sensor_height - 0.05;
  const patchList = [];
  for (let zi = 0; zi < 4; zi++)
    for (let r = 0; r < pw.rings[zi]; r++)
      for (let s = 0; s < pw.sectors[zi]; s++) {
        const r0 = pw.mins[zi] + r * pw.ring_sizes[zi], r1 = r0 + pw.ring_sizes[zi];
        const a0 = s * 2 * Math.PI / pw.sectors[zi], a1 = (s + 1) * 2 * Math.PI / pw.sectors[zi];
        patchList.push([r0, r1, a0, a1]);
      }
  function patchMesh(ids, color, opacity) {
    const pos = [];
    for (const i of ids) {
      const [r0, r1, a0, a1] = patchList[i], n = 4, shrink = 0.04;
      for (let k = 0; k < n; k++) {
        const b0 = a0 + (a1 - a0) * (k / n), b1 = a0 + (a1 - a0) * ((k + 1) / n);
        const q = [[r0 + shrink, b0], [r1 - shrink, b0], [r1 - shrink, b1], [r0 + shrink, b1]].map(([r, a]) => [r * Math.cos(a), r * Math.sin(a), z]);
        pos.push(...q[0], ...q[1], ...q[2], ...q[0], ...q[2], ...q[3]);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  }

  let points = null, cur = -1, timer = null;
  async function show(k) {
    cur = k;
    const f = pw.frames[k];
    const d = await loadCloud(f);
    if (cur !== k) return;
    if (points) { v.scene.remove(points); points.geometry.dispose(); }
    points = makePoints(d, (i, x, y, zz, c) => {
      const l = d.labels[i];
      c.copy(l === 1 ? gc : l === 0 ? nc : out).multiplyScalar(Math.max(0.35, 1 - Math.hypot(x, y) / 55));
    }, 0.07);
    v.scene.add(points);
    patchGroup.children.forEach(m => m.geometry.dispose());
    patchGroup.clear();
    for (const [st, col] of Object.entries(stCol)) {
      const ids = f.status.flatMap((s, i) => (s === +st ? [i] : []));
      if (ids.length) patchGroup.add(patchMesh(ids, col, st === '0' || st === '1' ? 0.12 : 0.45));
    }
    v.done();
    slider.value = k;
    document.getElementById('pwros-frame').textContent = `frame ${f.frame}`;
    document.getElementById('pwros-share').textContent = `${Math.round(100 * f.ground_share)}%`;
    document.getElementById('pwros-up').textContent = f.status.filter(s => s === 0 || s === 1).length;
    document.getElementById('pwros-tilt').textContent = f.status.filter(s => s === 3).length;
    // prefetch the next frame
    if (pw.frames[k + 1]) loadCloud(pw.frames[k + 1]);
  }
  showPatches.onchange = () => { patchGroup.visible = showPatches.checked; };
  const stop = () => { clearInterval(timer); timer = null; play.textContent = '▶'; };
  slider.oninput = () => { stop(); show(+slider.value); };
  play.onclick = () => {
    if (timer) return stop();
    play.textContent = '❚❚';
    timer = setInterval(() => show((cur + 1) % pw.frames.length), 700);
  };
  whenNear(el).then(() => show(0));
}

// ---------------------------------------------------------------- 3. geometry: scan-line model
if (document.getElementById('geo-svg')) {
  const svg = document.getElementById('geo-svg');
  const ui = id => document.getElementById(id);
  const inp = { H: ui('geo-H'), W: ui('geo-W'), R: ui('geo-R'), T: ui('geo-T') };
  // OS1-128 beams: +20.94° .. -21.4° in the sensor frame, mount pitched down 15°
  const BEAMS = Array.from({ length: 128 }, (_, i) => (20.94 - i * (42.34 / 127) - 15) * Math.PI / 180);
  const PIT_D = 0.6;                                  // drawn pit depth ("deep" relative to d)
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, parent = svg) => {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
    parent.appendChild(e);
    return e;
  };

  function draw() {
    const H = +inp.H.value, W = +inp.W.value, R = +inp.R.value, T = +inp.T.value;
    ui('geo-H-v').textContent = `${H.toFixed(2)} m`;
    ui('geo-W-v').textContent = `${W.toFixed(2)} m`;
    ui('geo-R-v').textContent = `${R.toFixed(1)} m`;
    ui('geo-T-v').textContent = `${T.toFixed(2)} m`;
    const d = H * W / R, dVis = Math.min(d, PIT_D), rmax = H * W / T;

    // world -> svg (vertical exaggeration so a 0.2 m pit is visible next to a 20 m range)
    const xmax = Math.max(R + W + 2.5, 7), x0 = -0.8;
    const sx = 960 / (xmax - x0), ytop = H + 0.35, ybot = -PIT_D - 0.15;
    const sy = 300 / (ytop - ybot);
    const X = x => 20 + (x - x0) * sx, Y = y => 15 + (ytop - y) * sy;
    svg.innerHTML = '';

    // beams
    let wall = 0;
    const hits = [];
    for (const a of BEAMS) {
      if (a >= -1e-4) continue;
      const t = Math.tan(-a), xg = H / t;               // where the beam meets the y=0 plane
      let hx, hy, kind;
      if (xg < R || xg > R + W) { hx = xg; hy = 0; kind = 'g'; }
      else {
        const yWall = H - (R + W) * t;                  // height when reaching the back wall
        if (yWall >= -PIT_D) { hx = R + W; hy = yWall; kind = 'w'; wall++; }
        else { hx = (H + PIT_D) / t; hy = -PIT_D; kind = 'f'; }
      }
      if (hx > xmax) { hx = xmax; hy = H - xmax * t; kind = 'out'; }
      el('line', { x1: X(0), y1: Y(H), x2: X(hx), y2: Y(hy), stroke: kind === 'w' || kind === 'f' ? '#0e8f7e' : '#b8c4d2',
        'stroke-width': kind === 'w' || kind === 'f' ? 1.3 : 0.6, opacity: kind === 'w' || kind === 'f' ? 0.9 : 0.45 });
      if (kind !== 'out') hits.push([hx, hy, kind]);
    }

    // occluded region inside the pit (below the critical scan line)
    el('polygon', { points: [[R, 0], [R + W, -dVis], [R + W, -PIT_D], [R, -PIT_D]].map(([x, y]) => `${X(x)},${Y(y)}`).join(' '),
      fill: '#e5384b', opacity: 0.12 });
    // terrain profile
    el('polyline', { points: [[x0, 0], [R, 0], [R, -PIT_D], [R + W, -PIT_D], [R + W, 0], [xmax, 0]].map(([x, y]) => `${X(x)},${Y(y)}`).join(' '),
      fill: 'none', stroke: '#121a24', 'stroke-width': 2 });
    // critical scan line through the leading edge
    el('line', { x1: X(0), y1: Y(H), x2: X(R + W), y2: Y(-d), stroke: '#e5384b', 'stroke-width': 1.6, 'stroke-dasharray': '6 4' });
    // hit points
    for (const [x, y, k] of hits) el('circle', { cx: X(x), cy: Y(y), r: k === 'g' ? 1.6 : 3, fill: k === 'g' ? '#8a9bb0' : '#0e8f7e' });
    // vehicle + sensor
    el('rect', { x: X(-0.75), y: Y(H * 0.55), width: 0.9 * sx, height: (H * 0.55) * sy - 3, rx: 4, fill: '#dfe5ec' });
    el('line', { x1: X(0), y1: Y(H), x2: X(0), y2: Y(H * 0.55), stroke: '#9aa8b8', 'stroke-width': 3 });
    el('circle', { cx: X(0), cy: Y(H), r: 6, fill: '#121a24' });

    // annotations
    const label = (x, y, text, color = '#364354', anchor = 'middle') => {
      const t = el('text', { x, y, fill: color, 'font-size': 13, 'font-family': 'JetBrains Mono, monospace', 'text-anchor': anchor });
      t.textContent = text;
    };
    label(X(0) + 12, Y(H) + 4, `H = ${H.toFixed(2)} m`, '#121a24', 'start');
    label((X(0) + X(R)) / 2, Y(0) + 18, `R = ${R.toFixed(1)} m`);
    label((X(R) + X(R + W)) / 2, Y(-PIT_D) + 16, `W = ${W.toFixed(2)}`);
    label(X(R + W) + 8, Y(-dVis / 2) + 4, `d = ${d.toFixed(3)} m`, '#e5384b', 'start');
    label(990, 22, `vertical ×${(sy / sx).toFixed(1)}`, '#66758a', 'end');

    ui('geo-d').textContent = `${(100 * d).toFixed(1)} cm`;
    ui('geo-rmax').textContent = `${rmax.toFixed(1)} m`;
    ui('geo-hits').textContent = wall;
    const v = ui('geo-verdict');
    v.textContent = d >= T ? 'detectable' : 'below threshold';
    v.className = `verdict ${d >= T ? 'ok' : 'no'}`;
  }
  Object.values(inp).forEach(i => i.addEventListener('input', draw));
  draw();
}

// ---------------------------------------------------------------- 3b. traffic cone: points vs range
if (document.getElementById('cone-chart')) {
  const data = manifest.cone;
  const chart = document.getElementById('cone-chart'), front = document.getElementById('cone-front');
  const slider = document.getElementById('cone-slider'), play = document.getElementById('cone-play');
  const read = document.getElementById('cone-read');
  slider.max = data.length - 1;
  const A = 0.146, dv = 42.34 / 127 * Math.PI / 180, dh = 2 * Math.PI / 2048;   // silhouette m², beam spacing
  const model = r => A / (r * r * dv * dh);
  const [rx0, rx1, ny1] = [8, 26, 110];
  const X = r => 50 + (r - rx0) / (rx1 - rx0) * 570, Y = n => 260 - n / ny1 * 235;

  let html = '';
  for (let n = 0; n <= 100; n += 25) html += `<line x1="50" x2="620" y1="${Y(n)}" y2="${Y(n)}" stroke="#e2e6ec"/><text x="42" y="${Y(n) + 4}" font-size="11" text-anchor="end" fill="#66758a" font-family="JetBrains Mono">${n}</text>`;
  for (let r = 8; r <= 26; r += 2) html += `<text x="${X(r)}" y="280" font-size="11" text-anchor="middle" fill="#66758a" font-family="JetBrains Mono">${r}</text>`;
  html += `<text x="335" y="297" font-size="11" text-anchor="middle" fill="#66758a">range to cone (m)</text>`;
  html += `<text x="14" y="140" font-size="11" text-anchor="middle" fill="#66758a" transform="rotate(-90 14 140)">points on cone</text>`;
  const curve = [];
  for (let r = rx0; r <= rx1; r += 0.2) curve.push(`${X(r)},${Y(Math.min(ny1, model(r)))}`);
  html += `<polyline points="${curve.join(' ')}" fill="none" stroke="#2f6fdb" stroke-width="2" stroke-dasharray="5 4"/>`;
  html += `<text x="${X(10.6)}" y="${Y(model(10.6)) - 8}" font-size="12" fill="#2f6fdb" font-family="JetBrains Mono">model ∝ 1/R²</text>`;
  html += data.map((f, i) => `<circle data-i="${i}" cx="${X(f.range)}" cy="${Y(f.n)}" r="4" fill="#0e8f7e" opacity="0.75"/>`).join('');
  chart.innerHTML = html;
  const dots = [...chart.querySelectorAll('circle')];
  chart.addEventListener('click', e => { const i = e.target.dataset?.i; if (i) { stop(); show(+i); } });

  function show(i) {
    const f = data[i];
    slider.value = i;
    dots.forEach((d, k) => { d.setAttribute('r', k === i ? 7 : 4); d.setAttribute('fill', k === i ? '#e5384b' : '#0e8f7e'); });
    read.textContent = `${f.range.toFixed(1)} m · ${f.n} pts`;
    // front view: lateral (y) vs height (z), in cm; guide = 28" cone outline
    let s = `<polygon points="-14,0 14,0 3,71 -3,71" fill="none" stroke="#2c3b4d" stroke-dasharray="2 2"/>`;
    s += `<line x1="-60" x2="60" y1="0" y2="0" stroke="#2c3b4d"/>`;
    for (let k = 0; k < f.pts.length; k += 3) s += `<circle cx="${-f.pts[k + 1]}" cy="${f.pts[k + 2]}" r="1.6" fill="#f0a03a"/>`;
    front.innerHTML = `<g transform="translate(0 80) scale(1 -1)">${s}</g>`;
  }
  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; play.textContent = '▶'; };
  slider.oninput = () => { stop(); show(+slider.value); };
  play.onclick = () => {
    if (timer) return stop();
    play.textContent = '❚❚';
    timer = setInterval(() => show((+slider.value + 1) % data.length), 180);
  };
  show(0);
}

// ---------------------------------------------------------------- figures lightbox
if (document.getElementById('lightbox')) {
  const lb = document.getElementById('lightbox');
  const open = f => { lb.querySelector('img').src = f.querySelector('img').src; lb.querySelector('p').textContent = f.dataset.cap || ''; lb.hidden = false; };
  document.querySelectorAll('.fig').forEach(f => {
    f.tabIndex = 0;
    f.addEventListener('click', () => open(f));
    f.addEventListener('keydown', e => { if (e.key === 'Enter') open(f); });
  });
  lb.onclick = () => { lb.hidden = true; };
  addEventListener('keydown', e => { if (e.key === 'Escape') lb.hidden = true; });
}
