/**
 * terrain.js — ground mesh for the Kempsey 3D flood viewer.
 *
 * The DEM is a 1536 x 1426 grid (25.5 m) over a 39.2 x 36.4 km extent. The mesh is built
 * on the CPU rather than with a displacementMap because three.js cannot recompute normals
 * from GPU displacement (`displacementmap_vertex` writes position only), and because we
 * want raycasting to hit the real surface for click-to-query.
 *
 * Cells outside the DEM footprint (flag bit 4) are dropped from the index buffer. No wall is
 * generated along that irregular NoData boundary: scaling such a wall with the terrain turns
 * small footprint gaps into kilometre-high spikes at large vertical exaggerations.
 */

import * as THREE from 'three';

const FLAG_SEA = 2;
const FLAG_OUT = 4;

/**
 * @param {Float32Array} terrain  elevation, metres, nx*ny row-major, row 0 = north
 * @param {Float32Array} flags    bitfield raster, same layout
 * @param {{nx,ny,EW,EH}} grid
 * @param {number} stride         decimation (1 = full resolution, 2 = half, …)
 */
export function buildTerrainGeometry(terrain, flags, grid, stride = 1) {
  const { nx, ny, EW, EH } = grid;
  const w = Math.floor((nx - 1) / stride) + 1;
  const h = Math.floor((ny - 1) / stride) + 1;

  const pos = new Float32Array(w * h * 3);
  const uv = new Float32Array(w * h * 2);
  const valid = new Uint8Array(w * h);

  for (let j = 0; j < h; j++) {
    const sz = Math.min(ny - 1, j * stride);
    for (let i = 0; i < w; i++) {
      const sx = Math.min(nx - 1, i * stride);
      const si = sz * nx + sx;
      const k = j * w + i;
      // Cell centres: u = (ix + 0.5)/nx, and x = (u - 0.5) * EW.
      const u = (sx + 0.5) / nx;
      const v = (sz + 0.5) / ny;
      const y = terrain[si];
      pos[k * 3] = (u - 0.5) * EW;
      pos[k * 3 + 1] = y;
      pos[k * 3 + 2] = (v - 0.5) * EH;
      uv[k * 2] = u;
      uv[k * 2 + 1] = v;
      valid[k] = (flags[si] & FLAG_OUT) ? 0 : 1;
    }
  }

  // ---- normals, straight off the heightfield -------------------------------------
  //
  // NOT computeVertexNormals(). That walks the index buffer, accumulates a face normal
  // into three vertices per triangle and normalises at the end — it is general enough for
  // any mesh, and at stride 1 (4.3 M triangles) it measured 1509-1861 ms of blocked main
  // thread, i.e. 95 % of this whole function. On a phone CPU that is 3-7 seconds of frozen
  // page before the first frame, which is the single reason high quality was unusable there.
  //
  // This surface is a regular heightfield, so the normal is analytic: for y = f(x, z),
  // N is proportional to (-dy/dx, 1, -dy/dz). One central difference per vertex, no index
  // walk, no accumulation pass. It is also SMOOTHER than the face-averaged result, because
  // it is the true surface gradient rather than a mean of two arbitrary triangulations.
  //
  // Computed in object space, on the unexaggerated elevation: main.js scales the group by
  // (1, vertExag, 1) and three applies the inverse-transpose normal matrix, so the shading
  // follows the exaggeration on its own. Doing it here as well would double-count.
  const nrm = new Float32Array(w * h * 3);
  const dx = (stride * EW) / nx;          // world metres between adjacent samples
  const dz = (stride * EH) / ny;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      // Never difference across a hole or the border: fall back to a one-sided difference
      // and shorten the span to match, otherwise the gradient is halved at every edge and
      // the footprint boundary picks up a bevel that is not in the DEM.
      let xl = i > 0 ? k - 1 : k;
      let xr = i < w - 1 ? k + 1 : k;
      if (!valid[xl]) xl = k;
      if (!valid[xr]) xr = k;
      const spanX = ((xl !== k ? 1 : 0) + (xr !== k ? 1 : 0)) * dx;
      const dydx = spanX > 0 ? (pos[xr * 3 + 1] - pos[xl * 3 + 1]) / spanX : 0;

      let zu = j > 0 ? k - w : k;
      let zd = j < h - 1 ? k + w : k;
      if (!valid[zu]) zu = k;
      if (!valid[zd]) zd = k;
      const spanZ = ((zu !== k ? 1 : 0) + (zd !== k ? 1 : 0)) * dz;
      const dydz = spanZ > 0 ? (pos[zd * 3 + 1] - pos[zu * 3 + 1]) / spanZ : 0;

      const inv = 1 / Math.hypot(dydx, 1, dydz);
      nrm[k * 3] = -dydx * inv;
      nrm[k * 3 + 1] = inv;
      nrm[k * 3 + 2] = -dydz * inv;
    }
  }

  // ---- top surface index buffer -------------------------------------------------
  // Counted first, then filled straight into a Uint32Array. The previous version pushed
  // into a plain `[]`, which for 4.3 M triangles is a 26 M-element JS array held live
  // alongside the typed copy three makes from it — tens of MB of peak heap on a device
  // that has just allocated 116 MB of geometry. Two cheap passes over the quad grid cost
  // far less than that peak.
  const quadOk = new Uint8Array((w - 1) * (h - 1));
  let quadCount = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (!(valid[a] && valid[b] && valid[c] && valid[d])) continue;
      quadOk[j * (w - 1) + i] = 1;
      quadCount++;
    }
  }
  const idx = new Uint32Array(quadCount * 6);
  let ip = 0;
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      if (!quadOk[j * (w - 1) + i]) continue;
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      // Winding: +X east, +Z south, +Y up → this order faces up.
      idx[ip++] = a; idx[ip++] = c; idx[ip++] = b;
      idx[ip++] = b; idx[ip++] = c; idx[ip++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  return { geo, triangles: idx.length / 3 };
}

/**
 * Terrain material: the aerial basemap, lit by the sun + sky environment.
 * A subtle slope-driven darkening is folded in so relief still reads where the aerial
 * imagery is flat and bright (sandbars, the coastal strip).
 */
export function createTerrainMaterial(tBasemap) {
  const mat = new THREE.MeshStandardMaterial({
    // A neutral olive stands in when the aerial texture is unavailable; the slope shading
    // below still gives the relief enough definition to read.
    map: tBasemap || null,
    color: tBasemap ? 0xffffff : 0x8a8f70,
    roughness: 0.94,
    metalness: 0.0,
    dithering: true,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSlopeShade = { value: 0.35 };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float uSlopeShade;')
      .replace(
        '#include <dithering_fragment>',
        `// darken steep faces slightly: pure image-based terrain otherwise reads flat
         float slope = 1.0 - clamp( normalize( vNormal ).y, 0.0, 1.0 );
         gl_FragColor.rgb *= mix( 1.0, 1.0 - uSlopeShade, slope * slope );
         #include <dithering_fragment>`
      );
    mat.userData.shader = shader;
  };
  return mat;
}

export { FLAG_SEA, FLAG_OUT };
