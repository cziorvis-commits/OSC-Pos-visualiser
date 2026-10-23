// three.js scene: stage grid/box, tracker markers, labels and fading trails.
// Stage coords from the bridge: x = across stage, y = upstage (depth), z = height, metres.
// three.js is Y-up, so stage (x, y, z) -> three (x, z, -y): the default camera sits
// in the audience looking upstage.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from './vendor/CSS2DRenderer.js';

const PALETTE = [
  0x58a6ff, 0xf778ba, 0x3fb950, 0xd29922, 0xa371f7, 0xff7b72,
  0x39c5cf, 0xe3b341, 0x8ddb8c, 0xffa657, 0xbc8cff, 0x79c0ff,
];
const STALE_COLOR = new THREE.Color(0x555b66);
const MAX_TRAIL_POINTS = 600;

function toThree(p, out = new THREE.Vector3()) {
  return out.set(p.x, p.z, -p.y);
}

function makeTextLabel(text, className = 'label') {
  const el = document.createElement('div');
  el.className = className;
  el.textContent = text;
  return new CSS2DObject(el);
}

export function createScene(container) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  container.appendChild(renderer.domElement);

  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.position = 'absolute';
  labelRenderer.domElement.style.inset = '0';
  labelRenderer.domElement.style.pointerEvents = 'none';
  container.appendChild(labelRenderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e1116);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x223344, 2.2));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(5, 12, 8);
  scene.add(sun);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;

  const stageGroup = new THREE.Group();
  scene.add(stageGroup);
  let stageCentre = new THREE.Vector3();
  let stageSize = 10;

  const trackers = new Map();
  let trailsOn = true;

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h);
    labelRenderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);
  resize();

  function setStage(stage = {}) {
    const { width = 14, depth = 10, height = 8, origin = 'downstage-centre' } = stage;
    stageGroup.clear();
    const y0 = origin === 'centre' ? -depth / 2 : 0;

    // Stage-coordinate extents, converted into three space.
    const min = toThree({ x: -width / 2, y: y0, z: 0 });
    const max = toThree({ x: width / 2, y: y0 + depth, z: height });
    const box = new THREE.Box3().setFromPoints([min, max]);
    stageCentre = box.getCenter(new THREE.Vector3());
    stageSize = Math.max(width, depth);

    const gridSize = Math.ceil(stageSize + 6);
    const grid = new THREE.GridHelper(gridSize, gridSize, 0x3a4250, 0x1e242d);
    stageGroup.add(grid);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({ color: 0x1b2330, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(stageCentre.x, 0.001, stageCentre.z);
    stageGroup.add(floor);

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
      new THREE.LineBasicMaterial({ color: 0x4b5566, transparent: true, opacity: 0.5 }),
    );
    outline.position.copy(stageCentre);
    stageGroup.add(outline);

    // Downstage edge highlighted so orientation is obvious at a glance.
    const dsEdge = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        toThree({ x: -width / 2, y: y0, z: 0 }),
        toThree({ x: width / 2, y: y0, z: 0 }),
      ]),
      new THREE.LineBasicMaterial({ color: 0xd29922 }),
    );
    stageGroup.add(dsEdge);

    const axes = new THREE.AxesHelper(1);
    stageGroup.add(axes);
    const labels = [
      ['origin', { x: 0, y: 0, z: 0 }],
      ['+X', { x: width / 2 + 0.6, y: y0 + depth / 2, z: 0 }],
      ['−X', { x: -width / 2 - 0.6, y: y0 + depth / 2, z: 0 }],
      ['Upstage +Y', { x: 0, y: y0 + depth + 0.6, z: 0 }],
      ['Downstage / audience', { x: 0, y: y0 - 0.6, z: 0 }],
    ];
    for (const [text, p] of labels) {
      const l = makeTextLabel(text, 'label stage-label');
      toThree(p, l.position);
      stageGroup.add(l);
    }
  }

  function resetView() {
    const d = stageSize;
    camera.position.set(stageCentre.x, d * 0.9, stageCentre.z + d * 1.7);
    controls.target.copy(stageCentre).setY(0);
    controls.update();
  }

  function topView() {
    camera.position.set(stageCentre.x, stageSize * 1.6, stageCentre.z + 0.001);
    controls.target.copy(stageCentre).setY(0);
    controls.update();
  }

  function createTracker(id) {
    const color = new THREE.Color(PALETTE[trackers.size % PALETTE.length]);
    const group = new THREE.Group();

    const headMat = new THREE.MeshStandardMaterial({ color, roughness: 0.4 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.15, 24, 16), headMat);
    group.add(head);

    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    const poleMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), poleMat);
    scene.add(pole);

    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    const label = new CSS2DObject(labelEl);
    label.position.set(0, 0.25, 0);
    group.add(label);

    const trailPos = new Float32Array(MAX_TRAIL_POINTS * 3);
    const trailCol = new Float32Array(MAX_TRAIL_POINTS * 4);
    const trailGeom = new THREE.BufferGeometry();
    trailGeom.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    trailGeom.setAttribute('color', new THREE.BufferAttribute(trailCol, 4).setUsage(THREE.DynamicDrawUsage));
    trailGeom.setDrawRange(0, 0);
    const trail = new THREE.Line(trailGeom, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true }));
    trail.frustumCulled = false;
    scene.add(trail);

    scene.add(group);
    const t = {
      id, color, group, head, headMat, ring, ringMat, pole, poleMat, label, labelEl,
      trail, trailGeom, trailPos, trailCol,
      history: [], // { v: Vector3, t }
      lastSeen: 0,
      stale: false,
      stage: { x: 0, y: 0, z: 0 },
    };
    trackers.set(id, t);
    return t;
  }

  function updateTracker(id, p, name, now) {
    const t = trackers.get(id) || createTracker(id);
    t.stage = p;
    t.lastSeen = now;
    const v = toThree(p);
    t.group.position.copy(v);
    t.ring.position.set(v.x, 0.002, v.z);
    const pp = t.pole.geometry.attributes.position;
    pp.setXYZ(0, v.x, 0, v.z);
    pp.setXYZ(1, v.x, v.y, v.z);
    pp.needsUpdate = true;

    const last = t.history[t.history.length - 1];
    if (!last || last.v.distanceToSquared(v) > 1e-4 || now - last.t > 50) {
      t.history.push({ v, t: now });
      if (t.history.length > MAX_TRAIL_POINTS) t.history.shift();
    }
    t.labelEl.innerHTML = `${name ?? id} <small>${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}</small>`;
  }

  function setStale(t, stale) {
    if (t.stale === stale) return;
    t.stale = stale;
    const c = stale ? STALE_COLOR : t.color;
    t.headMat.color.copy(c);
    t.ringMat.color.copy(c);
    t.poleMat.color.copy(c);
    t.labelEl.classList.toggle('stale', stale);
  }

  function updateTrail(t, now, trailMs) {
    while (t.history.length && now - t.history[0].t > trailMs) t.history.shift();
    const n = trailsOn ? t.history.length : 0;
    const c = t.stale ? STALE_COLOR : t.color;
    for (let i = 0; i < n; i++) {
      const h = t.history[i];
      t.trailPos.set([h.v.x, h.v.y, h.v.z], i * 3);
      const a = 1 - (now - h.t) / trailMs;
      t.trailCol.set([c.r, c.g, c.b, Math.max(0, a) * 0.9], i * 4);
    }
    t.trailGeom.attributes.position.needsUpdate = true;
    t.trailGeom.attributes.color.needsUpdate = true;
    t.trailGeom.setDrawRange(0, n);
  }

  // Called every animation frame.
  function render(now, { trailSeconds = 3, staleMs = 1500 } = {}) {
    let live = 0;
    for (const t of trackers.values()) {
      setStale(t, now - t.lastSeen > staleMs);
      if (!t.stale) live++;
      updateTrail(t, now, trailSeconds * 1000);
    }
    controls.update();
    renderer.render(scene, camera);
    labelRenderer.render(scene, camera);
    return { total: trackers.size, live };
  }

  function setTrails(on) {
    trailsOn = on;
  }

  function relabel(names = {}) {
    for (const t of trackers.values()) {
      const p = t.stage;
      t.labelEl.innerHTML = `${names[t.id] ?? t.id} <small>${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}</small>`;
    }
  }

  setStage();
  resetView();

  return { setStage, resetView, topView, updateTracker, render, setTrails, relabel };
}
