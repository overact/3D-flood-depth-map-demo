/**
 * Build the local building snapshot from the official GlobalBuildingAtlas
 * release.  The browser never downloads the 5° source tiles; this tool joins
 * the released height attributes to the released building polygons, clips the
 * result to data3d/meta.json, and writes only the small local snapshot.
 *
 * The release is split into two polygon sources plus one attribute file.  The
 * official produce_lod1.py script joins the same three inputs:
 *
 *   GBA.ODbLPolygon/<tile>.geojson   (ODbL 1.0 footprints)
 *   GBA.Polygon/<tile>.geojson       (CC BY-NC 4.0 footprints)
 *   GBA.LoD1/<tile>.json             (CC BY-NC 4.0 height and var attributes)
 *
 * Example (after downloading the three files to a temporary directory):
 *
 *   node --max-old-space-size=2048 tools/fetch_gba_buildings.mjs \
 *     --odbl C:\\temp\\e150_s30_e155_s35-odbl.geojson \
 *     --polygon C:\\temp\\e150_s30_e155_s35-polygon.geojson \
 *     --attributes C:\\temp\\e150_s30_e155_s35.json
 *
 * Official release URLs:
 *   https://huggingface.co/datasets/zhu-xlab/GBA.ODbLPolygon
 *   https://huggingface.co/datasets/zhu-xlab/GBA.LoD1
 *   https://github.com/zhu-xlab/GlobalBuildingAtlas
 */

import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'layers', 'buildings.json');
const MANIFEST = path.join(ROOT, 'data', 'layers', 'manifest.json');
const META = path.join(ROOT, 'data3d', 'meta.json');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const equal = token.indexOf('=');
    if (equal >= 0) out[token.slice(2, equal)] = token.slice(equal + 1);
    else out[token.slice(2)] = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const odblPath = args.odbl;
const polygonPath = args.polygon;
const attributesPath = args.attributes;
if (!odblPath || !polygonPath || !attributesPath) {
  throw new Error('Usage: node tools/fetch_gba_buildings.mjs --odbl <file> --polygon <file> --attributes <file>');
}

const meta = JSON.parse(await readFile(META, 'utf8'));
const extent = meta.extent;
const bounds = {
  minX: extent.left - extent.cx,
  maxX: extent.right - extent.cx,
  minZ: extent.cy - extent.top,
  maxZ: extent.cy - extent.bottom,
};
const R_EARTH = 6378137;
const geographicBbox = {
  west: extent.left / R_EARTH * 180 / Math.PI,
  east: extent.right / R_EARTH * 180 / Math.PI,
  south: (2 * Math.atan(Math.exp(extent.bottom / R_EARTH)) - Math.PI / 2) * 180 / Math.PI,
  north: (2 * Math.atan(Math.exp(extent.top / R_EARTH)) - Math.PI / 2) * 180 / Math.PI,
};

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function samePoint(a, b) {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

function sqSegDist(point, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx || dy) {
    const t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = point[0] - x;
  dy = point[1] - y;
  return dx * dx + dy * dy;
}

function simplify(points, tolerance = 0.25) {
  const source = points.length > 1 && samePoint(points[0], points.at(-1))
    ? points.slice(0, -1) : points.slice();
  if (source.length <= 3) return source;
  const keep = new Uint8Array(source.length);
  keep[0] = 1;
  keep[source.length - 1] = 1;
  const stack = [[0, source.length - 1]];
  const squaredTolerance = tolerance * tolerance;
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDistance = squaredTolerance;
    let split = -1;
    for (let i = first + 1; i < last; i++) {
      const distance = sqSegDist(source[i], source[first], source[last]);
      if (distance > maxDistance) { maxDistance = distance; split = i; }
    }
    if (split >= 0) {
      keep[split] = 1;
      stack.push([first, split], [split, last]);
    }
  }
  return source.filter((_, index) => keep[index]);
}

function clipIntersection(a, b, axis, value) {
  const delta = b[axis] - a[axis];
  const t = Math.abs(delta) < 1e-9 ? 0 : (value - a[axis]) / delta;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function clipRing(points) {
  let source = points.length > 1 && samePoint(points[0], points.at(-1))
    ? points.slice(0, -1) : points.slice();
  if (source.length < 3) return [];
  const edges = [
    { inside: (p) => p[0] >= bounds.minX, axis: 0, value: bounds.minX },
    { inside: (p) => p[0] <= bounds.maxX, axis: 0, value: bounds.maxX },
    { inside: (p) => p[1] >= bounds.minZ, axis: 1, value: bounds.minZ },
    { inside: (p) => p[1] <= bounds.maxZ, axis: 1, value: bounds.maxZ },
  ];
  for (const edge of edges) {
    if (!source.length) break;
    const output = [];
    let previous = source.at(-1);
    let previousInside = edge.inside(previous);
    for (const current of source) {
      const currentInside = edge.inside(current);
      if (currentInside) {
        if (!previousInside) output.push(clipIntersection(previous, current, edge.axis, edge.value));
        output.push(current);
      } else if (previousInside) {
        output.push(clipIntersection(previous, current, edge.axis, edge.value));
      }
      previous = current;
      previousInside = currentInside;
    }
    source = output;
  }
  const clean = [];
  for (const point of source) {
    const rounded = [round(point[0]), round(point[1])];
    if (!clean.length || !samePoint(clean.at(-1), rounded)) clean.push(rounded);
  }
  if (clean.length > 1 && samePoint(clean[0], clean.at(-1))) clean.pop();
  if (clean.length < 3) return [];
  clean.push(clean[0]);
  return clean;
}

function toLocalRing(rawRing) {
  if (!Array.isArray(rawRing)) return [];
  const local = [];
  for (const point of rawRing) {
    if (!Array.isArray(point) || point.length < 2) continue;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const next = [round(x - extent.cx), round(extent.cy - y)];
    if (!local.length || !samePoint(local.at(-1), next)) local.push(next);
  }
  return clipRing(simplify(local));
}

function polygonParts(geometry) {
  if (!geometry?.coordinates) return [];
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

const attributes = JSON.parse(await readFile(attributesPath, 'utf8'));
const buildings = [];
const seen = new Set();
const stats = {
  scanned: 0,
  matched: 0,
  missingHeight: 0,
  clipped: 0,
  skippedGeometry: 0,
  duplicate: 0,
  files: {},
  heights: [],
};

function addFeature(feature, fileLabel) {
  const properties = feature.properties || {};
  const source = String(properties.source || '');
  const id = String(properties.id || '');
  const region = String(properties.region || 'AUS');
  const key = source + id + region;
  const attribute = attributes[key];
  stats.matched += attribute ? 1 : 0;
  if (!attribute) return;
  const height = Number(attribute.height);
  if (!Number.isFinite(height) || height <= 0) {
    stats.missingHeight++;
    return;
  }
  if (seen.has(key)) {
    stats.duplicate++;
    return;
  }
  const parts = polygonParts(feature.geometry);
  let wrote = false;
  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const sourceRings = parts[partIndex] || [];
    const ring = toLocalRing(sourceRings[0]);
    if (ring.length < 4) continue;
    const holes = sourceRings.slice(1).map(toLocalRing).filter((hole) => hole.length >= 4);
    const output = {
      id: key + (parts.length > 1 ? `:${partIndex}` : ''),
      sourceId: id,
      source,
      region,
      height: round(height, 2),
      heightVar: Number.isFinite(Number(attribute.var)) ? round(Number(attribute.var), 4) : null,
      heightSource: 'GlobalBuildingAtlas GBA.LoD1 height attribute',
      ring,
    };
    if (holes.length) output.rings = [ring, ...holes];
    buildings.push(output);
    stats.heights.push(height);
    wrote = true;
    stats.clipped++;
  }
  if (wrote) seen.add(key);
  else stats.skippedGeometry++;
}

async function processGeoJson(filePath, label) {
  const fileStats = { lines: 0, features: 0, output: 0 };
  stats.files[label] = fileStats;
  const input = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    fileStats.lines++;
    const text = line.trim();
    if (!text.startsWith('{') || !text.includes('"geometry"') || !text.includes('"properties"')) continue;
    let feature;
    try {
      // The released GeoJSON is pretty-printed with one feature per line and
      // a trailing comma on every feature except the last one.
      feature = JSON.parse(text.endsWith(',') ? text.slice(0, -1) : text);
    } catch (error) {
      throw new Error(`${label}: could not parse feature near line ${fileStats.lines}: ${error.message}`);
    }
    fileStats.features++;
    stats.scanned++;
    const before = buildings.length;
    addFeature(feature, label);
    fileStats.output += buildings.length - before;
    if (fileStats.features % 100000 === 0) {
      console.log(`${label}: scanned ${fileStats.features.toLocaleString()}, local buildings ${buildings.length.toLocaleString()}`);
    }
  }
  console.log(`${label}: scanned ${fileStats.features.toLocaleString()}, emitted ${fileStats.output.toLocaleString()}`);
}

await processGeoJson(odblPath, 'GBA.ODbLPolygon');
await processGeoJson(polygonPath, 'GBA.Polygon');

stats.heights.sort((a, b) => a - b);
const heightStats = stats.heights.length ? {
  count: stats.heights.length,
  min: round(stats.heights[0], 2),
  median: round(stats.heights[Math.floor(stats.heights.length * 0.5)], 2),
  p95: round(stats.heights[Math.floor(stats.heights.length * 0.95)], 2),
  max: round(stats.heights.at(-1), 2),
} : { count: 0 };
const generatedAt = new Date().toISOString();
const output = {
  version: 2,
  generatedAt,
  source: 'GlobalBuildingAtlas GBA.LoD1 (GBA.ODbLPolygon + GBA.Polygon)',
  heightSource: 'GlobalBuildingAtlas GBA.LoD1 height attribute; project does not derive building heights',
  heightUncertainty: 'GBA.LoD1 var field is the model prediction variance',
  crs: 'EPSG:3857, rebased to the viewer local scene coordinates',
  bbox: geographicBbox,
  tile: 'e150_s30_e155_s35',
  features: buildings,
};

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, JSON.stringify(output));

// The sorted height list is useful only for the console summary.  Do not put
// thousands of raw values into the browser manifest.
delete stats.heights;

let manifest;
try {
  manifest = JSON.parse(await readFile(MANIFEST, 'utf8'));
} catch {
  manifest = { version: 1, layers: {}, attribution: [] };
}
manifest.generatedAt = generatedAt;
manifest.bbox = geographicBbox;
manifest.layers ||= {};
manifest.layers.buildings = {
  file: 'buildings.json',
  count: buildings.length,
  source: 'GlobalBuildingAtlas GBA.LoD1, local e150_s30_e155_s35 tile',
  heightField: 'height (metres), supplied by GBA; not calculated by this project',
  uncertaintyField: 'var (model prediction variance)',
  heightStats,
  processing: stats,
};
manifest.attribution = [...new Set([
  ...(manifest.attribution || []),
  'GlobalBuildingAtlas GBA.LoD1: CC BY-NC 4.0',
  'GlobalBuildingAtlas GBA.ODbLPolygon: ODbL 1.0',
])];
await writeFile(MANIFEST, JSON.stringify(manifest));
console.log(JSON.stringify({ output: OUT, buildings: buildings.length, heightStats, stats }, null, 2));
