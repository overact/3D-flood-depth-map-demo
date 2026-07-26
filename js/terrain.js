/**
 * terrain.js — ground mesh for the Kempsey 3D flood viewer.
 *
 * The DEM is a 1536 x 1426 grid (25.5 m) over a 39.2 x 36.4 km extent. The mesh is built
 * on the CPU rather than with a displacementMap because three.js cannot recompute normals
 * from GPU displacement (`displacementmap_vertex` writes position only), and because we
 * want raycasting to hit the real surface for click-to-query.
 *
 * Cells outside the DEM footprint (flag bit 4) are dropped from the index buffer, and the
 * resulting boundary is extruded down to a base plane so the model reads as a solid relief
 * block instead of a torn sheet.
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

  let minY = Infinity;
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
      if (valid[k] && y < minY) minY = y;
    }
  }

  // ---- top surface index buffer -------------------------------------------------
  const idx = [];
  const quadOk = new Uint8Array((w - 1) * (h - 1));
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      const a = j * w + i, b = a + 1, c = a + w, d = c + 1;
      if (!(valid[a] && valid[b] && valid[c] && valid[d])) continue;
      quadOk[j * (w - 1) + i] = 1;
      // Winding: +X east, +Z south, +Y up → this order faces up.
      idx.push(a, c, b, b, c, d);
    }
  }

  // ---- extruded sides at the footprint boundary ---------------------------------
  const BASE_DROP = 220;                      // metres below the lowest valid ground
  const baseY = minY - BASE_DROP;
  const sideVerts = [];
  const sideIdx = [];
  const pushWall = (i0, j0, i1, j1) => {
    const k0 = j0 * w + i0, k1 = j1 * w + i1;
    const n = sideVerts.length / 3;
    sideVerts.push(
      pos[k0 * 3], pos[k0 * 3 + 1], pos[k0 * 3 + 2],
      pos[k1 * 3], pos[k1 * 3 + 1], pos[k1 * 3 + 2],
      pos[k0 * 3], baseY, pos[k0 * 3 + 2],
      pos[k1 * 3], baseY, pos[k1 * 3 + 2],
    );
    sideIdx.push(n, n + 2, n + 1, n + 1, n + 2, n + 3);
    sideIdx.push(n, n + 1, n + 2, n + 1, n + 3, n + 2);   // double sided, cheap
  };
  const qOk = (i, j) => (i >= 0 && j >= 0 && i < w - 1 && j < h - 1) && quadOk[j * (w - 1) + i];
  for (let j = 0; j < h - 1; j++) {
    for (let i = 0; i < w - 1; i++) {
      if (!qOk(i, j)) continue;
      if (!qOk(i, j - 1)) pushWall(i, j, i + 1, j);           // north edge
      if (!qOk(i, j + 1)) pushWall(i, j + 1, i + 1, j + 1);   // south edge
      if (!qOk(i - 1, j)) pushWall(i, j, i, j + 1);           // west edge
      if (!qOk(i + 1, j)) pushWall(i + 1, j, i + 1, j + 1);   // east edge
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  geo.computeBoundingBox();

  let sideGeo = null;
  if (sideVerts.length) {
    sideGeo = new THREE.BufferGeometry();
    sideGeo.setAttribute('position', new THREE.Float32BufferAttribute(sideVerts, 3));
    sideGeo.setIndex(sideIdx);
    sideGeo.computeVertexNormals();
    sideGeo.computeBoundingSphere();
  }

  return { geo, sideGeo, baseY, triangles: idx.length / 3 };
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

export function createSideMaterial() {
  return new THREE.MeshStandardMaterial({
    color: 0x4a4640,
    roughness: 1.0,
    metalness: 0.0,
    side: THREE.DoubleSide,
    flatShading: true,
  });
}

export { FLAG_SEA, FLAG_OUT };
