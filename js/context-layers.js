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
  population: 'population_sa1.json',
};

const ROAD_WIDTH = {
  motorway: 8,
  trunk: 7,
  primary: 6,
  secondary: 5,
  tertiary: 4,
  unclassified: 3.2,
  residential: 3.0,
  living_street: 2.6,
  service: 2.1,
  track: 1.6,
  road: 3.0,
};

function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

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
  // Log scaling keeps Kempsey's rural SA1s visible while retaining contrast in
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
    const flood = colorFor === 'road' ? roadFloodSample(layer, line) : null;
    const color = colorFor === 'road'
      ? colorForFlood(new THREE.Color(0xdde5ea), flood.maxDepth, flood.wetFraction)
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
      const ga = layer.groundAt(a[0], a[1]) + yOffset;
      const gb = layer.groundAt(b[0], b[1]) + yOffset;
      const base = positions.length / 3;
      pushPosition(positions, a[0] + nx, ga, a[1] + nz);
      pushPosition(positions, a[0] - nx, ga, a[1] - nz);
      pushPosition(positions, b[0] + nx, gb, b[1] + nz);
      pushPosition(positions, b[0] - nx, gb, b[1] - nz);
      for (let k = 0; k < 4; k++) pushColor(colors, color);
      indices.push(base, base + 1, base + 2, base + 1, base + 3, base + 2);
    }

    const count = positions.length / 3 - start;
    if (count) records.push({ id: feature.id, line, start, count, flood, colorFor });
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
  const records = [];
  const baseColor = new THREE.Color(0xe2a654);

  for (const feature of features) {
    const ring = stripClosingPoint(feature.ring);
    if (ring.length < 3) continue;
    const center = averagePoint(ring);
    const ground = layer.groundAt(center[0], center[1]);
    const baseY = Number.isFinite(ground) ? ground : 0;
    const height = clamp(Number(feature.height) || 3.5, 2.5, 60);
    const flood = featureFloodSample(layer, ring);
    const color = colorForFlood(baseColor, flood.maxDepth, flood.wetFraction);
    const start = positions.length / 3;
    const n = ring.length;

    for (const p of ring) pushPosition(positions, p[0], baseY, p[1]);
    for (const p of ring) pushPosition(positions, p[0], baseY + height, p[1]);
    for (let i = 0; i < n * 2; i++) pushColor(colors, color);

    const triangles = triangulate(ring);
    for (const tri of triangles) {
      indices.push(start + tri[0], start + tri[2], start + tri[1]);
      indices.push(start + n + tri[0], start + n + tri[1], start + n + tri[2]);
    }
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      indices.push(start + i, start + j, start + n + i,
        start + j, start + n + j, start + n + i);
    }
    records.push({ start, count: n * 2, ring, flood });
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return { geometry, records };
}

function polygonGeometry(features, layer, colorForFeature, yOffset = 0.25) {
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
    const y = layer.groundAt(center[0], center[1]) + yOffset;
    const color = colorForFeature(feature);
    const start = positions.length / 3;
    const all = [outer, ...holes];
    for (const ring of all) {
      for (const p of ring) {
        pushPosition(positions, p[0], Number.isFinite(y) ? y : yOffset, p[1]);
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
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0.02 });
  }
  if (kind === 'roads') {
    return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.0,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
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
    this.group.scale.y = Number.isFinite(this.state.vertExag) ? this.state.vertExag : 8;
    if (scene) scene.add(this.group);
  }

  async load() {
    const manifest = await this.fetchJson('./data/layers/manifest.json');
    const files = { ...DEFAULT_FILES };
    for (const key of Object.keys(files)) files[key] = manifest.layers?.[key]?.file || files[key];
    const keys = Object.keys(files);
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      this.data[key] = await this.fetchJson('./data/layers/' + files[key]);
      this.onProgress((i + 1) / keys.length, key);
    }
    this.build();
    this.loaded = true;
    return this;
  }

  async fetchJson(url) {
    const response = await fetch(url + '?v=1');
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    return response.json();
  }

  groundAt(x, z) {
    const { arrays, grid } = this.dataset;
    const v = sampleRaster(arrays.terrain, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    return Number.isFinite(v) ? v : 0;
  }

  floodDepthAt(x, z) {
    const { arrays, grid, meta } = this.dataset;
    const flag = sampleNearest(arrays.flags, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    if (flag & 4) return 0;
    const ground = sampleRaster(arrays.terrain, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    if (!Number.isFinite(ground)) return 0;
    const offset = Number(this.state.waterOffset) || 0;
    if (flag & 2) return Math.max(0, -ground);
    const need = sampleRaster(arrays.need, grid.nx, grid.ny, grid.EW, grid.EH, x, z);
    const wet = Math.abs(offset) < 0.0005 ? !!(flag & 1) : offset >= need;
    if (!wet) return 0;
    const ws = meta.wsurfGrid;
    const surface = sampleRaster(arrays.wsurf, ws.nx, ws.ny, grid.EW, grid.EH, x, z) + offset;
    return Number.isFinite(surface) ? Math.max(0, surface - ground) : 0;
  }

  build() {
    this.disposeObjects();
    const b = buildingGeometry(this.data.buildings?.features || [], this);
    const buildings = new THREE.Mesh(b.geometry, makeMaterial('buildings'));
    buildings.name = 'OSM buildings';
    buildings.layers.set(LAYER);
    buildings.renderOrder = 4;
    this.group.add(buildings);
    this.objects.buildings = buildings;
    this.records.buildings = b.records;

    const r = ribbonGeometry(this.data.roads?.features || [], this,
      (feature) => ROAD_WIDTH[feature.class] || ROAD_WIDTH.road, 0.22, 'road');
    const roads = new THREE.Mesh(r.geometry, makeMaterial('roads'));
    roads.name = 'OSM roads';
    roads.layers.set(LAYER);
    roads.renderOrder = 3;
    this.group.add(roads);
    this.objects.roads = roads;
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
    this.objects.water = new THREE.Group();
    this.objects.water.name = 'OSM water';
    this.objects.water.layers.set(LAYER);
    this.objects.water.add(waterPolygons, waterLines);
    this.group.add(this.objects.water);
    this.records.water = { polygons: w.records, lines: wl.records };

    const popFeatures = this.data.population?.features || [];
    const maxDensity = popFeatures.reduce((m, f) => Math.max(m, Number(f.density) || 0), 0);
    const p = polygonGeometry(popFeatures, this,
      (feature) => populationColor(Number(feature.density) || 0, maxDensity), 0.32);
    const population = new THREE.Mesh(p.geometry, makeMaterial('population'));
    population.name = 'ABS 2021 population density';
    population.layers.set(LAYER);
    population.renderOrder = 0;
    this.group.add(population);
    this.objects.population = population;
    this.records.population = p.records;

    this.setVisibility('showBuildings', this.state.showBuildings !== false);
    this.setVisibility('showRoads', this.state.showRoads !== false);
    this.setVisibility('showOsmWater', !!this.state.showOsmWater);
    this.setVisibility('showPopulation', this.state.showPopulation !== false);
    this.updateFloodState(this.dataset, this.state);
  }

  updateFloodState(dataset = this.dataset, state = this.state) {
    this.dataset = dataset;
    this.state = state || this.state;
    this.setVerticalExaggeration(this.state.vertExag);
    this.updateRecords('buildings', this.records.buildings, 0xe2a654);
    this.updateRecords('roads', this.records.roads, 0xdde5ea);
  }

  updateRecords(kind, records, baseHex) {
    const object = this.objects[kind];
    const attr = object?.geometry?.getAttribute('color');
    if (!attr) return;
    const base = new THREE.Color(baseHex);
    for (const record of records || []) {
      const flood = kind === 'buildings'
        ? featureFloodSample(this, record.ring)
        : roadFloodSample(this, record.line || []);
      const color = colorForFlood(base, flood.maxDepth, flood.wetFraction);
      for (let i = record.start; i < record.start + record.count; i++) {
        attr.setXYZ(i, color.r, color.g, color.b);
      }
    }
    attr.needsUpdate = true;
  }

  setVisibility(key, visible) {
    const names = {
      showBuildings: 'buildings',
      showRoads: 'roads',
      showOsmWater: 'water',
      showPopulation: 'population',
    };
    const name = names[key];
    const object = this.objects[name];
    if (object) object.visible = !!visible;
    if (this.state && key in this.state) this.state[key] = !!visible;
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
  }

  dispose() {
    this.disposeObjects();
    if (this.group.parent) this.group.parent.remove(this.group);
  }
}

export async function loadContextLayers(options = {}) {
  const layers = new ContextLayers(options);
  await layers.load();
  return layers;
}
