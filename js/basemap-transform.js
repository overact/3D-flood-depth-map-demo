// The viewer uses local Web Mercator X-east/Y-up/Z-south. Cesium's flat-map
// camera uses projected X-east/Y-north/Z-up before its internal axis transform.
export const AUSTRALIA_BOUNDS = [110, -45, 155, -9];
export const WORLD_BOUNDS = [-180, -85.05112878, 180, 85.05112878];
export function projectedPosition(position, extent) {
  return [extent.cx + position.x, extent.cy - position.z, position.y];
}
export function projectedDirection(direction) {
  return [direction.x, -direction.z, direction.y];
}
export function cesiumFov(verticalDegrees, aspect) {
  const vertical = verticalDegrees * Math.PI / 180;
  return aspect > 1 ? 2 * Math.atan(Math.tan(vertical / 2) * aspect) : vertical;
}
export function mercator(lon, lat) {
  return [6378137 * lon * Math.PI / 180,
    6378137 * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))];
}
