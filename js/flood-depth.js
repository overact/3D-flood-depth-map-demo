/** Deterministic overview-depth queries, independent of Three.js and the DOM.
 * Prepared samples contain only offset-independent raster values, so context
 * features can reuse them throughout a water-level drag. Outside/NoData is null.
 * Keep the reconstruction aligned with water.js and data.js's statistics index.
 */
export function isWetCell(flag, need, offset) {
  if (flag & 4) return false;
  if (flag & 2) return true;
  return Math.abs(offset) < 0.0005 ? !!(flag & 1) : offset >= need;
}

// Match the renderer's linear, clamp-to-edge texture sampling inside the
// footprint. Bounds are checked before this helper; outside is never clamped in.
function sampleClamped(array, nx, ny, width, height, x, z) {
  const fx = Math.max(0, Math.min(nx - 1, (x / width + 0.5) * nx - 0.5));
  const fz = Math.max(0, Math.min(ny - 1, (z / height + 0.5) * ny - 0.5));
  const x0 = Math.floor(fx), z0 = Math.floor(fz);
  const x1 = Math.min(nx - 1, x0 + 1), z1 = Math.min(ny - 1, z0 + 1);
  const tx = fx - x0, tz = fz - z0;
  return (array[z0 * nx + x0] * (1 - tx) + array[z0 * nx + x1] * tx) * (1 - tz)
    + (array[z1 * nx + x0] * (1 - tx) + array[z1 * nx + x1] * tx) * tz;
}

export function prepareFloodSample(dataset, x, z) {
  const { arrays, grid: g, meta } = dataset;
  if (!Number.isFinite(x) || !Number.isFinite(z)
      || Math.abs(x) > g.EW / 2 || Math.abs(z) > g.EH / 2) return null;
  const ix = Math.min(g.nx - 1, Math.floor((x / g.EW + 0.5) * g.nx));
  const iz = Math.min(g.ny - 1, Math.floor((z / g.EH + 0.5) * g.ny));
  const flag = arrays.flags[iz * g.nx + ix];
  if (flag & 4) return null;
  const ground = sampleClamped(arrays.terrain, g.nx, g.ny, g.EW, g.EH, x, z);
  const need = sampleClamped(arrays.need, g.nx, g.ny, g.EW, g.EH, x, z);
  const ws = meta.wsurfGrid;
  const baseSurface = sampleClamped(arrays.wsurf, ws.nx, ws.ny, g.EW, g.EH, x, z);
  if (!Number.isFinite(ground) || (!(flag & 2)
      && (!Number.isFinite(need) || !Number.isFinite(baseSurface)))) return null;
  return { flag, ground, need, baseSurface };
}

export function floodDepthAtSample(sample, offset) {
  if (!sample || !Number.isFinite(offset)) return null;
  const { flag, ground, need, baseSurface } = sample;
  if (!isWetCell(flag, need, offset)) return 0;
  if (flag & 2) return Math.max(0, -ground); // permanent sea stays at AHD 0
  const baselineDepth = flag & 1 ? -need : Math.max(baseSurface - ground, -need);
  return Math.max(0, baselineDepth + offset);
}

export function queryFloodDepth(dataset, x, z, offset) {
  const sample = prepareFloodSample(dataset, x, z);
  const depth = floodDepthAtSample(sample, offset);
  if (depth === null) return null;
  return {
    x, z, ground: sample.ground, depth,
    // Reconstruct the quantitative surface from the authoritative depth. The
    // coarser animated mesh surface is used only for camera picking/rendering.
    waterSurface: depth > 0 ? sample.ground + depth : null,
    sea: !!(sample.flag & 2), observed: !!(sample.flag & 1),
  };
}
