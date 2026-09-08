import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t, { missingPopulation = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flood-context-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['tools', 'data3d', 'data/layers']) await mkdir(join(root, dir), { recursive: true });
  const source = new URL('../', import.meta.url);
  for (const file of ['tools/fetch_context_layers.mjs', 'data3d/meta.json', 'data/layers/manifest.json']) {
    await copyFile(new URL(file, source), join(root, file));
  }
  const population = '{"source":"WorldPop Global2 R2025A v1","cells":[[1,2,3]],"attribution":"WorldPop / CC BY 4.0"}';
  if (!missingPopulation) await writeFile(join(root, 'data/layers/population_worldpop_2021.json'), population);
  await writeFile(join(root, 'data/layers/buildings.json'), '{"source":"GlobalBuildingAtlas","features":[]}');
  // Run the real script in an isolated tree, without network or live data writes.
  await writeFile(join(root, 'mock-fetch.mjs'), `
    globalThis.fetch = async (url, options) => {
      if (${missingPopulation}) throw new Error('Unexpected network request');
      if (url !== 'https://overpass-api.de/api/interpreter' || options.method !== 'POST') {
        throw new Error('Unexpected source: ' + url);
      }
      return {ok:true, json:async()=>({osm3s:{timestamp_osm_base:'2026-09-08T00:00:00Z'},elements:[]})};
    };
  `);
  return { root, population, run: (...args) => spawnSync(process.execPath,
    ['--import', join(root, 'mock-fetch.mjs'), join(root, 'tools/fetch_context_layers.mjs'), ...args],
    { encoding: 'utf8' }) };
}

test('roads/water refresh preserves population bytes and all manifest provenance', async t => {
  const f = await fixture(t);
  const before = JSON.parse(await readFile(join(f.root, 'data/layers/manifest.json'), 'utf8'));
  const run = f.run();
  assert.equal(run.status, 0, run.stderr);
  const after = JSON.parse(await readFile(join(f.root, 'data/layers/manifest.json'), 'utf8'));
  assert.deepEqual(after.layers.population, before.layers.population);
  assert.equal(await readFile(join(f.root, 'data/layers/population_worldpop_2021.json'), 'utf8'), f.population);
  assert.equal(after.layers.roads.sourceDate, '2026-09-08T00:00:00Z');
  assert.ok(after.attribution.includes('WorldPop / CC BY 4.0'));
  assert.deepEqual((await readdir(join(f.root, 'data/layers'))).sort(),
    ['buildings.json', 'manifest.json', 'population_worldpop_2021.json', 'roads.json', 'water.json']);
});

test('missing population stops before network or writes instead of generating legacy data', async t => {
  const f = await fixture(t, { missingPopulation: true });
  const before = await readFile(join(f.root, 'data/layers/manifest.json'), 'utf8');
  const run = f.run();
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Active population snapshot is missing or invalid/);
  assert.doesNotMatch(run.stderr, /Unexpected network request/);
  assert.equal(await readFile(join(f.root, 'data/layers/manifest.json'), 'utf8'), before);
  assert.deepEqual((await readdir(join(f.root, 'data/layers'))).sort(), ['buildings.json', 'manifest.json']);
});

test('retired population option fails explicitly before modifying snapshots', async t => {
  const f = await fixture(t);
  const run = f.run('--refresh-sa1-population');
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Unsupported option: --refresh-sa1-population/);
  assert.match(run.stderr, /fetch_worldpop_population.py/);
});
