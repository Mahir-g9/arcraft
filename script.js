console.log("guli guli")
/* ================================================================
   AR CRAFT — script.js
   A blocky, Minecraft-style AR building game.
   Real 3D cubes (Three.js), a WebXR hit-test AR path for supported
   devices, and a camera + device-orientation fallback for everyone
   else. No third-party game assets: every block texture below is
   generated at runtime on a <canvas>.
   ================================================================ */

/* ---------------------------------------------------------------
   0. CONFIG & GLOBAL STATE
   --------------------------------------------------------------- */
const GRID = 0.035;            // metres per block
const EYE_HEIGHT = 1.3;       // assumed phone height above the floor (fallback mode)
const REACH = 6;              // max metres the player can aim/build at

let currentARMode = null;     // 'xr' | 'fallback'
let worldPlaced = false;
let usingOrientationFallback = false;
let orientationSupported = false;
let currentFacingMode = 'environment';
let videoStream = null;
let xrSession = null, xrHitTestSource = null, xrRefSpace = null, lastHitPose = null;
let xrSupportedCache = null;
let selectedId = 'grass';
let currentTarget = null;

/* ---------------------------------------------------------------
   1. DOM REFERENCES
   --------------------------------------------------------------- */
const videoEl = document.getElementById('camera-feed');
const canvas = document.getElementById('three-canvas');

const startScreen = document.getElementById('start-screen');
const startBtn = document.getElementById('start-btn');
startBtn.disabled = false;
const supportNote = document.getElementById('support-note');

const placementScreen = document.getElementById('placement-screen');
const placementText = document.getElementById('placement-text');
const placeWorldBtn = document.getElementById('place-world-btn');

const errorScreen = document.getElementById('error-screen');
const errorText = document.getElementById('error-text');
const errorRetryBtn = document.getElementById('error-retry-btn');

const hud = document.getElementById('hud');
const modeBanner = document.getElementById('mode-banner');
const cameraSwitchBtn = document.getElementById('camera-switch-btn');
const selectedSwatchEl = document.getElementById('selected-block-swatch');
const selectedNameEl = document.getElementById('selected-block-name');
const helpBtn = document.getElementById('help-btn');
const mineBtn = document.getElementById('mine-btn');
const placeBtn = document.getElementById('place-btn');
const hotbarEl = document.getElementById('hotbar');
const moreBtn = document.getElementById('more-blocks-btn');
const toastEl = document.getElementById('toast');

const inventoryModal = document.getElementById('inventory-modal');
const inventoryGrid = document.getElementById('inventory-grid');
const closeInventoryBtn = document.getElementById('close-inventory-btn');

const helpModal = document.getElementById('help-modal');
const closeHelpBtn = document.getElementById('close-help-btn');

/* ---------------------------------------------------------------
   2. PROCEDURAL TEXTURE GENERATION
   (all block art is drawn on a canvas — no external image assets)
   --------------------------------------------------------------- */
function makeCanvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function finalizeTexture(c) {
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function makeNoiseTexture(base, variant, opts) {
  opts = opts || {};
  const size = 32, cell = opts.cell || 4, density = opts.density != null ? opts.density : 0.4;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = variant;
  const n = size / cell;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (Math.random() < density) ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  return finalizeTexture(c);
}

function makeGrassSideTexture() {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#8B5A2B';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#7A4B22';
  for (let y = 8; y < size; y += 4) {
    for (let x = 0; x < size; x += 4) {
      if (Math.random() < 0.35) ctx.fillRect(x, y, 4, 4);
    }
  }
  ctx.fillStyle = '#6CAD3F';
  ctx.fillRect(0, 0, size, 9);
  ctx.fillStyle = '#5C9A32';
  for (let x = 0; x < size; x += 4) {
    if (Math.random() < 0.6) ctx.fillRect(x, 5, 4, 4);
    if (Math.random() < 0.4) ctx.fillRect(x, 9, 4, 3);
  }
  return finalizeTexture(c);
}

function makePlanksTexture(base, dark) {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = dark;
  for (let y = 0; y < size; y += 8) ctx.fillRect(0, y, size, 1);
  for (let row = 0, y = 0; y < size; row++, y += 8) {
    const offset = row % 2 === 0 ? 0 : 4;
    for (let x = offset; x < size; x += 8) ctx.fillRect(x, y, 1, 8);
  }
  for (let i = 0; i < 40; i++) {
    if (Math.random() < 0.5) ctx.fillRect((Math.random() * size) | 0, (Math.random() * size) | 0, 1, 1);
  }
  return finalizeTexture(c);
}

function makeBricksTexture(base, mortar) {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = mortar;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = base;
  const bh = 7, bw = 15;
  for (let row = 0, y = 1; y < size; row++, y += bh + 1) {
    const offset = row % 2 === 0 ? 0 : Math.floor(bw / 2) + 1;
    for (let x = -bw + offset; x < size; x += bw + 1) ctx.fillRect(x, y, bw, bh);
  }
  return finalizeTexture(c);
}

function makeLogEndTexture(base, ring) {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = ring; ctx.fillRect(2, 2, 28, 28);
  ctx.fillStyle = base; ctx.fillRect(6, 6, 20, 20);
  ctx.fillStyle = ring; ctx.fillRect(10, 10, 12, 12);
  ctx.fillStyle = base; ctx.fillRect(13, 13, 6, 6);
  return finalizeTexture(c);
}

function makeLogSideTexture(base, dark) {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = base; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = dark;
  for (let x = 0; x < size; x += 5) ctx.fillRect(x, 0, 1, size);
  for (let i = 0; i < 30; i++) {
    if (Math.random() < 0.4) ctx.fillRect((Math.random() * size) | 0, (Math.random() * size) | 0, 1, 2);
  }
  return finalizeTexture(c);
}

function makeTntSideTexture() {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#C0392B'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#2b2b2b'; ctx.fillRect(0, 10, size, 2); ctx.fillRect(0, 20, size, 2);
  ctx.fillStyle = '#DCD3B2'; ctx.fillRect(0, 12, size, 8);
  ctx.fillStyle = '#1a1a1a';
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('TNT', size / 2, 19);
  return finalizeTexture(c);
}

function makeGlassTexture() {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = 'rgba(205,238,248,0.55)';
  ctx.fillRect(0, 0, size, size);
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, size - 2, size - 2);
  return finalizeTexture(c);
}

function makePumpkinSideTexture() {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#D9821B'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#9C5C10';
  for (let x = 0; x < size; x += 4) ctx.fillRect(x, 0, 1, size);
  ctx.fillStyle = '#2a1a05';
  ctx.fillRect(8, 10, 4, 4); ctx.fillRect(20, 10, 4, 4);
  ctx.fillRect(9, 20, 14, 4);
  return finalizeTexture(c);
}

function makeMelonTexture() {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#5C9A32'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#3E7A21';
  for (let x = 0; x < size; x += 4) ctx.fillRect(x, 0, 2, size);
  return finalizeTexture(c);
}

/* ---------------------------------------------------------------
   3. BLOCK REGISTRY
   --------------------------------------------------------------- */
const textureCache = {};
function cachedTex(key, gen) {
  if (!textureCache[key]) textureCache[key] = gen();
  return textureCache[key];
}

const BLOCK_DEFS = [
  { id: 'grass', name: 'Grass Block', faces: () => ({
      top: cachedTex('grass_top', () => makeNoiseTexture('#6CAD3F', '#5C9A32', { cell: 4, density: 0.35 })),
      bottom: cachedTex('dirt', () => makeNoiseTexture('#8B5A2B', '#7A4B22', { cell: 4, density: 0.4 })),
      side: cachedTex('grass_side', makeGrassSideTexture)
  })},
  { id: 'dirt', name: 'Dirt', faces: () => ({ all: cachedTex('dirt', () => makeNoiseTexture('#8B5A2B', '#7A4B22', { cell: 4, density: 0.4 })) })},
  { id: 'stone', name: 'Stone', faces: () => ({ all: cachedTex('stone', () => makeNoiseTexture('#8A8A8A', '#7C7C7C', { cell: 4, density: 0.4 })) })},
  { id: 'cobblestone', name: 'Cobblestone', faces: () => ({ all: cachedTex('cobble', () => makeNoiseTexture('#8C8C8C', '#65635F', { cell: 6, density: 0.5 })) })},
  { id: 'oak_log', name: 'Wood Log', faces: () => ({
      top: cachedTex('log_end', () => makeLogEndTexture('#C9A66B', '#8A6B3E')),
      bottom: cachedTex('log_end', () => makeLogEndTexture('#C9A66B', '#8A6B3E')),
      side: cachedTex('log_side', () => makeLogSideTexture('#6B4423', '#54341A'))
  })},
  { id: 'oak_planks', name: 'Oak Planks', faces: () => ({ all: cachedTex('planks', () => makePlanksTexture('#B98B4E', '#9A7038')) })},
  { id: 'leaves', name: 'Leaves', faces: () => ({ all: cachedTex('leaves', () => makeNoiseTexture('#4C8C3B', '#3E7A2E', { cell: 3, density: 0.5 })) })},
  { id: 'sand', name: 'Sand', faces: () => ({ all: cachedTex('sand', () => makeNoiseTexture('#E3D2A0', '#D6C28C', { cell: 4, density: 0.35 })) })},
  { id: 'gravel', name: 'Gravel', faces: () => ({ all: cachedTex('gravel', () => makeNoiseTexture('#96928C', '#716D67', { cell: 3, density: 0.5 })) })},
  { id: 'glass', name: 'Glass', transparent: true, opacity: 0.42, faces: () => ({ all: cachedTex('glass', makeGlassTexture) })},
  { id: 'obsidian', name: 'Obsidian', faces: () => ({ all: cachedTex('obsidian', () => makeNoiseTexture('#160424', '#0D0217', { cell: 4, density: 0.3 })) })},
  { id: 'iron_block', name: 'Iron Block', metal: true, faces: () => ({ all: cachedTex('iron', () => makeNoiseTexture('#E5E5E0', '#C9C9C2', { cell: 8, density: 0.2 })) })},
  { id: 'gold_block', name: 'Gold Block', metal: true, faces: () => ({ all: cachedTex('gold', () => makeNoiseTexture('#F6D94B', '#E0C13A', { cell: 8, density: 0.2 })) })},
  { id: 'diamond_block', name: 'Diamond Block', metal: true, faces: () => ({ all: cachedTex('diamond', () => makeNoiseTexture('#79EFE2', '#4FCFC2', { cell: 8, density: 0.2 })) })},
  { id: 'coal_block', name: 'Coal Block', faces: () => ({ all: cachedTex('coal', () => makeNoiseTexture('#232323', '#141414', { cell: 4, density: 0.35 })) })},
  { id: 'redstone_block', name: 'Redstone Block', emissive: '#7a140d', faces: () => ({ all: cachedTex('redstone', () => makeNoiseTexture('#B0231C', '#8E1B15', { cell: 4, density: 0.3 })) })},
  { id: 'bricks', name: 'Bricks', faces: () => ({ all: cachedTex('bricks', () => makeBricksTexture('#9C4A34', '#6B3123')) })},
  { id: 'snow', name: 'Snow', faces: () => ({ all: cachedTex('snow', () => makeNoiseTexture('#F5F8FA', '#E4EAEE', { cell: 4, density: 0.25 })) })},
  { id: 'ice', name: 'Ice', transparent: true, opacity: 0.7, faces: () => ({ all: cachedTex('ice', () => makeNoiseTexture('#BFE7F5', '#9FD3E8', { cell: 6, density: 0.25 })) })},
  { id: 'tnt', name: 'TNT', faces: () => ({
      top: cachedTex('tnt_top', () => makeNoiseTexture('#DCD3B2', '#C9BE95', { cell: 6, density: 0.25 })),
      bottom: cachedTex('tnt_top', () => makeNoiseTexture('#DCD3B2', '#C9BE95', { cell: 6, density: 0.25 })),
      side: cachedTex('tnt_side', makeTntSideTexture)
  })},
  { id: 'netherrack', name: 'Netherrack', faces: () => ({ all: cachedTex('netherrack', () => makeNoiseTexture('#6B2B2B', '#4E1F1F', { cell: 4, density: 0.4 })) })},
  { id: 'soul_sand', name: 'Soul Sand', faces: () => ({ all: cachedTex('soulsand', () => makeNoiseTexture('#4A3A2C', '#3A2D22', { cell: 4, density: 0.4 })) })},
  { id: 'end_stone', name: 'End Stone', faces: () => ({ all: cachedTex('endstone', () => makeNoiseTexture('#DDD9A6', '#CFCB96', { cell: 4, density: 0.3 })) })},
  { id: 'quartz_block', name: 'Quartz Block', faces: () => ({ all: cachedTex('quartz', () => makeNoiseTexture('#EDE8DD', '#DDD6C6', { cell: 4, density: 0.25 })) })},
  { id: 'bedrock', name: 'Bedrock', faces: () => ({ all: cachedTex('bedrock', () => makeNoiseTexture('#333333', '#1C1C1C', { cell: 4, density: 0.45 })) })},
  { id: 'glowstone', name: 'Glowstone', emissive: '#F5D27A', faces: () => ({ all: cachedTex('glowstone', () => makeNoiseTexture('#F5D27A', '#E0BB55', { cell: 4, density: 0.35 })) })},
  { id: 'clay', name: 'Clay', faces: () => ({ all: cachedTex('clay', () => makeNoiseTexture('#A9B3BD', '#96A0AA', { cell: 4, density: 0.3 })) })},
  { id: 'mossy_cobblestone', name: 'Mossy Cobblestone', faces: () => ({ all: cachedTex('mossy', () => makeNoiseTexture('#7C8C63', '#65635F', { cell: 6, density: 0.45 })) })},
  { id: 'pumpkin', name: 'Pumpkin', faces: () => ({
      top: cachedTex('pumpkin_top', () => makeNoiseTexture('#D9821B', '#C4740F', { cell: 4, density: 0.3 })),
      bottom: cachedTex('pumpkin_top', () => makeNoiseTexture('#D9821B', '#C4740F', { cell: 4, density: 0.3 })),
      side: cachedTex('pumpkin_side', makePumpkinSideTexture)
  })},
  { id: 'melon', name: 'Melon', faces: () => ({ all: cachedTex('melon', makeMelonTexture) })},
  { id: 'hay_bale', name: 'Hay Bale', faces: () => ({
      top: cachedTex('hay_top', () => makePlanksTexture('#E3C23C', '#C7A62E')),
      bottom: cachedTex('hay_top', () => makePlanksTexture('#E3C23C', '#C7A62E')),
      side: cachedTex('hay_side', () => makeLogSideTexture('#E3C23C', '#B99425'))
  })}
];

const TOOL_DEFS = [
  { id: 'flint_and_steel', name: 'Flint & Steel', isTool: true }
];

const DEFS_BY_ID = {};
BLOCK_DEFS.forEach(d => DEFS_BY_ID[d.id] = d);
TOOL_DEFS.forEach(d => DEFS_BY_ID[d.id] = d);

const HOTBAR_IDS = ['grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'glass', 'obsidian', 'flint_and_steel'];

const materialCache = {};
function getMaterials(id) {
  if (materialCache[id]) return materialCache[id];
  const def = DEFS_BY_ID[id];
  const faces = def.faces();
  const roughness = def.metal ? 0.35 : 0.95;
  const metalness = def.metal ? 0.85 : 0.02;
  function matFor(tex) {
    return new THREE.MeshStandardMaterial({
      map: tex,
      transparent: !!def.transparent,
      opacity: def.opacity != null ? def.opacity : 1,
      side: def.transparent ? THREE.DoubleSide : THREE.FrontSide,
      roughness, metalness,
      emissive: def.emissive ? new THREE.Color(def.emissive) : new THREE.Color(0, 0, 0),
      emissiveIntensity: def.emissive ? 0.55 : 0,
      emissiveMap: def.emissive ? tex : null
    });
  }
  let mats;
  if (faces.all) {
    const m = matFor(faces.all);
    mats = [m, m, m, m, m, m];
  } else {
    const top = matFor(faces.top);
    const bottom = matFor(faces.bottom || faces.top);
    const side = matFor(faces.side);
    mats = [side, side, top, bottom, side, side];
  }
  materialCache[id] = mats;
  return mats;
}

const swatchCache = {};
function swatchDataUrl(id) {
  if (swatchCache[id]) return swatchCache[id];
  const def = DEFS_BY_ID[id];
  const faces = def.faces();
  const tex = faces.all || faces.side || faces.top;
  const url = tex.image.toDataURL();
  swatchCache[id] = url;
  return url;
}

/* ---------------------------------------------------------------
   4. THREE.JS SCENE / RENDERER
   --------------------------------------------------------------- */
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0x000000, 0);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 0, 0);

const worldRoot = new THREE.Group();
scene.add(worldRoot);

const hemi = new THREE.HemisphereLight(0xffffff, 0x55503f, 0.95);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.05);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far = 15;
sun.shadow.camera.left = -4;
sun.shadow.camera.right = 4;
sun.shadow.camera.top = 4;
sun.shadow.camera.bottom = -4;
sun.shadow.bias = -0.003;
scene.add(sun);
scene.add(sun.target);

// Invisible plane so blocks cast soft contact shadows onto the real floor
const shadowPlane = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.32 }));
shadowPlane.rotation.x = -Math.PI / 2;
shadowPlane.receiveShadow = true;
worldRoot.add(shadowPlane);

function positionShadowLight() {
  sun.position.copy(worldRoot.position).add(new THREE.Vector3(3, 6, 2));
  sun.target.position.copy(worldRoot.position);
  sun.target.updateMatrixWorld();
}

// Ground-detection reticle (world space, shown while scanning in XR mode)
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.09, 0.13, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x7cbd4b, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
);
reticle.visible = false;
scene.add(reticle);

// Black 3D "aimed at" outline — transparent block with black edges
const aimOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(GRID * 1.02, GRID * 1.02, GRID * 1.02)),
  new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
);

aimOutline.visible = false;
worldRoot.add(aimOutline);

const blockGeometry = new THREE.BoxGeometry(GRID * 0.98, GRID * 0.98, GRID * 0.98);
const particleGeometry = new THREE.BoxGeometry(GRID * 0.18, GRID * 0.18, GRID * 0.18);

const clock = new THREE.Clock();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/* ---------------------------------------------------------------
   5. VOXEL WORLD — placing, mining, targeting
   --------------------------------------------------------------- */
const occupied = new Map();     // "ix,iy,iz" -> { typeId, mesh, ix, iy, iz }
const blockMeshList = [];       // flat array kept for fast raycasting

function cellKey(ix, iy, iz) { return ix + ',' + iy + ',' + iz; }
function cellType(ix, iy, iz) {
  const e = occupied.get(cellKey(ix, iy, iz));
  return e ? e.typeId : null;
}

function placeBlockAt(ix, iy, iz, typeId) {
  const k = cellKey(ix, iy, iz);
  if (occupied.has(k)) return false;
  const mesh = new THREE.Mesh(blockGeometry, getMaterials(typeId));
  mesh.position.set(ix * GRID, iy * GRID, iz * GRID);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.userData = { ix, iy, iz, typeId };
  worldRoot.add(mesh);
  blockMeshList.push(mesh);
  occupied.set(k, { typeId, mesh, ix, iy, iz });
  spawnPlaceEffect(mesh);
  return true;
}

function removeFromMeshList(mesh) {
  const idx = blockMeshList.indexOf(mesh);
  if (idx === -1) return;
  const last = blockMeshList.length - 1;
  blockMeshList[idx] = blockMeshList[last];
  blockMeshList.pop();
}

function mineBlockAt(ix, iy, iz) {
  const k = cellKey(ix, iy, iz);
  const entry = occupied.get(k);
  if (!entry) return false;
  spawnMineEffect(entry.mesh.position, entry.typeId);
  worldRoot.remove(entry.mesh);
  removeFromMeshList(entry.mesh);
  occupied.delete(k);
  deactivatePortalsUsingCell(ix, iy, iz);
  return true;
}

/* ---- targeting: raycast from the fixed center crosshair ---- */
const raycaster = new THREE.Raycaster();
raycaster.far = REACH;
const NDC_CENTER = new THREE.Vector2(0, 0);
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function raycastGroundCell() {
  groundPlane.constant = -worldRoot.position.y;
  const pt = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(groundPlane, pt);
  if (!hit) return null;
  if (raycaster.ray.origin.distanceTo(pt) > REACH) return null;
  const local = pt.clone().sub(worldRoot.position);
  return { ix: Math.round(local.x / GRID), iy: 0, iz: Math.round(local.z / GRID) };
}

function updateTargeting() {
  raycaster.setFromCamera(NDC_CENTER, camera);
  let target = null;
  if (blockMeshList.length) {
    const hits = raycaster.intersectObjects(blockMeshList, false);
    if (hits.length > 0) {
      const hit = hits[0];
      const ud = hit.object.userData;
      const n = hit.face.normal; // blocks are axis-aligned & unrotated, so this is already a world-axis direction
      target = {
        mode: 'block',
        block: { ix: ud.ix, iy: ud.iy, iz: ud.iz },
        placeCell: { ix: ud.ix + Math.round(n.x), iy: ud.iy + Math.round(n.y), iz: ud.iz + Math.round(n.z) }
      };
    }
  }
  if (!target) {
    const g = raycastGroundCell();
    if (g) target = { mode: 'ground', placeCell: g };
  }
  currentTarget = target;
  updateAimOutline();
}

function updateAimOutline() {
  if (!currentTarget) { aimOutline.visible = false; return; }
  const cell = currentTarget.mode === 'block' ? currentTarget.block : currentTarget.placeCell;
  aimOutline.position.set(cell.ix * GRID, cell.iy * GRID, cell.iz * GRID);
  aimOutline.visible = true;
}

/* ---- lightweight place / mine feedback animations (no per-frame allocation) ---- */
let popAnims = [];
function spawnPlaceEffect(mesh) {
  mesh.scale.setScalar(0.35);
  popAnims.push({ mesh, t: 0, duration: 0.14 });
}
function updatePopAnims(dt) {
  for (let i = popAnims.length - 1; i >= 0; i--) {
    const a = popAnims[i];
    a.t += dt;
    const k = Math.min(1, a.t / a.duration);
    a.mesh.scale.setScalar(0.35 + 0.65 * k);
    if (k >= 1) popAnims.splice(i, 1);
  }
}

let particles = [];
function spawnMineEffect(localPos, typeId) {
  const mats = getMaterials(typeId);
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(particleGeometry, mats);
    p.position.copy(localPos);
    worldRoot.add(p);
    particles.push({
      mesh: p,
      vel: new THREE.Vector3((Math.random() - 0.5) * 1.2, Math.random() * 1.5 + 0.5, (Math.random() - 0.5) * 1.2),
      life: 0,
      maxLife: 0.4 + Math.random() * 0.25
    });
  }
}
function updateParticles(dt) {
  for (let i = particles.length - 1; i >= 0; i--) {
    const pt = particles[i];
    pt.life += dt;
    pt.vel.y -= 3.2 * dt;
    pt.mesh.position.addScaledVector(pt.vel, dt);
    const s = Math.max(0, 1 - pt.life / pt.maxLife);
    pt.mesh.scale.setScalar(s * 0.9);
    if (pt.life >= pt.maxLife) {
      worldRoot.remove(pt.mesh);
      particles.splice(i, 1);
    }
  }
}

/* ---------------------------------------------------------------
   6. NETHER PORTAL
   --------------------------------------------------------------- */
let portals = [];

const portalVertexShader = `
varying vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const portalFragmentShader = `
uniform float uTime;
varying vec2 vUv;
void main(){
  vec2 uv = vUv * vec2(1.0, 1.6);
  float n1 = sin((uv.y * 10.0) + uTime * 2.2 + sin(uv.x * 6.0 + uTime) * 1.5);
  float n2 = sin((uv.x * 9.0) - uTime * 2.6 + cos(uv.y * 5.0 - uTime * 1.3) * 1.2);
  float m = clamp(n1 * 0.5 + n2 * 0.5, 0.0, 1.0);
  vec3 deep = vec3(0.06, 0.0, 0.12);
  vec3 bright = vec3(0.72, 0.28, 1.0);
  vec3 col = mix(deep, bright, m);
  float edge = smoothstep(0.0, 0.12, vUv.x) * smoothstep(1.0, 0.88, vUv.x) * smoothstep(0.0, 0.12, vUv.y) * smoothstep(1.0, 0.88, vUv.y);
  gl_FragColor = vec4(col, 0.5 + 0.35 * m * edge + 0.15);
}`;

function findFrameOnAxis(cell, axis) {
  const constCoord = axis === 'z' ? cell.iz : cell.ix;
  const u0 = axis === 'z' ? cell.ix : cell.iz;
  const v0 = cell.iy;
  function typeAt(u, v) {
    return axis === 'z' ? cellType(u, v, constCoord) : cellType(constCoord, v, u);
  }
  function rectValid(uMin, vMin, uMax, vMax) {
    for (let u = uMin; u <= uMax; u++) {
      if (typeAt(u, vMin) !== 'obsidian') return false;
      if (typeAt(u, vMax) !== 'obsidian') return false;
    }
    for (let v = vMin; v <= vMax; v++) {
      if (typeAt(uMin, v) !== 'obsidian') return false;
      if (typeAt(uMax, v) !== 'obsidian') return false;
    }
    for (let u = uMin + 1; u < uMax; u++) {
      for (let v = vMin + 1; v < vMax; v++) {
        if (typeAt(u, v) !== null) return false;
      }
    }
    return true;
  }
  const MIN_W = 4, MAX_W = 6, MIN_H = 5, MAX_H = 7;
  for (let width = MIN_W; width <= MAX_W; width++) {
    for (let height = MIN_H; height <= MAX_H; height++) {
      for (let du = -(width - 1); du <= 0; du++) {
        for (let dv = -(height - 1); dv <= 0; dv++) {
          const uMin = u0 + du, vMin = v0 + dv;
          const uMax = uMin + width - 1, vMax = vMin + height - 1;
          if (vMin < 0) continue;
          if (rectValid(uMin, vMin, uMax, vMax)) return { axis, constCoord, uMin, uMax, vMin, vMax };
        }
      }
    }
  }
  return null;
}

function findPortalFrame(cell) {
  return findFrameOnAxis(cell, 'z') || findFrameOnAxis(cell, 'x');
}

function portalExistsForFrame(frame) {
  return portals.some(p => p.axis === frame.axis && p.constCoord === frame.constCoord &&
    !(frame.uMax < p.uMin || frame.uMin > p.uMax || frame.vMax < p.vMin || frame.vMin > p.vMax));
}

function ignitePortal(frame) {
  const innerW = (frame.uMax - frame.uMin - 1) * GRID;
  const innerH = (frame.vMax - frame.vMin - 1) * GRID;
  const geo = new THREE.PlaneGeometry(innerW, innerH);
  const mat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: portalVertexShader,
    fragmentShader: portalFragmentShader,
    transparent: true,
    side: THREE.DoubleSide,
    depthWrite: false
  });
  const mesh = new THREE.Mesh(geo, mat);
  const uCenter = (frame.uMin + frame.uMax) / 2;
  const vCenter = (frame.vMin + frame.vMax) / 2;
  if (frame.axis === 'z') {
    mesh.position.set(uCenter * GRID, vCenter * GRID, frame.constCoord * GRID);
  } else {
    mesh.position.set(frame.constCoord * GRID, vCenter * GRID, uCenter * GRID);
    mesh.rotation.y = Math.PI / 2;
  }
  worldRoot.add(mesh);
  const glow = new THREE.PointLight(0x9a3bff, 1.1, GRID * 7);
  glow.position.copy(mesh.position);
  worldRoot.add(glow);
  portals.push(Object.assign({}, frame, { mesh, glow, id: portals.length }));
}

function updatePortals(dt) {
  for (const p of portals) p.mesh.material.uniforms.uTime.value += dt;
}

function deactivatePortalsUsingCell(ix, iy, iz) {
  portals = portals.filter(p => {
    let onBorder;
    if (p.axis === 'z') {
      onBorder = p.constCoord === iz &&
        (((ix === p.uMin || ix === p.uMax) && iy >= p.vMin && iy <= p.vMax) ||
         ((iy === p.vMin || iy === p.vMax) && ix >= p.uMin && ix <= p.uMax));
    } else {
      onBorder = p.constCoord === ix &&
        (((iz === p.uMin || iz === p.uMax) && iy >= p.vMin && iy <= p.vMax) ||
         ((iy === p.vMin || iy === p.vMax) && iz >= p.uMin && iz <= p.uMax));
    }
    if (onBorder) {
      worldRoot.remove(p.mesh); p.mesh.geometry.dispose(); p.mesh.material.dispose();
      worldRoot.remove(p.glow);
      return false;
    }
    return true;
  });
}

function tryIgnitePortal() {
  if (!currentTarget) { toast('Aim Flint & Steel at an obsidian frame'); return; }
  let obsCell = null;
  if (currentTarget.mode === 'block') {
    const e = occupied.get(cellKey(currentTarget.block.ix, currentTarget.block.iy, currentTarget.block.iz));
    if (e && e.typeId === 'obsidian') obsCell = currentTarget.block;
  }
  if (!obsCell) { toast('Point at an obsidian block that is part of a frame'); return; }
  const frame = findPortalFrame(obsCell);
  if (!frame) { toast('No valid frame — build a standing obsidian rectangle with an empty middle'); return; }
  if (portalExistsForFrame(frame)) { toast('That portal is already lit'); return; }
  ignitePortal(frame);
  toast('The portal roars to life!');
}

/* ---------------------------------------------------------------
   7. PLACE / MINE BUTTONS
   --------------------------------------------------------------- */
placeBtn.addEventListener('click', () => {
  if (!worldPlaced) { toast('Place the world first'); return; }
  if (!currentTarget) { toast('Point at a surface to build on'); return; }
  if (selectedId === 'flint_and_steel') { tryIgnitePortal(); return; }
  const cell = currentTarget.placeCell;
  if (cell.iy < 0) { toast("Can't build below the ground"); return; }
  const ok = placeBlockAt(cell.ix, cell.iy, cell.iz, selectedId);
  if (!ok) toast('Something is already there');
});

mineBtn.addEventListener('click', () => {
  if (!worldPlaced) { toast('Place the world first'); return; }
  if (!currentTarget || currentTarget.mode !== 'block') { toast('Aim at a block to mine'); return; }
  mineBlockAt(currentTarget.block.ix, currentTarget.block.iy, currentTarget.block.iz);
});

/* ---------------------------------------------------------------
   8. TOASTS
   --------------------------------------------------------------- */
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 1900);
}

/* ---------------------------------------------------------------
   9. HOTBAR / INVENTORY UI
   --------------------------------------------------------------- */
function makeSlotEl(id, isInventory) {
  const def = DEFS_BY_ID[id];
  const slot = document.createElement('button');
  slot.className = isInventory ? 'inv-slot' : 'hotbar-slot';
  slot.dataset.id = id;
  const swatch = document.createElement('div');
  swatch.className = 'swatch';
  if (def.isTool) {
    swatch.style.display = 'flex';
    swatch.style.alignItems = 'center';
    swatch.style.justifyContent = 'center';
    swatch.style.fontSize = isInventory ? '20px' : '24px';
    swatch.style.background = '#241f1b';
    swatch.textContent = '\uD83D\uDD25'; // fire emoji
  } else {
    swatch.style.backgroundImage = 'url(' + swatchDataUrl(id) + ')';
  }
  slot.appendChild(swatch);
  if (isInventory) {
    const label = document.createElement('div');
    label.className = 'inv-name';
    label.textContent = def.name;
    slot.appendChild(label);
  }
  slot.addEventListener('click', () => selectBlock(id));
  return slot;
}

function buildHotbar() {
  Array.from(hotbarEl.children).forEach(ch => { if (ch.id !== 'more-blocks-btn') ch.remove(); });
  HOTBAR_IDS.forEach(id => hotbarEl.insertBefore(makeSlotEl(id, false), moreBtn));
  refreshHotbarSelection();
}

function buildInventory() {
  inventoryGrid.innerHTML = '';
  BLOCK_DEFS.concat(TOOL_DEFS).forEach(def => inventoryGrid.appendChild(makeSlotEl(def.id, true)));
  refreshInventorySelection();
}

function refreshHotbarSelection() {
  hotbarEl.querySelectorAll('.hotbar-slot').forEach(el => el.classList.toggle('selected', el.dataset.id === selectedId));
}
function refreshInventorySelection() {
  inventoryGrid.querySelectorAll('.inv-slot').forEach(el => el.classList.toggle('selected', el.dataset.id === selectedId));
}

function selectBlock(id) {
  selectedId = id;
  const def = DEFS_BY_ID[id];
  selectedNameEl.textContent = def.name;
  if (def.isTool) {
    selectedSwatchEl.textContent = '\uD83D\uDD25';
    selectedSwatchEl.style.backgroundImage = 'none';
    selectedSwatchEl.style.backgroundColor = '#241f1b';
    selectedSwatchEl.style.display = 'flex';
    selectedSwatchEl.style.alignItems = 'center';
    selectedSwatchEl.style.justifyContent = 'center';
    selectedSwatchEl.style.fontSize = '15px';
  } else {
    selectedSwatchEl.textContent = '';
    selectedSwatchEl.style.display = 'inline-block';
    selectedSwatchEl.style.backgroundColor = 'transparent';
    selectedSwatchEl.style.backgroundImage = 'url(' + swatchDataUrl(id) + ')';
  }
  refreshHotbarSelection();
  refreshInventorySelection();
}

moreBtn.addEventListener('click', () => inventoryModal.classList.remove('hidden'));
closeInventoryBtn.addEventListener('click', () => inventoryModal.classList.add('hidden'));
helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
closeHelpBtn.addEventListener('click', () => helpModal.classList.add('hidden'));
[inventoryModal, helpModal].forEach(m => {
  m.addEventListener('click', e => { if (e.target === m) m.classList.add('hidden'); });
});

/* ---------------------------------------------------------------
   10. CAMERA FEED (fallback mode background + switching)
   --------------------------------------------------------------- */
async function startCameraFeed() {
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); }
  const constraints = { video: { facingMode: { ideal: currentFacingMode } }, audio: false };
  videoStream = await navigator.mediaDevices.getUserMedia(constraints);
  videoEl.srcObject = videoStream;
  await videoEl.play();
  videoEl.classList.toggle('mirrored', currentFacingMode === 'user');
}
function stopCameraFeed() {
  if (videoStream) { videoStream.getTracks().forEach(t => t.stop()); videoStream = null; }
}

cameraSwitchBtn.addEventListener('click', async () => {
  if (currentARMode === 'xr') { toast('Camera switching is handled by the AR system in this mode.'); return; }
  const prev = currentFacingMode;
  currentFacingMode = currentFacingMode === 'environment' ? 'user' : 'environment';
  try { await startCameraFeed(); }
  catch (e) { currentFacingMode = prev; toast('Could not switch camera on this device.'); }
});

/* ---------------------------------------------------------------
   11. FALLBACK AR (device orientation, or drag-to-look as a last resort)
   --------------------------------------------------------------- */
let deviceAlpha = 0, deviceBeta = 0, deviceGamma = 0, screenOrientAngle = 0;
const zee = new THREE.Vector3(0, 0, 1);
const eulerTmp = new THREE.Euler();
const q0 = new THREE.Quaternion();
const q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));

function setCameraQuaternionFromOrientation(alpha, beta, gamma, screenAngle) {
  eulerTmp.set(beta, alpha, -gamma, 'YXZ');
  camera.quaternion.setFromEuler(eulerTmp);
  camera.quaternion.multiply(q1);
  camera.quaternion.multiply(q0.setFromAxisAngle(zee, -screenAngle));
}

function onDeviceOrientation(e) {
  if (e.alpha == null) return;
  deviceAlpha = e.alpha; deviceBeta = e.beta; deviceGamma = e.gamma;
}
function onScreenOrientationChange() {
  screenOrientAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
}

let dragging = false, dragYaw = 0, dragPitch = 0, lastX = 0, lastY = 0, dragLookEnabled = false;
function setupDragLook() {
  if (dragLookEnabled) return;
  dragLookEnabled = true;
  canvas.addEventListener('pointerdown', e => { dragging = true; lastX = e.clientX; lastY = e.clientY; });
  window.addEventListener('pointerup', () => { dragging = false; });
  window.addEventListener('pointermove', e => {
    if (!dragging) return;
    const dx = e.clientX - lastX, dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    dragYaw -= dx * 0.0035;
    dragPitch = Math.max(-1.4, Math.min(1.4, dragPitch - dy * 0.0035));
  });
}

async function requestOrientationPermission() {
  if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
    try { return (await DeviceOrientationEvent.requestPermission()) === 'granted'; }
    catch (e) { return false; }
  }
  return typeof DeviceOrientationEvent !== 'undefined';
}

function beginFallbackTracking() {
  requestOrientationPermission().then(granted => {
    if (!granted) {
      orientationSupported = false;
      setupDragLook();
      modeBanner.textContent = 'Limited fallback — drag to look around';
      return;
    }
    window.addEventListener('deviceorientation', onDeviceOrientation);
    window.addEventListener('orientationchange', onScreenOrientationChange);
    onScreenOrientationChange();
    let gotEvent = false;
    window.addEventListener('deviceorientation', () => { gotEvent = true; }, { once: true });
    setTimeout(() => {
      orientationSupported = gotEvent;
      if (gotEvent) {
        modeBanner.textContent = 'Fallback AR — tilt your device to look around';
      } else {
        setupDragLook();
        modeBanner.textContent = 'Limited fallback — drag to look around';
      }
    }, 1200);
  });
}

function updateFallbackOrientation() {
  if (orientationSupported) {
    setCameraQuaternionFromOrientation(
      THREE.MathUtils.degToRad(deviceAlpha),
      THREE.MathUtils.degToRad(deviceBeta),
      THREE.MathUtils.degToRad(deviceGamma),
      THREE.MathUtils.degToRad(screenOrientAngle)
    );
  } else if (dragLookEnabled) {
    camera.quaternion.setFromEuler(new THREE.Euler(dragPitch, dragYaw, 0, 'YXZ'));
  }
}

function fallbackGroundPoint() {
  const dir = new THREE.Vector3();
  camera.getWorldDirection(dir);
  const camPos = camera.position.clone();
  const floorY = camPos.y - EYE_HEIGHT;
  let point;
  if (Math.abs(dir.y) < 0.05 || (floorY - camPos.y) / dir.y <= 0) {
    const flat = dir.clone(); flat.y = 0;
    if (flat.lengthSq() < 1e-6) flat.set(0, 0, -1); else flat.normalize();
    point = camPos.clone().add(flat.multiplyScalar(1.4));
    point.y = floorY;
  } else {
    const t = (floorY - camPos.y) / dir.y;
    point = camPos.clone().add(dir.multiplyScalar(t));
  }
  return point;
}

/* ---------------------------------------------------------------
   12. WEBXR AR PATH
   --------------------------------------------------------------- */
function setPlaceWorldButtonEnabled(enabled) {
  placeWorldBtn.disabled = !enabled;
  if (enabled) placeWorldBtn.classList.remove('hidden');
}

async function startXRSession() {
  videoEl.style.display = 'none';
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local');
  const session = await navigator.xr.requestSession('immersive-ar', {
    requiredFeatures: ['hit-test', 'local'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  if (!session.domOverlayState || session.domOverlayState.type !== 'screen') {
    // Our HUD/buttons need DOM Overlay to stay visible during the session.
    // Without it the player would be stranded with no UI, so bail out and
    // let the caller fall back to the camera-based mode instead.
    await session.end();
    renderer.xr.enabled = false;
    throw new Error('dom-overlay unsupported on this session');
  }
  xrSession = session;
  await renderer.xr.setSession(session);
  const viewerSpace = await session.requestReferenceSpace('viewer');
  xrHitTestSource = await session.requestHitTestSource({ space: viewerSpace });
  xrRefSpace = await session.requestReferenceSpace('local');
  session.addEventListener('end', onXRSessionEnd);

  cameraSwitchBtn.disabled = true;
  placementScreen.classList.remove('hidden');
  placeWorldBtn.classList.add('hidden');
  placementText.textContent = 'Slowly move your device to scan the floor…';
}

function onXRSessionEnd() {
  videoEl.style.display = 'block';
  xrSession = null; xrHitTestSource = null; xrRefSpace = null; lastHitPose = null;
  renderer.xr.enabled = false;
  worldPlaced = false;
  hud.classList.add('hidden');
  placementScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
  toast('AR session ended.');
}

function updateXRHitTest(frame) {
  if (worldPlaced || !xrHitTestSource) return;
  const results = frame.getHitTestResults(xrHitTestSource);
  if (results.length > 0) {
    const pose = results[0].getPose(xrRefSpace);
    lastHitPose = pose;
    reticle.visible = true;
    reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
    setPlaceWorldButtonEnabled(true);
    placementText.textContent = 'Floor detected — tap to place your world.';
  } else {
    reticle.visible = false;
    lastHitPose = null;
    setPlaceWorldButtonEnabled(false);
    placementText.textContent = 'Slowly move your device to scan the floor…';
  }
}

/* ---------------------------------------------------------------
   13. START / PLACEMENT / ERROR FLOW
   --------------------------------------------------------------- */
function showError(msg) {
  errorText.textContent = msg;
  errorScreen.classList.remove('hidden');
  startScreen.classList.add('hidden');
  placementScreen.classList.add('hidden');
  hud.classList.add('hidden');
}

async function detectSupportNote() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    supportNote.textContent = 'Your browser does not support camera access — AR Craft needs it to run.';
    startBtn.disabled = true;
    return;
  }
  if (navigator.xr && navigator.xr.isSessionSupported) {
    try {
      xrSupportedCache = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (e) { xrSupportedCache = false; }
  } else {
    xrSupportedCache = false;
  }
  supportNote.textContent = xrSupportedCache
    ? 'Full AR ground detection is available on this device.'
    : 'This device will use the camera-based AR fallback.';
}

async function detectAndStartAR() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('This browser does not support camera access, which AR Craft requires. Try the latest Chrome on Android or Safari on iOS.');
    return;
  }
  if (xrSupportedCache === null) {
    try { xrSupportedCache = navigator.xr && navigator.xr.isSessionSupported ? await navigator.xr.isSessionSupported('immersive-ar') : false; }
    catch (e) { xrSupportedCache = false; }
  }
  if (xrSupportedCache) {
    currentARMode = 'xr';
    try { await startXRSession(); return; }
    catch (e) { console.warn('XR session failed, falling back to camera mode.', e); }
  }
  currentARMode = 'fallback';
  try { await startCameraFeed(); }
  catch (e) {
    showError('Camera access failed (' + (e.message || e.name || 'unknown error') + '). Please allow camera permission in your browser settings and reload the page.');
    return;
  }
  usingOrientationFallback = true;
  cameraSwitchBtn.disabled = false;
  placementScreen.classList.remove('hidden');
  setPlaceWorldButtonEnabled(true);
  placementText.textContent = 'Point your camera at the floor, then tap Place World.';
  beginFallbackTracking();
}

function finalizeWorldPlacement() {
  worldPlaced = true;
  reticle.visible = false;
  placementScreen.classList.add('hidden');
  hud.classList.remove('hidden');
  positionShadowLight();
  if (currentARMode !== 'xr') {
    modeBanner.textContent = orientationSupported ? 'Fallback AR — tilt to look around' : 'Fallback AR — drag to look around';
  } else {
    modeBanner.textContent = 'AR ground detection active';
  }
  toast('World placed — start building!');
}

startBtn.addEventListener('click', async () => {
  startScreen.classList.add('hidden');
  await detectAndStartAR();
});

errorRetryBtn.addEventListener('click', () => {
  errorScreen.classList.add('hidden');
  startScreen.classList.remove('hidden');
});

placeWorldBtn.addEventListener('click', () => {
  if (currentARMode === 'xr') {
    if (!lastHitPose) return;
    worldRoot.position.set(lastHitPose.transform.position.x, lastHitPose.transform.position.y, lastHitPose.transform.position.z);
  } else {
    const p = fallbackGroundPoint();
    if (!p) { toast('Point your camera toward the floor first'); return; }
    worldRoot.position.copy(p);
  }
  worldRoot.quaternion.identity();
  finalizeWorldPlacement();
});

/* ---------------------------------------------------------------
   14. MAIN LOOP
   --------------------------------------------------------------- */
function onFrame(timestamp, xrFrame) {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (renderer.xr.isPresenting) {
    if (xrFrame) updateXRHitTest(xrFrame);
  } else if (usingOrientationFallback) {
    updateFallbackOrientation();
  }
  if (worldPlaced) {
    updateTargeting();
    updatePortals(dt);
  }
  updateParticles(dt);
  updatePopAnims(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(onFrame);

/* ---------------------------------------------------------------
   15. INIT
   --------------------------------------------------------------- */
buildHotbar();
buildInventory();
selectBlock('grass');
detectSupportNote();
