/**
 * data.js — asset loading for the Kempsey 3D flood viewer.
 *
 * All rasters ship as PNG with each 16-bit sample split across two 8-bit channels, and are
 * read back through the browser's image decoder. 4.7 MB for the whole dataset, against the
 * 39 MB scene.js the original Qgis2threejs export used. See loadPacked() for why this goes
 * through <img> rather than fetch().
 *
 * Everything here follows the UV convention in SPEC.md §1:
 *     u = (x + EW/2) / EW     v = (z + EH/2) / EH      →  v = 0 is NORTH (row 0)
 * DataTexture uploads row 0 first, and GL treats row 0 as v = 0, so the arrays need no
 * flipping. The basemap image is created with flipY = false so it obeys the same rule.
 */

import * as THREE from 'three';

const R_EARTH = 6378137.0;

/**
 * Rasters are shipped as PNG and read back through the IMAGE decoder, not `fetch()`.
 *
 * Each 16-bit sample is split across two 8-bit channels — R = high byte, G = low byte — so
 * the round trip is bit-exact, and a spare channel carries the flag bitfield. This is the
 * same trick as Mapbox terrain-RGB. PNG's filters compress the smooth high byte very well,
 * so the three images together come to 4.7 MB, slightly *less* than the gzip streams they
 * replace.
 *
 * The reason for the image path rather than fetch: on at least one Windows machine every
 * `fetch()` of a multi-megabyte binary from localhost came back with an empty body and then
 * an outright "Failed to fetch", while the same-sized WebP basemap and the 1.4 MB three.js
 * bundle loaded fine — i.e. whatever was interfering (endpoint security, an extension) hooks
 * fetch/XHR and leaves `<img>` and `<script>` alone. Images are also decoded off the main
 * thread, so this is faster as well as more robust.
 *
 * `colorSpaceConversion: 'none'` is essential — without it the browser is free to colour-
 * manage the bitmap and the byte values stop being the values we wrote.
 */
function loadImageEl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(url + ': image failed to load or decode'));
    img.src = url;
  });
}

async function loadPacked(url, w, h) {
  const img = await loadImageEl(url);
  if (img.naturalWidth !== w || img.naturalHeight !== h) {
    throw new Error(`${url}: decoded ${img.naturalWidth}x${img.naturalHeight}, expected ${w}x${h}`);
  }
  let src = img;
  try {
    src = await createImageBitmap(img, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  } catch (e) { /* older browsers: fall back to the element, values are still sRGB-verbatim */ }
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' });
  ctx.drawImage(src, 0, 0);
  if (src !== img && src.close) src.close();
  const px = ctx.getImageData(0, 0, w, h).data;
  if (px.length !== w * h * 4) throw new Error(`${url}: readback gave ${px.length} bytes`);
  return px;
}

/** R<<8 | G  →  Float32Array, rescaled from [0,65535] to [lo,hi]. */
function unpackU16(px, lo, hi, sentinelOut) {
  const n = px.length >> 2;
  const out = new Float32Array(n);
  const k = (hi - lo) / 65535.0;
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const v = (px[p] << 8) | px[p + 1];
    out[i] = (sentinelOut !== undefined && v === 65535) ? sentinelOut : lo + v * k;
  }
  return out;
}

/** the spare blue channel, as a Float32Array (three wants floats for a RedFormat texture) */
function unpackChannel(px, ch) {
  const n = px.length >> 2;
  const out = new Float32Array(n);
  for (let i = 0, p = ch; i < n; i++, p += 4) out[i] = px[p];
  return out;
}

/* ---- coastal blend field -----------------------------------------------------------
 * The sea flag is binary per 25.5 m cell, but the water shader needs a SMOOTH 0..1 "how
 * much open ocean is here" field, for three separate reasons: the two regimes (a tidal sea
 * pinned at 0 m AHD vs. a flood that rides the slider) would otherwise meet in a hard seam;
 * the clarity and body colour differ between them; and the surf band needs a shoaling
 * coordinate, which this dataset cannot supply any other way because it carries no
 * bathymetry.
 *
 * Doing the blur in the shader costs nine texture taps per fragment per stage and still
 * quantises to ninths — which shows up as speckle along the beach wherever the two regimes
 * shade differently, and as a zigzag following the water-mesh triangulation when it is
 * computed per vertex. Precomputing it here is exact, perfectly smooth under LinearFilter,
 * and one tap at run time.
 *
 * Two box passes at radius 5 on a half-resolution grid = a near-Gaussian about 500 m wide,
 * i.e. the coast fades over roughly half a kilometre.
 */
function buildSeaField(flags, nx, ny) {
  const D = 2;                                   // decimation: 25.5 m -> 51 m cells
  const w = Math.ceil(nx / D), h = Math.ceil(ny / D);
  let a = new Float32Array(w * h);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0, n = 0;
      for (let b = 0; b < D; b++) {
        const y = j * D + b;
        if (y >= ny) continue;
        for (let c = 0; c < D; c++) {
          const x = i * D + c;
          if (x >= nx) continue;
          s += (flags[y * nx + x] & 2) ? 1 : 0;
          n++;
        }
      }
      a[j * w + i] = n ? s / n : 0;
    }
  }
  const R = 5;
  let b = new Float32Array(w * h);
  for (let pass = 0; pass < 2; pass++) {
    // horizontal, running sum with clamped edges
    for (let j = 0; j < h; j++) {
      const row = j * w;
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += a[row + Math.min(w - 1, Math.max(0, k))];
      const inv = 1 / (2 * R + 1);
      for (let i = 0; i < w; i++) {
        b[row + i] = acc * inv;
        acc -= a[row + Math.min(w - 1, Math.max(0, i - R))];
        acc += a[row + Math.min(w - 1, Math.max(0, i + R + 1))];
      }
    }
    // vertical
    for (let i = 0; i < w; i++) {
      let acc = 0;
      for (let k = -R; k <= R; k++) acc += b[Math.min(h - 1, Math.max(0, k)) * w + i];
      const inv = 1 / (2 * R + 1);
      for (let j = 0; j < h; j++) {
        a[j * w + i] = acc * inv;
        acc -= b[Math.min(h - 1, Math.max(0, j - R)) * w + i];
        acc += b[Math.min(h - 1, Math.max(0, j + R + 1)) * w + i];
      }
    }
  }
  // The raw box average saturates slowly; a smoothstep puts a proper 0 and 1 at the ends so
  // the open ocean is fully "sea" and the floodplain is fully "flood".
  for (let i = 0; i < a.length; i++) {
    const t = Math.min(1, Math.max(0, (a[i] - 0.12) / 0.66));
    a[i] = t * t * (3 - 2 * t);
  }
  return { a, w, h };
}

function makeDataTexture(array, w, h, filter) {
  const t = new THREE.DataTexture(array, w, h, THREE.RedFormat, THREE.FloatType);
  t.magFilter = filter;
  t.minFilter = filter;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

/**
 * @param {THREE.WebGLRenderer} renderer
 * @param {(frac:number, label:string)=>void} onProgress
 */
// Bump this whenever anything in data3d/ changes. Python's http.server sends no
// Cache-Control, so browsers apply heuristic freshness and can serve a stale copy for
// hours without ever asking the server — invisible in the access log and very confusing.
const ASSET_VERSION = '4';

export async function loadDataset(renderer, onProgress = () => {}) {
  const base = './data3d/';
  const v = '?v=' + ASSET_VERSION;
  const metaRes = await fetch(base + 'meta.json' + v);
  if (!metaRes.ok) throw new Error('data3d/meta.json: HTTP ' + metaRes.status);
  const meta = await metaRes.json();
  const { nx, ny } = meta.grid;
  const ws = meta.wsurfGrid;

  // Linear filtering of 32-bit float textures needs OES_texture_float_linear. It is
  // present on essentially every WebGL2 device, but fall back to NEAREST rather than
  // rendering nothing if it is missing.
  const canFilterFloat = renderer.extensions.has('OES_texture_float_linear');
  const F = canFilterFloat ? THREE.LinearFilter : THREE.NearestFilter;

  const terrPx = await loadPacked(base + 'terrain.png' + v, nx, ny);
  onProgress(0.42, 'terrain elevation');
  const needPx = await loadPacked(base + 'need.png' + v, nx, ny);
  onProgress(0.70, 'connectivity fill level');
  const wsPx = await loadPacked(base + 'wsurf.png' + v, ws.nx, ws.ny);
  onProgress(0.72, 'water surface');

  const terrain = unpackU16(terrPx, meta.elev.min, meta.elev.max);
  // 65535 is the "never floodable" sentinel. Decode it to +9 m, not +999: this array also
  // becomes a LinearFilter texture, and bilinear interpolation between a wet cell (need ≈ 0)
  // and a 999 neighbour produces hundreds of metres halfway across the cell — a one-cell dry
  // seam wherever the floodable region meets excluded terrain. +9 is past the slider's +5
  // ceiling, so the semantics are identical while the interpolant stays bounded.
  const need = unpackU16(needPx, meta.need.min, meta.need.max, 9.0);
  const wsurf = unpackU16(wsPx, meta.elev.min, meta.elev.max);
  const flags = unpackChannel(terrPx, 2);       // blue channel of terrain.png

  // Basemap: 4096 needs ~64 MB of VRAM; drop to 2048 on small/weak devices.
  const maxTex = renderer.capabilities.maxTextureSize;
  const small = maxTex < 4096 || Math.min(screen.width, screen.height) <= 820;

  // Try each candidate in turn and keep the first that decodes. JPEG leads because a
  // content blocker on one Windows machine answered every request for the .webp with
  // HTTP 204 (its signature for "blocked") while serving .png and .jpg untouched — and
  // whichever filter rule that was, guessing at it is less useful than simply carrying an
  // alternative. The imagery is a nicety in any case; if none of them load we fall through
  // to a plain terrain colour rather than failing the whole viewer.
  const candidates = small
    ? ['imagery_2048.jpg', 'basemap_2048.webp']
    : ['imagery.jpg', 'basemap.webp'];
  let tBasemap = null, bmUsed = null;
  for (const name of candidates) {
    try {
      tBasemap = await new Promise((resolve, reject) => {
        new THREE.TextureLoader().load(base + name + v, resolve, undefined,
          () => reject(new Error('blocked or undecodable')));
      });
      bmUsed = name;
      break;
    } catch (e) {
      console.warn('[flood-viewer] basemap candidate ' + name + ' failed (' + e.message + ')');
    }
  }
  if (tBasemap) {
    tBasemap.colorSpace = THREE.SRGBColorSpace;
    tBasemap.flipY = false;                     // row 0 of the image is NORTH → v = 0
    tBasemap.wrapS = tBasemap.wrapT = THREE.ClampToEdgeWrapping;
    tBasemap.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    tBasemap.needsUpdate = true;
    onProgress(1.0, 'basemap imagery');
  } else {
    console.warn('[flood-viewer] no basemap could be loaded (' + candidates.join(', ') +
      '). Falling back to a plain terrain colour. HTTP 204 on these requests means a ' +
      'browser extension is blocking them — check in an incognito window.');
    onProgress(1.0, 'basemap unavailable — using plain terrain');
  }

  return {
    meta,
    grid: { nx, ny, EW: meta.extent.width, EH: meta.extent.height },
    arrays: { terrain, need, wsurf, flags },
    textures: {
      tTerrain: makeDataTexture(terrain, nx, ny, F),
      tNeed: makeDataTexture(need, nx, ny, F),
      tWsurf: makeDataTexture(wsurf, ws.nx, ws.ny, F),
      tFlags: makeDataTexture(flags, nx, ny, THREE.NearestFilter),
      tSea: (() => { const f = buildSeaField(flags, nx, ny);
                     return makeDataTexture(f.a, f.w, f.h, THREE.LinearFilter); })(),
      tBasemap,
    },
    basemapMissing: !tBasemap,
    basemapUsed: bmUsed,
  };
}

/* ---------------------------------------------------------------- sampling helpers */

/** Bilinear sample of a cell-centred raster at world (x, z). Returns NaN outside. */
export function sampleRaster(arr, nx, ny, EW, EH, x, z) {
  const fx = ((x + EW / 2) / EW) * nx - 0.5;
  const fz = ((z + EH / 2) / EH) * ny - 0.5;
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  if (x0 < 0 || z0 < 0 || x0 + 1 >= nx || z0 + 1 >= ny) return NaN;
  const tx = fx - x0, tz = fz - z0;
  const i00 = z0 * nx + x0;
  const a = arr[i00] * (1 - tx) + arr[i00 + 1] * tx;
  const b = arr[i00 + nx] * (1 - tx) + arr[i00 + nx + 1] * tx;
  return a * (1 - tz) + b * tz;
}

/** Nearest sample — for the flag bitfield, which must never be interpolated. */
export function sampleNearest(arr, nx, ny, EW, EH, x, z) {
  const ix = Math.round(((x + EW / 2) / EW) * nx - 0.5);
  const iz = Math.round(((z + EH / 2) / EH) * ny - 0.5);
  if (ix < 0 || iz < 0 || ix >= nx || iz >= ny) return 0;
  return arr[iz * nx + ix];
}

/** World (x, z) in local metres → WGS84 lon/lat, via the scene's Web Mercator origin. */
export function worldToLonLat(meta, x, z) {
  const mx = meta.extent.cx + x;
  const my = meta.extent.cy - z;                // world +Z is SOUTH
  const lon = (mx / R_EARTH) * (180 / Math.PI);
  const lat = (2 * Math.atan(Math.exp(my / R_EARTH)) - Math.PI / 2) * (180 / Math.PI);
  return { lon, lat };
}

/**
 * Inundated area and water volume for a given water-level offset.
 * Areas are corrected for Web Mercator distortion: at latitude φ a projected square
 * metre is only cos²φ real square metres (φ ≈ −31.08° here → factor 0.7335).
 */
export function buildStatsIndex(arrays, meta) {
  const { need, terrain, wsurf, flags } = arrays;
  const { nx, ny } = meta.grid;
  const ws = meta.wsurfGrid;
  const cellA = meta.stats.cellX * meta.stats.cellY * meta.stats.mercatorAreaFactor;

  const LO = -8.0, HI = 8.0, BIN = 0.001;
  const N = Math.round((HI - LO) / BIN) + 1;
  const cnt = new Float64Array(N);        // cells whose need falls in this bin
  const sumWT = new Float64Array(N);      // Σ (W − ground) for those cells
  const minTW = new Float64Array(N).fill(Infinity);   // min (ground − W)

  for (let iz = 0; iz < ny; iz++) {
    const wz = Math.min(ws.ny - 1, (iz * ws.ny / ny) | 0) * ws.nx;
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const f = flags[i];
      if (f & 4 || f & 2) continue;                    // outside footprint, or permanent sea
      const nd = need[i];
      if (nd > HI) continue;                           // never floodable
      const W = wsurf[wz + Math.min(ws.nx - 1, (ix * ws.nx / nx) | 0)];
      // Same reconstruction the shader uses. On a published-wet cell `need` holds exactly
      // −depth, so −need is the exact water column at Δ = 0; elsewhere use the coarse
      // surface, floored by the same bound so the column can never go negative.
      const wt = (f & 1) ? -nd : Math.max(W - terrain[i], -nd);
      let b = Math.floor((nd - LO) / BIN);
      if (b < 0) b = 0; else if (b >= N) b = N - 1;
      cnt[b] += 1;
      sumWT[b] += wt;
      if (-wt < minTW[b]) minTW[b] = -wt;
    }
  }
  // running totals, so a query is three array reads
  for (let b = 1; b < N; b++) {
    cnt[b] += cnt[b - 1];
    sumWT[b] += sumWT[b - 1];
    if (minTW[b - 1] < minTW[b]) minTW[b] = minTW[b - 1];
  }

  /**
   * A cell is wet ⟺ Δ ≥ need, and by construction need ≥ ground − W, so every such cell has
   * depth = W + Δ − ground ≥ 0. That makes the two integrals separable:
   *     volume = Σ depth = Δ·N(Δ) + Σ (W − ground)
   *     maxDepth = Δ − min(ground − W)
   * Both are prefix sums over `need`, so the whole 2.2 M-cell sweep collapses to a lookup.
   */
  return function query(offset) {
    let b = Math.floor((offset - LO) / BIN);
    if (b < 0) return { areaKm2: 0, volumeMm3: 0, maxDepth: 0, meanDepth: 0, offset };
    if (b >= N) b = N - 1;
    const n = cnt[b];
    const vol = n * offset + sumWT[b];
    return {
      areaKm2: n * cellA / 1e6,
      volumeMm3: vol * cellA / 1e6,
      maxDepth: n ? Math.max(0, offset - minTW[b]) : 0,
      meanDepth: n ? vol / n : 0,
      offset,
    };
  };
}

/** Exact reference implementation — kept to validate the index above. */
export function computeStats(arrays, meta, offset) {
  const { need, terrain, wsurf, flags } = arrays;
  const { nx, ny } = meta.grid;
  const ws = meta.wsurfGrid;
  const cellA = meta.stats.cellX * meta.stats.cellY * meta.stats.mercatorAreaFactor;
  let wetCells = 0, volume = 0, maxDepth = 0;
  for (let iz = 0; iz < ny; iz++) {
    // wsurf is a coarse smooth raster; nearest-sample is plenty for an integral
    const wz = Math.min(ws.ny - 1, (iz * ws.ny / ny) | 0) * ws.nx;
    for (let ix = 0; ix < nx; ix++) {
      const i = iz * nx + ix;
      const f = flags[i];
      if (f & 4 || f & 2) continue;             // outside footprint, or permanent sea
      if (offset < need[i]) continue;
      const W = wsurf[wz + Math.min(ws.nx - 1, (ix * ws.nx / nx) | 0)];
      const d = (f & 1) ? (offset - need[i]) : Math.max(W + offset - terrain[i], offset - need[i]);
      if (d <= 0) continue;
      wetCells++;
      volume += d;
      if (d > maxDepth) maxDepth = d;
    }
  }
  const areaKm2 = wetCells * cellA / 1e6;
  return {
    areaKm2,
    volumeMm3: volume * cellA / 1e6,
    maxDepth,
    meanDepth: wetCells ? volume / wetCells : 0,
    offset,
  };
}
