/**
 * Optional context layers for the Kempsey flood viewer.
 *
 * The files under data/layers/ are a versioned, local snapshot. Keeping the
 * network work here (instead of calling Overpass/ABS from the render loop) makes
 * the viewer deterministic on GitHub Pages and lets the layer geometry share the
 * viewer's rebased EPSG:3857 world space.
 */

import * as THREE from 'three';
import { sampleNearest, sampleRaster } from './data.js';

const LAYER = 0;
const DEFAULT_FILES = {
  buildings: 'buildings.json',
  roads: 'roads.json',
  water: 'water.json',
  population: 'population_meshblock.json',
};

const ROAD_WIDTH = {
  // Cartographic display widths: wider than engineering widths so roads remain
  // legible at the overview scale of a 39 km flood scene.
  motorway: 18,
  motorway_link: 12,
  trunk: 16,
  trunk_link: 11,
  primary: 14,
  primary_link: 10,
  secondary: 12,
  secondary_link: 9,
  tertiary: 10,
  tertiary_link: 8,
  unclassified: 8,
  residential: 7,
  living_street: 6,
  service: 5,
  services: 5,
  track: 4,
  road: 7,
};

// These are display offsets, not surveyed bridge elevations. They only keep
// OSM bridge/tunnel geometry visually separated from the terrain and each
// other at the scene's overview scale.
const ROAD_BRIDGE_LIFT = 1.8;
const ROAD_TUNNEL_DROP = 0.45;
const ROAD_LAYER_STEP = 0.35;

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function roadDisplayWidth(feature) {
  const taggedWidth = Number(feature.width);
  if (Number.isFinite(taggedWidth) && taggedWidth > 0) return clamp(taggedWidth, 2.5, 32);
  const lanes = Number(feature.lanes);
  if (Number.isFinite(lanes) && lanes > 0) return clamp(lanes * 3.3 + 1.0, 3.5, 28);
  return ROAD_WIDTH[feature.class] || ROAD_WIDTH.road;
}

function roadSurfaceColor(feature) {
  const surface = String(feature.surface || '').toLowerCase();
  const unpaved = new Set(['unpaved', 'gravel', 'fine_gravel', 'ground', 'dirt', 'earth',
    'sand', 'mud', 'compacted', 'grass', 'woodchips']);
  return unpaved.has(surface) ? new THREE.Color(0xbca17a) : new THREE.Color(0xe8eef2);
}

function samePoint(a, b) {
  return !!a && !!b && Math.abs(a[0] - b[0]) < 0.01 && Math.abs(a[1] - b[1]) < 0.01;
}

function stripClosingPoint(ring) {
  if (ring.length > 1 && samePoint(ring[0], ring.at(-1))) return ring.slice(0, -1);
  return ring.slice();
}

function averagePoint(points) {
  let x = 0;
  let z = 0;
  for (const p of points) { x += p[0]; z += p[1]; }
  return points.length ? [x / points.length, z / points.length] : [0, 0];
}

function pushPosition(positions, x, y, z) {
  positions.push(x, y, z);
  return positions.length / 3 - 1;
}

function pushColor(colors, color) {
  colors.push(color.r, color.g, color.b);
}

function colorForFlood(base, depth, wetFraction = 0) {
  if (!(depth > 0) && !(wetFraction > 0)) return base.clone();
  const t = clamp(Math.max(depth / 4.0, wetFraction * 0.7), 0, 1);
  const wet = new THREE.Color(0x236fa8);
  return base.clone().lerp(wet, 0.42 + t * 0.45);
}

function populationColor(density, maxDensity) {
  // Log scaling keeps rural Mesh Blocks visible while retaining contrast in
  // the town centre, where a linear ramp would collapse everything to one colour.
  const t = clamp(Math.log1p(Math.max(0, density)) / Math.log1p(Math.max(1, maxDensity)), 0, 1);
  return new THREE.Color().setHSL(0.78 - 0.76 * t, 0.72, 0.54);
}

function triangulate(contour, holes = []) {
  if (contour.length < 3) return [];
  const shape = contour.map((p) => new THREE.Vector2(p[0], p[1]));
  const holeShapes = holes.map((ring) => ring.map((p) => new THREE.Vector2(p[0], p[1])));
  let triangles = THREE.ShapeUtils.triangulateShape(shape, holeShapes);
  if (!triangles.length && holes.length === 0) {
    // A few OSM footprints are imperfect or self-touching. The fan fallback
    // keeps the footprint visible instead of dropping an otherwise useful map
    // feature; the common case still uses robust Earcut triangulation.
    triangles = [];
    for (let i = 1; i < shape.length - 1; i++) triangles.push([0, i, i + 1]);
  }
  return triangles;
}

function roadFloodSample(layer, line) {
  let max = 0;
  let sum = 0;
  let wet = 0;
  for (const p of line) {
    const d = layer.floodDepthAt(p[0], p[1]);
    max = Math.max(max, d);
    sum += d;
    if (d > 0.05) wet++;
  }
  return { maxDepth: max, meanDepth: line.length ? sum / line.length : 0,
    wetFraction: line.length ? wet / line.length : 0 };
}

function roadGroundAt(layer, feature, x, z, baseOffset) {
  const ground = layer.groundAt(x, z);
  const terrain = Number.isFinite(ground) ? ground : 0;
  const osmLayer = Number(feature.layer);
  const layerOffset = Number.isFinite(osmLayer) ? osmLayer * ROAD_LAYER_STEP : 0;
  const bridgeOffset = feature.bridge === true
    ? ROAD_BRIDGE_LIFT
    : feature.tunnel === true
      ? -ROAD_TUNNEL_DROP
      : 0;

  return terrain + baseOffset + bridgeOffset + layerOffset;
}

function featureFloodSample(layer, ring) {
  const points = stripClosingPoint(ring);
  if (!points.length) return { maxDepth: 0, meanDepth: 0, wetFraction: 0 };
  const samples = points.length > 12
    ? points.filter((_, i) => i % Math.ceil(points.length / 12) === 0)
    : points;
  samples.push(averagePoint(points));
  let max = 0;
  let sum = 0;
  let wet = 0;
  for (const p of samples) {
    const d = layer.floodDepthAt(p[0], p[1]);
    max = Math.max(max, d);
    sum += d;
    if (d > 0.05) wet++;
  }
  return { maxDepth: max, meanDepth: sum / samples.length,
    wetFraction: wet / samples.length };
}

function ribbonGeometry(features, layer, widthFor, yOffset, colorFor, closed = false) {
  const positions = [];
  const colors = [];
  const indices = [];
  const records = [];

  for (const feature of features) {
    const line = closed ? stripClosingPoint(feature.ring) : feature.line;
    if (line.length < 2) continue;
    const width = widthFor(feature);
    const isRoad = colorFor === 'road' || colorFor === 'road-casing';
    const flood = isRoad ? roadFloodSample(layer, line) : null;
    const baseColor = colorFor === 'road' ? roadSurfaceColor(feature) : null;
    const color = colorFor === 'road'
      ? colorForFlood(baseColor, flood.maxDepth, flood.wetFraction)
      : colorFor === 'road-casing'
        ? new THREE.Color(0x243642)
        : new THREE.Color(0x48b7c9);
    const start = positions.length / 3;

    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const nx = -dz / len * width * 0.5;
      const nz = dx / len * width * 0.5;
      const ga = roadGroundAt(layer, feature, a[0], a[1], yOffset);
      const gb = roadGroundAt(layer, feature, b[0], b[1], yOffset);
      const base = positions.length / 3;
      pushPosition(positions, a[0] + nx, ga, a[1] + nz);
      pushPosition(positions, a[0] - nx, ga, a[1] - nz);
      pushPosition(positions, b[0] + nx, gb, b[1] + nz);
      pushPosition(positions, b[0] - nx, gb, b[1] - nz);
      for (let k = 0; k < 4; k++) pushColor(colors, color);
      // With +Y up, the ribbon's first edge is the left/right pair and the
      // triangles must be wound counter-clockwise as viewed from above.
      indices.push(base, base + 2, base + 1, base + 1, base + 2, base + 3);
    }

    const count = positions.length / 3 - start;
    if (count) records.push({ id: feature.id, line, start, count, flood, colorFor, baseColor });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, records };
}

function buildingGeometry(features, layer) {
  const positions = [];
  const colors = [];
  const indices = [];
  const outlinePositions = [];
  const overviewPositions = [];
  const overviewColors = [];
  const records = [];
  const baseColor = new THREE.Color(0xe2a654);
  const outlineOffset = 0.14;

  for (const feature of features) {
    const ring = stripClosingPoint(feature.rings?.[0] || feature.ring);
    if (ring.length < 3) continue;
    // GBA.LoD1 supplies the height in metres.  Keep that source value rather
    // than replacing it with an OSM level conversion or a project estimate.
    const sourceHeight = Number(feature.height);
    if (!Number.isFinite(sourceHeight) || sourceHeight <= 0) continue;
    const height = sourceHeight;
    const flood = featureFloodSample(layer, ring);
    const color = colorForFlood(baseColor, flood.maxDepth, flood.wetFraction);
    const start = positions.length / 3;
    const n = ring.length;
    const center = averagePoint(ring);
    const centerGround = layer.groundAt(center[0], center[1]);
    const overviewIndex = overviewPositions.length / 3;
    pushPosition(overviewPositions, center[0], (Number.isFinite(centerGround) ? centerGround : 0) + 0.55, center[1]);
    pushColor(overviewColors, color);
    const grounds = ring.map((p) => {
      const ground = layer.groundAt(p[0], p[1]);
      return Number.isFinite(ground) ? ground : 0;
    });

    // Sample the terrain at each corner rather than using one centre height;
    // this keeps footprints seated on a sloped DEM instead of looking like
    // detached paper cut-outs.
    for (let i = 0; i < n; i++) pushPosition(positions, ring[i][0], grounds[i], ring[i][1]);
    for (let i = 0; i < n; i++) pushPosition(positions, ring[i][0], grounds[i] + height, ring[i][1]);
    for (let i = 0; i < n * 2; i++) pushColor(colors, color);

    const triangles = triangulate(ring);
    for (const tri of triangles) {
      // The DEM already supplies the ground below the footprint. Omitting the
      // coplanar bottom cap avoids depth competition between a building base
      // and the terrain, especially along sloped footprint edges.
      indices.push(start + n + tri[0], start + n + tri[1], start + n + tri[2]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(start + i, start + j, start + n + i,
        start + j, start + n + j, start + n + i);

      // Roof perimeter, base perimeter and corner edges give small footprints
      // a readable silhouette at overview scale.
      outlinePositions.push(
        ring[i][0], grounds[i] + height + outlineOffset, ring[i][1],
        ring[j][0], grounds[j] + height + outlineOffset, ring[j][1],
        ring[i][0], grounds[i] + outlineOffset, ring[i][1],
        ring[j][0], grounds[j] + outlineOffset, ring[j][1],
        ring[i][0], grounds[i] + outlineOffset, ring[i][1],
        ring[i][0], grounds[i] + height + outlineOffset, ring[i][1]
      );
    }
    records.push({ start, count: n * 2, ring, flood, overviewIndex });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const outline = new THREE.BufferGeometry();
  outline.setAttribute('position', new THREE.Float32BufferAttribute(outlinePositions, 3));
  const overview = new THREE.BufferGeometry();
  overview.setAttribute('position', new THREE.Float32BufferAttribute(overviewPositions, 3));
  overview.setAttribute('color', new THREE.Float32BufferAttribute(overviewColors, 3));
  return { geometry, outline, overview, records };
}

function roadOverviewGeometry(features, layer) {
  const positions = [];
  const colors = [];
  const color = new THREE.Color(0x243642);
  const sampleStep = 28;

  for (const feature of features) {
    const line = feature.line || [];
    if (line.length < 2) continue;
    for (let i = 0; i < line.length - 1; i++) {
      const a = line[i];
      const b = line[i + 1];
      const dx = b[0] - a[0];
      const dz = b[1] - a[1];
      const len = Math.hypot(dx, dz);
      if (len < 0.01) continue;
      const steps = Math.max(1, Math.ceil(len / sampleStep));
      for (let j = 0; j < steps; j++) {
        const t = j / steps;
        const x = a[0] + dx * t;
        const z = a[1] + dz * t;
        pushPosition(positions, x, roadGroundAt(layer, feature, x, z, 0.55), z);
        pushColor(colors, color);
      }
    }
    const last = line.at(-1);
    pushPosition(positions, last[0], roadGroundAt(layer, feature, last[0], last[1], 0.55), last[1]);
    pushColor(colors, color);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return geometry;
}

function polygonGeometry(features, layer, colorForFeature, yOffset = 0.25, drapeToTerrain = false) {
  const positions = [];
  const colors = [];
  const indices = [];
  const records = [];

  for (const feature of features) {
    const rings = (feature.rings || [feature.ring]).filter((r) => r && r.length >= 4)
      .map(stripClosingPoint);
    if (!rings.length || rings[0].length < 3) continue;
    const outer = rings[0];
    const holes = rings.slice(1);
    const center = averagePoint(outer);
    const centerY = layer.groundAt(center[0], center[1]) + yOffset;
    const color = colorForFeature(feature);
    const start = positions.length / 3;
    const all = [outer, ...holes];
    for (const ring of all) {
      for (const p of ring) {
        const vertexY = drapeToTerrain
          ? layer.groundAt(p[0], p[1]) + yOffset
          : centerY;
        pushPosition(positions, p[0], Number.isFinite(vertexY) ? vertexY : yOffset, p[1]);
        pushColor(colors, color);
      }
    }
    const triangles = triangulate(outer, holes);
    // ShapeUtils returns indices relative to the flattened contour+holes array.
    for (const tri of triangles) {
      indices.push(start + tri[0], start + tri[2], start + tri[1]);
    }
    records.push({ start, count: positions.length / 3 - start, color });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, records };
}

function makeMaterial(kind) {
  if (kind === 'buildings') {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02,
      side: THREE.DoubleSide, flatShading: true });
  }
  if (kind === 'roads') {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  if (kind === 'road-casing') {
    return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92,
      depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  if (kind === 'population') {
    return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.52,
      depthWrite: false, side: THREE.DoubleSide, polygonOffset: true,
      polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  }
  return new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.36,
    depthWrite: false, side: THREE.DoubleSide, polygonOffset: true,
    polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
}

function clampRasterPoint(nx, ny, EW, EH, x, z) {
  const cellX = EW / Math.max(1, nx);
  const cellZ = EH / Math.max(1, ny);
  // sampleRaster needs the next cell for bilinear interpolation. Leave a tiny
  // inward epsilon at the eastern/southern edge so an exact extent corner
  // cannot select an out-of-range x0+1/z0+1 sample.
  const epsX = Math.max(1e-6, cellX * 1e-6);
  const epsZ = Math.max(1e-6, cellZ * 1e-6);
  return [
    clamp(Number.isFinite(x) ? x : 0, -EW * 0.5 + cellX * 0.5, EW * 0.5 - cellX * 0.5 - epsX),
    clamp(Number.isFinite(z) ? z : 0, -EH * 0.5 + cellZ * 0.5, EH * 0.5 - cellZ * 0.5 - epsZ),
  ];
}

export class ContextLayers {
  constructor({ scene, dataset, state, onProgress = () => {} } = {}) {
    this.scene = scene;
    this.dataset = dataset;
    this.state = state || {};
    this.onProgress = onProgress;
    this.group = new THREE.Group();
    this.group.name = 'Context layers';
    this.group.layers.set(LAYER);
    this.group.visible = true;
    this.objects = {};
    this.records = {};
    this.data = {};
    this.loaded = false;
    this.farMode = false;
    this.group.scale.y = Number.isFinite(this.state.vertExag) ? this.state.vertExag : 8;
    if (scene) scene.add(this.group);
  }

  async load() {
    // Revalidate the small manifest so a regenerated snapshot can provide a
    // new content version for the larger layer files.  Without this, the old
    // hard-coded query string could leave a static host serving stale JSON.
    const manifest = await this.fetchJson('./data/layers/manifest.json', 'manifest', { cache: 'no-cache' });
    const dataVersion = manifest.generatedAt || '1';
    const files = { ...DEFAULT_FILES };
    for (const key of Object.keys(files)) files[key] = manifest.layers?.[key]?.file || files[key];
    const keys = Object.keys(files);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      this.data[key] = await this.fetchJson('./data/layers/' + files[key], dataVersion);
      this.onProgress((i + 1) / keys.length, key);
    }
    this.build();
    this.loaded = true;
    return this;
  }

  async fetchJson(url, version = '1', options = {}) {
    const separator = url.includes('?') ? '&' : '?';
    const response = await fetch(`${url}${separator}v=${encodeURIComponent(version)}`, options);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  groundAt(x, z) {
    const { arrays, grid } = this.dataset;
    const [sx, sz] = clampRasterPoint(grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    const v = sampleRaster(arrays.terrain, grid.nx, grid.ny, grid.EW, grid.EH, sx, sz);
    return Number.isFinite(v) ? v : 0;
  }

  floodDepthAt(x, z) {
    const { arrays, grid, meta } = this.dataset;
    const [sx, sz] = clampRasterPoint(grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    const ws = meta.wsurfGrid;
    const [wx, wz] = clampRasterPoint(ws.nx, ws.ny, grid.EW, grid.EH, x, z);
    const flag = sampleNearest(arrays.flags, grid.nx, grid.ny, grid.EW, grid.EH, sx, sz);
    if (flag & 4) return 0;
    const ground = sampleRaster(arrays.terrain, grid.nx, grid.ny, grid.EW, grid.EH, sx, sz);
    if (!Number.isFinite(ground)) return 0;
    const offset = Number(this.state.waterOffset) || 0;
    if (flag & 2) return Math.max(0, -ground);
    const need = sampleRaster(arrays.need, grid.nx, grid.ny, grid.EW, grid.EH, sx, sz);
    const wet = Math.abs(offset) < 0.0005 ? !!(flag & 1) : offset >= need;
    if (!wet) return 0;
    const surface = sampleRaster(arrays.wsurf, ws.nx, ws.ny, grid.EW, grid.EH, wx, wz) + offset;
    return Number.isFinite(surface) ? Math.max(0, surface - ground) : 0;
  }

  build() {
    this.disposeObjects();
    const b = buildingGeometry(this.data.buildings?.features || [], this);
    const buildings = new THREE.Mesh(b.geometry, makeMaterial('buildings'));
    buildings.name = 'GBA building solids';
    buildings.layers.set(LAYER);
    buildings.renderOrder = 4;
    buildings.frustumCulled = false;
    const buildingOutlines = new THREE.LineSegments(b.outline,
      new THREE.LineBasicMaterial({ color: 0x17222e, transparent: true, opacity: 0.82,
        depthTest: true, depthWrite: false, polygonOffset: true,
        polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
    buildingOutlines.name = 'GBA building outlines';
    buildingOutlines.layers.set(LAYER);
    buildingOutlines.renderOrder = 5;
    buildingOutlines.frustumCulled = false;
    const buildingOverview = new THREE.Points(b.overview,
      new THREE.PointsMaterial({ vertexColors: true, size: 3.4, sizeAttenuation: false,
        transparent: true, opacity: 0.92, depthTest: true, depthWrite: false }));
    buildingOverview.name = 'GBA building overview markers';
    buildingOverview.layers.set(LAYER);
    buildingOverview.renderOrder = 6;
    buildingOverview.frustumCulled = false;
    const buildingLayer = new THREE.Group();
    buildingLayer.name = 'GlobalBuildingAtlas buildings';
    buildingLayer.layers.set(LAYER);
    buildingLayer.add(buildings, buildingOutlines, buildingOverview);
    this.group.add(buildingLayer);
    this.objects.buildings = buildingLayer;
    this.objects.buildingSurface = buildings;
    this.objects.buildingOutlines = buildingOutlines;
    this.objects.buildingOverview = buildingOverview;
    this.records.buildings = b.records;

    const roadFeatures = this.data.roads?.features || [];
    const casing = ribbonGeometry(roadFeatures, this,
      (feature) => roadDisplayWidth(feature) + 2.6, 0.28, 'road-casing');
    const roadCasing = new THREE.Mesh(casing.geometry, makeMaterial('road-casing'));
    roadCasing.name = 'OSM road casing';
    roadCasing.layers.set(LAYER);
    roadCasing.renderOrder = 2;
    roadCasing.frustumCulled = false;

    const r = ribbonGeometry(roadFeatures, this,
      (feature) => roadDisplayWidth(feature), 0.42, 'road');
    const roads = new THREE.Mesh(r.geometry, makeMaterial('roads'));
    roads.name = 'OSM road surfaces';
    roads.layers.set(LAYER);
    roads.renderOrder = 3;
    roads.frustumCulled = false;
    const roadOverview = new THREE.Points(roadOverviewGeometry(roadFeatures, this),
      new THREE.PointsMaterial({ vertexColors: true, size: 2.0, sizeAttenuation: false,
        transparent: true, opacity: 0.88, depthTest: true, depthWrite: false }));
    roadOverview.name = 'OSM road overview skeleton';
    roadOverview.layers.set(LAYER);
    roadOverview.renderOrder = 4;
    roadOverview.frustumCulled = false;
    const roadLayer = new THREE.Group();
    roadLayer.name = 'OSM roads';
    roadLayer.layers.set(LAYER);
    roadLayer.add(roadCasing, roads, roadOverview);
    this.group.add(roadLayer);
    this.objects.roads = roadLayer;
    this.objects.roadCasing = roadCasing;
    this.objects.roadSurface = roads;
    this.objects.roadOverview = roadOverview;
    this.records.roads = r.records;

    const waterData = this.data.water || {};
    const w = polygonGeometry(waterData.polygons || [], this, () => new THREE.Color(0x48b7c9), 0.18);
    const waterPolygons = new THREE.Mesh(w.geometry, makeMaterial('water'));
    waterPolygons.name = 'OSM water polygons';
    waterPolygons.layers.set(LAYER);
    waterPolygons.renderOrder = 1;
    const wl = ribbonGeometry(waterData.lines || [], this,
      (feature) => feature.kind === 'river' ? 4 : 1.5, 0.2, 'water');
    const waterLines = new THREE.Mesh(wl.geometry, makeMaterial('water'));
    waterLines.name = 'OSM waterways';
    waterLines.layers.set(LAYER);
    waterLines.renderOrder = 2;
    waterLines.frustumCulled = false;
    this.objects.water = new THREE.Group();
    this.objects.water.name = 'OSM water';
    this.objects.water.layers.set(LAYER);
    this.objects.water.add(waterPolygons, waterLines);
    this.group.add(this.objects.water);
    this.records.water = { polygons: w.records, lines: wl.records };

    const popFeatures = this.data.population?.features || [];
    const maxDensity = popFeatures.reduce((m, f) => Math.max(m, Number(f.density) || 0), 0);
    const p = polygonGeometry(popFeatures, this,
      (feature) => populationColor(Number(feature.density) || 0, maxDensity), 0.32, true);
    const population = new THREE.Mesh(p.geometry, makeMaterial('population'));
    population.name = 'ABS 2021 Mesh Block population density';
    population.layers.set(LAYER);
    population.renderOrder = 0;
    population.frustumCulled = false;
    this.group.add(population);
    this.objects.population = population;
    this.records.population = p.records;

    this.setVisibility('showBuildings', this.state.showBuildings !== false);
    this.setVisibility('showRoads', this.state.showRoads !== false);
    this.setVisibility('showOsmWater', !!this.state.showOsmWater);
    // Population is an opt-in contextual overlay; the main app also keeps it
    // off by default, but this makes the loader safe when used independently.
    this.setVisibility('showPopulation', this.state.showPopulation === true);
    this.updateFloodState(this.dataset, this.state);
    this.applyLod();
  }

  updateFloodState(dataset = this.dataset, state = this.state) {
    this.dataset = dataset;
    this.state = state || this.state;
    this.setVerticalExaggeration(this.state.vertExag);
    this.updateRecords('buildings', this.records.buildings, 0xe2a654);
    this.updateRecords('roads', this.records.roads, 0xdde5ea);
    this.applyLod();
  }

  updateRecords(kind, records, baseHex) {
    const object = kind === 'roads' ? this.objects.roadSurface :
      kind === 'buildings' ? this.objects.buildingSurface : this.objects[kind];
    const attr = object?.geometry?.getAttribute('color');
    if (!attr) return;
    const overviewAttr = kind === 'buildings'
      ? this.objects.buildingOverview?.geometry?.getAttribute('color')
      : null;
    const fallbackBase = new THREE.Color(baseHex);
    for (const record of records || []) {
      const flood = kind === 'buildings'
        ? featureFloodSample(this, record.ring)
        : roadFloodSample(this, record.line || []);
      const base = kind === 'roads' && record.baseColor ? record.baseColor : fallbackBase;
      const color = colorForFlood(base, flood.maxDepth, flood.wetFraction);
      for (let i = record.start; i < record.start + record.count; i++) {
        attr.setXYZ(i, color.r, color.g, color.b);
      }
      if (overviewAttr && Number.isInteger(record.overviewIndex)) {
        overviewAttr.setXYZ(record.overviewIndex, color.r, color.g, color.b);
      }
    }
    attr.needsUpdate = true;
    if (overviewAttr) overviewAttr.needsUpdate = true;
  }

  setVisibility(key, visible) {
    const names = {
      showBuildings: 'buildings',
      showRoads: 'roads',
      showOsmWater: 'water',
      showPopulation: 'population',
    };
    const name = names[key];
    if (this.state && key in this.state) this.state[key] = !!visible;
    if (key === 'showBuildings' || key === 'showRoads') {
      this.applyLod();
      return;
    }
    const object = this.objects[name];
    if (object) object.visible = !!visible;
  }

  /**
   * Switch between metric geometry and screen-space overview symbols. In a
   * 39 km scene, a 10 m footprint is below a pixel at the default camera
   * distance, so keeping the detailed mesh alone cannot make it readable.
   */
  updateCamera(camera, target) {
    if (!camera || !target?.isVector3) return;
    const distance = camera.position.distanceTo(target);
    const sceneScale = Math.max(this.dataset?.grid?.EW || 0, this.dataset?.grid?.EH || 0);
    const enterFar = Math.max(12000, sceneScale * 0.62);
    const leaveFar = Math.max(9000, sceneScale * 0.52);
    const nextFar = this.farMode ? distance > leaveFar : distance > enterFar;
    if (nextFar === this.farMode) return;
    this.farMode = nextFar;
    this.applyLod();
  }

  applyLod() {
    const showBuildings = this.state.showBuildings !== false;
    const showRoads = this.state.showRoads !== false;
    if (this.objects.buildings) this.objects.buildings.visible = showBuildings;
    if (this.objects.buildingSurface) this.objects.buildingSurface.visible = !this.farMode;
    if (this.objects.buildingOutlines) this.objects.buildingOutlines.visible = !this.farMode;
    if (this.objects.buildingOverview) this.objects.buildingOverview.visible = showBuildings && this.farMode;
    if (this.objects.roads) this.objects.roads.visible = showRoads;
    if (this.objects.roadCasing) this.objects.roadCasing.visible = !this.farMode;
    if (this.objects.roadSurface) this.objects.roadSurface.visible = !this.farMode;
    if (this.objects.roadOverview) this.objects.roadOverview.visible = showRoads && this.farMode;
  }

  setVerticalExaggeration(value) {
    if (Number.isFinite(value) && value > 0) this.group.scale.y = value;
  }

  disposeObjects() {
    for (const child of [...this.group.children]) {
      child.traverse((object) => {
        if (object.geometry) object.geometry.dispose();
        if (object.material) {
          const materials = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of materials) material.dispose();
        }
      });
      this.group.remove(child);
    }
    this.objects = {};
    this.records = {};
    this.farMode = false;
  }

  dispose() {
    this.disposeObjects();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

export async function loadContextLayers(options = {}) {
  const layers = new ContextLayers(options);
  try {
    await layers.load();
    return layers;
  } catch (error) {
    layers.dispose();
    throw error;
  }
}
