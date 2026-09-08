/** One quantitative population ramp shared by the map and legend (sRGB). */
export const POPULATION_RAMP = ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'];

export function populationPosition(density, maxDensity) {
  return Math.min(1, Math.max(0, Math.log1p(Math.max(0, density)) / Math.log1p(Math.max(1, maxDensity))));
}

export function populationColor(density, maxDensity) {
  const t = populationPosition(density, maxDensity) * (POPULATION_RAMP.length - 1);
  const i = Math.min(POPULATION_RAMP.length - 2, Math.floor(t)), f = t - i;
  const a = POPULATION_RAMP[i], b = POPULATION_RAMP[i + 1];
  const channels = [1, 3, 5].map(k => Math.round(
    parseInt(a.slice(k, k + 2), 16) * (1 - f) + parseInt(b.slice(k, k + 2), 16) * f));
  return '#' + channels.map(v => v.toString(16).padStart(2, '0')).join('');
}
