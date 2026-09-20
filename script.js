/* ================================================================
   AR CRAFT — script.js
   A blocky, Minecraft-style AR building game.
   Real 3D cubes (Three.js), a WebXR hit-test AR path for supported
   devices, and a camera + device-orientation fallback for everyone
   else.

   Texture system: every block has an instant, offline, procedurally
   generated canvas texture. In the background, the game tries to
   fetch higher-quality vanilla Minecraft textures from a public
   texture CDN and swaps them in live if/when they arrive. If the
   network call fails, times out, or is disabled in Settings, the
   procedural texture simply stays — the game never blocks on the
   network and never breaks if it's unavailable.

   Also includes a simple blocky Zombie mob with basic chase AI and
   an in-game Settings menu (online textures / mobs / reach).
   ================================================================ */

/* ---------------------------------------------------------------
   0. CONFIG & GLOBAL STATE
   --------------------------------------------------------------- */
const GRID = 0.035;            // metres per block
const EYE_HEIGHT = 1.3;        // assumed phone height above the floor (fallback mode)

const MAX_ZOMBIES = 3;         // how many zombies can be alive at once
const ZOMBIE_MAX_HP = 3;       // hits required to defeat a zombie

// Zombie movement/spawn distances are expressed in GRID units (blocks), NOT
// metres, because this is a tiny tabletop-scale world (GRID = 3.5cm). Using
// the metre-scale "reach" setting for these previously spawned zombies many
// real metres away, far outside the tabletop diorama, where they could
// never be seen or reached — hence "the zombie doesn't work".
const ZOMBIE_SPEED = GRID * 5;          // ~0.175 m/s — closes the gap in a few seconds once spawned
const ZOMBIE_STOP_DIST = GRID * 5;       // ~0.18m — always well inside raycast "reach"

// Mutable, user-adjustable settings (exposed via the in-game Settings menu)
const settings = {
  useApiTextures: true,   // try to fetch real Minecraft textures over the network
  mobsEnabled: true,      // spawn zombies
  reach: 6                // max metres the player can aim/build/fight at (raycast distance only)
};

let currentARMode = null;     // 'xr' | 'fallback'
let worldPlaced = false;
let usingOrientationFallback = false;
let orientationSupported = false;
let currentFacingMode = 'environment';
let videoStream = null;
let xrSession = null, xrHitTestSource = null, xrRefSpace = null, lastHitPose = null;
let lastHitResult = null, worldAnchor = null; // WebXR anchor used to keep placed content drift-corrected
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
   (all block art is drawn on a canvas — no external image assets
   are required for the game to run)
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
   Each block optionally carries an `api` field describing which
   real Minecraft texture filenames (from the MC Assets CDN, no
   ".png" suffix) should replace its procedural faces once loaded.
   `tint` is an optional hex colour multiplied onto the fetched
   texture (used for biome-tinted textures like grass/leaves).
   --------------------------------------------------------------- */
const textureCache = {};
function cachedTex(key, gen) {
  if (!textureCache[key]) textureCache[key] = gen();
  return textureCache[key];
}

const BLOCK_DEFS = [
  { id: 'grass', name: 'Grass Block',
    faces: () => ({
      top: cachedTex('grass_top', () => makeNoiseTexture('#6CAD3F', '#5C9A32', { cell: 4, density: 0.35 })),
      bottom: cachedTex('dirt', () => makeNoiseTexture('#8B5A2B', '#7A4B22', { cell: 4, density: 0.4 })),
      side: cachedTex('grass_side', makeGrassSideTexture)
    }),
    api: { top: 'grass_block_top', tint: '#7CBD4B', bottom: 'dirt', side: 'grass_block_side' } },
  { id: 'dirt', name: 'Dirt',
    faces: () => ({ all: cachedTex('dirt', () => makeNoiseTexture('#8B5A2B', '#7A4B22', { cell: 4, density: 0.4 })) }),
    api: { all: 'dirt' } },
  { id: 'stone', name: 'Stone',
    faces: () => ({ all: cachedTex('stone', () => makeNoiseTexture('#8A8A8A', '#7C7C7C', { cell: 4, density: 0.4 })) }),
    api: { all: 'stone' } },
  { id: 'cobblestone', name: 'Cobblestone',
    faces: () => ({ all: cachedTex('cobble', () => makeNoiseTexture('#8C8C8C', '#65635F', { cell: 6, density: 0.5 })) }),
    api: { all: 'cobblestone' } },
  { id: 'oak_log', name: 'Wood Log',
    faces: () => ({
      top: cachedTex('log_end', () => makeLogEndTexture('#C9A66B', '#8A6B3E')),
      bottom: cachedTex('log_end', () => makeLogEndTexture('#C9A66B', '#8A6B3E')),
      side: cachedTex('log_side', () => makeLogSideTexture('#6B4423', '#54341A'))
    }),
    api: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log' } },
  { id: 'oak_planks', name: 'Oak Planks',
    faces: () => ({ all: cachedTex('planks', () => makePlanksTexture('#B98B4E', '#9A7038')) }),
    api: { all: 'oak_planks' } },
  { id: 'leaves', name: 'Leaves',
    faces: () => ({ all: cachedTex('leaves', () => makeNoiseTexture('#4C8C3B', '#3E7A2E', { cell: 3, density: 0.5 })) }),
    api: { all: 'oak_leaves', tint: '#48B518' } },
  { id: 'sand', name: 'Sand',
    faces: () => ({ all: cachedTex('sand', () => makeNoiseTexture('#E3D2A0', '#D6C28C', { cell: 4, density: 0.35 })) }),
    api: { all: 'sand' } },
  { id: 'gravel', name: 'Gravel',
    faces: () => ({ all: cachedTex('gravel', () => makeNoiseTexture('#96928C', '#716D67', { cell: 3, density: 0.5 })) }),
    api: { all: 'gravel' } },
  { id: 'glass', name: 'Glass', transparent: true, opacity: 0.42,
    faces: () => ({ all: cachedTex('glass', makeGlassTexture) }),
    api: { all: 'glass' } },
  { id: 'obsidian', name: 'Obsidian',
    faces: () => ({ all: cachedTex('obsidian', () => makeNoiseTexture('#160424', '#0D0217', { cell: 4, density: 0.3 })) }),
    api: { all: 'obsidian' } },
  { id: 'iron_block', name: 'Iron Block', metal: true,
    faces: () => ({ all: cachedTex('iron', () => makeNoiseTexture('#E5E5E0', '#C9C9C2', { cell: 8, density: 0.2 })) }),
    api: { all: 'iron_block' } },
  { id: 'gold_block', name: 'Gold Block', metal: true,
    faces: () => ({ all: cachedTex('gold', () => makeNoiseTexture('#F6D94B', '#E0C13A', { cell: 8, density: 0.2 })) }),
    api: { all: 'gold_block' } },
  { id: 'diamond_block', name: 'Diamond Block', metal: true,
    faces: () => ({ all: cachedTex('diamond', () => makeNoiseTexture('#79EFE2', '#4FCFC2', { cell: 8, density: 0.2 })) }),
    api: { all: 'diamond_block' } },
  { id: 'coal_block', name: 'Coal Block',
    faces: () => ({ all: cachedTex('coal', () => makeNoiseTexture('#232323', '#141414', { cell: 4, density: 0.35 })) }),
    api: { all: 'coal_block' } },
  { id: 'redstone_block', name: 'Redstone Block', emissive: '#7a140d',
    faces: () => ({ all: cachedTex('redstone', () => makeNoiseTexture('#B0231C', '#8E1B15', { cell: 4, density: 0.3 })) }),
    api: { all: 'redstone_block' } },
  { id: 'bricks', name: 'Bricks',
    faces: () => ({ all: cachedTex('bricks', () => makeBricksTexture('#9C4A34', '#6B3123')) }),
    api: { all: 'bricks' } },
  { id: 'snow', name: 'Snow',
    faces: () => ({ all: cachedTex('snow', () => makeNoiseTexture('#F5F8FA', '#E4EAEE', { cell: 4, density: 0.25 })) }),
    api: { all: 'snow' } },
  { id: 'ice', name: 'Ice', transparent: true, opacity: 0.7,
    faces: () => ({ all: cachedTex('ice', () => makeNoiseTexture('#BFE7F5', '#9FD3E8', { cell: 6, density: 0.25 })) }),
    api: { all: 'ice' } },
  { id: 'tnt', name: 'TNT',
    faces: () => ({
      top: cachedTex('tnt_top', () => makeNoiseTexture('#DCD3B2', '#C9BE95', { cell: 6, density: 0.25 })),
      bottom: cachedTex('tnt_top', () => makeNoiseTexture('#DCD3B2', '#C9BE95', { cell: 6, density: 0.25 })),
      side: cachedTex('tnt_side', makeTntSideTexture)
    }),
    api: { top: 'tnt_top', bottom: 'tnt_bottom', side: 'tnt_side' } },
  { id: 'netherrack', name: 'Netherrack',
    faces: () => ({ all: cachedTex('netherrack', () => makeNoiseTexture('#6B2B2B', '#4E1F1F', { cell: 4, density: 0.4 })) }),
    api: { all: 'netherrack' } },
  { id: 'soul_sand', name: 'Soul Sand',
    faces: () => ({ all: cachedTex('soulsand', () => makeNoiseTexture('#4A3A2C', '#3A2D22', { cell: 4, density: 0.4 })) }),
    api: { all: 'soul_sand' } },
  { id: 'end_stone', name: 'End Stone',
    faces: () => ({ all: cachedTex('endstone', () => makeNoiseTexture('#DDD9A6', '#CFCB96', { cell: 4, density: 0.3 })) }),
    api: { all: 'end_stone' } },
  { id: 'quartz_block', name: 'Quartz Block',
    faces: () => ({ all: cachedTex('quartz', () => makeNoiseTexture('#EDE8DD', '#DDD6C6', { cell: 4, density: 0.25 })) }),
    api: { all: 'quartz_block_side' } },
  { id: 'bedrock', name: 'Bedrock',
    faces: () => ({ all: cachedTex('bedrock', () => makeNoiseTexture('#333333', '#1C1C1C', { cell: 4, density: 0.45 })) }),
    api: { all: 'bedrock' } },
  { id: 'glowstone', name: 'Glowstone', emissive: '#F5D27A',
    faces: () => ({ all: cachedTex('glowstone', () => makeNoiseTexture('#F5D27A', '#E0BB55', { cell: 4, density: 0.35 })) }),
    api: { all: 'glowstone' } },
  { id: 'clay', name: 'Clay',
    faces: () => ({ all: cachedTex('clay', () => makeNoiseTexture('#A9B3BD', '#96A0AA', { cell: 4, density: 0.3 })) }),
    api: { all: 'clay' } },
  { id: 'mossy_cobblestone', name: 'Mossy Cobblestone',
    faces: () => ({ all: cachedTex('mossy', () => makeNoiseTexture('#7C8C63', '#65635F', { cell: 6, density: 0.45 })) }),
    api: { all: 'mossy_cobblestone' } },
  { id: 'pumpkin', name: 'Pumpkin',
    faces: () => ({
      top: cachedTex('pumpkin_top', () => makeNoiseTexture('#D9821B', '#C4740F', { cell: 4, density: 0.3 })),
      bottom: cachedTex('pumpkin_top', () => makeNoiseTexture('#D9821B', '#C4740F', { cell: 4, density: 0.3 })),
      side: cachedTex('pumpkin_side', makePumpkinSideTexture)
    }),
    api: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side' } },
  { id: 'melon', name: 'Melon',
    faces: () => ({ all: cachedTex('melon', makeMelonTexture) }),
    api: { all: 'melon_side' } },
  { id: 'hay_bale', name: 'Hay Bale',
    faces: () => ({
      top: cachedTex('hay_top', () => makePlanksTexture('#E3C23C', '#C7A62E')),
      bottom: cachedTex('hay_top', () => makePlanksTexture('#E3C23C', '#C7A62E')),
      side: cachedTex('hay_side', () => makeLogSideTexture('#E3C23C', '#B99425'))
    }),
    api: { top: 'hay_block_top', bottom: 'hay_block_top', side: 'hay_block_side' } }
];

function makeSpawnEggIconDataUrl(baseColor, spotColor) {
  const size = 32;
  const c = makeCanvas(size);
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = baseColor;
  ctx.beginPath();
  ctx.ellipse(size / 2, size / 2 + 1, size * 0.34, size * 0.42, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = spotColor;
  for (let i = 0; i < 9; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = Math.random() * size * 0.26;
    const x = size / 2 + Math.cos(ang) * r;
    const y = size / 2 + 1 + Math.sin(ang) * r * 1.1;
    ctx.beginPath();
    ctx.arc(x, y, 1.4 + Math.random() * 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
  return c.toDataURL();
}

const TOOL_DEFS = [
  { id: 'flint_and_steel', name: 'Flint & Steel', isTool: true },
  // Manual mob spawner — the only way a zombie enters the world. Aim at the
  // ground/a block and tap Place to spawn one right there.
  { id: 'zombie_spawn_egg', name: 'Zombie Spawn Egg', isTool: true, isSpawnEgg: true,
    icon: () => makeSpawnEggIconDataUrl('#5B8731', '#1D2E1B'),
    apiIcon: 'zombie_spawn_egg' } // real texture lives under textures/item/, fetched separately below
];

const DEFS_BY_ID = {};
BLOCK_DEFS.forEach(d => DEFS_BY_ID[d.id] = d);
TOOL_DEFS.forEach(d => DEFS_BY_ID[d.id] = d);

const HOTBAR_IDS = ['grass', 'dirt', 'stone', 'cobblestone', 'oak_planks', 'glass', 'obsidian', 'flint_and_steel'];

/* materialCache[id] = { mats: [6 materials for box faces], byFace: {all|top/bottom/side -> material},
                          procedural: {same keys -> original procedural texture} } */
const materialCache = {};

function buildMaterialsForBlock(id) {
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
  let mats, byFace = {}, procedural = {};
  if (faces.all) {
    const m = matFor(faces.all);
    mats = [m, m, m, m, m, m];
    byFace.all = m;
    procedural.all = faces.all;
  } else {
    const top = matFor(faces.top);
    const bottom = matFor(faces.bottom || faces.top);
    const side = matFor(faces.side);
    mats = [side, side, top, bottom, side, side];
    byFace = { top, bottom, side };
    procedural = { top: faces.top, bottom: faces.bottom || faces.top, side: faces.side };
  }
  return { mats, byFace, procedural };
}

function getMaterials(id) {
  if (!materialCache[id]) materialCache[id] = buildMaterialsForBlock(id);
  return materialCache[id].mats;
}

const swatchCache = {};
function swatchDataUrl(id) {
  if (swatchCache[id]) return swatchCache[id];
  const def = DEFS_BY_ID[id];
  if (def.icon) { swatchCache[id] = def.icon(); return swatchCache[id]; }
  const faces = def.faces();
  const tex = faces.all || faces.side || faces.top;
  const url = tex.image.toDataURL();
  swatchCache[id] = url;
  return url;
}

// Re-draws a block's hotbar/inventory swatch from whatever texture its
// material currently has (procedural or API-loaded) and pushes it to
// every matching swatch element already in the DOM.
function refreshSwatchForId(id) {
  const cache = materialCache[id];
  if (!cache) return;
  const mat = cache.byFace.all || cache.byFace.side || cache.byFace.top;
  if (!mat || !mat.map || !mat.map.image) return;
  try {
    const c = makeCanvas(32);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(mat.map.image, 0, 0, 32, 32);
    swatchCache[id] = c.toDataURL();
  } catch (e) {
    // Canvas may be tainted if the remote host doesn't send CORS headers —
    // just skip the swatch refresh, the 3D texture itself still applied fine.
    return;
  }
  document.querySelectorAll('[data-id="' + id + '"] .swatch').forEach(el => {
    el.style.backgroundImage = 'url(' + swatchCache[id] + ')';
  });
  if (selectedId === id) selectBlock(id);
}

/* ---------------------------------------------------------------
   3.5 HYBRID TEXTURE LOADING (MC Assets CDN, with offline fallback)

   Two independent public mirrors are tried, in order, for every texture.
   If a mirror is blocked (CORS, ad-blocker, restrictive CSP in the page
   this script is embedded in, offline, etc.) the next mirror is tried
   before giving up and keeping the procedural texture. Every failure is
   logged to the console with the exact URL and error so this is actually
   debuggable — open devtools and look for "[AR Craft]" warnings.
   --------------------------------------------------------------- */
const MC_VERSION = '1.21.3';
const TEXTURE_SOURCES = [
  (category, name) => 'https://mcasset.cloud/' + MC_VERSION + '/assets/minecraft/textures/' + category + '/' + name + '.png',
  (category, name) => 'https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/' + MC_VERSION + '/assets/minecraft/textures/' + category + '/' + name + '.png'
];
const API_TIMEOUT_MS = 6000;

const apiTextureLoader = new THREE.TextureLoader();
apiTextureLoader.setCrossOrigin('anonymous');

const apiLoadStats = { ok: 0, fail: 0 };

function configureLoadedTexture(tex) {
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function loadTextureWithTimeout(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('timeout loading ' + url)); }
    }, timeoutMs);
    apiTextureLoader.load(
      url,
      tex => { if (!settled) { settled = true; clearTimeout(timer); resolve(tex); } },
      undefined,
      err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } }
    );
  });
}

// Multiplies a loaded texture image by a tint colour (for biome-tinted
// textures like grass/leaves) while preserving the original alpha shape.
function tintTexture(image, hexColor) {
  const w = image.width || 16, h = image.height || 16;
  const c = makeCanvas(Math.max(w, h));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.drawImage(image, 0, 0, w, h);
  ctx.globalCompositeOperation = 'multiply';
  ctx.fillStyle = hexColor;
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(image, 0, 0, w, h);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

async function fetchApiTexture(name, tint, category) {
  category = category || 'block';
  let lastErr = null;
  for (let i = 0; i < TEXTURE_SOURCES.length; i++) {
    const url = TEXTURE_SOURCES[i](category, name);
    try {
      const raw = await loadTextureWithTimeout(url, API_TIMEOUT_MS);
      configureLoadedTexture(raw);
      apiLoadStats.ok++;
      if (!tint) return raw;
      try {
        const canvas = tintTexture(raw.image, tint);
        return configureLoadedTexture(new THREE.CanvasTexture(canvas));
      } catch (tintErr) {
        // If the canvas got tainted (no CORS headers from this mirror), fall
        // back to the untinted texture rather than failing the whole block.
        console.warn('[AR Craft] Could not tint "' + name + '" (CORS?), using untinted texture.', tintErr);
        return raw;
      }
    } catch (err) {
      lastErr = err;
      console.warn('[AR Craft] Texture mirror failed for "' + category + '/' + name + '": ' + url, err && (err.message || err.type || err));
    }
  }
  apiLoadStats.fail++;
  throw lastErr || new Error('All texture mirrors failed for ' + category + '/' + name);
}

// Crops a rectangular region out of a loaded image (used to pull individual
// body-part swatches out of a full Minecraft entity skin sheet).
function cropTextureRegion(image, sx, sy, sw, sh) {
  const c = makeCanvas(Math.max(sw, sh));
  c.width = sw; c.height = sh;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

function applyTextureToFace(cache, faceKey, tex) {
  const mat = cache.byFace[faceKey];
  if (!mat) return;
  mat.map = tex;
  if (mat.emissiveMap) mat.emissiveMap = tex;
  mat.needsUpdate = true;
}

function loadApiTexturesForId(id) {
  const def = DEFS_BY_ID[id];
  if (!def || !def.api || def.isTool) return Promise.resolve();
  getMaterials(id); // ensure procedural materials exist first (instant fallback)
  const cache = materialCache[id];
  const spec = def.api;
  const jobs = [];
  if (spec.all) {
    jobs.push(
      fetchApiTexture(spec.all, spec.tint)
        .then(tex => { applyTextureToFace(cache, 'all', tex); refreshSwatchForId(id); })
        .catch(() => {})
    );
  } else {
    if (spec.top) jobs.push(fetchApiTexture(spec.top, spec.tint).then(tex => { applyTextureToFace(cache, 'top', tex); refreshSwatchForId(id); }).catch(() => {}));
    if (spec.bottom) jobs.push(fetchApiTexture(spec.bottom).then(tex => applyTextureToFace(cache, 'bottom', tex)).catch(() => {}));
    if (spec.side) jobs.push(fetchApiTexture(spec.side).then(tex => { applyTextureToFace(cache, 'side', tex); refreshSwatchForId(id); }).catch(() => {}));
  }
  return Promise.all(jobs);
}

// Fetches the real vanilla zombie entity skin (a single 64x64 sheet) and
// crops the standard humanoid box-UV front-facing regions out of it for the
// head/body/arm/leg boxes. This is a close approximation rather than a
// pixel-perfect UV unwrap (each box uses one texture on all its sides), but
// it reads as a real zombie instead of flat colour blocks. Falls back to
// the flat colours already on zombieMaterials if the fetch/crop fails.
function loadZombieApiSkin() {
  if (!settings.useApiTextures) return Promise.resolve();
  return fetchApiTexture('zombie', null, 'entity/zombie').then(raw => {
    const img = raw.image;
    // Standard 64x64 humanoid skin layout, front-facing layer-0 regions.
    const regions = {
      head: [8, 8, 8, 8],
      body: [20, 20, 8, 12],
      arm: [44, 20, 4, 12],
      leg: [4, 20, 4, 12]
    };
    let appliedAny = false;
    Object.keys(regions).forEach(part => {
      const mat = zombieMaterials[part];
      if (!mat) return;
      try {
        const r = regions[part];
        const canvas = cropTextureRegion(img, r[0], r[1], r[2], r[3]);
        mat.map = configureLoadedTexture(new THREE.CanvasTexture(canvas));
        mat.needsUpdate = true;
        appliedAny = true;
      } catch (e) {
        console.warn('[AR Craft] Could not crop zombie skin region "' + part + '" (CORS?) — keeping flat colour.', e);
      }
    });
    if (appliedAny) toast('Zombie texture loaded!');
  }).catch(() => {});
}

function revertZombieToProceduralColors() {
  ['head', 'body', 'arm', 'leg'].forEach(part => {
    const mat = zombieMaterials[part];
    if (!mat) return;
    mat.map = null;
    mat.needsUpdate = true;
  });
}

// Fetches the real "zombie_spawn_egg" item icon and swaps it in for the
// procedurally-drawn egg icon on the hotbar/inventory slot.
function loadSpawnEggApiIcon(id) {
  if (!settings.useApiTextures) return Promise.resolve();
  const def = DEFS_BY_ID[id];
  if (!def || !def.apiIcon) return Promise.resolve();
  return fetchApiTexture(def.apiIcon, null, 'item').then(raw => {
    try {
      const c = makeCanvas(32);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(raw.image, 0, 0, 32, 32);
      swatchCache[id] = c.toDataURL();
    } catch (e) {
      console.warn('[AR Craft] Could not read spawn egg icon (CORS?) — keeping built-in icon.', e);
      return;
    }
    document.querySelectorAll('[data-id="' + id + '"] .swatch').forEach(el => {
      el.style.backgroundImage = 'url(' + swatchCache[id] + ')';
    });
    if (selectedId === id) selectBlock(id);
  }).catch(() => {});
}

function revertSpawnEggIconToProcedural(id) {
  const def = DEFS_BY_ID[id];
  if (!def || !def.icon) return;
  swatchCache[id] = def.icon();
  document.querySelectorAll('[data-id="' + id + '"] .swatch').forEach(el => {
    el.style.backgroundImage = 'url(' + swatchCache[id] + ')';
  });
  if (selectedId === id) selectBlock(id);
}

function loadAllApiTextures() {
  if (!settings.useApiTextures) return;
  apiLoadStats.ok = 0;
  apiLoadStats.fail = 0;
  console.info('[AR Craft] Loading online textures. Trying, in order:', TEXTURE_SOURCES.map(f => f('block', '<name>')));
  const jobs = BLOCK_DEFS.filter(def => def.api).map(def => loadApiTexturesForId(def.id));
  jobs.push(loadZombieApiSkin());
  TOOL_DEFS.forEach(def => { if (def.apiIcon) jobs.push(loadSpawnEggApiIcon(def.id)); });
  Promise.all(jobs).then(() => {
    if (!settings.useApiTextures) return; // user toggled it back off while this was in flight
    if (apiLoadStats.ok === 0 && apiLoadStats.fail > 0) {
      toast('Online textures unavailable — using built-in art');
      console.warn('[AR Craft] Every online texture request failed (' + apiLoadStats.fail + ' textures). ' +
        'This is almost always the network/browser blocking the request — check the warnings above ' +
        'for the exact URL + error (common causes: no internet, an ad-blocker/extension, a restrictive ' +
        'Content-Security-Policy on the page hosting this script, or the page running inside a sandboxed ' +
        'iframe/preview tool that blocks cross-origin network requests).');
    } else if (apiLoadStats.fail > 0) {
      toast('Loaded ' + apiLoadStats.ok + ' online textures (' + apiLoadStats.fail + ' used built-in art)');
    } else if (apiLoadStats.ok > 0) {
      toast('Online Minecraft textures loaded!');
    }
  });
}

function revertAllToProceduralTextures() {
  Object.keys(materialCache).forEach(id => {
    const cache = materialCache[id];
    if (!cache.procedural) return;
    Object.keys(cache.procedural).forEach(faceKey => {
      const mat = cache.byFace[faceKey];
      const tex = cache.procedural[faceKey];
      if (!mat || !tex) return;
      mat.map = tex;
      if (mat.emissiveMap) mat.emissiveMap = tex;
      mat.needsUpdate = true;
    });
    refreshSwatchForId(id);
  });
  revertZombieToProceduralColors();
  TOOL_DEFS.forEach(def => { if (def.apiIcon) revertSpawnEggIconToProcedural(def.id); });
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

// Black 3D "aimed at" outline — transparent block with black edges.
// Its scale is adjusted at runtime to also wrap around a targeted zombie.
const aimOutline = new THREE.LineSegments(
  new THREE.EdgesGeometry(new THREE.BoxGeometry(GRID * 1.02, GRID * 1.02, GRID * 1.02)),
  new THREE.LineBasicMaterial({ color: 0x000000, linewidth: 2 })
);
aimOutline.visible = false;
worldRoot.add(aimOutline);

// Full grid-cell size (not shrunk) so adjacent blocks sit flush with no visible
// seams between them. This is safe from z-fighting because two neighbouring
// blocks' touching faces point in opposite directions — only one is ever
// front-facing to the camera at a time.
const blockGeometry = new THREE.BoxGeometry(GRID, GRID, GRID);
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
  cancelPrimedTntAt(ix, iy, iz);
  return true;
}

/* ---- targeting: raycast from the fixed center crosshair ---- */
const raycaster = new THREE.Raycaster();
raycaster.far = settings.reach;
const NDC_CENTER = new THREE.Vector2(0, 0);
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

function raycastGroundCell() {
  groundPlane.constant = -worldRoot.position.y;
  const pt = new THREE.Vector3();
  const hit = raycaster.ray.intersectPlane(groundPlane, pt);
  if (!hit) return null;
  if (raycaster.ray.origin.distanceTo(pt) > settings.reach) return null;
  const local = pt.clone().sub(worldRoot.position);
  return { ix: Math.round(local.x / GRID), iy: 0, iz: Math.round(local.z / GRID) };
}

function updateTargeting() {
  raycaster.far = settings.reach;
  raycaster.setFromCamera(NDC_CENTER, camera);
  let target = null;
  const zombieHitMeshes = zombies.map(z => z.hitMesh);
  const combined = blockMeshList.concat(zombieHitMeshes);
  if (combined.length) {
    const hits = raycaster.intersectObjects(combined, false);
    if (hits.length > 0) {
      const hit = hits[0];
      const ud = hit.object.userData;
      if (ud.isZombieHitbox) {
        target = { mode: 'zombie', zombieId: ud.zombieId };
      } else {
        const n = hit.face.normal; // blocks are axis-aligned & unrotated, so this is already a world-axis direction
        target = {
          mode: 'block',
          block: { ix: ud.ix, iy: ud.iy, iz: ud.iz },
          placeCell: { ix: ud.ix + Math.round(n.x), iy: ud.iy + Math.round(n.y), iz: ud.iz + Math.round(n.z) }
        };
      }
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
  if (currentTarget.mode === 'zombie') {
    const z = zombies.find(zz => zz.id === currentTarget.zombieId);
    if (!z) { aimOutline.visible = false; return; }
    const baseSize = GRID * 1.02;
    aimOutline.scale.set(ZOMBIE_HIT_W / baseSize, ZOMBIE_HIT_H / baseSize, ZOMBIE_HIT_D / baseSize);
    aimOutline.position.copy(z.group.position);
    aimOutline.position.y += ZOMBIE_HIT_H / 2;
    aimOutline.visible = true;
    return;
  }
  aimOutline.scale.set(1, 1, 1);
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
function spawnColoredParticles(localPos, material, count) {
  for (let i = 0; i < count; i++) {
    const p = new THREE.Mesh(particleGeometry, material);
    p.position.copy(localPos);
    worldRoot.add(p);
    particles.push({
      mesh: p,
      vel: new THREE.Vector3((Math.random() - 0.5) * 1.4, Math.random() * 1.8 + 0.6, (Math.random() - 0.5) * 1.4),
      life: 0,
      maxLife: 0.4 + Math.random() * 0.3
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



/* ---------------------------------------------------------------
   6.5 ZOMBIE MOB — blocky mesh, simple chase AI, hit detection
   Zombies are ONLY created by using a Zombie Spawn Egg (see section 7) —
   there is no automatic/random spawning, by design.
   --------------------------------------------------------------- */
const ZOMBIE_HEAD_SIZE = GRID * 1.3;
const ZOMBIE_BODY_W = GRID * 1.3;
const ZOMBIE_BODY_H = GRID * 1.9;
const ZOMBIE_BODY_D = GRID * 0.7;
const ZOMBIE_ARM_W = GRID * 0.45;
const ZOMBIE_ARM_H = GRID * 1.85;
const ZOMBIE_LEG_W = GRID * 0.5;
const ZOMBIE_LEG_H = GRID * 1.9;
const ZOMBIE_TOTAL_HEIGHT = ZOMBIE_LEG_H + ZOMBIE_BODY_H + ZOMBIE_HEAD_SIZE;

const ZOMBIE_HIT_W = (ZOMBIE_BODY_W + ZOMBIE_ARM_W * 2) * 1.25;
const ZOMBIE_HIT_H = ZOMBIE_TOTAL_HEIGHT * 1.05;
const ZOMBIE_HIT_D = ZOMBIE_BODY_D * 1.8;

// One material per body part (not shared across parts) so the real API skin
// can be cropped onto each part independently — see loadZombieApiSkin().
const zombieMaterials = {
  head: new THREE.MeshStandardMaterial({ color: 0x4E9A51, roughness: 0.9, metalness: 0.02 }),
  arm: new THREE.MeshStandardMaterial({ color: 0x4E9A51, roughness: 0.9, metalness: 0.02 }),
  body: new THREE.MeshStandardMaterial({ color: 0x0E7C7B, roughness: 0.9, metalness: 0.02 }),
  leg: new THREE.MeshStandardMaterial({ color: 0x2B3A8F, roughness: 0.9, metalness: 0.02 }),
  eye: new THREE.MeshStandardMaterial({ color: 0x0A0A0A, roughness: 0.6 }),
  hitbox: new THREE.MeshBasicMaterial({ visible: false })
};

const zombieGeometries = {
  head: new THREE.BoxGeometry(ZOMBIE_HEAD_SIZE, ZOMBIE_HEAD_SIZE, ZOMBIE_HEAD_SIZE),
  eye: new THREE.BoxGeometry(ZOMBIE_HEAD_SIZE * 0.18, ZOMBIE_HEAD_SIZE * 0.18, ZOMBIE_HEAD_SIZE * 0.06),
  body: new THREE.BoxGeometry(ZOMBIE_BODY_W, ZOMBIE_BODY_H, ZOMBIE_BODY_D),
  arm: new THREE.BoxGeometry(ZOMBIE_ARM_W, ZOMBIE_ARM_H, ZOMBIE_ARM_W),
  leg: new THREE.BoxGeometry(ZOMBIE_LEG_W, ZOMBIE_LEG_H, ZOMBIE_LEG_W),
  hitbox: new THREE.BoxGeometry(ZOMBIE_HIT_W, ZOMBIE_HIT_H, ZOMBIE_HIT_D)
};

let zombies = [];
let zombieIdCounter = 0;

// Builds one zombie's visual group (feet at local y = 0) plus an
// invisible hitbox used only for raycasting (mine/attack targeting).
function buildZombieMesh() {
  const group = new THREE.Group();
  const legY = ZOMBIE_LEG_H / 2;
  const bodyY = ZOMBIE_LEG_H + ZOMBIE_BODY_H / 2;
  const headY = ZOMBIE_LEG_H + ZOMBIE_BODY_H + ZOMBIE_HEAD_SIZE / 2;

  const head = new THREE.Mesh(zombieGeometries.head, zombieMaterials.head);
  head.position.y = headY;
  group.add(head);

  const eyeL = new THREE.Mesh(zombieGeometries.eye, zombieMaterials.eye);
  eyeL.position.set(-ZOMBIE_HEAD_SIZE * 0.22, headY, ZOMBIE_HEAD_SIZE / 2 + 0.001);
  const eyeR = new THREE.Mesh(zombieGeometries.eye, zombieMaterials.eye);
  eyeR.position.set(ZOMBIE_HEAD_SIZE * 0.22, headY, ZOMBIE_HEAD_SIZE / 2 + 0.001);
  group.add(eyeL, eyeR);

  const body = new THREE.Mesh(zombieGeometries.body, zombieMaterials.body);
  body.position.y = bodyY;
  group.add(body);

  const armL = new THREE.Mesh(zombieGeometries.arm, zombieMaterials.arm);
  armL.position.set(-(ZOMBIE_BODY_W / 2 + ZOMBIE_ARM_W / 2), bodyY + GRID * 0.05, 0);
  armL.rotation.z = 0.15;
  const armR = new THREE.Mesh(zombieGeometries.arm, zombieMaterials.arm);
  armR.position.set(ZOMBIE_BODY_W / 2 + ZOMBIE_ARM_W / 2, bodyY + GRID * 0.05, 0);
  armR.rotation.z = -0.15;
  group.add(armL, armR);

  const legL = new THREE.Mesh(zombieGeometries.leg, zombieMaterials.leg);
  legL.position.set(-ZOMBIE_LEG_W * 0.55, legY, 0);
  const legR = new THREE.Mesh(zombieGeometries.leg, zombieMaterials.leg);
  legR.position.set(ZOMBIE_LEG_W * 0.55, legY, 0);
  group.add(legL, legR);

  [head, body, armL, armR, legL, legR].forEach(m => { m.castShadow = true; m.receiveShadow = true; });

  const hitMesh = new THREE.Mesh(zombieGeometries.hitbox, zombieMaterials.hitbox);
  hitMesh.visible = false;
  hitMesh.position.y = ZOMBIE_HIT_H / 2;
  group.add(hitMesh);

  return { group, hitMesh };
}

const _camWorldPos = new THREE.Vector3();
function worldRootLocalOfCamera() {
  camera.getWorldPosition(_camWorldPos);
  return worldRoot.worldToLocal(_camWorldPos.clone());
}

// The ONLY way a zombie enters the world: spawns it at a specific grid cell
// (called from useZombieSpawnEgg() when the player uses the egg on the
// ground or a block). No timer, no randomness in *whether* one appears.
function spawnZombieAt(localX, localZ) {
  if (zombies.length >= MAX_ZOMBIES) { toast('Too many zombies already! (max ' + MAX_ZOMBIES + ')'); return; }
  const { group, hitMesh } = buildZombieMesh();
  group.position.set(localX, 0, localZ);
  worldRoot.add(group);

  const zid = zombieIdCounter++;
  hitMesh.userData = { isZombieHitbox: true, zombieId: zid };

  zombies.push({
    id: zid,
    group,
    hitMesh,
    hp: ZOMBIE_MAX_HP,
    bobT: Math.random() * 10,
    alerted: false
  });
  toast('Zombie spawned!');
}

function updateZombies(dt) {
  if (!zombies.length) return;
  const playerLocal = worldRootLocalOfCamera();
  const stopDist = ZOMBIE_STOP_DIST;
  for (let i = 0; i < zombies.length; i++) {
    const z = zombies[i];
    const dx = playerLocal.x - z.group.position.x;
    const dz = playerLocal.z - z.group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist > stopDist && dist > 1e-4) {
      const nx = dx / dist, nz = dz / dist;
      z.group.position.x += nx * ZOMBIE_SPEED * dt;
      z.group.position.z += nz * ZOMBIE_SPEED * dt;
    }
    if (dist > 1e-4) z.group.rotation.y = Math.atan2(dx, dz);
    z.bobT += dt * 5;
    z.group.position.y = Math.sin(z.bobT) * GRID * 0.06;
    if (dist <= stopDist && !z.alerted) { z.alerted = true; toast('A zombie is attacking you!'); }
    if (dist > stopDist * 1.4) z.alerted = false;
  }
}

function spawnZombieHitParticles(localPos, count) {
  spawnColoredParticles(localPos, zombieMaterials.head, count || 6);
}

function removeZombie(z) {
  worldRoot.remove(z.group);
  const idx = zombies.indexOf(z);
  if (idx !== -1) zombies.splice(idx, 1);
  if (currentTarget && currentTarget.mode === 'zombie' && currentTarget.zombieId === z.id) currentTarget = null;
}

function attackZombie(zid) {
  const z = zombies.find(zz => zz.id === zid);
  if (!z) return;
  z.hp -= 1;
  const hitPos = z.group.position.clone();
  hitPos.y += ZOMBIE_TOTAL_HEIGHT * 0.6;
  if (z.hp <= 0) {
    spawnZombieHitParticles(hitPos, 16);
    removeZombie(z);
    toast('Zombie defeated!');
  } else {
    spawnZombieHitParticles(hitPos, 6);
    toast('Hit! (' + z.hp + ' HP left)');
  }
}

function despawnAllZombies() {
  [...zombies].forEach(removeZombie);
}

// Uses the Zombie Spawn Egg on whatever is currently targeted — the ground
// or the top of a block, exactly like using an egg in Minecraft.
function useZombieSpawnEgg() {
  if (!settings.mobsEnabled) { toast('Mobs are disabled in Settings'); return; }
  if (!currentTarget || currentTarget.mode === 'zombie' || !currentTarget.placeCell) {
    toast('Aim at the ground or a block to place the egg');
    return;
  }
  const cell = currentTarget.placeCell;
  spawnZombieAt(cell.ix * GRID, cell.iz * GRID);
}

/* ---------------------------------------------------------------
   6.6 TNT — Flint & Steel ignites TNT (short fuse, then a real blast)
   or an obsidian portal frame, matching what each item is aimed at.
   --------------------------------------------------------------- */
let primedTnts = [];

function cancelPrimedTntAt(ix, iy, iz) {
  for (let i = primedTnts.length - 1; i >= 0; i--) {
    const p = primedTnts[i];
    if (p.ix === ix && p.iy === iy && p.iz === iz) {
      if (p.light) worldRoot.remove(p.light);
      if (p.mesh) p.mesh.scale.setScalar(1);
      primedTnts.splice(i, 1);
    }
  }
}

function igniteTnt(cell) {
  const key = cellKey(cell.ix, cell.iy, cell.iz);
  const entry = occupied.get(key);
  if (!entry || entry.typeId !== 'tnt') return;
  if (primedTnts.some(p => p.ix === cell.ix && p.iy === cell.iy && p.iz === cell.iz)) {
    toast('That TNT is already primed!');
    return;
  }
  const light = new THREE.PointLight(0xffaa33, 1.2, GRID * 6);
  light.position.copy(entry.mesh.position);
  worldRoot.add(light);
  primedTnts.push({ ix: cell.ix, iy: cell.iy, iz: cell.iz, mesh: entry.mesh, light, t: 0, fuse: 1.6 });
  toast('TNT primed — get back!');
}

// Ticks every primed TNT's fuse: the block pulses/flickers faster as it
// nears detonation, then explodes. Uses per-instance mesh.scale (not the
// shared material) for the flicker, since all TNT blocks share one
// material and we don't want every TNT block flashing at once.
function updatePrimedTnt(dt) {
  for (let i = primedTnts.length - 1; i >= 0; i--) {
    const p = primedTnts[i];
    p.t += dt;
    const pulseSpeed = 14 + p.t * 6; // flicker speeds up as the fuse burns down
    const pulse = (Math.sin(p.t * pulseSpeed) + 1) / 2;
    if (p.mesh) p.mesh.scale.setScalar(1 + pulse * 0.12);
    if (p.light) p.light.intensity = 1.2 + pulse * 2.2;
    if (p.t < p.fuse) continue;
    primedTnts.splice(i, 1);
    if (p.light) worldRoot.remove(p.light);
    if (p.mesh) p.mesh.scale.setScalar(1);
    if (!occupied.has(cellKey(p.ix, p.iy, p.iz))) continue; // mined away before it went off
    mineBlockAt(p.ix, p.iy, p.iz);
    explodeTnt(p.ix, p.iy, p.iz);
  }
}

const explosionParticleMats = [
  new THREE.MeshStandardMaterial({ color: 0xFF8C1A, emissive: 0xFF5500, emissiveIntensity: 0.6, roughness: 0.6 }),
  new THREE.MeshStandardMaterial({ color: 0x2B2B2B, roughness: 0.9 }),
  new THREE.MeshStandardMaterial({ color: 0xFFD24C, emissive: 0xFFAA00, emissiveIntensity: 0.7, roughness: 0.5 })
];
let explosionFlashes = [];

function spawnExplosionParticles(localPos) {
  for (let i = 0; i < 26; i++) {
    const mat = explosionParticleMats[i % explosionParticleMats.length];
    const p = new THREE.Mesh(particleGeometry, mat);
    p.position.copy(localPos);
    worldRoot.add(p);
    const speed = 1.6 + Math.random() * 2.2;
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    particles.push({
      mesh: p,
      vel: new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.abs(Math.cos(phi)) + 0.6, Math.sin(phi) * Math.sin(theta)).multiplyScalar(speed),
      life: 0,
      maxLife: 0.5 + Math.random() * 0.4
    });
  }
  const flash = new THREE.PointLight(0xffaa33, 3.5, GRID * 14);
  flash.position.copy(localPos);
  worldRoot.add(flash);
  explosionFlashes.push({ light: flash, t: 0, duration: 0.35 });
}

function updateExplosionFlashes(dt) {
  for (let i = explosionFlashes.length - 1; i >= 0; i--) {
    const f = explosionFlashes[i];
    f.t += dt;
    const k = Math.min(1, f.t / f.duration);
    f.light.intensity = 3.5 * (1 - k);
    if (k >= 1) { worldRoot.remove(f.light); explosionFlashes.splice(i, 1); }
  }
}

function explodeTnt(ix, iy, iz) {
  const blastRadiusCells = 2.4;
  const blastRadiusMetres = blastRadiusCells * GRID;
  const centerLocal = new THREE.Vector3(ix * GRID, iy * GRID, iz * GRID);

  const toRemove = [];
  occupied.forEach(entry => {
    const dx = entry.ix - ix, dy = entry.iy - iy, dz = entry.iz - iz;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dist > blastRadiusCells) return;
    if (entry.typeId === 'bedrock') return; // indestructible, matches vanilla
    const chance = Math.max(0.35, 1 - dist / blastRadiusCells);
    if (Math.random() < chance) toRemove.push({ ix: entry.ix, iy: entry.iy, iz: entry.iz });
  });
  toRemove.forEach(c => mineBlockAt(c.ix, c.iy, c.iz)); // reuses normal mine particles + portal cleanup

  [...zombies].forEach(z => {
    const dx = z.group.position.x - centerLocal.x;
    const dz = z.group.position.z - centerLocal.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist <= blastRadiusMetres) {
      const hitPos = z.group.position.clone();
      hitPos.y += ZOMBIE_TOTAL_HEIGHT * 0.5;
      spawnZombieHitParticles(hitPos, 10);
      removeZombie(z);
    }
  });

  spawnExplosionParticles(centerLocal);
  toast('KABOOM!');
}

// Chooses what Flint & Steel does based on what's actually being aimed at.
function useFlintAndSteel() {
  if (!currentTarget || currentTarget.mode !== 'block') { toast('Aim Flint & Steel at TNT or an obsidian frame'); return; }
  const entry = occupied.get(cellKey(currentTarget.block.ix, currentTarget.block.iy, currentTarget.block.iz));
  if (!entry) { toast('Aim Flint & Steel at TNT or an obsidian frame'); return; }
  if (entry.typeId === 'tnt') { igniteTnt(currentTarget.block); return; }
  if (entry.typeId === 'obsidian') {
    const frame = findPortalFrame(currentTarget.block);
    if (!frame) { toast('No valid frame — build a standing obsidian rectangle with an empty middle'); return; }
    if (portalExistsForFrame(frame)) { toast('That portal is already lit'); return; }
    ignitePortal(frame);
    toast('The portal roars to life!');
    return;
  }
  toast('Flint & Steel works on TNT or an obsidian portal frame');
}

/* ---------------------------------------------------------------
   7. PLACE / MINE BUTTONS
   --------------------------------------------------------------- */
placeBtn.addEventListener('click', () => {
  if (!worldPlaced) { toast('Place the world first'); return; }
  if (!currentTarget) { toast('Point at a surface to build on'); return; }
  if (currentTarget.mode === 'zombie') { toast("Can't build on a mob — mine it first!"); return; }
  if (selectedId === 'flint_and_steel') { useFlintAndSteel(); return; }
  if (selectedId === 'zombie_spawn_egg') { useZombieSpawnEgg(); return; }
  const cell = currentTarget.placeCell;
  if (cell.iy < 0) { toast("Can't build below the ground"); return; }
  const ok = placeBlockAt(cell.ix, cell.iy, cell.iz, selectedId);
  if (!ok) toast('Something is already there');
});

mineBtn.addEventListener('click', () => {
  if (!worldPlaced) { toast('Place the world first'); return; }
  if (!currentTarget) { toast('Aim at a block or mob'); return; }
  if (currentTarget.mode === 'zombie') { attackZombie(currentTarget.zombieId); return; }
  if (currentTarget.mode !== 'block') { toast('Aim at a block to mine'); return; }
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

   Tapping ANY inventory item selects it immediately (so it's always usable
   right away), and also "arms" it with a white highlight. Tapping a hotbar
   slot next pins that armed item into the hotbar permanently, replacing
   whatever was there. The inventory modal shows a live copy of the 8
   hotbar slots at its top (the real hotbar sits behind the modal while
   it's open, so this in-modal row is what you actually tap to assign).
   --------------------------------------------------------------- */
let heldInventoryId = null;

function clearHeldInventoryItem() {
  heldInventoryId = null;
  document.querySelectorAll('.arc-held').forEach(el => el.classList.remove('arc-held'));
}

function makeSlotEl(id, isInventory, hotbarIndex) {
  const def = DEFS_BY_ID[id];
  const slot = document.createElement('button');
  slot.className = isInventory ? 'inv-slot' : 'hotbar-slot';
  slot.dataset.id = id;
  const swatch = document.createElement('div');
  swatch.className = 'swatch';
  if (def.isTool && !def.icon) {
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
  slot.addEventListener('click', () => {
    if (isInventory) onInventorySlotTapped(id, slot);
    else onHotbarSlotTapped(hotbarIndex);
  });
  return slot;
}

function onInventorySlotTapped(id, slotEl) {
  selectBlock(id); // tapping an inventory item always equips it immediately
  document.querySelectorAll('.arc-held').forEach(el => el.classList.remove('arc-held'));
  heldInventoryId = id;
  slotEl.classList.add('arc-held');
  toast(DEFS_BY_ID[id].name + ' selected — tap a hotbar slot above to pin it there too');
}

function onHotbarSlotTapped(index) {
  if (heldInventoryId) {
    const newId = heldInventoryId;
    HOTBAR_IDS[index] = newId;
    clearHeldInventoryItem();
    buildHotbar();
    buildInventoryHotbarRow();
    selectBlock(newId);
    toast(DEFS_BY_ID[newId].name + ' pinned to hotbar!');
  } else {
    selectBlock(HOTBAR_IDS[index]);
  }
}

function buildHotbar() {
  Array.from(hotbarEl.children).forEach(ch => { if (ch.id !== 'more-blocks-btn') ch.remove(); });
  HOTBAR_IDS.forEach((id, idx) => hotbarEl.insertBefore(makeSlotEl(id, false, idx), moreBtn));
  refreshHotbarSelection();
}

// A live 8-slot copy of the hotbar, shown at the top of the inventory
// modal. It's a real, independent set of buttons (not just a picture of
// the hotbar) so it works as the assign target while the modal is open.
const inventoryHotbarRow = document.createElement('div');
inventoryHotbarRow.id = 'arc-inv-hotbar-row';
inventoryHotbarRow.className = 'arc-inv-hotbar-row';

function buildInventoryHotbarRow() {
  inventoryHotbarRow.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'arc-inv-hotbar-label';
  label.textContent = 'Your Hotbar — tap a slot to pin the selected item there';
  inventoryHotbarRow.appendChild(label);
  const row = document.createElement('div');
  row.className = 'arc-inv-hotbar-slots';
  HOTBAR_IDS.forEach((id, idx) => row.appendChild(makeSlotEl(id, false, idx)));
  inventoryHotbarRow.appendChild(row);
  refreshHotbarSelection();
}

function buildInventory() {
  if (!inventoryHotbarRow.parentNode && inventoryGrid.parentNode) {
    inventoryGrid.parentNode.insertBefore(inventoryHotbarRow, inventoryGrid);
  }
  buildInventoryHotbarRow();
  inventoryGrid.innerHTML = '';
  BLOCK_DEFS.concat(TOOL_DEFS).forEach(def => inventoryGrid.appendChild(makeSlotEl(def.id, true)));
  refreshInventorySelection();
}

// Scoped to the whole document (not just hotbarEl) since hotbar-style
// slots now also live inside the inventory modal's preview row.
function refreshHotbarSelection() {
  document.querySelectorAll('.hotbar-slot').forEach(el => el.classList.toggle('selected', el.dataset.id === selectedId));
}
function refreshInventorySelection() {
  inventoryGrid.querySelectorAll('.inv-slot').forEach(el => el.classList.toggle('selected', el.dataset.id === selectedId));
}

function selectBlock(id) {
  selectedId = id;
  const def = DEFS_BY_ID[id];
  selectedNameEl.textContent = def.name;
  if (def.isTool && !def.icon) {
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
closeInventoryBtn.addEventListener('click', () => { inventoryModal.classList.add('hidden'); clearHeldInventoryItem(); });
helpBtn.addEventListener('click', () => helpModal.classList.remove('hidden'));
closeHelpBtn.addEventListener('click', () => helpModal.classList.add('hidden'));
[inventoryModal, helpModal].forEach(m => {
  m.addEventListener('click', e => {
    if (e.target !== m) return;
    m.classList.add('hidden');
    if (m === inventoryModal) clearHeldInventoryItem();
  });
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

/* ---- pinch-to-zoom (manual world scale) ----
   Fallback mode has no positional/6DoF tracking — device orientation only
   reports rotation, never how far the phone has physically moved — so the
   app has no way to tell that the player walked closer or farther away,
   and the world can't automatically get bigger/smaller the way it would in
   true AR. (XR mode doesn't have this problem: it uses the device's real
   tracked position, so walking around it already works correctly.) Pinch
   with two fingers lets the player manually compensate in fallback mode. */
const WORLD_SCALE_MIN = 0.3, WORLD_SCALE_MAX = 3.0;
let worldScale = 1;
let pinchActive = false, pinchStartDist = 0, pinchStartScale = 1;

function touchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function setupPinchZoom() {
  canvas.addEventListener('touchstart', e => {
    if (currentARMode !== 'fallback' || e.touches.length !== 2) return;
    pinchActive = true;
    pinchStartDist = touchDistance(e.touches);
    pinchStartScale = worldScale;
  }, { passive: true });
  canvas.addEventListener('touchmove', e => {
    if (!pinchActive || e.touches.length !== 2 || pinchStartDist < 1) return;
    const ratio = touchDistance(e.touches) / pinchStartDist;
    worldScale = Math.min(WORLD_SCALE_MAX, Math.max(WORLD_SCALE_MIN, pinchStartScale * ratio));
    worldRoot.scale.setScalar(worldScale);
  }, { passive: true });
  const endPinch = e => { if (e.touches.length < 2) pinchActive = false; };
  canvas.addEventListener('touchend', endPinch, { passive: true });
  canvas.addEventListener('touchcancel', endPinch, { passive: true });
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
    optionalFeatures: ['dom-overlay', 'anchors'],
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
  lastHitResult = null; worldAnchor = null;
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
    lastHitResult = results[0];
    const pose = lastHitResult.getPose(xrRefSpace);
    lastHitPose = pose;
    reticle.visible = true;
    reticle.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
    setPlaceWorldButtonEnabled(true);
    placementText.textContent = 'Floor detected — tap to place your world.';
  } else {
    reticle.visible = false;
    lastHitPose = null;
    lastHitResult = null;
    setPlaceWorldButtonEnabled(false);
    placementText.textContent = 'Slowly move your device to scan the floor…';
  }
}

// Once placed, this re-reads the anchor's pose every frame so the world
// stays glued to the real surface as ARCore/ARKit refines its own tracking
// — a static position snapshot alone can't self-correct like this, which
// is what causes placed content to visibly drift/slide over time,
// especially on low-detail or patterned surfaces the camera struggles to
// track well (plain fabric, blank walls, repeating patterns, etc).
function updateXRAnchor(frame) {
  if (!worldAnchor || !xrRefSpace) return;
  const pose = frame.getPose(worldAnchor.anchorSpace, xrRefSpace);
  if (pose) {
    worldRoot.position.set(pose.transform.position.x, pose.transform.position.y, pose.transform.position.z);
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

// Camera/AR access is governed entirely by the browser's security sandbox —
// no amount of code in this file can force it to work where the platform
// forbids it. These helpers detect the common blockers (embedded iframe
// without permission delegation, non-HTTPS page, unsupported browser) so the
// user gets an accurate explanation instead of a generic failure.
function isEmbeddedInIframe() {
  try { return window.self !== window.top; }
  catch (e) { return true; } // a cross-origin parent throws on access — that's still "embedded"
}

function environmentWarning() {
  if (!window.isSecureContext) {
    return 'This page is not running in a secure context. Camera access and WebXR only work over HTTPS (or http://localhost) — open this page via an https:// URL.';
  }
  if (isEmbeddedInIframe()) {
    return 'This page looks like it is embedded in an iframe (a code preview/simulator, for example). Browsers block camera access inside embedded frames unless the parent page explicitly adds allow="camera; xr-spatial-tracking" to the <iframe>. Try opening this page directly in its own browser tab.';
  }
  return null;
}

function describeMediaError(e) {
  const envMsg = environmentWarning();
  if (envMsg) return envMsg;
  const name = e && e.name;
  if (name === 'NotAllowedError') return 'Camera permission was denied or blocked by a permissions policy. Check your browser\'s site settings, allow camera access, then reload.';
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') return 'No camera was found on this device.';
  if (name === 'NotReadableError' || name === 'TrackStartError') return 'The camera is already in use by another app or browser tab. Close it and try again.';
  if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') return 'No camera on this device matches the requested settings.';
  if (name === 'SecurityError') return 'Camera access was blocked by this page\'s security/permissions policy.';
  return 'Camera access failed (' + (e && (e.message || name) || 'unknown error') + ').';
}

async function detectSupportNote() {
  const envMsg = environmentWarning();
  if (envMsg) {
    supportNote.textContent = envMsg;
    if (!window.isSecureContext) startBtn.disabled = true; // this one truly cannot work — no point letting them tap Start
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    supportNote.textContent = 'This browser does not expose camera access (no navigator.mediaDevices.getUserMedia) — AR Craft needs it to run. Try the latest Chrome, Brave, Edge, or Safari.';
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
  const envMsg = environmentWarning();
  if (envMsg) { showError(envMsg); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showError('This browser does not support camera access, which AR Craft requires. Try the latest Chrome, Brave, Edge, or Safari — many in-app/embedded browsers and simulators intentionally leave this out.');
    return;
  }
  if (xrSupportedCache === null) {
    try { xrSupportedCache = navigator.xr && navigator.xr.isSessionSupported ? await navigator.xr.isSessionSupported('immersive-ar') : false; }
    catch (e) { xrSupportedCache = false; }
  }
  if (xrSupportedCache) {
    currentARMode = 'xr';
    try { await startXRSession(); return; }
    catch (e) { console.warn('[AR Craft] XR session failed, falling back to camera mode.', e); }
  }
  currentARMode = 'fallback';
  try { await startCameraFeed(); }
  catch (e) {
    console.warn('[AR Craft] getUserMedia failed:', e);
    showError(describeMediaError(e));
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
    toast('World placed! Pinch with two fingers to resize it.');
  } else {
    modeBanner.textContent = 'AR ground detection active';
    toast('World placed — start building!');
  }
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
    worldAnchor = null;
    if (lastHitResult && typeof lastHitResult.createAnchor === 'function') {
      lastHitResult.createAnchor().then(anchor => {
        worldAnchor = anchor; // updateXRAnchor() will now keep worldRoot glued to it each frame
      }).catch(err => {
        console.warn('[AR Craft] WebXR anchors unsupported/failed on this device — placement will not self-correct for drift.', err);
      });
    } else {
      console.warn('[AR Craft] This browser/device does not support WebXR anchors — placement is a static snapshot and may drift on low-detail surfaces.');
    }
  } else {
    const p = fallbackGroundPoint();
    if (!p) { toast('Point your camera toward the floor first'); return; }
    worldRoot.position.copy(p);
  }
  worldRoot.quaternion.identity();
  worldScale = 1;
  worldRoot.scale.setScalar(1);
  finalizeWorldPlacement();
});

/* ---------------------------------------------------------------
   14. SETTINGS MENU
   Injects its own gear button + modal so it works without needing
   any changes to the surrounding HTML/CSS.
   --------------------------------------------------------------- */
function createSettingsUI() {
  const style = document.createElement('style');
  style.textContent = `
    .arc-held {
      outline: 3px solid #ffffff !important;
      outline-offset: -3px;
      box-shadow: 0 0 10px 2px rgba(255,255,255,0.85);
    }
    .arc-inv-hotbar-row {
      padding: 10px 10px 14px;
      border-bottom: 2px solid rgba(255,255,255,0.15);
      margin-bottom: 10px;
    }
    .arc-inv-hotbar-label {
      font-size: 11px; opacity: 0.7; margin-bottom: 8px; line-height: 1.3;
    }
    .arc-inv-hotbar-slots {
      display: flex; flex-wrap: wrap; gap: 6px;
    }
    .arc-settings-btn {
      position: fixed; top: 14px; left: 14px; width: 44px; height: 44px; border-radius: 50%;
      background: rgba(20,20,20,0.55); color: #fff; border: 2px solid rgba(255,255,255,0.25);
      font-size: 20px; display: flex; align-items: center; justify-content: center;
      z-index: 45; cursor: pointer; backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px);
      padding: 0;
    }
    .arc-modal-backdrop {
      position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 60;
      align-items: center; justify-content: center;
    }
    .arc-modal-backdrop:not(.hidden) { display: flex; }
    .arc-modal-panel {
      background: #1c1c1e; color: #f2f2f2; width: min(90vw, 380px); max-height: 80vh; overflow: auto;
      border-radius: 14px; padding: 18px 20px 20px; font-family: inherit;
      box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    }
    .arc-modal-panel h2 { margin: 0 0 6px; font-size: 18px; }
    .arc-setting-row {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 0; border-top: 1px solid rgba(255,255,255,0.08);
    }
    .arc-setting-label { font-size: 14px; padding-right: 14px; }
    .arc-setting-sub { font-size: 11px; opacity: 0.6; margin-top: 3px; line-height: 1.3; }
    .arc-toggle {
      position: relative; width: 46px; height: 26px; border-radius: 13px; background: #555;
      border: none; cursor: pointer; flex-shrink: 0; transition: background .15s; padding: 0;
    }
    .arc-toggle.on { background: #5C9A32; }
    .arc-toggle::after {
      content: ''; position: absolute; top: 3px; left: 3px; width: 20px; height: 20px;
      border-radius: 50%; background: #fff; transition: left .15s;
    }
    .arc-toggle.on::after { left: 23px; }
    .arc-slider-row { padding: 14px 0; border-top: 1px solid rgba(255,255,255,0.08); }
    .arc-slider-row input[type=range] { width: 100%; margin-top: 10px; }
    .arc-close-btn {
      margin-top: 18px; width: 100%; padding: 11px; border-radius: 8px; border: none;
      background: #3a3a3c; color: #fff; font-size: 14px; cursor: pointer;
    }
  `;
  document.head.appendChild(style);

  const btn = document.createElement('button');
  btn.className = 'arc-settings-btn';
  btn.type = 'button';
  btn.textContent = '\u2699\uFE0F'; // gear emoji
  btn.setAttribute('aria-label', 'Settings');
  document.body.appendChild(btn);

  const backdrop = document.createElement('div');
  backdrop.className = 'arc-modal-backdrop hidden';
  backdrop.innerHTML =
    '<div class="arc-modal-panel">' +
      '<h2>Settings</h2>' +
      '<div class="arc-setting-row">' +
        '<div><div class="arc-setting-label">Online API Textures</div>' +
        '<div class="arc-setting-sub">Fetch real Minecraft block textures over the network</div></div>' +
        '<button type="button" class="arc-toggle" data-setting="useApiTextures"></button>' +
      '</div>' +
      '<div class="arc-setting-row">' +
        '<div><div class="arc-setting-label">Mobs</div>' +
        '<div class="arc-setting-sub">Spawn zombies to fight in your world</div></div>' +
        '<button type="button" class="arc-toggle" data-setting="mobsEnabled"></button>' +
      '</div>' +
      '<div class="arc-slider-row">' +
        '<div class="arc-setting-label">Reach / Render Distance: <span id="arc-reach-value"></span> m</div>' +
        '<input type="range" id="arc-reach-slider" min="2" max="12" step="0.5">' +
      '</div>' +
      '<button type="button" class="arc-close-btn" id="arc-settings-close">Done</button>' +
    '</div>';
  document.body.appendChild(backdrop);

  const apiToggle = backdrop.querySelector('[data-setting="useApiTextures"]');
  const mobToggle = backdrop.querySelector('[data-setting="mobsEnabled"]');
  const reachSlider = backdrop.querySelector('#arc-reach-slider');
  const reachValue = backdrop.querySelector('#arc-reach-value');

  function syncUI() {
    apiToggle.classList.toggle('on', settings.useApiTextures);
    mobToggle.classList.toggle('on', settings.mobsEnabled);
    reachSlider.value = String(settings.reach);
    reachValue.textContent = settings.reach.toFixed(1);
  }

  apiToggle.addEventListener('click', () => {
    settings.useApiTextures = !settings.useApiTextures;
    syncUI();
    if (settings.useApiTextures) {
      toast('Loading online textures…');
      loadAllApiTextures();
    } else {
      revertAllToProceduralTextures();
      toast('Using built-in textures');
    }
  });

  mobToggle.addEventListener('click', () => {
    settings.mobsEnabled = !settings.mobsEnabled;
    syncUI();
    if (!settings.mobsEnabled) {
      despawnAllZombies();
      toast('Mobs disabled');
    } else {
      toast('Mobs enabled');
    }
  });

  reachSlider.addEventListener('input', () => {
    settings.reach = parseFloat(reachSlider.value);
    reachValue.textContent = settings.reach.toFixed(1);
    raycaster.far = settings.reach;
  });

  btn.addEventListener('click', () => { syncUI(); backdrop.classList.remove('hidden'); });
  backdrop.querySelector('#arc-settings-close').addEventListener('click', () => backdrop.classList.add('hidden'));
  backdrop.addEventListener('click', e => { if (e.target === backdrop) backdrop.classList.add('hidden'); });

  syncUI();
}

/* ---------------------------------------------------------------
   15. MAIN LOOP
   --------------------------------------------------------------- */
function onFrame(timestamp, xrFrame) {
  const dt = Math.min(clock.getDelta(), 0.1);
  if (renderer.xr.isPresenting) {
    if (xrFrame) {
      if (!worldPlaced) updateXRHitTest(xrFrame);
      else updateXRAnchor(xrFrame);
    }
  } else if (usingOrientationFallback) {
    updateFallbackOrientation();
  }
  if (worldPlaced) {
    updateTargeting();
    updatePortals(dt);
    updateZombies(dt);
    updatePrimedTnt(dt);
  }
  updateParticles(dt);
  updatePopAnims(dt);
  updateExplosionFlashes(dt);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(onFrame);

/* ---------------------------------------------------------------
   16. INIT
   --------------------------------------------------------------- */
BLOCK_DEFS.forEach(d => getMaterials(d.id)); // pre-build materials (procedural first) for every block
buildHotbar();
buildInventory();
selectBlock('grass');
createSettingsUI();
setupPinchZoom();
detectSupportNote();
if (settings.useApiTextures) loadAllApiTextures();
