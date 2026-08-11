/** Region-manifest and native-resolution LOD helpers. */

export async function loadRegionManifest(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Region manifest: HTTP ${response.status}`);
  const manifest = await response.json();
  validateRegionManifest(manifest);
  manifest.url = response.url;
  manifest.baseUrl = new URL('.', response.url).href;
  return manifest;
}

export function validateRegionManifest(manifest) {
  if (!manifest || manifest.schemaVersion !== 1) throw new Error('Unsupported region manifest');
  if (!Array.isArray(manifest.bounds) || manifest.bounds.length !== 4) throw new Error('Invalid region bounds');
  if (!manifest.overview || !manifest.lod) throw new Error('Region manifest is missing overview or LOD');
  if (manifest.lod.tileSamples < 3 || manifest.lod.maxLevel < manifest.lod.minLevel) {
    throw new Error('Invalid LOD definition');
  }
  return manifest;
}

export function levelDecimation(manifest, level) {
  const lod = manifest.lod;
  const clamped = Math.max(lod.minLevel, Math.min(lod.maxLevel, level));
  return Math.max(1, lod.levelZeroDecimation >> (clamped - lod.minLevel));
}

export function levelResolution(manifest, level) {
  return manifest.sourceResolution.terrainMetres * levelDecimation(manifest, level);
}

export function tileAssetUrl(manifest, level, x, y, asset) {
  const stem = manifest.lod.urlTemplate
    .replace('{z}', String(level)).replace('{x}', String(x)).replace('{y}', String(y));
  return new URL(`${stem}/${asset}`, manifest.baseUrl).href;
}

/**
 * Choose a level from ground sampling distance. The renderer should request a finer level
 * when one source cell would cover more than maxPixels on screen.
 */
export function chooseLevel(manifest, metresPerPixel, maxPixels = 1.5) {
  const target = Math.max(Number.EPSILON, metresPerPixel * maxPixels);
  let selected = manifest.lod.minLevel;
  for (let level = manifest.lod.minLevel; level <= manifest.lod.maxLevel; level++) {
    selected = level;
    if (levelResolution(manifest, level) <= target) break;
  }
  return selected;
}
