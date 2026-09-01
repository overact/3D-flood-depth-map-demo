/**
 * main.js — Kempsey 3D flood viewer.
 *
 * Render architecture (see SPEC.md §3): one geometry pass into an HDR render target that
 * carries a DepthTexture, a fullscreen blit of that target to the canvas, then the water
 * pass composited manually on top. The water shader samples the target's colour and depth,
 * so it gets screen-space refraction, a correct water column thickness and shoreline foam
 * for the price of a single scene render.
 */

import * as THREE from 'three';
import { MapControls } from 'three/addons/controls/MapControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { loadDataset, sampleRaster, sampleNearest, worldToLonLat, buildStatsIndex } from './data.js';
import { buildTerrainGeometry, createTerrainMaterial, FLAG_OUT } from './terrain.js';
import { createWaterMaterial, createWaterGeometry } from './water.js';
import { loadContextLayers } from './context-layers.js';
import { createUI } from './ui.js';

const WATER_LAYER = 1;
const BASELINE_EPSILON = 0.0005;

function isWetCell(flag, need, offset) {
  if (flag & FLAG_OUT) return false;
  if (flag & 2) return true;
  return Math.abs(offset) < BASELINE_EPSILON ? !!(flag & 1) : offset >= need;
}

// Agent analysis excludes permanent sea and outside-footprint cells. Keep the
// presentation renderer's sea behavior separate so region ids match the host's
// deterministic flood-analysis index exactly.
function isAgentFloodCell(flag, need, offset) {
  if (flag & FLAG_OUT || flag & 2) return false;
  return Math.abs(offset) < BASELINE_EPSILON ? !!(flag & 1) : offset >= need;
}
const QUALITY = {
  high:   { stride: 1, water: [896, 832], dpr: 2.0 },
  medium: { stride: 2, water: [640, 594], dpr: 1.5 },
  low:    { stride: 3, water: [448, 416], dpr: 1.0 },
};

// One grade, applied in two places: main.js's blit (terrain, sky) and water.js's fragment
// shader (the water pass draws straight to the canvas). They must not drift apart.
const GRADE = { saturation: 1.22, contrast: 1.10, lift: -0.012 };

const TIERS = ['low', 'medium', 'high'];

/**
 * Opening guess only — `autoTune()` below has the last word, from measured frames.
 *
 * The old rule was `pointer: coarse -> low`, which handed an iPad Pro and a five-year-old
 * budget phone the same 857 k triangles. Touch now starts at MEDIUM (1.85 M triangles,
 * dpr 1.5) and the tuner promotes or demotes within about two seconds of real rendering.
 * Starting in the middle is deliberate: every tier change rebuilds the terrain mesh, and
 * medium rebuilds in ~150 ms against high's ~620 ms, so guessing wrong here is cheap in
 * the direction of medium and expensive in the direction of high.
 */
function pickInitialQuality() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) <= 820;
  // Touch never starts at the bottom any more. Gating that on hardwareConcurrency was
  // tried and removed: iOS Safari under-reports it (this container reports 2), so the
  // check fired on hardware that was perfectly capable and put it right back on low —
  // reintroducing the exact problem it was meant to avoid. The frame timer knows what the
  // core count only guesses at, so let it be the one to demote.
  if (coarse || small) return 'medium';
  if ((navigator.hardwareConcurrency || 4) <= 4) return 'medium';
  return 'high';
}

/**
 * Render scale, and the viewer's ONLY antialiasing.
 *
 * `antialias: true` on the renderer buys nothing here and MSAA on `sceneRT` measurably makes
 * things WORSE (shimmer 1465 -> 2581 px in the rotate test): the water pass does its own
 * depth test against `sceneRT.depthTexture`, and a resolved multisample depth is not the
 * exact per-pixel value that comparison needs. That is what the explicit `samples: 0` is
 * protecting. The water's wet test is a hard `discard` too, which no MSAA mode antialiases.
 * So supersampling is not a stylistic preference here, it is the only lever available.
 *
 * It used to be written `Math.min(window.devicePixelRatio, tierDpr)`, which silently meant
 * NO antialiasing at all on an ordinary 1x monitor — the min is 1, the scene renders at
 * native resolution, and every terrain silhouette and waterline crawls as the camera rotates.
 * Asking for the tier's ratio outright supersamples on a 1x display (2x2 = 5.3x less shimmer
 * measured) and still steps a 3x phone DOWN to 2x, which is what the cap was always for.
 *
 * The pixel budget is what keeps that honest on a big monitor: 2x on 2560x1440 would be a
 * 236 MB render target, so the ratio is clipped to fit ~9 M drawing-buffer pixels. 1080p at
 * 2x lands just inside it; 4K barely needs supersampling anyway and lands at ~1.
 */
const DRAW_BUFFER_BUDGET = 9e6;

function effectivePixelRatio(tier) {
  const want = QUALITY[tier].dpr;
  const px = Math.max(1, window.innerWidth * window.innerHeight);
  return Math.max(1, Math.min(want, Math.sqrt(DRAW_BUFFER_BUDGET / px)));
}

/* --------------------------------------------------------------------- quality tuner */

const TUNE_WARMUP = 25;      // frames to ignore after a (re)build: shader compile, uploads
const TUNE_WINDOW = 70;      // frames per decision when the device is keeping up
const TUNE_MIN_SAMPLES = 12; // ...but never judge on fewer than this
const TUNE_DEADLINE_MS = 2500;
const TUNE_MAX_ADJUST = 2;   // then stop, so the viewer can never oscillate forever
let tuneSamples = [];
let tuneWarmup = 0;
let tuneWindowStart = 0;
let tuneAdjustments = 0;
let tuneDemoted = false;     // once we have stepped DOWN, never step back up
let tuneApplying = false;    // distinguishes our own onChange from the user's

/**
 * Measure, then move — in both directions.
 *
 * The previous version only ever stepped down, only once, and only from the tier the
 * opening guess happened to pick. That is what forced the guess to be pessimistic: a wrong
 * guess upward was permanent. Measuring both ways means the guess can start optimistic and
 * a phone that genuinely renders this at 60 fps ends up on high without anyone hard-coding
 * that it may.
 *
 * Promotion needs the median AND the 90th percentile to be fast, not just the median: a
 * device that hits vsync most frames but stutters every tenth one is exactly the device
 * that would then fail at the next tier up and have to pay two rebuilds to get back.
 */
function autoTune(dt) {
  if (tuneAdjustments >= TUNE_MAX_ADJUST) return;
  if (tuneWarmup < TUNE_WARMUP) { tuneWarmup++; tuneWindowStart = performance.now(); return; }
  tuneSamples.push(dt);
  // A frame COUNT alone is the wrong deadline: 70 frames is 1.2 s on a device that is fine
  // and 14 s on one rendering at 5 fps — i.e. the worse the device, the longer it waits to
  // be rescued. Whichever comes first, so the struggling case is the fast one.
  const enough = tuneSamples.length >= TUNE_WINDOW
    || (tuneSamples.length >= TUNE_MIN_SAMPLES
        && performance.now() - tuneWindowStart >= TUNE_DEADLINE_MS);
  if (!enough) return;

  const s = tuneSamples.slice().sort((a, b) => a - b);
  const med = s[s.length >> 1];
  const p90 = s[Math.floor(s.length * 0.9)];
  tuneSamples = [];
  tuneWarmup = 0;
  tuneWindowStart = performance.now();

  const i = TIERS.indexOf(state.quality);
  if (med > 1 / 28 && i > 0) {
    tuneDemoted = true;
    tuneAdjustments++;
    applyTunedQuality(TIERS[i - 1], 'Frame rate low — render quality reduced to');
  } else if (!tuneDemoted && i < TIERS.length - 1 && med < 1 / 58 && p90 < 1 / 45) {
    tuneAdjustments++;
    applyTunedQuality(TIERS[i + 1], 'Rendering comfortably — quality raised to');
  } else {
    tuneAdjustments = TUNE_MAX_ADJUST;      // already where it belongs
  }
}

function applyTunedQuality(tier, label) {
  tuneApplying = true;
  onChange('quality', tier);
  tuneApplying = false;
  if (ui.refresh) ui.refresh();
  ui.setStatus({ text: `${label} "${tier}"`, timeout: 4500 });
}

/**
 * Hover highlight costs a connected-component flood fill over a 2.19 M cell grid —
 * measured 24 ms at Δ = 0 and 56 ms at Δ = +5 on a desktop CPU, so 2-4x that on a
 * phone. A touch device has no hover to begin with (pointermove only fires mid-drag,
 * where the gesture is a camera move), so it would pay the whole bill for nothing.
 */
const COARSE_POINTER = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

const state = {
  waterOffset: 0,
  // Eight times keeps the broad floodplain legible while NoData boundary walls stay disabled.
  vertExag: 8,
  sunAzimuth: 138,
  sunElevation: 34,
  waveAmp: 1,
  turbidity: 1,
  foam: 1,
  science: false,
  showWater: true,
  showBuildings: true,
  showRoads: true,
  showOsmWater: false,
  showPopulation: false,
  autoRotate: true,
  hoverFx: !COARSE_POINTER,
  quality: pickInitialQuality(),
};

let renderer, scene, camera, controls, ui, dataset, contextLayers;
let sceneRT, blitScene, blitCam, blitMat;
let sky, sun = new THREE.Vector3(), sunLight, hemiLight, envCubeRT, envCubeCam, envScene;
let terrainGroup, terrainMesh, waterMesh, waterMat;
let lastT = 0, elapsed = 0, statsTimer = 0, needStats = true, statsQuery = null;
let tour = null;
let pointerStart = null;
let hoverNdc = null, hoverActive = false;
let hoverStrength = 0;
let hoverMask = null, hoverMaskTex = null, hoverQueue = null;
let hoverMaskOffset = NaN, hoverLastSolve = 0, hoverCells = 0;
const AGENT_REGION_ID = 'kempsey';
const AGENT_SOURCE_COMMIT = '85d9847d2cf61ff2c6920dbfd2dd1a1aac5aed06';
const AGENT_SOURCE_SNAPSHOT_ID = 'sha256:138276c02707be3d1890e401444fe8c7e07df30534c6850fea1b78177bbf89a4';
const AGENT_DATA_FINGERPRINT = 'kempsey-overview-v4';
let agentHighlightRegionId = null;
let agentHighlightMode = null;
let agentHighlightStartedAt = 0;
let agentHighlightExpiresAt = 0;
const AGENT_FOCUS_HIGHLIGHT_SECONDS = 3.2;
let agentActionHistory = new Map();
let agentSceneRevisionValue = 0;
let agentViewGenerationValue = null;
let agentViewGenerationReady = false;
let agentSceneRevisionReady = false;

init().catch((err) => {
  console.error(err);
  const p = document.createElement('pre');
  p.className = 'fv-fatal';
  p.textContent = 'Failed to load\n\n' + (err && err.stack || err);
  document.body.appendChild(p);
});

async function init() {
  renderer = new THREE.WebGLRenderer({
    antialias: false,                 // AA comes from supersampling via devicePixelRatio
    preserveDrawingBuffer: true,      // needed for the screenshot button
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(effectivePixelRatio(state.quality));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.62;
  renderer.domElement.className = 'fv-canvas';
  document.body.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 20, 400000);

  ui = createUI({ state, onChange, onAction, meta: null });
  setStatus('Initialising', 0.02);

  // ---- sky + sun ---------------------------------------------------------------
  sky = new Sky();
  sky.scale.setScalar(120000);
  sky.material.uniforms.turbidity.value = 2.6;
  sky.material.uniforms.rayleigh.value = 3.0;
  sky.material.uniforms.mieCoefficient.value = 0.004;
  sky.material.uniforms.mieDirectionalG.value = 0.75;
  if (sky.material.uniforms.cloudCoverage) sky.material.uniforms.cloudCoverage.value = 0.30;
  // The r183+ Sky is linear HDR with no gamma, and its radiance (~5-40) sits far above
  // anything the terrain reflects. Scale it into the same exposure bracket as the ground
  // instead of pushing toneMappingExposure down until the terrain goes black.
  sky.material.fragmentShader = sky.material.fragmentShader.replace(
    'gl_FragColor = vec4( texColor, 1.0 );',
    'gl_FragColor = vec4( texColor * 0.075, 1.0 );'
  );
  sky.material.needsUpdate = true;
  sky.layers.set(0);
  scene.add(sky);

  sunLight = new THREE.DirectionalLight(0xfff2e0, 5.0);
  sunLight.layers.enableAll();
  scene.add(sunLight);
  hemiLight = new THREE.HemisphereLight(0xbcd6ef, 0x4a4030, 1.2);
  hemiLight.layers.enableAll();
  scene.add(hemiLight);

  // Sky -> cube map for the water reflections. A plain CubeRenderTarget sampled with
  // textureCube is used rather than PMREM: water is close to a mirror so the prefiltered
  // roughness chain buys nothing, and textureCubeUV has been observed to return NaN on
  // software GL stacks, which turns the whole surface black.
  envScene = new THREE.Scene();
  envCubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
  envCubeRT.texture.minFilter = THREE.LinearMipmapLinearFilter;
  envCubeRT.texture.generateMipmaps = true;
  envCubeCam = new THREE.CubeCamera(100, 300000, envCubeRT);

  // ---- data --------------------------------------------------------------------
  dataset = await loadDataset(renderer, (frac, label) => setStatus(`Loading ${label}`, 0.05 + frac * 0.8));
  statsQuery = buildStatsIndex(dataset.arrays, dataset.meta);
  ui.setMeta && ui.setMeta(dataset.meta);
  setStatus('Building terrain mesh', 0.88);
  await frame();

  buildScene();
  agentSceneRevisionValue = 0;
  agentSceneRevisionReady = false;
  agentRegionIndexCache.clear();
  setStatus('Loading context layers', 0.90);
  try {
    contextLayers = await loadContextLayers({
      scene,
      dataset,
      state,
      onProgress: (frac, label) => setStatus(`Loading ${label} layer`, 0.90 + frac * 0.05),
    });
  } catch (err) {
    // The terrain viewer remains useful if a static context snapshot is absent or
    // blocked by a partial deployment. Keep the failure visible in the console,
    // but do not turn optional overlays into a fatal startup error.
    console.warn('[flood-viewer] context layers unavailable', err);
    if (contextLayers) contextLayers.dispose();
    contextLayers = null;
    ui.setStatus({ text: 'Context layers unavailable', timeout: 4500 });
  }
  setStatus('Compiling shaders', 0.96);
  await frame();

  updateSun();
  updateStats();

  controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  // OrbitControls applies damping as `delta *= (1 - dampingFactor)` per frame, so a SMALL
  // factor means a long tail: decaying to 1% of a flick takes ln(0.01)/ln(0.94) = 74 frames
  // at 0.06 — over a second of drift after the mouse stops, which is what reads as "the
  // camera is not following me". 0.14 gets there in 31 frames and still smooths jitter.
  controls.dampingFactor = 0.14;
  // MapControls ships LEFT = pan, RIGHT = rotate. Swapped to the orbit convention — left
  // drag turns the model, right drag slides it — which is what the shortcut card has always
  // told the user ("drag to orbit") and what every other 3D viewer does. Click-to-query is
  // unaffected: onPointerUp only treats a LEFT press that moved < 5 px as a query.
  controls.mouseButtons = {
    LEFT: THREE.MOUSE.ROTATE,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  };
  // Touch has to move with it. MapControls defaults to ONE = PAN / TWO = DOLLY_ROTATE,
  // so leaving this alone would have meant one finger pans on a phone while one button
  // orbits on a desktop — and the shortcut card would have been lying to the touch user,
  // who is the one least able to discover the real binding by experiment.
  controls.touches = {
    ONE: THREE.TOUCH.ROTATE,
    TWO: THREE.TOUCH.DOLLY_PAN,
  };
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 300;
  controls.maxDistance = 120000;
  controls.zoomSpeed = 0.9;
  controls.addEventListener('start', () => { tour = null; });
  // After the controls exist, not before: frameToFlood() sets controls.target, and calling
  // it earlier silently left the orbit centre at the origin — which auto-rotate then spins
  // around, swinging the whole floodplain through the frame.
  frameToFlood();

  renderer.domElement.addEventListener('pointerdown', (e) => {
    pointerStart = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button };
  });
  renderer.domElement.addEventListener('pointerup', onPointerUp);
  // A cancelled press (OS gesture, context menu, the browser stealing the pointer) never
  // delivers pointerup, so without this `pointerStart` stays truthy forever — and since
  // updateHover now skips while it is set, one cancelled press would kill the hover
  // highlight for the rest of the session.
  renderer.domElement.addEventListener('pointercancel', () => { pointerStart = null; });
  renderer.domElement.addEventListener('pointermove', (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    hoverNdc = new THREE.Vector2(
      ((e.clientX - r.left) / r.width) * 2 - 1,
      -((e.clientY - r.top) / r.height) * 2 + 1
    );
  });
  renderer.domElement.addEventListener('pointerleave', () => { hoverNdc = null; });
  window.addEventListener('resize', onResize);
  onResize();

  lastT = performance.now() / 1000;
  // Small inspection hook: handy when tuning, and harmless in production.
  //
  // `camera` here is the pre-existing read-only REPORTER (returns pos/target for
  // copying into a ?cam= string). The live three.js objects therefore live under
  // `three` — an earlier version of this hook put `camera` at the top level and
  // the reporter below silently overwrote it, so `__fv.camera.position` was a
  // function with no `.position` and every headless camera move failed.
  window.__fv = {
    state,
    three: { renderer, scene, get camera() { return camera; }, get controls() { return controls; } },
    get dataset() { return dataset; },
    get contextLayers() { return contextLayers; },
    pickSurface: (x, y) => pickSurface(new THREE.Vector2(x, y)),
    solveHoverBody: (i) => solveHoverBody(i),
    get hoverCells() { return hoverCells; },
    get tuner() {
      return { warmup: tuneWarmup, samples: tuneSamples.length, adjustments: tuneAdjustments,
               demoted: tuneDemoted, tier: state.quality };
    },
    renderOnce: () => render(),
    get uniforms() { return waterMat ? waterMat.uniforms : null; },
    get hover() { return { strength: hoverStrength, cells: hoverCells, active: hoverActive, mode: agentHighlightMode, expiresAt: Number.isFinite(agentHighlightExpiresAt) ? agentHighlightExpiresAt : null }; },
    get agentAction() { return getAgentActionState(); },
    applyAgentAction,
    setAgentViewGeneration,
    setAgentSceneRevision,
    get agentProtocol() { return { region: AGENT_REGION_ID, sourceCommit: AGENT_SOURCE_COMMIT, sourceSnapshotId: AGENT_SOURCE_SNAPSHOT_ID, viewGeneration: agentViewGenerationValue, sceneRevision: agentSceneRevisionValue, dataFingerprint: AGENT_DATA_FINGERPRINT, ready: agentViewGenerationReady && agentSceneRevisionReady }; },
    meta: () => ({ ...dataset.meta, region: AGENT_REGION_ID, sourceCommit: AGENT_SOURCE_COMMIT, sourceSnapshotId: AGENT_SOURCE_SNAPSHOT_ID, dataFingerprint: AGENT_DATA_FINGERPRINT }),
    camera: () => ({ pos: camera.position.toArray(), target: controls.target.toArray() }),
  };
  setStatus(null);
  // --- dev hooks: override any state key from the query string, and place the camera ---
  {
    const qs = new URLSearchParams(location.search);
    for (const k of Object.keys(state)) {
      if (qs.has(k)) {
        const raw = qs.get(k);
        state[k] = (raw === 'true') ? true : (raw === 'false') ? false : (isNaN(+raw) ? raw : +raw);
      }
    }
    if (qs.has('quality')) { renderer.setPixelRatio(effectivePixelRatio(state.quality)); buildScene(); onResize(); }
    if ([...qs.keys()].some((k) => k in state)) {
      syncUniforms(); updateSun(); updateStats(); syncContextLayers(); ui.refresh && ui.refresh();
    }
    if (qs.has('cam')) {
      const a = qs.get('cam').split(',').map(Number);
      camera.position.set(a[0], a[1], a[2]);
      const t = new THREE.Vector3(a[3] || 0, a[4] || 0, a[5] || 0);
      camera.lookAt(t); controls.target.copy(t); controls.update();
    }
    for (const [k, v] of qs.entries()) {
      if (k.startsWith('u') && waterMat && waterMat.uniforms[k] && typeof waterMat.uniforms[k].value === 'number') {
        waterMat.uniforms[k].value = +v;
      }
    }
    if (qs.has('nogui')) Array.from(document.body.children).forEach((e) => { if (e !== renderer.domElement) e.style.display = 'none'; });
  }
  if (new URLSearchParams(location.search).get('once') === '1') {
    render(); window.__done = true; return;
  }
  window.__done = true;
  renderer.setAnimationLoop(animate);
}

function frame() { return new Promise((r) => requestAnimationFrame(() => r())); }
function setStatus(text, progress) {
  if (!ui) return;
  if (text === null) ui.setStatus(null);
  else ui.setStatus(progress === undefined ? text : { text, progress });
}

/* ------------------------------------------------------------------ scene assembly */

function buildScene() {
  const { arrays, grid, textures } = dataset;
  const q = QUALITY[state.quality];

  if (terrainGroup) {
    scene.remove(terrainGroup);
    terrainMesh.geometry.dispose();
    terrainMesh.material.dispose();
  }
  const { geo } = buildTerrainGeometry(arrays.terrain, arrays.flags, grid, q.stride);
  terrainGroup = new THREE.Group();
  terrainGroup.scale.set(1, state.vertExag, 1);
  terrainMesh = new THREE.Mesh(geo, createTerrainMaterial(textures.tBasemap));
  terrainMesh.layers.set(0);
  terrainGroup.add(terrainMesh);
  scene.add(terrainGroup);

  if (waterMesh) { scene.remove(waterMesh); waterMesh.geometry.dispose(); }
  if (!waterMat) {
    waterMat = createWaterMaterial({
      textures,
      grid: { EW: grid.EW, EH: grid.EH, nx: grid.nx, ny: grid.ny },
      envMap: envCubeRT ? envCubeRT.texture : null,
    });
  }
  waterMesh = new THREE.Mesh(createWaterGeometry(q.water[0], q.water[1], grid.EW, grid.EH), waterMat);
  waterMesh.layers.set(WATER_LAYER);
  waterMesh.frustumCulled = false;             // the vertex shader moves it vertically
  waterMesh.renderOrder = 10;
  scene.add(waterMesh);

  syncUniforms();
}

function syncUniforms() {
  if (!waterMat) return;
  const u = waterMat.uniforms;
  u.uWaterOffset.value = state.waterOffset;
  u.uVertExag.value = state.vertExag;
  u.uWaveAmp.value = state.waveAmp;
  u.uTurbidity.value = state.turbidity;
  u.uFoam.value = state.foam;
  u.uScience.value = state.science ? 1 : 0;
  if (u.uRampMax) u.uRampMax.value = dataset.meta.rampMax;
  if (u.uSaturation) {
    u.uSaturation.value = GRADE.saturation;
    u.uContrast.value = GRADE.contrast;
    u.uLift.value = GRADE.lift;
  }
  if (terrainGroup) terrainGroup.scale.set(1, state.vertExag, 1);
  if (waterMesh) waterMesh.visible = state.showWater;
  if (contextLayers) contextLayers.setVerticalExaggeration(state.vertExag);
}

function syncContextLayers() {
  if (!contextLayers) return;
  contextLayers.setVerticalExaggeration(state.vertExag);
  contextLayers.setVisibility('showBuildings', state.showBuildings);
  contextLayers.setVisibility('showRoads', state.showRoads);
  contextLayers.setVisibility('showOsmWater', state.showOsmWater);
  contextLayers.setVisibility('showPopulation', state.showPopulation);
  contextLayers.updateFloodState(dataset, state);
}

function updateSun() {
  const phi = THREE.MathUtils.degToRad(90 - state.sunElevation);
  const theta = THREE.MathUtils.degToRad(state.sunAzimuth);
  sun.setFromSphericalCoords(1, phi, theta);
  sky.material.uniforms.sunPosition.value.copy(sun);
  sunLight.position.copy(sun).multiplyScalar(150000);
  // Warmer and dimmer near the horizon, as the atmosphere would.
  const t = THREE.MathUtils.clamp(state.sunElevation / 45, 0, 1);
  sunLight.color.setRGB(1.0, 0.72 + 0.22 * t, 0.44 + 0.44 * t);
  sunLight.intensity = 2.0 + 3.6 * Math.pow(t, 0.7);

  hemiLight.intensity = 0.6 + 0.75 * t;

  // refresh the reflection cube (sky only — the terrain is far too big to reflect usefully).
  // The solar disc is 19000x the sky radiance; leaving it in bakes a hot spot into every
  // mip level, which the water then reads as ambient irradiance and goes milk-white.
  const disc = sky.material.uniforms.showSunDisc;
  const hadDisc = disc ? disc.value : null;
  if (disc) disc.value = false;
  envScene.add(sky);
  envCubeCam.update(renderer, envScene);
  scene.add(sky);
  if (disc) disc.value = hadDisc;

  if (waterMat) {
    waterMat.userData.setEnvMap(envCubeRT.texture);
    waterMat.uniforms.uSunDir.value.copy(sun);
    waterMat.uniforms.uSunColor.value.copy(sunLight.color).multiplyScalar(sunLight.intensity * 0.55);
  }
}

/* --------------------------------------------------------------------- render loop */

function makeTargets(w, h) {
  if (sceneRT) sceneRT.dispose();
  sceneRT = new THREE.WebGLRenderTarget(w, h, {
    type: THREE.HalfFloatType,
    samples: 0,
    depthBuffer: true,
    stencilBuffer: false,
  });
  const dt = new THREE.DepthTexture(w, h);
  dt.format = THREE.DepthFormat;
  dt.type = THREE.UnsignedIntType;             // 16-bit depth is far too coarse at 39 km
  dt.minFilter = THREE.NearestFilter;
  dt.magFilter = THREE.NearestFilter;
  sceneRT.depthTexture = dt;

  if (!blitScene) {
    blitMat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uSaturation: { value: GRADE.saturation },
        uContrast: { value: GRADE.contrast },
        uLift: { value: GRADE.lift },
      },
      vertexShader: /* glsl */`
        varying vec2 vUv;
        void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform sampler2D tDiffuse;
        uniform float uSaturation, uContrast, uLift;
        varying vec2 vUv;
        void main(){
          gl_FragColor = texture2D(tDiffuse, vUv);
          #include <tonemapping_fragment>
          // Gentle grade: ACES on a hazy Preetham sky lands very desaturated, and a
          // 39 km aerial view has almost no local contrast left after tone mapping.
          vec3 c = gl_FragColor.rgb;
          float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
          c = mix(vec3(l), c, uSaturation);
          c = clamp((c - 0.5) * uContrast + 0.5 + uLift * (1.0 - l), 0.0, 1.0);
          gl_FragColor.rgb = c;
          #include <colorspace_fragment>
        }`,
      depthTest: false,
      depthWrite: false,
    });
    blitScene = new THREE.Scene();
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blitMat);
    quad.frustumCulled = false;
    blitScene.add(quad);
    blitCam = new THREE.Camera();
  }
  blitMat.uniforms.tDiffuse.value = sceneRT.texture;
  if (waterMat) {
    waterMat.uniforms.tSceneColor.value = sceneRT.texture;
    waterMat.uniforms.tSceneDepth.value = sceneRT.depthTexture;
    waterMat.uniforms.uResolution.value.set(w, h);
  }
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Recompute the ratio, do not reuse the old one: it is clipped against a pixel BUDGET, so
  // dragging a window from a quarter of the screen to full screen would otherwise keep the
  // supersampling factor chosen for the small size and quadruple the render target.
  renderer.setPixelRatio(effectivePixelRatio(state.quality));
  renderer.setSize(w, h);
  const dpr = renderer.getPixelRatio();
  makeTargets(Math.max(2, Math.floor(w * dpr)), Math.max(2, Math.floor(h * dpr)));
}

function animate() {
  const now = performance.now() / 1000;
  // Two different numbers on purpose. `dt` is clamped so a long stall cannot teleport the
  // animation; `raw` is the real frame interval, which is what the quality tuner has to
  // see — through the clamp every device slower than 20 fps looks identical.
  const raw = now - lastT;
  const dt = Math.min(raw, 0.05);
  lastT = now;
  elapsed += dt;
  const t = elapsed;
  if (tour) stepTour(dt);
  if (controls) {
    controls.autoRotate = state.autoRotate && !tour;
    controls.autoRotateSpeed = 0.35;
    controls.update();
  }
  if (contextLayers && controls) contextLayers.updateCamera(camera, controls.target);
  if (waterMat) waterMat.uniforms.uTime.value = t;
  updateHover(dt);
  autoTune(raw);
  if (needStats) {
    statsTimer += dt;
    if (statsTimer > 0.12) { needStats = false; statsTimer = 0; updateStats(); }
  }
  render();
}

function render() {
  if (waterMat) {
    waterMat.uniforms.uCameraNear.value = camera.near;
    waterMat.uniforms.uCameraFar.value = camera.far;
  }
  // pass 1 — opaque scene (sky + terrain) into the HDR target with its depth texture
  camera.layers.set(0);
  renderer.setRenderTarget(sceneRT);
  renderer.clear();
  renderer.render(scene, camera);

  // pass 2 — tone-map and blit to the canvas
  renderer.setRenderTarget(null);
  renderer.clear();
  renderer.render(blitScene, blitCam);

  // pass 3 — water, composited manually against the pass-1 colour + depth
  if (state.showWater) {
    camera.layers.set(WATER_LAYER);
    renderer.autoClear = false;
    renderer.render(scene, camera);
    renderer.autoClear = true;
  }
  camera.layers.enableAll();
}

/**
 * Flood-fill the connected water body containing cell `start`, writing 255 into `hoverMask`.
 *
 * Connectivity is exactly the viewer's own wet rule — a cell is in the body iff
 * `waterOffset >= need` — so the highlighted region is the set of cells the water could
 * actually reach from the one under the cursor at this water level, not a bounding shape.
 * At Δ = 0 that is one of the 247 pools HOTA mapped; raise the slider and neighbouring
 * pools merge, and the highlight grows with them.
 *
 * 4-connectivity over a 2.19 M cell grid, with an explicit typed-array queue rather than
 * recursion: worst case (the whole floodplain as one body) measures ~15 ms, and it only
 * runs when the pointer crosses into a body that is not already highlighted.
 */
function solveHoverBody(start) {
  const { arrays, meta } = dataset;
  const { nx, ny } = meta.grid;
  const need = arrays.need, flags = arrays.flags;
  const off = state.waterOffset;
  const wet = (i) => isWetCell(flags[i], need[i], off);
  // Bail BEFORE clearing. This used to wipe the mask first and only then discover the start
  // cell was dry, so every time the cursor grazed a bank inside a body — which on a
  // floodplain this fractal is constantly — the highlight was destroyed and the next wet
  // frame paid a full 24-56 ms re-solve. Leaving the mask alone means a dry pixel just fades
  // the highlight out and moving back on resumes it for free.
  //
  // updateHover() now makes the same test before it calls in, so in the viewer this bail is
  // only reached through the __fv debug hook — it stays because it is the invariant the
  // mask-clearing below depends on, not because the hot path needs it.
  if (!wet(start)) { hoverCells = 0; return false; }
  if (!hoverMask) {
    hoverMask = new Uint8Array(nx * ny);
    hoverQueue = new Int32Array(nx * ny);
  } else {
    hoverMask.fill(0);
  }

  const q = hoverQueue;
  let head = 0, tail = 0;
  q[tail++] = start;
  hoverMask[start] = 255;
  while (head < tail) {
    const i = q[head++];
    const x = i % nx;
    if (x > 0        && !hoverMask[i - 1]  && wet(i - 1))  { hoverMask[i - 1]  = 255; q[tail++] = i - 1; }
    if (x < nx - 1   && !hoverMask[i + 1]  && wet(i + 1))  { hoverMask[i + 1]  = 255; q[tail++] = i + 1; }
    if (i >= nx      && !hoverMask[i - nx] && wet(i - nx)) { hoverMask[i - nx] = 255; q[tail++] = i - nx; }
    if (i + nx < q.length && !hoverMask[i + nx] && wet(i + nx)) { hoverMask[i + nx] = 255; q[tail++] = i + nx; }
  }
  hoverCells = tail;

  if (!hoverMaskTex) {
    hoverMaskTex = new THREE.DataTexture(hoverMask, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    // Linear so the highlight edge is feathered across a cell instead of stair-stepping
    // along the 25.5 m grid.
    hoverMaskTex.magFilter = THREE.LinearFilter;
    hoverMaskTex.minFilter = THREE.LinearFilter;
    hoverMaskTex.wrapS = hoverMaskTex.wrapT = THREE.ClampToEdgeWrapping;
    hoverMaskTex.generateMipmaps = false;
    waterMat.uniforms.tHoverMask.value = hoverMaskTex;
  }
  hoverMaskTex.needsUpdate = true;
  hoverMaskOffset = off;
  return true;
}

/**
 * Decide, once per frame, whether the pointer is over water and which body it is in, then
 * ease the highlight in and out. Once per frame rather than per pointermove: the ray march
 * is only ~0.4 ms, but there is no reason to run it faster than we draw.
 */
function updateHover(dt) {
  if (!waterMat) return;
  let want = 0;
  if (agentHighlightRegionId && hoverMaskOffset === state.waterOffset && state.showWater) {
    if (agentHighlightMode === 'pulse') {
      const now = performance.now() / 1000;
      if (now >= agentHighlightExpiresAt) {
        clearAgentHighlight();
      } else {
        const age = now - agentHighlightStartedAt;
        const fade = Math.min(1, Math.max(0, (agentHighlightExpiresAt - now) / 0.55));
        want = (0.28 + 0.72 * (0.5 + 0.5 * Math.sin(age * Math.PI * 4.4))) * fade;
      }
    } else {
      want = 1;
    }
  }
  // Not while a mouse button is down and not during a fly tour: both mean the camera is
  // moving, and a 24-56 ms flood fill dropped into the middle of a drag is precisely the
  // stall that makes the controls feel disconnected from the mouse. Hover is an idle-time
  // affordance, so it only runs when the pointer is idle.
  if (state.hoverFx && hoverNdc && state.showWater && !pointerStart && !tour) {
    const p = pickSurface(hoverNdc);
    if (p) {
      const { arrays, grid, meta } = dataset;
      const ix = Math.round(((p.x + grid.EW / 2) / grid.EW) * meta.grid.nx - 0.5);
      const iz = Math.round(((p.z + grid.EH / 2) / grid.EH) * meta.grid.ny - 0.5);
      if (ix >= 0 && iz >= 0 && ix < meta.grid.nx && iz < meta.grid.ny) {
        const idx = iz * meta.grid.nx + ix;
        const inCurrent = hoverMask && hoverMask[idx] && hoverMaskOffset === state.waterOffset;
        if (inCurrent) {
          want = 1;
        } else if (isWetCell(arrays.flags[idx], arrays.need[idx], state.waterOffset)) {
          // Two array reads decide whether this cell is even wet. Doing that BEFORE the rate
          // limiter means a dry pixel no longer burns the 100 ms budget that the next
          // genuinely-new body needs, so entering a new pool highlights immediately.
          const now = performance.now();
          if (now - hoverLastSolve > 100) {
            hoverLastSolve = now;
            if (solveHoverBody(idx)) want = 1;
          } else if (hoverStrength > 0) {
            want = 1;                     // hold the current highlight until we can re-solve
          }
        }
      }
    }
  }
  hoverActive = want > 0;
  const rate = want > hoverStrength ? 9.0 : 4.0;
  hoverStrength += (want - hoverStrength) * Math.min(1, rate * dt);
  waterMat.uniforms.uHoverStrength.value = hoverStrength;
}

/* ------------------------------------------------------------------------- actions */

function onChange(key, value) {
  state[key] = value;
  if (key === 'waterOffset') {
    agentRegionIndexCache.clear();
    agentActionHistory.clear();
    clearAgentHighlight();
    agentSceneRevisionReady = false;
  }
  switch (key) {
    case 'sunAzimuth': case 'sunElevation': updateSun(); break;
    case 'quality':
      // A hand-picked tier is final: if the user opened the panel and chose one, the tuner
      // must not quietly move it back. Only our own calls leave tuneApplying set.
      if (!tuneApplying) tuneAdjustments = TUNE_MAX_ADJUST;
      renderer.setPixelRatio(effectivePixelRatio(value));
      buildScene(); onResize();
      tuneWarmup = 0; tuneSamples = []; tuneWindowStart = performance.now();
      break;
    case 'waterOffset':
      needStats = true;
      hoverMaskOffset = NaN;
      syncUniforms();
      if (contextLayers) contextLayers.updateFloodState(dataset, state);
      break;
    case 'showBuildings': case 'showRoads': case 'showOsmWater': case 'showPopulation':
      if (contextLayers) contextLayers.setVisibility(key, value);
      syncUniforms();
      break;
    default: syncUniforms();
  }
}

function onAction(name) {
  switch (name) {
    case 'screenshot': saveScreenshot(); break;
    case 'resetView': frameToFlood(); break;
    case 'topView': topView(); break;
    case 'flyTour': startTour(); break;
  }
}

function updateStats() {
  ui.setStats(statsQuery(state.waterOffset));
}

function floodCentre() {
  const { arrays, grid } = dataset;
  const { nx, ny, EW, EH } = grid;
  let sx = 0, sz = 0, n = 0;
  for (let iz = 0; iz < ny; iz += 4) {
    for (let ix = 0; ix < nx; ix += 4) {
      const f = arrays.flags[iz * nx + ix];
      if ((f & 1) && !(f & 2) && !(f & 4)) {
        sx += ((ix + 0.5) / nx - 0.5) * EW;
        sz += ((iz + 0.5) / ny - 0.5) * EH;
        n++;
      }
    }
  }
  return n ? new THREE.Vector3(sx / n, 0, sz / n) : new THREE.Vector3();
}

function frameToFlood() {
  const c = floodCentre();
  camera.position.set(c.x - 11000, 17000, c.z + 23000);
  camera.lookAt(c);
  if (controls) { controls.target.copy(c); controls.update(); }
}

function regionLabelFromId(regionId) {
  if (typeof regionId !== 'string' || !regionId.startsWith('kempsey-dz')) return null;
  const match = /-r(\d+)$/.exec(regionId);
  return match ? Number(match[1]) : null;
}

function regionBoundsForId(regionId) {
  const label = regionLabelFromId(regionId);
  if (!regionId.includes(`-dz${(Math.round(state.waterOffset * 100) / 100).toFixed(2).replace('-', 'm').replace('.', 'p')}-`)) return null;
  if (!Number.isSafeInteger(label) || label <= 0) return null;
  const index = buildAgentRegionIndex(state.waterOffset);
  if (!index) return null;
  const region = index.regions.find((item) => item.label === label);
  if (!region) return null;
  return region;
}

const agentRegionIndexCache = new Map();

function buildAgentRegionIndex(offset) {
  const cacheKey = `${AGENT_DATA_FINGERPRINT}:${Number(offset).toFixed(4)}`;
  if (agentRegionIndexCache.has(cacheKey)) return agentRegionIndexCache.get(cacheKey);
  const { arrays, grid, meta } = dataset;
  const { nx, ny } = grid;
  const labels = new Int32Array(nx * ny);
  const queue = new Int32Array(nx * ny);
  const regions = [];
  const wet = (i) => isAgentFloodCell(arrays.flags[i], arrays.need[i], offset);
  for (let iz = 0; iz < ny; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const start = iz * nx + ix;
      if (labels[start] || !wet(start)) continue;
      const label = regions.length + 1;
      let head = 0, tail = 0;
      queue[tail++] = start;
      labels[start] = label;
      const region = { label, cells: [], minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity };
      while (head < tail) {
        const i = queue[head++];
        const x = i % nx, z = Math.floor(i / nx);
        region.cells.push(i);
        const px = ((x + 0.5) / nx - 0.5) * grid.EW;
        const pz = ((z + 0.5) / ny - 0.5) * grid.EH;
        region.minX = Math.min(region.minX, px); region.maxX = Math.max(region.maxX, px);
        region.minZ = Math.min(region.minZ, pz); region.maxZ = Math.max(region.maxZ, pz);
        if (x > 0 && !labels[i - 1] && wet(i - 1)) { labels[i - 1] = label; queue[tail++] = i - 1; }
        if (x + 1 < nx && !labels[i + 1] && wet(i + 1)) { labels[i + 1] = label; queue[tail++] = i + 1; }
        if (z > 0 && !labels[i - nx] && wet(i - nx)) { labels[i - nx] = label; queue[tail++] = i - nx; }
        if (z + 1 < ny && !labels[i + nx] && wet(i + nx)) { labels[i + nx] = label; queue[tail++] = i + nx; }
      }
      regions.push(region);
    }
  }
  const result = { labels, regions };
  agentRegionIndexCache.set(cacheKey, result);
  return result;
}

function clearAgentHighlight() {
  agentHighlightRegionId = null;
  agentHighlightMode = null;
  agentHighlightStartedAt = 0;
  agentHighlightExpiresAt = 0;
  if (hoverMask) {
    hoverMask.fill(0);
    if (hoverMaskTex) hoverMaskTex.needsUpdate = true;
  }
  hoverCells = 0;
  hoverActive = false;
  hoverStrength = 0;
  if (waterMat) waterMat.uniforms.uHoverStrength.value = 0;
}

function setAgentHighlight(region, mode = 'persistent') {
  if (!region || !region.cells || !region.cells.length) return false;
  if (!hoverMask) {
    hoverMask = new Uint8Array(dataset.grid.nx * dataset.grid.ny);
    hoverQueue = new Int32Array(dataset.grid.nx * dataset.grid.ny);
  } else hoverMask.fill(0);
  for (const index of region.cells) hoverMask[index] = 255;
  hoverCells = region.cells.length;
  if (!hoverMaskTex) {
    hoverMaskTex = new THREE.DataTexture(hoverMask, dataset.grid.nx, dataset.grid.ny, THREE.RedFormat, THREE.UnsignedByteType);
    hoverMaskTex.magFilter = THREE.LinearFilter;
    hoverMaskTex.minFilter = THREE.LinearFilter;
    hoverMaskTex.wrapS = hoverMaskTex.wrapT = THREE.ClampToEdgeWrapping;
    hoverMaskTex.generateMipmaps = false;
    waterMat.uniforms.tHoverMask.value = hoverMaskTex;
  }
  hoverMaskTex.needsUpdate = true;
  hoverMaskOffset = state.waterOffset;
  hoverActive = true;
  hoverStrength = 1;
  waterMat.uniforms.uHoverStrength.value = 1;
  agentHighlightRegionId = region.regionId || agentHighlightRegionId;
  agentHighlightMode = mode === 'pulse' ? 'pulse' : 'persistent';
  agentHighlightStartedAt = performance.now() / 1000;
  agentHighlightExpiresAt = agentHighlightMode === 'pulse' ? agentHighlightStartedAt + AGENT_FOCUS_HIGHLIGHT_SECONDS : Infinity;
  return true;
}

function getAgentActionState() {
  const entries = [...agentActionHistory.values()];
  return entries.length ? entries[entries.length - 1] : null;
}

function setAgentViewGeneration(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return false;
  if (agentViewGenerationReady && value < agentViewGenerationValue) return false;
  if (value > agentViewGenerationValue) {
    agentSceneRevisionValue = 0;
    agentSceneRevisionReady = false;
    agentActionHistory.clear();
  }
  agentViewGenerationValue = value;
  agentViewGenerationReady = true;
  return true;
}

function setAgentSceneRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) return false;
  if (agentSceneRevisionReady && value < agentSceneRevisionValue) return false;
  agentSceneRevisionValue = value;
  agentSceneRevisionReady = true;
  return true;
}

function focusAgentRegion(region) {
  const centerX = (region.minX + region.maxX) * 0.5;
  const centerZ = (region.minZ + region.maxZ) * 0.5;
  const span = Math.max(region.maxX - region.minX, region.maxZ - region.minZ, 500);
  const distance = Math.min(120000, Math.max(300, span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) * 1.45));
  const azimuth = new THREE.Vector3().subVectors(camera.position, controls.target);
  azimuth.y = 0;
  if (azimuth.lengthSq() < 1) azimuth.set(-1, 0, 1);
  azimuth.normalize();
  const target = new THREE.Vector3(centerX, 0, centerZ);
  const position = target.clone().add(azimuth.multiplyScalar(distance));
  position.y = Math.max(distance * 0.72, 900);
  camera.position.copy(position);
  camera.lookAt(target);
  controls.target.copy(target);
  controls.update();
  return { position: camera.position.toArray(), target: controls.target.toArray() };
}

function applyAgentAction(request) {
  const action = request && request.action;
  const regionId = action && action.regionId;
  const expectedRevision = request && request.expectedSceneRevision;
  if (!request || typeof request.actionId !== 'string' || request.actionId.length === 0 || request.actionId.length > 128 || !action || typeof action.kind !== 'string' || typeof regionId !== 'string' || regionId.length === 0 || regionId.length > 256) return { ok: false, code: 'bad_action', message: 'action envelope is invalid' };
  if (!agentViewGenerationReady || !agentSceneRevisionReady) return { ok: false, code: 'viewer_protocol_not_ready', message: 'viewer action protocol handshake is incomplete' };
  if (request.viewGeneration !== agentViewGenerationValue) return { ok: false, code: 'stale_view_generation', message: 'viewer generation no longer matches' };
  if (request.sourceCommit !== undefined && request.sourceCommit !== AGENT_SOURCE_COMMIT) return { ok: false, code: 'stale_data', message: 'source commit no longer matches' };
  if (request.sourceSnapshotId !== undefined && request.sourceSnapshotId !== AGENT_SOURCE_SNAPSHOT_ID) return { ok: false, code: 'stale_data', message: 'source snapshot no longer matches' };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== agentSceneRevision()) return { ok: false, code: 'stale_scene', message: 'scene revision no longer matches' };
  const expectedFingerprint = request.expectedDataFingerprint;
  if (typeof expectedFingerprint !== 'string' || expectedFingerprint.length === 0 || expectedFingerprint !== agentDataFingerprint()) return { ok: false, code: 'stale_data', message: 'data fingerprint no longer matches' };
  const fingerprint = JSON.stringify({ actionId: request.actionId, action, expectedRevision, expectedFingerprint });
  const previous = agentActionHistory.get(request.actionId);
  if (previous) {
    if (previous.fingerprint !== fingerprint) return { ok: false, code: 'action_id_reuse', message: 'actionId was reused with different parameters' };
    return { ok: true, value: previous.result };
  }
  if (action.kind !== 'focus_region' && action.kind !== 'highlight_region') return { ok: false, code: 'unsupported_action', message: 'unsupported viewer action' };
  const region = regionBoundsForId(regionId);
  if (!region) return { ok: false, code: 'unknown_region', message: 'regionId is not present at the current water level' };
  region.regionId = regionId;
  let cameraResult = null;
  if (action.kind === 'highlight_region') {
    if (!setAgentHighlight(region, 'persistent')) return { ok: false, code: 'highlight_failed', message: 'could not create highlight mask' };
  } else {
    cameraResult = focusAgentRegion(region);
    if (!setAgentHighlight(region, 'pulse')) return { ok: false, code: 'highlight_failed', message: 'could not create temporary focus highlight' };
  }
  render();
  const result = { status: 'applied', actionId: request.actionId, action, regionId, postCamera: cameraResult || { position: camera.position.toArray(), target: controls.target.toArray() }, highlightedCells: hoverCells, sceneRevision: agentSceneRevision(), dataFingerprint: agentDataFingerprint() };
  agentActionHistory.set(request.actionId, { fingerprint, result });
  while (agentActionHistory.size > 32) agentActionHistory.delete(agentActionHistory.keys().next().value);
  return { ok: true, value: result };
}

function agentSceneRevision() {
  return agentSceneRevisionValue;
}

function agentDataFingerprint() {
  return AGENT_DATA_FINGERPRINT;
}

function topView() {
  const c = floodCentre();
  camera.position.set(c.x, 34000, c.z + 0.01);
  camera.lookAt(c);
  if (controls) { controls.target.copy(c); controls.update(); }
}

function startTour() {
  const c = floodCentre();
  const wp = [
    { pos: new THREE.Vector3(c.x - 11000, 17000, c.z + 23000), tgt: c.clone() },
    { pos: new THREE.Vector3(c.x + 2500, 3200, c.z + 7000), tgt: c.clone().add(new THREE.Vector3(1200, 0, -1500)) },
    { pos: new THREE.Vector3(c.x + 11000, 4200, c.z - 3000), tgt: c.clone().add(new THREE.Vector3(2000, 0, -800)) },
    { pos: new THREE.Vector3(c.x - 2000, 26000, c.z + 3000), tgt: c.clone() },
    { pos: new THREE.Vector3(c.x - 11000, 17000, c.z + 23000), tgt: c.clone() },
  ];
  tour = { wp, i: 0, t: 0, dur: 7.5 };
}

function stepTour(dt) {
  tour.t += dt / tour.dur;
  if (tour.t >= 1) { tour.t = 0; tour.i++; if (tour.i >= tour.wp.length - 1) { tour = null; return; } }
  const a = tour.wp[tour.i], b = tour.wp[tour.i + 1];
  const s = tour.t * tour.t * (3 - 2 * tour.t);      // smoothstep easing
  camera.position.lerpVectors(a.pos, b.pos, s);
  const tgt = new THREE.Vector3().lerpVectors(a.tgt, b.tgt, s);
  camera.lookAt(tgt);
  if (controls) controls.target.copy(tgt);
}

function saveScreenshot() {
  render();
  renderer.domElement.toBlob((blob) => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `kempsey-flood-3d_dz${state.waterOffset.toFixed(2)}m.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }, 'image/png');
}

/* ----------------------------------------------------------------- click-to-query */

/**
 * Height of the visible surface at world (x, z), in world units (i.e. exaggerated).
 * "Visible" means the water top where the cell is wet, the ground otherwise — clicking a
 * flooded paddock should report that paddock, not whatever the ray would have hit behind it.
 * Returns null outside the data footprint.
 */
function surfaceHeightAt(x, z) {
  const { arrays, grid, meta } = dataset;
  const flag = sampleNearest(arrays.flags, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
  if (flag & FLAG_OUT) return null;
  const g = sampleRaster(arrays.terrain, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
  if (!Number.isFinite(g)) return null;
  let top = g;
  if (flag & 2) {
    top = Math.max(g, 0);                                  // permanent sea, fixed at AHD 0
  } else {
    const nd = sampleRaster(arrays.need, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    if (Number.isFinite(nd) && isWetCell(flag, nd, state.waterOffset)) {
      const ws = meta.wsurfGrid;
      const W = sampleRaster(arrays.wsurf, ws.nx, ws.ny, grid.EW, grid.EH, x, z);
      if (Number.isFinite(W)) top = Math.max(g, W + state.waterOffset);
    }
  }
  return top * state.vertExag;
}

/**
 * Ray-march the heightfield instead of raycasting the mesh.
 *
 * `Raycaster.intersectObject` is brute force over the index buffer: at stride 1 that is
 * 4.3 M triangles and a measured **389 ms** of blocked main thread per click. The surface is
 * a heightfield, so marching the ray against it and bisecting the sign change costs a couple
 * of thousand bilinear samples — microseconds — and, unlike the mesh test, it sees the water
 * as well as the ground.
 */
function pickSurface(ndc) {
  const { grid } = dataset;
  const o = new THREE.Vector3(ndc.x, ndc.y, -1).unproject(camera);
  const dir = new THREE.Vector3(ndc.x, ndc.y, 1).unproject(camera).sub(o).normalize();

  // clip the ray to the XZ footprint so we never march across empty space
  const hx = grid.EW / 2, hz = grid.EH / 2;
  let t0 = 0, t1 = 1e9;
  const slab = (oc, dc, h) => {
    if (Math.abs(dc) < 1e-9) return (oc >= -h && oc <= h);
    let a = (-h - oc) / dc, b = (h - oc) / dc;
    if (a > b) { const s = a; a = b; b = s; }
    t0 = Math.max(t0, a); t1 = Math.min(t1, b);
    return true;
  };
  if (!slab(o.x, dir.x, hx) || !slab(o.z, dir.z, hz) || t1 <= t0) return null;

  const p = new THREE.Vector3();
  const diffAt = (t) => {
    p.copy(dir).multiplyScalar(t).add(o);
    const h = surfaceHeightAt(p.x, p.z);
    return h === null ? null : p.y - h;      // > 0 = above the surface
  };

  let tPrev = t0, dPrev = diffAt(t0);
  if (dPrev !== null && dPrev <= 0) return p.clone();     // camera already below ground
  // Step proportional to range, so the sampling stays roughly constant in screen space.
  for (let t = t0, guard = 0; t < t1 && guard < 4000; guard++) {
    t = Math.min(t1, t + Math.max(12, t * 0.004));
    const d = diffAt(t);
    if (d === null) { tPrev = t; dPrev = null; continue; }
    if (dPrev !== null && d <= 0) {
      let lo = tPrev, hi = t;                              // bisect the crossing
      for (let i = 0; i < 28; i++) {
        const mid = (lo + hi) * 0.5;
        const dm = diffAt(mid);
        if (dm === null || dm > 0) lo = mid; else hi = mid;
      }
      p.copy(dir).multiplyScalar(hi).add(o);
      return p.clone();
    }
    tPrev = t; dPrev = d;
  }
  return null;
}

function onPointerUp(ev) {
  // A drag is a camera move, not a query. Only a press that barely moved counts as a click.
  const s0 = pointerStart;
  pointerStart = null;
  if (ev.button !== 0 || !s0 || s0.b !== 0) return;
  if (Math.hypot(ev.clientX - s0.x, ev.clientY - s0.y) > 5) return;
  if (performance.now() - s0.t > 700) return;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  const p = pickSurface(ndc);
  if (!p) { ui.setQuery(null); return; }

  const { arrays, grid, meta } = dataset;
  const flag = sampleNearest(arrays.flags, grid.nx, grid.ny, grid.EW, grid.EH, p.x, p.z);
  if (flag & FLAG_OUT) { ui.setQuery(null); return; }
  const ground = sampleRaster(arrays.terrain, grid.nx, grid.ny, grid.EW, grid.EH, p.x, p.z);
  const need = sampleRaster(arrays.need, grid.nx, grid.ny, grid.EW, grid.EH, p.x, p.z);
  const ws = meta.wsurfGrid;
  const W = sampleRaster(arrays.wsurf, ws.nx, ws.ny, grid.EW, grid.EH, p.x, p.z);
  const isSea = !!(flag & 2);
  const surface = isSea ? state.waterOffset * 0 : W + state.waterOffset;
  const wet = isWetCell(flag, need, state.waterOffset) && (isSea || surface > ground);
  const { lon, lat } = worldToLonLat(meta, p.x, p.z);
  ui.setQuery({
    lon, lat, x: p.x, z: p.z,
    ground,
    waterSurface: wet ? surface : null,
    depth: wet ? Math.max(0, surface - ground) : 0,
    sea: isSea,
    observed: !!(flag & 1),
  });
}
