/** Expand a compact native grid into the context renderer's local X/Z polygons. */
export function populationFeatures(data) {
  if (data?.format !== 'population-grid-v1') return data?.features || [];
  const { nx, ny, xEdges, zEdges } = data.grid;
  if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1
      || xEdges.length !== nx + 1 || zEdges.length !== ny + 1
      || ![...xEdges, ...zEdges].every(Number.isFinite)) throw new Error('Invalid population grid');
  const seen = new Set();
  return data.cells.map(([index, population, density]) => {
    if (!Number.isInteger(index) || index < 0 || index >= nx * ny || seen.has(index)
        || !Number.isFinite(population) || population < 0
        || !Number.isFinite(density) || density < 0) throw new Error('Invalid population cell');
    seen.add(index);
    const row = Math.floor(index / nx), col = index % nx;
    const w = xEdges[col], e = xEdges[col + 1], n = zEdges[row], s = zEdges[row + 1];
    if (!(w < e && n < s)) throw new Error('Empty or inverted population cell');
    return { id: `wp2021-${index}`, population, density,
      ring: [[w, n], [e, n], [e, s], [w, s], [w, n]] };
  });
}
