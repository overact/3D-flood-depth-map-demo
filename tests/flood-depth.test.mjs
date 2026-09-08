import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareFloodSample, floodDepthAtSample, queryFloodDepth } from '../js/flood-depth.js';

function fixture() {
  return {
    grid: { nx: 2, ny: 2, EW: 4, EH: 4 },
    meta: { wsurfGrid: { nx: 1, ny: 1 } },
    arrays: {
      terrain: new Float32Array([2, 2, -2, 2]),
      need: new Float32Array([-3, 1, 9, 9]),
      flags: new Float32Array([1, 0, 2, 4]),
      wsurf: new Float32Array([1]),
    },
  };
}

test('published depth survives coarse-surface loss and reconstructs a consistent elevation', () => {
  const q = queryFloodDepth(fixture(), -1, -1, 0);
  assert.equal(q.depth, 3); // coarse W - ground would incorrectly report dry
  assert.equal(q.waterSurface, 5);
  assert.equal(q.waterSurface - q.ground, q.depth);
  assert.equal(q.observed, true);
});

test('the same selected point rises, drains and refloods without resampling', () => {
  const sample = prepareFloodSample(fixture(), -1, -1);
  for (const [offset, depth] of [[0, 3], [1, 4], [-2, 1], [-3, 0], [-4, 0], [2, 5]]) {
    assert.equal(floodDepthAtSample(sample, offset), depth);
  }
  assert.equal(queryFloodDepth(fixture(), -1, -1, -3).waterSurface, null);
});

test('scenario-only cells obey connectivity and the depth lower bound', () => {
  const data = fixture();
  assert.equal(queryFloodDepth(data, 1, -1, 0).depth, 0);
  assert.equal(queryFloodDepth(data, 1, -1, 0.5).depth, 0);
  assert.equal(queryFloodDepth(data, 1, -1, 2).depth, 1);
  data.arrays.wsurf[0] = 5;
  assert.equal(queryFloodDepth(data, 1, -1, 0).depth, 0);
  assert.equal(queryFloodDepth(data, 1, -1, 1).depth, 4);
});

test('permanent sea stays at AHD zero regardless of flood offset', () => {
  for (const offset of [-3, 0, 5]) {
    const q = queryFloodDepth(fixture(), -1, 1, offset);
    assert.equal(q.depth, 2);
    assert.equal(q.waterSurface, 0);
    assert.equal(q.sea, true);
  }
});

test('outside and NoData remain distinct from a dry valid pixel', () => {
  const data = fixture();
  for (const [x, z] of [[1, 1], [-2.01, -1], [2.01, -1], [-1, -2.01], [NaN, 0]]) {
    assert.equal(queryFloodDepth(data, x, z, 0), null);
  }
  assert.equal(queryFloodDepth(data, 1, -1, 0).depth, 0);
  assert.equal(queryFloodDepth(data, -1, -1, NaN), null);
});

test('footprint edge sampling matches clamp-to-edge textures without expanding the footprint', () => {
  const data = fixture();
  assert.equal(queryFloodDepth(data, -2, -2, 0).depth, 3);
  assert.equal(queryFloodDepth(data, 2, -2, 0).depth, 0);
  assert.equal(queryFloodDepth(data, -2, 2, 0).depth, 2);
});
