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
import { buildTerrainGeometry, createTerrainMaterial, createSideMaterial, FLAG_OUT } from './terrain.js';
import { createWaterMaterial, createWaterGeometry } from './water.js';
import { createUI } from './ui.js';

const WATER_LAYER = 1;
const QUALITY = {
  high:   { stride: 1, water: [896, 832], dpr: 2.0 },
  medium: { stride: 2, water: [640, 594], dpr: 1.5 },
  low:    { stride: 3, water: [448, 416], dpr: 1.0 },
};

// One grade, applied in two places: main.js's blit (terrain, sky) and water.js's fragment
// shader (the water pass draws straight to the canvas). They must not drift apart.
const GRADE = { saturation: 1.22, contrast: 1.10, lift: -0.012 };

/**
 * Terrain at stride 1 is 4.3 M triangles; that is fine on a discrete GPU and miserable on a
 * phone. Guess from what the platform will tell us, then let the frame timer correct it.
 */
function pickInitialQuality() {
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) <= 820;
  const cores = navigator.hardwareConcurrency || 4;
  if (coarse || small) return 'low';
  if (cores <= 4) return 'medium';
  return 'high';
}

const state = {
  waterOffset: 0,
  vertExag: 7,
  sunAzimuth: 138,
  sunElevation: 34,
  waveAmp: 1,
  turbidity: 1,
  foam: 1,
  science: false,
  showWater: true,
  autoRotate: true,
  hoverFx: true,
  quality: pickInitialQuality(),
};

let renderer, scene, camera, controls, ui, dataset;
let sceneRT, blitScene, blitCam, blitMat;
let sky, sun = new THREE.Vector3(), sunLight, hemiLight, envCubeRT, envCubeCam, envScene;
let terrainGroup, terrainMesh, sideMesh, waterMesh, waterMat;
let lastT = 0, elapsed = 0, statsTimer = 0, needStats = true, statsQuery = null;
let frameAcc = 0, frameCount = 0, autoTuned = false;
let tour = null;
let pointerStart = null;
let hoverNdc = null, hoverActive = false;
let hoverStrength = 0;
let hoverMask = null, hoverMaskTex = null, hoverQueue = null;
let hoverMaskOffset = NaN, hoverLastSolve = 0, hoverCells = 0;

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
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[state.quality].dpr));
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
  setStatus('Compiling shaders', 0.96);
  await frame();

  updateSun();
  updateStats();

  controls = new MapControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
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
  window.__fv = {
    state,
    get uniforms() { return waterMat ? waterMat.uniforms : null; },
    get hover() { return { strength: hoverStrength, cells: hoverCells, active: hoverActive }; },
    meta: () => dataset.meta,
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
    if (qs.has('quality')) { renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[state.quality].dpr)); buildScene(); onResize(); }
    if ([...qs.keys()].some((k) => k in state)) {
      syncUniforms(); updateSun(); updateStats(); ui.refresh && ui.refresh();
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
    if (sideMesh) { sideMesh.geometry.dispose(); sideMesh.material.dispose(); }
  }
  const { geo, sideGeo } = buildTerrainGeometry(arrays.terrain, arrays.flags, grid, q.stride);
  terrainGroup = new THREE.Group();
  terrainGroup.scale.set(1, state.vertExag, 1);
  terrainMesh = new THREE.Mesh(geo, createTerrainMaterial(textures.tBasemap));
  terrainMesh.layers.set(0);
  terrainGroup.add(terrainMesh);
  if (sideGeo) {
    sideMesh = new THREE.Mesh(sideGeo, createSideMaterial());
    sideMesh.layers.set(0);
    terrainGroup.add(sideMesh);
  }
  scene.add(terrainGroup);

  if (waterMesh) { scene.remove(waterMesh); waterMesh.geometry.dispose(); }
  if (!waterMat) {
    waterMat = createWaterMaterial({
      textures,
      grid: { EW: grid.EW, EH: grid.EH },
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
  renderer.setSize(w, h);
  const dpr = renderer.getPixelRatio();
  makeTargets(Math.max(2, Math.floor(w * dpr)), Math.max(2, Math.floor(h * dpr)));
}

function animate() {
  const now = performance.now() / 1000;
  const dt = Math.min(now - lastT, 0.05);
  lastT = now;
  elapsed += dt;
  const t = elapsed;
  if (tour) stepTour(dt);
  if (controls) {
    controls.autoRotate = state.autoRotate && !tour;
    controls.autoRotateSpeed = 0.35;
    controls.update();
  }
  if (waterMat) waterMat.uniforms.uTime.value = t;
  updateHover(dt);
  if (!autoTuned && frameCount < 120) {
    // Ignore the first 20 frames: shader compiles and texture uploads land there.
    if (frameCount++ > 20) frameAcc += dt;
    if (frameCount === 120) {
      const avg = frameAcc / 99;
      const next = state.quality === 'high' ? 'medium' : state.quality === 'medium' ? 'low' : null;
      if (avg > 1 / 28 && next) {
        autoTuned = true;
        onChange('quality', next);
        if (ui.refresh) ui.refresh();
        ui.setStatus({ text: `Low frame rate — render quality reduced to "${next}"`, timeout: 5000 });
      } else {
        autoTuned = true;
      }
    }
  }
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
  if (!hoverMask) {
    hoverMask = new Uint8Array(nx * ny);
    hoverQueue = new Int32Array(nx * ny);
  } else {
    hoverMask.fill(0);
  }
  const wet = (i) => !(flags[i] & 4) && off >= need[i];
  if (!wet(start)) { hoverCells = 0; return false; }

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
  if (state.hoverFx && hoverNdc && state.showWater) {
    const p = pickSurface(hoverNdc);
    if (p) {
      const { grid, meta } = dataset;
      const ix = Math.round(((p.x + grid.EW / 2) / grid.EW) * meta.grid.nx - 0.5);
      const iz = Math.round(((p.z + grid.EH / 2) / grid.EH) * meta.grid.ny - 0.5);
      if (ix >= 0 && iz >= 0 && ix < meta.grid.nx && iz < meta.grid.ny) {
        const idx = iz * meta.grid.nx + ix;
        const inCurrent = hoverMask && hoverMask[idx] && hoverMaskOffset === state.waterOffset;
        if (inCurrent) {
          want = 1;
        } else {
          // Re-solving is ~15 ms worst case, so do it only when the pointer is genuinely in
          // a different body, and no more than ten times a second while it sweeps around.
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
  switch (key) {
    case 'sunAzimuth': case 'sunElevation': updateSun(); break;
    case 'quality':
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, QUALITY[value].dpr));
      buildScene(); onResize(); break;
    case 'waterOffset': needStats = true; hoverMaskOffset = NaN; syncUniforms(); break;
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
    if (Number.isFinite(nd) && state.waterOffset >= nd) {
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
  const wet = isSea || (state.waterOffset >= need && surface > ground);
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
