import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { populationFeatures } from '../js/population-grid.js';
import { populationColor, populationPosition, POPULATION_RAMP } from '../js/population-style.js';

test('compact native cells retain their bounds, population and density', () => {
  const d = {format:'population-grid-v1',grid:{nx:2,ny:1,xEdges:[0,10,20],zEdges:[0,10]},cells:[[1,2.5,25000]]};
  const [f] = populationFeatures(d);
  assert.equal(f.population, 2.5);
  assert.equal(f.density, 25000);
  assert.deepEqual(f.ring, [[10,0],[20,0],[20,10],[10,10],[10,0]]);
  assert.throws(() => populationFeatures({...d,cells:[...d.cells,...d.cells]}), /Invalid population cell/);
});

test('map and legend use the same monotonic log scale and endpoint colours', () => {
  assert.equal(populationColor(0, 10000), POPULATION_RAMP[0]);
  assert.equal(populationColor(10000, 10000), POPULATION_RAMP.at(-1));
  assert.equal(populationColor(20000, 10000), POPULATION_RAMP.at(-1));
  assert.ok(populationPosition(10, 10000) < populationPosition(100, 10000));
  assert.ok(Math.abs(populationPosition(Math.sqrt(10001) - 1, 10000) - 0.5) < 1e-12);
});

test('shipped WorldPop grid conserves its clipped count and stays inside the scene', () => {
  const d = JSON.parse(readFileSync(new URL('../data/layers/population_worldpop_2021.json', import.meta.url)));
  const m = JSON.parse(readFileSync(new URL('../data3d/meta.json', import.meta.url)));
  const features = populationFeatures(d);
  assert.equal(d.year, 2021);
  assert.equal(features.length, d.stats.positiveCells);
  assert.ok(Math.abs(features.reduce((s, f) => s + f.population, 0) - d.stats.populationWithinBounds) < 0.001);
  assert.ok(d.stats.maxDensity <= d.display.legendMax);
  for (const f of features) for (const [x,z] of f.ring) {
    assert.ok(Math.abs(x) <= m.extent.width / 2 + 0.01);
    assert.ok(Math.abs(z) <= m.extent.height / 2 + 0.01);
  }
});
