/**
 * Download and normalize the context layers used by the static viewer.
 *
 * The browser deliberately does not call Overpass or the ABS service at runtime.
 * Run this script when refreshing the data snapshot:
 *
 *   node tools/fetch_context_layers.mjs
 *
 * Output is intentionally small, local-coordinate JSON so the GitHub Pages build
 * stays dependency-free and the renderer can batch every layer into one geometry.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'layers');
const R_EARTH = 6378137;

const meta = JSON.parse(await readFile(path.join(ROOT, 'data3d', 'meta.json'), 'utf8'));
const extent = meta.extent;
const bbox = {
  west: extent.left / R_EARTH * 180 / Math.PI,
  east: extent.right / R_EARTH * 180 / Math.PI,
  south: (2 * Math.atan(Math.exp(extent.bottom / R_EARTH)) - Math.PI / 2) * 180 / Math.PI,
  north: (2 * Math.atan(Math.exp(extent.top / R_EARTH)) - Math.PI / 2) * 180 / Math.PI,
};

const bboxText = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
const generatedAt = new Date().toISOString();

function round(v, digits = 1) {
  const p = 10 ** digits;
  return Math.round(v * p) / p;
}

function mercator(lon, lat) {
  return {
    x: lon * Math.PI / 180 * R_EARTH,
    y: Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) * R_EARTH,
  };
}

function localPoint(lon, lat) {
  const p = mercator(lon, lat);
  return [round(p.x - extent.cx), round(extent.cy - p.y)];
}

function sqSegDist(p, a, b) {
  let x = a[0];
  let y = a[1];
  let dx = b[0] - x;
  let dy = b[1] - y;
  if (dx || dy) {
    const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) { x = b[0]; y = b[1]; }
    else if (t > 0) { x += dx * t; y += dy * t; }
  }
  dx = p[0] - x;
  dy = p[1] - y;
  return dx * dx + dy * dy;
}

function simplify(points, tolerance, closed = false) {
  if (points.length <= (closed ? 4 : 2)) return points;
  const source = closed && points.length > 1 && samePoint(points[0], points.at(-1))
    ? points.slice(0, -1) : points.slice();
  if (source.length <= (closed ? 3 : 2)) return source;
  const keep = new Uint8Array(source.length);
  keep[0] = 1;
  keep[source.length - 1] = 1;
  const sqTolerance = tolerance * tolerance;
  const stack = [[0, source.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = sqTolerance;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(source[i], source[first], source[last]);
      if (sq > maxSq) { index = i; maxSq = sq; }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  const out = source.filter((_, i) => keep[i]);
  if (closed) out.push(out[0]);
  return out;
}

function samePoint(a, b) {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

function elementLine(element, tolerance = 1, closed = false) {
  const raw = (element.geometry || []).map((p) => localPoint(p.lon, p.lat));
  const clean = [];
  for (const p of raw) if (!clean.length || !samePoint(clean.at(-1), p)) clean.push(p);
  if (closed && clean.length >= 3 && !samePoint(clean[0], clean.at(-1))) clean.push(clean[0]);
  return simplify(clean, tolerance, closed);
}

function parseMetres(value) {
  if (value == null) return NaN;
  const n = Number(String(value).replace(',', '.').match(/-?\d+(?:\.\d+)?/)?.[0]);
  return Number.isFinite(n) ? n : NaN;
}

function buildingHeight(tags) {
  const explicit = parseMetres(tags.height || tags['building:height']);
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(60, Math.max(2.5, explicit));
  const levels = parseMetres(tags['building:levels'] || tags.levels);
  if (Number.isFinite(levels) && levels > 0) return Math.min(60, Math.max(2.5, levels * 3.1));
  return 3.5;
}

async function overpass(query, label) {
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  let lastError;
  for (const endpoint of endpoints) {
    try {
      const body = new URLSearchParams({ data: query });
      const response = await fetch(endpoint, {
        method: 'POST',
        body,
        headers: {
          'user-agent': '3D-flood-depth-map-demo/1.0 context-layer-snapshot',
          accept: 'application/json',
        },
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      const json = await response.json();
      console.log(`${label}: ${json.elements?.length || 0} OSM elements from ${endpoint}`);
      return json.elements || [];
    } catch (error) {
      lastError = error;
      console.warn(`${label}: ${endpoint} failed (${error.message})`);
    }
  }
  throw lastError || new Error(`${label}: no Overpass endpoint succeeded`);
}

function polygonArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  }
  return Math.abs(a) * 0.5;
}

function populationDensity(features) {
  return features.map((feature) => {
    const p = feature.properties || {};
    const rings = (feature.geometry?.coordinates || []).map((ring) =>
      simplify(ring.map(([x, y]) => [round(x - extent.cx), round(extent.cy - y)]), 10, true));
    if (!rings.length || rings[0].length < 4) return null;
    const areas = rings.map(polygonArea);
    const outer = Math.max(...areas);
    const areaM2 = Math.max(1, outer - areas.reduce((sum, a) => sum + (a === outer ? 0 : a), 0));
    const population = Number(p.Tot_P_P) || 0;
    return {
      id: String(p.SA1_CODE_2021 || feature.id || ''),
      population,
      density: round(population / (areaM2 / 1e6), 1),
      areaKm2: round(areaM2 / 1e6, 3),
      rings,
    };
  }).filter(Boolean);
}

async function fetchAbsPopulation() {
  const query = new URLSearchParams({
    where: '1=1',
    geometry: `${bbox.west},${bbox.south},${bbox.east},${bbox.north}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outFields: '*',
    returnGeometry: 'true',
    outSR: '3857',
    maxAllowableOffset: '10',
    geometryPrecision: '1',
    resultRecordCount: '2000',
    returnExceededLimitFeatures: 'true',
    f: 'geojson',
  });
  const url = 'https://services1.arcgis.com/vHnIGBHHqDR6y0CR/arcgis/rest/services/'
    + '2021_ABS_General_Community_Profile/FeatureServer/6/query?' + query;
  const response = await fetch(url, { headers: { 'user-agent': '3D-flood-depth-map-demo/1.0 context-layer-snapshot' } });
  if (!response.ok) throw new Error(`ABS population query: ${response.status} ${response.statusText}`);
  const json = await response.json();
  if (json.error) throw new Error(`ABS population query: ${JSON.stringify(json.error)}`);
  const features = populationDensity(json.features || []);
  console.log(`population: ${features.length} ABS 2021 SA1 polygons`);
  return features;
}

const buildingElements = await overpass(
  `[out:json][timeout:180];way["building"](${bboxText});out tags geom;`, 'buildings');
const roadElements = await overpass(
  `[out:json][timeout:180];way[highway](${bboxText});out tags geom;`, 'roads');
const waterElements = await overpass(
  `[out:json][timeout:180];(way["natural"="water"](${bboxText});way[waterway](${bboxText}););out tags geom;`, 'water');
const populationFeatures = await fetchAbsPopulation();

const buildings = buildingElements.map((e) => {
  const ring = elementLine(e, 0.5, true);
  if (ring.length < 4) return null;
  const tags = e.tags || {};
  return {
    id: String(e.id),
    height: round(buildingHeight(tags), 1),
    levels: Number.isFinite(parseMetres(tags['building:levels'])) ? parseMetres(tags['building:levels']) : null,
    ring,
  };
}).filter(Boolean);

const ignoredRoads = new Set(['footway', 'path', 'cycleway', 'bridleway', 'steps', 'corridor',
  'pedestrian', 'construction', 'proposed', 'platform', 'raceway']);
const roads = roadElements.map((e) => {
  const tags = e.tags || {};
  const roadClass = tags.highway || 'road';
  if (ignoredRoads.has(roadClass)) return null;
  const line = elementLine(e, 1, false);
  if (line.length < 2) return null;
  return {
    id: String(e.id),
    class: roadClass,
    name: tags.name || '',
    bridge: tags.bridge === 'yes',
    tunnel: tags.tunnel === 'yes',
    line,
  };
}).filter(Boolean);

const waterPolygons = [];
const waterLines = [];
for (const e of waterElements) {
  const tags = e.tags || {};
  const closed = tags.natural === 'water';
  const points = elementLine(e, closed ? 2 : 2, closed);
  if (closed && points.length >= 4) waterPolygons.push({ id: String(e.id), kind: tags.water || tags.natural, ring: points });
  else if (!closed && points.length >= 2) waterLines.push({ id: String(e.id), kind: tags.waterway || 'waterway', line: points });
}

await mkdir(OUT, { recursive: true });
const writeJson = async (name, value) => {
  await writeFile(path.join(OUT, name), JSON.stringify(value));
};

await writeJson('buildings.json', {
  version: 1,
  generatedAt,
  source: 'OpenStreetMap contributors via Overpass API',
  bbox,
  features: buildings,
});
await writeJson('roads.json', {
  version: 1,
  generatedAt,
  source: 'OpenStreetMap contributors via Overpass API',
  bbox,
  features: roads,
});
await writeJson('water.json', {
  version: 1,
  generatedAt,
  source: 'OpenStreetMap contributors via Overpass API',
  bbox,
  polygons: waterPolygons,
  lines: waterLines,
});
await writeJson('population_sa1.json', {
  version: 1,
  generatedAt,
  source: 'Australian Bureau of Statistics, 2021 Census General Community Profile, SA1',
  bbox,
  year: 2021,
  value: 'Total population / polygon area (people per km²)',
  features: populationFeatures,
});
await writeJson('manifest.json', {
  version: 1,
  generatedAt,
  bbox,
  layers: {
    buildings: { file: 'buildings.json', count: buildings.length, source: 'OSM via Overpass API' },
    roads: { file: 'roads.json', count: roads.length, source: 'OSM via Overpass API' },
    water: { file: 'water.json', polygons: waterPolygons.length, lines: waterLines.length, source: 'OSM via Overpass API' },
    population: { file: 'population_sa1.json', count: populationFeatures.length, source: 'ABS 2021 Census SA1' },
  },
  attribution: [
    '© OpenStreetMap contributors, ODbL 1.0',
    'Australian Bureau of Statistics, 2021 Census General Community Profile (CC BY 4.0)',
  ],
});

console.log(`Wrote context layers to ${OUT}`);
console.log(`buildings=${buildings.length}, roads=${roads.length}, water=${waterPolygons.length}/${waterLines.length}, population=${populationFeatures.length}`);
