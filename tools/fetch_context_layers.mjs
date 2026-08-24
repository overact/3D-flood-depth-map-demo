/**
 * Download and normalize the context layers used by the static viewer.
 *
 * The browser deliberately does not call Overpass or the ABS service at runtime.
 * Run this script when refreshing the data snapshot:
 *
 *   node tools/fetch_context_layers.mjs
 *
 * By default an existing GlobalBuildingAtlas snapshot is preserved and the
 * existing population snapshot is preserved. Use --refresh-osm-buildings or
 * --refresh-sa1-population only when deliberately replacing those layers.
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
const mercatorAreaFactor = Number(meta.stats?.mercatorAreaFactor) ||
  Math.cos((Number(extent.latCentre) || 0) * Math.PI / 180) ** 2;
const bbox = {
  west: extent.left / R_EARTH * 180 / Math.PI,
  east: extent.right / R_EARTH * 180 / Math.PI,
  south: (2 * Math.atan(Math.exp(extent.bottom / R_EARTH)) - Math.PI / 2) * 180 / Math.PI,
  north: (2 * Math.atan(Math.exp(extent.top / R_EARTH)) - Math.PI / 2) * 180 / Math.PI,
};

const bboxText = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
const generatedAt = new Date().toISOString();
const args = new Set(process.argv.slice(2));
const refreshSa1Population = args.has('--refresh-sa1-population');
const refreshOsmBuildings = args.has('--refresh-osm-buildings');
const overpassInfo = {};

async function readJsonIfExists(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

const existingManifest = await readJsonIfExists(path.join(OUT, 'manifest.json'));
const existingBuildingsSnapshot = await readJsonIfExists(path.join(OUT, 'buildings.json'));
const existingPopulationFile = existingManifest?.layers?.population?.file || 'population_sa1.json';
const existingPopulationSnapshot = await readJsonIfExists(path.join(OUT, existingPopulationFile));
const preserveGbaBuildings = !refreshOsmBuildings &&
  String(existingBuildingsSnapshot?.source || '').includes('GlobalBuildingAtlas');
const shouldFetchSa1Population = refreshSa1Population || !existingPopulationSnapshot;
// ArcGIS/Overpass return complete features that intersect the request bbox. Clip
// their local geometry back to the exact raster rectangle so every context layer
// shares the same drawable extent as the flood scene.
const bounds = {
  minX: extent.left - extent.cx,
  maxX: extent.right - extent.cx,
  minZ: extent.cy - extent.top,
  maxZ: extent.cy - extent.bottom,
};

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

function clipIntersection(a, b, axis, value) {
  const d = b[axis] - a[axis];
  const t = Math.abs(d) < 1e-9 ? 0 : (value - a[axis]) / d;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function clipRing(points) {
  const source = points.length > 1 && samePoint(points[0], points.at(-1))
    ? points.slice(0, -1) : points.slice();
  if (source.length < 3) return [];
  const edges = [
    { inside: (p) => p[0] >= bounds.minX, axis: 0, value: bounds.minX },
    { inside: (p) => p[0] <= bounds.maxX, axis: 0, value: bounds.maxX },
    { inside: (p) => p[1] >= bounds.minZ, axis: 1, value: bounds.minZ },
    { inside: (p) => p[1] <= bounds.maxZ, axis: 1, value: bounds.maxZ },
  ];
  let clipped = source;
  for (const edge of edges) {
    if (!clipped.length) break;
    const output = [];
    let previous = clipped.at(-1);
    let previousInside = edge.inside(previous);
    for (const current of clipped) {
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
    clipped = output;
  }
  const clean = [];
  for (const p of clipped) {
    const rounded = [round(p[0]), round(p[1])];
    if (!clean.length || !samePoint(clean.at(-1), rounded)) clean.push(rounded);
  }
  if (clean.length > 1 && samePoint(clean[0], clean.at(-1))) clean.pop();
  if (clean.length < 3) return [];
  clean.push(clean[0]);
  return clean;
}

function clipSegment(a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  let t0 = 0;
  let t1 = 1;
  const tests = [
    [-dx, a[0] - bounds.minX],
    [ dx, bounds.maxX - a[0]],
    [-dz, a[1] - bounds.minZ],
    [ dz, bounds.maxZ - a[1]],
  ];
  for (const [p, q] of tests) {
    if (Math.abs(p) < 1e-9) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > t1) return null;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return null;
      if (t < t1) t1 = t;
    }
  }
  return [
    [round(a[0] + dx * t0), round(a[1] + dz * t0)],
    [round(a[0] + dx * t1), round(a[1] + dz * t1)],
  ];
}

function clipLine(points) {
  const parts = [];
  let current = [];
  const flush = () => {
    if (current.length >= 2) parts.push(current);
    current = [];
  };
  for (let i = 0; i < points.length - 1; i++) {
    const segment = clipSegment(points[i], points[i + 1]);
    if (!segment) {
      flush();
      continue;
    }
    const [a, b] = segment;
    if (!current.length) current.push(a, b);
    else if (samePoint(current.at(-1), a)) current.push(b);
    else { flush(); current.push(a, b); }
  }
  flush();
  return parts;
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
  if (Number.isFinite(explicit) && explicit > 0) {
    return { height: Math.min(60, Math.max(2.5, explicit)), source: 'height tag' };
  }
  const levels = parseMetres(tags['building:levels'] || tags.levels);
  if (Number.isFinite(levels) && levels > 0) {
    return { height: Math.min(60, Math.max(2.5, levels * 3.1)), source: 'levels × 3.1 m' };
  }
  return { height: 3.5, source: 'estimated fallback' };
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
      overpassInfo[label] = {
        endpoint,
        timestamp: json.osm3s?.timestamp_osm_base || null,
      };
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
  const output = [];
  for (const feature of features) {
    const p = feature.properties || {};
    const geometry = feature.geometry;
    if (!geometry?.coordinates) continue;
    const polygons = geometry.type === 'MultiPolygon'
      ? geometry.coordinates
      : [geometry.coordinates];
    const localPolygons = polygons.map((polygon) => polygon.map((ring) =>
      simplify(ring.map(([x, y]) => [round(x - extent.cx), round(extent.cy - y)]), 10, true)));
    const projectedAreaM2 = Math.max(1, localPolygons.reduce((sum, rings) => {
      if (!rings.length) return sum;
      return sum + polygonArea(rings[0]) - rings.slice(1).reduce((s, ring) => s + polygonArea(ring), 0);
    }, 0));
    // SA1 geometry is returned in Web Mercator. Convert projected area back to
    // approximate ground area using the same factor used by the flood stats.
    const areaM2 = projectedAreaM2 * mercatorAreaFactor;
    const population = Number(p.Tot_P_P) || 0;
    const density = round(population / (areaM2 / 1e6), 1);
    let part = 0;
    for (const rings of localPolygons) {
      const outer = clipRing(rings[0] || []);
      if (outer.length < 4) continue;
      const holes = rings.slice(1).map(clipRing).filter((ring) => ring.length >= 4);
      output.push({
        id: String(p.SA1_CODE_2021 || feature.id || '') + (part ? `:${part}` : ''),
        sourceId: String(p.SA1_CODE_2021 || feature.id || ''),
        partIndex: part,
        population: part === 0 ? population : 0,
        density,
        areaKm2: part === 0 ? round(areaM2 / 1e6, 3) : 0,
        rings: [outer, ...holes],
      });
      part++;
    }
  }
  return output;
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

const buildingElements = preserveGbaBuildings ? [] : await overpass(
  `[out:json][timeout:180];way["building"](${bboxText});out tags geom;`, 'buildings');
const roadElements = await overpass(
  `[out:json][timeout:180];way[highway](${bboxText});out tags geom;`, 'roads');
const waterElements = await overpass(
  `[out:json][timeout:180];(way["natural"="water"](${bboxText});way[waterway](${bboxText}););out tags geom;`, 'water');
const populationFeatures = shouldFetchSa1Population
  ? await fetchAbsPopulation()
  : existingPopulationSnapshot.features || [];

const osmBuildings = buildingElements.map((e) => {
  const ring = clipRing(elementLine(e, 0.5, true));
  if (ring.length < 4) return null;
  const tags = e.tags || {};
  const heightInfo = buildingHeight(tags);
  return {
    id: String(e.id),
    height: round(heightInfo.height, 1),
    heightSource: heightInfo.source,
    levels: Number.isFinite(parseMetres(tags['building:levels'])) ? parseMetres(tags['building:levels']) : null,
    ring,
  };
}).filter(Boolean);
const buildings = preserveGbaBuildings ? existingBuildingsSnapshot.features || [] : osmBuildings;

const ignoredRoads = new Set(['footway', 'path', 'cycleway', 'bridleway', 'steps', 'corridor',
  'pedestrian', 'construction', 'proposed', 'platform', 'raceway']);
const roads = roadElements.flatMap((e) => {
  const tags = e.tags || {};
  const roadClass = tags.highway || 'road';
  if (ignoredRoads.has(roadClass)) return [];
  const lines = clipLine(elementLine(e, 1, false));
  const width = parseMetres(tags.width);
  const lanes = parseMetres(tags.lanes);
  const osmLayer = parseMetres(tags.layer);
  return lines.map((line, i) => ({
    id: String(e.id) + (i ? `:${i}` : ''),
    class: roadClass,
    name: tags.name || '',
    bridge: !!tags.bridge && tags.bridge !== 'no',
    tunnel: !!tags.tunnel && tags.tunnel !== 'no',
    width: Number.isFinite(width) ? round(width, 2) : null,
    lanes: Number.isFinite(lanes) ? round(lanes, 1) : null,
    surface: tags.surface || null,
    tracktype: tags.tracktype || null,
    service: tags.service || null,
    layer: Number.isFinite(osmLayer) ? round(osmLayer, 1) : 0,
    oneway: tags.oneway === 'yes',
    line,
  }));
});

const waterPolygons = [];
const waterLines = [];
for (const e of waterElements) {
  const tags = e.tags || {};
  const closed = tags.natural === 'water';
  const points = elementLine(e, closed ? 2 : 2, closed);
  const clipped = closed ? clipRing(points) : clipLine(points);
  if (closed && clipped.length >= 4) waterPolygons.push({ id: String(e.id), kind: tags.water || tags.natural, ring: clipped });
  else if (!closed) clipped.forEach((line, i) => {
    if (line.length >= 2) waterLines.push({ id: String(e.id) + (i ? `:${i}` : ''), kind: tags.waterway || 'waterway', line });
  });
}

await mkdir(OUT, { recursive: true });
const writeJson = async (name, value) => {
  await writeFile(path.join(OUT, name), JSON.stringify(value));
};

if (!preserveGbaBuildings) {
  await writeJson('buildings.json', {
    version: 1,
    generatedAt,
    source: 'OpenStreetMap contributors via Overpass API',
    bbox,
    features: buildings,
  });
}
await writeJson('roads.json', {
  version: 1,
  generatedAt,
  source: 'OpenStreetMap contributors via Overpass API',
  sourceDate: overpassInfo.roads?.timestamp || null,
  queryEndpoint: overpassInfo.roads?.endpoint || null,
  queryBbox: bboxText,
  ignoredHighwayTags: [...ignoredRoads],
  bbox,
  features: roads,
});
await writeJson('water.json', {
  version: 1,
  generatedAt,
  source: 'OpenStreetMap contributors via Overpass API',
  sourceDate: overpassInfo.water?.timestamp || null,
  queryEndpoint: overpassInfo.water?.endpoint || null,
  queryBbox: bboxText,
  query: '(way[natural=water]; way[waterway])',
  bbox,
  polygons: waterPolygons,
  lines: waterLines,
});
if (shouldFetchSa1Population) {
  await writeJson('population_sa1.json', {
    version: 1,
    generatedAt,
    source: 'Australian Bureau of Statistics, 2021 Census General Community Profile, SA1',
    bbox,
    year: 2021,
    value: 'Total population / polygon area (people per km²)',
    areaCorrection: mercatorAreaFactor,
    areaMethod: 'EPSG:3857 polygon area × meta.stats.mercatorAreaFactor',
    features: populationFeatures,
  });
}
const buildingLayer = preserveGbaBuildings
  ? { ...(existingManifest?.layers?.buildings || {}), file: 'buildings.json', count: buildings.length }
  : {
      file: 'buildings.json',
      count: buildings.length,
      source: 'OSM via Overpass API',
      heightSources: buildings.reduce((summary, feature) => {
        summary[feature.heightSource] = (summary[feature.heightSource] || 0) + 1;
        return summary;
      }, {}),
    };
const populationLayer = shouldFetchSa1Population
  ? { file: 'population_sa1.json', count: populationFeatures.length, source: 'ABS 2021 Census SA1' }
  : {
      ...(existingManifest?.layers?.population || {}),
      file: existingPopulationFile,
      count: populationFeatures.length,
      source: existingPopulationSnapshot?.source || existingManifest?.layers?.population?.source || 'ABS population snapshot',
      year: existingPopulationSnapshot?.year,
      geography: existingPopulationSnapshot?.geography,
      populationField: existingPopulationSnapshot?.populationField,
      dwellingField: existingPopulationSnapshot?.dwellingField,
      boundarySource: existingPopulationSnapshot?.boundarySource,
      countSource: existingPopulationSnapshot?.countSource,
    };
const absAttribution = shouldFetchSa1Population
  ? 'Australian Bureau of Statistics, 2021 Census General Community Profile (CC BY 4.0)'
  : 'Australian Bureau of Statistics, 2021 Census Mesh Block Counts + ASGS 2021 Mesh Block boundaries (CC BY 4.0)';
await writeJson('manifest.json', {
  version: 1,
  generatedAt,
  bbox,
  layers: {
    buildings: buildingLayer,
    roads: {
      file: 'roads.json', count: roads.length, source: 'OSM via Overpass API',
      sourceDate: overpassInfo.roads?.timestamp || null,
      queryEndpoint: overpassInfo.roads?.endpoint || null,
      queryBbox: bboxText,
      ignoredHighwayTags: [...ignoredRoads],
    },
    water: {
      file: 'water.json', polygons: waterPolygons.length, lines: waterLines.length,
      source: 'OSM via Overpass API',
      sourceDate: overpassInfo.water?.timestamp || null,
      queryEndpoint: overpassInfo.water?.endpoint || null,
      queryBbox: bboxText,
    },
    population: populationLayer,
  },
  attribution: [
    ...(existingManifest?.attribution || []).filter((value) =>
      !String(value).startsWith('Australian Bureau of Statistics, 2021 Census')),
    '© OpenStreetMap contributors, ODbL 1.0',
    absAttribution,
  ].filter((value, index, values) => values.indexOf(value) === index),
});

console.log(`Wrote context layers to ${OUT}`);
console.log(`buildings=${buildings.length}, roads=${roads.length}, water=${waterPolygons.length}/${waterLines.length}, population=${populationFeatures.length}`);
