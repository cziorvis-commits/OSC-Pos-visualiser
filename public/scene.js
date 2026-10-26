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

  // stageGroup holds what stays at the tracking origin (grid, axes); floorGroup holds
  // the floor, outline and stage labels, and is placed by stage.position / stage.rotation.
  const stageGroup = new THREE.Group();
  scene.add(stageGroup);
  const floorGroup = new THREE.Group();
  scene.add(floorGroup);
  let floorMesh = null;
  let stageCentre = new THREE.Vector3();
  let stageSize = 10;
  let placement = { position: [0, 0], rotation: 0 };
  let currentStage = {};
  let size = { width: 3.66, depth: 3.66 };
  let onPlacementChange = () => {};

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
    const { width = 3.66, depth = 3.66, height = 3, origin = 'downstage-centre' } = stage;
    currentStage = stage;
    size = { width, depth };
    stageGroup.clear();
    floorGroup.clear();
    const y0 = origin === 'centre' ? -depth / 2 : 0;

    // Floor-local extents (origin point at 0,0), converted into three space.
    const min = toThree({ x: -width / 2, y: y0, z: 0 });
    const max = toThree({ x: width / 2, y: y0 + depth, z: height });
    const localCentre = new THREE.Box3().setFromPoints([min, max]).getCenter(new THREE.Vector3());
    stageSize = Math.max(width, depth);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshBasicMaterial({ color: editing ? 0x24364d : 0x1b2330, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(localCentre.x, 0.001, localCentre.z);
    floorGroup.add(floor);
    floorMesh = floor;

    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(width, height, depth)),
      new THREE.LineBasicMaterial({ color: 0x4b5566, transparent: true, opacity: 0.5 }),
    );
    outline.position.copy(localCentre);
    floorGroup.add(outline);

    // Downstage edge highlighted so orientation is obvious at a glance.
    const dsEdge = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([
        toThree({ x: -width / 2, y: y0, z: 0 }),
        toThree({ x: width / 2, y: y0, z: 0 }),
      ]),
      new THREE.LineBasicMaterial({ color: 0xd29922 }),
    );
    floorGroup.add(dsEdge);

    const labels = [
      ['+X', { x: width / 2 + 0.4, y: y0 + depth / 2, z: 0 }],
      ['−X', { x: -width / 2 - 0.4, y: y0 + depth / 2, z: 0 }],
      ['Upstage +Y', { x: 0, y: y0 + depth + 0.4, z: 0 }],
      ['Downstage', { x: 0, y: y0 - 0.4, z: 0 }],
    ];
    for (const [text, p] of labels) {
      const l = makeTextLabel(text, 'label stage-label');
      toThree(p, l.position);
      floorGroup.add(l);
    }

    // The tracking origin stays put while the floor moves.
    stageGroup.add(new THREE.AxesHelper(1));
    const originLabel = makeTextLabel('tracking origin', 'label stage-label');
    stageGroup.add(originLabel);

    floorGroup.userData.localCentre = localCentre;
    setPlacement({ position: stage.position, rotation: stage.rotation }, false);
  }

  // Place the floor in tracking space: position = [x, y] of the floor's origin point
  // (metres), rotation = degrees counter-clockwise seen from above.
  function setPlacement({ position = [0, 0], rotation = 0 } = {}, notify = true) {
    placement = { position: [Number(position[0]) || 0, Number(position[1]) || 0], rotation: Number(rotation) || 0 };
    const [px, py] = placement.position;
    floorGroup.position.copy(toThree({ x: px, y: py, z: 0 }));
    floorGroup.rotation.y = (placement.rotation * Math.PI) / 180;
    floorGroup.updateMatrixWorld();
    stageCentre = floorGroup.localToWorld(floorGroup.userData.localCentre.clone());

    // Grid on whole metres around the tracking origin, big enough to include the floor.
    stageGroup.children.filter((c) => c.isGridHelper).forEach((g) => stageGroup.remove(g));
    const reach = Math.max(Math.abs(stageCentre.x), Math.abs(stageCentre.z)) + stageSize;
    const gridSize = 2 * Math.ceil(reach + 2);
    stageGroup.add(new THREE.GridHelper(gridSize, gridSize, 0x3a4250, 0x1e242d));

    if (notify) onPlacementChange(getFloor());
  }

  function getPlacement() {
    return { position: [...placement.position], rotation: placement.rotation };
  }

  // Floor size plus placement, as edited in the floor panel.
  function getFloor() {
    return { ...size, ...getPlacement() };
  }

  function setSize(width, depth) {
    setStage({ ...currentStage, width, depth, ...getPlacement() });
    onPlacementChange(getFloor());
  }

  // ---- Move-floor mode: drag the floor across the ground plane ----
  let editing = false;
  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  let drag = null; // { start: Vector3 on ground, position: [x, y] at drag start }

  function groundPoint(ev) {
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    return { hitsFloor: raycaster.intersectObject(floorMesh).length > 0, point: raycaster.ray.intersectPlane(ground, new THREE.Vector3()) };
  }

  // Capture phase on the container so this runs before OrbitControls sees the press.
  container.addEventListener('pointerdown', (ev) => {
    if (!editing || ev.button !== 0) return;
    const { hitsFloor, point } = groundPoint(ev);
    if (!hitsFloor || !point) return;
    controls.enabled = false;
    drag = { start: point, position: [...placement.position] };
    renderer.domElement.setPointerCapture(ev.pointerId);
  }, true);

  renderer.domElement.addEventListener('pointermove', (ev) => {
    if (editing && !drag) renderer.domElement.style.cursor = groundPoint(ev).hitsFloor ? 'move' : '';
    if (!drag) return;
    const { point } = groundPoint(ev);
    if (!point) return;
    // three (x, z) -> stage (x, -y)
    const dx = point.x - drag.start.x;
    const dy = -(point.z - drag.start.z);
    setPlacement({ position: [drag.position[0] + dx, drag.position[1] + dy], rotation: placement.rotation });
  });

  renderer.domElement.addEventListener('pointerup', () => {
    if (!drag) return;
    drag = null;
    controls.enabled = true;
  });

  function setEditing(on) {
    editing = on;
    if (!on) renderer.domElement.style.cursor = '';
    floorMesh.material.color.set(on ? 0x24364d : 0x1b2330);
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
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.06, 24, 16), headMat);
    group.add(head);

    const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.08, 0.11, 32), ringMat);
    ring.rotation.x = -Math.PI / 2;
    scene.add(ring);

    const poleMat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.6 });
    const pole = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), poleMat);
    scene.add(pole);

    const labelEl = document.createElement('div');
    labelEl.className = 'label';
    const label = new CSS2DObject(labelEl);
    label.position.set(0, 0.1, 0);
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

  // The tracker's marker colour as CSS, so the Table view can match it.
  function colorOf(id) {
    const t = trackers.get(id);
    return t ? `#${(t.stale ? STALE_COLOR : t.color).getHexString()}` : 'transparent';
  }

  function relabel(names = {}) {
    for (const t of trackers.values()) {
      const p = t.stage;
      t.labelEl.innerHTML = `${names[t.id] ?? t.id} <small>${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}</small>`;
    }
  }

  setStage();
  resetView();

  return {
    setStage, setPlacement, getPlacement, getFloor, setSize, setEditing, resetView, topView, updateTracker, render, setTrails, relabel, colorOf,
    onPlacement(fn) { onPlacementChange = fn; },
  };
}
