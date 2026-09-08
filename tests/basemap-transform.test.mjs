import test from 'node:test';
import assert from 'node:assert/strict';
import { projectedPosition, projectedDirection, cesiumFov, mercator } from '../js/basemap-transform.js';

test('local east/up/south maps to projected east/north/up without scaling the data', () => {
  assert.deepEqual(projectedPosition({x:10,y:3,z:20},{cx:1000,cy:2000}),[1010,1980,3]);
  assert.deepEqual(projectedDirection({x:1,y:2,z:3}),[1,-3,2]);
});
test('portrait and landscape retain the same vertical field of view', () => {
  const vertical = 46 * Math.PI / 180;
  assert.equal(cesiumFov(46,0.5), vertical);
  assert.ok(Math.abs(2*Math.atan(Math.tan(cesiumFov(46,2)/2)/2)-vertical)<1e-12);
});
test('Web Mercator coordinates use the same projection as the pinned flood rasters', () => {
  assert.ok(Math.abs(mercator(0,0)[1])<1e-8);
  assert.ok(Math.abs(mercator(180,0)[0]-20037508.342789244)<1e-8);
  const p=mercator(153,-31);
  assert.ok(p[0]>17000000 && p[1]<-3600000);
});
