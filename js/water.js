/**
 * js/water.js — Kempsey 3D Flood Viewer, flood-water ShaderMaterial  (SPEC §4)
 *
 * The water is drawn as one displaced grid over the whole 39.2 x 36.4 km extent, on
 * layer 1, AFTER the terrain has been blitted to the canvas.  It has no depth buffer of
 * its own, so it does its own depth test against `tSceneDepth`, and it composites itself
 * manually against `tSceneColor` (linear HDR) — hence the tonemapping/colorspace
 * includes at the very end of the fragment shader.
 *
 * Physical model, in one paragraph:
 *   The surface is a flat plane at elevation `wsE` carrying a small-amplitude wind-wave
 *   field.  We shade it as a dielectric interface: Schlick fresnel (F0 = 0.02) splits the
 *   radiance into a reflected part (prefiltered sky = envMap, or a procedural dome) and a
 *   transmitted part.  The transmitted part is the screen-space refraction of whatever
 *   the terrain pass drew under the water, attenuated by Beer-Lambert over the slant path
 *   through the column, plus the saturating single-scatter radiance of the suspended
 *   sediment (the "body colour").  A flood on a coastal floodplain is turbid, so the
 *   column goes opaque within ~4 m; the ocean is a separate regime with a longer swell,
 *   a deeper body colour and a stronger glint.
 *
 * Exports:  createWaterGeometry(nx, ny, EW, EH)
 *           createWaterMaterial(opts)
 *           updateWaterTime(mat, t)
 */

import * as THREE from 'three';

/* Dataset extent (data/meta.json). Used only as defaults. */
const DEFAULT_EW = 39230.0;
const DEFAULT_EH = 36414.1748046875;

/* ------------------------------------------------------------------------------------
 * Geometry
 * ---------------------------------------------------------------------------------- */

/**
 * A regular XZ grid covering the full extent, y = 0 (the vertex shader lifts it).
 * UV follows SPEC §1:  u = (x + EW/2)/EW,  v = (z + EH/2)/EH   (so v = 0 is NORTH).
 *
 * @param {number} nx  vertices along X (east)   default 768
 * @param {number} ny  vertices along Z (south)  default 713
 * @param {number} EW  extent width  in metres
 * @param {number} EH  extent height in metres
 * @returns {THREE.BufferGeometry}
 */
export function createWaterGeometry(nx = 768, ny = 713, EW = DEFAULT_EW, EH = DEFAULT_EH) {
  const gx = Math.max(2, Math.floor(nx) | 0);
  const gy = Math.max(2, Math.floor(ny) | 0);
  const count = gx * gy;

  const positions = new Float32Array(count * 3);
  const uvs = new Float32Array(count * 2);

  for (let j = 0; j < gy; j++) {
    const v = j / (gy - 1);
    const z = (v - 0.5) * EH;           // v = 0 -> z = -EH/2 (north)
    for (let i = 0; i < gx; i++) {
      const u = i / (gx - 1);
      const x = (u - 0.5) * EW;         // u = 0 -> x = -EW/2 (west)
      const k = j * gx + i;
      positions[k * 3] = x;
      positions[k * 3 + 1] = 0.0;
      positions[k * 3 + 2] = z;
      uvs[k * 2] = u;
      uvs[k * 2 + 1] = v;
    }
  }

  // 768*713 vertices > 65535, so 32-bit indices (always available on WebGL2).
  const quads = (gx - 1) * (gy - 1);
  const index = new Uint32Array(quads * 6);
  let p = 0;
  for (let j = 0; j < gy - 1; j++) {
    for (let i = 0; i < gx - 1; i++) {
      const a = j * gx + i;
      const b = a + 1;
      const c = a + gx;
      const d = c + 1;
      // (a, c, b) winds counter-clockwise seen from +Y, i.e. the front face points up.
      index[p++] = a; index[p++] = c; index[p++] = b;
      index[p++] = b; index[p++] = c; index[p++] = d;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(new THREE.BufferAttribute(index, 1));

  // The vertex shader moves y by (W + offset) * vertExag, which the CPU-side bounds know
  // nothing about; give it a generous manual volume so it is never wrongly frustum-culled.
  const halfDiag = 0.5 * Math.sqrt(EW * EW + EH * EH);
  geo.boundingBox = new THREE.Box3(
    new THREE.Vector3(-EW / 2, -4000, -EH / 2),
    new THREE.Vector3(EW / 2, 4000, EH / 2)
  );
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), halfDiag + 4000);
  geo.userData.gridSize = { nx: gx, ny: gy };
  return geo;
}

/* ------------------------------------------------------------------------------------
 * Shaders
 * ---------------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------------------
 * The long-wave (swell) field.  Shared VERBATIM between the two stages: the vertex stage
 * DISPLACES the sheet by it, the fragment stage folds its SLOPE into the shading normal.
 * Two copies would drift apart and you would see geometry that moves without shading, so
 * there is one source string injected into both programs.
 * ---------------------------------------------------------------------------------- */
const SWELL_GLSL = /* glsl */`
// Long waves, wavelengths from 310 m to 800 m offshore.  Deep-water gravity dispersion
// c = sqrt(g/k) keeps the three speeds mutually consistent: the 26 m wave crawls at
// 6.4 m/s, the 310 m ocean swell runs at 22 m/s (~14 s period).
//
// Three things make this read as an ocean rather than as a wobbling sheet:
//   * the components are pulled onto a common ONSHORE heading offshore — a swell that has
//     travelled is directionally narrow, i.e. long parallel crests all going one way;
//   * their wavelengths are mutually incommensurate, so they beat into wave GROUPS a few
//     hundred metres long, which is what real swell does;
//   * unlike the fragment ripple field, this one is NOT band-limited away with distance.
//     It is what keeps the far ocean alive when every short wave has been filtered out.
// Amplitude offshore is ~1 m of true water. Inland (sea = 0) nothing changes: |h| <= 0.10 m
// of wind chop on standing floodwater.
const vec2 SWELL_DIR = vec2(-0.966, 0.259);      // onshore, ~15 deg off due west

float swell(vec2 p, float t, float sea, out vec2 grad) {
  // 12x offshore puts the shortest component at ~310 m. That is not decoration: the
  // water mesh is 61 m per cell at medium quality, so the shortest offshore component still
  // receives roughly five samples per period instead of collapsing onto the triangulation.
  float ls = mix(1.0, 12.0, sea);
  float turn = sea * 0.45;                       // retain directional variation offshore
  vec2 d1 = normalize(mix(vec2( 0.94,  0.34), SWELL_DIR, turn));
  vec2 d2 = normalize(mix(vec2(-0.42,  0.91), SWELL_DIR, turn));
  vec2 d3 = normalize(mix(vec2( 0.62, -0.78), SWELL_DIR, turn));
  float k1 = 6.2831853 / (26.0 * ls);
  float k2 = 6.2831853 / (41.0 * ls);
  float k3 = 6.2831853 / (67.0 * ls);
  float a1 = 0.055, a2 = 0.045, a3 = sea * 0.060;
  float x1 = k1 * (dot(p, d1) - sqrt(9.81 / k1) * t);
  float x2 = k2 * (dot(p, d2) - sqrt(9.81 / k2) * t);
  float x3 = k3 * (dot(p, d3) - sqrt(9.81 / k3) * t);
  float a = mix(1.0, 6.0, sea);            // restrained ~0.6 m offshore swell
  grad = a * (a1 * k1 * cos(x1) * d1 + a2 * k2 * cos(x2) * d2 + a3 * k3 * cos(x3) * d3);
  return a * (a1 * sin(x1) + a2 * sin(x2) + a3 * sin(x3));
}
`;

const VERT = /* glsl */`
uniform sampler2D tWsurf;
uniform sampler2D tTerrain;
uniform sampler2D tFlags;
uniform sampler2D tSea;       // precomputed coastal blend: 0 flood, 1 open sea
uniform float uTime;
uniform float uWaterOffset;
uniform float uVertExag;
uniform float uWaveAmp;
uniform float uSeaLevel;

varying vec2  vUv;
varying vec3  vWorld;         // rendered world position (y is vertically exaggerated)
varying vec4  vClip;
varying vec3  vViewPos;

// tFlags is NearestFilter and holds a small integer (bit 1 wet, 2 sea, 4 outside).
// Tolerate a 0..1 normalised upload (RedFormat/UnsignedByte) as well as raw 0..7 floats.
float flagSea(vec2 uv) {
  float f = texture2D(tFlags, clamp(uv, vec2(0.0), vec2(1.0))).r;
  f = (f > 0.0 && f < 0.9) ? f * 255.0 : f;
  return mod(floor(floor(f + 0.5) / 2.0), 2.0);
}

` + SWELL_GLSL + /* glsl */`

void main() {
  vUv = uv;

  float W   = texture2D(tWsurf, uv).r;           // base water surface, m
  float G   = texture2D(tTerrain, uv).r;         // ground, m
  float sea = clamp(texture2D(tSea, uv).r, 0.0, 1.0);

  // The slider raises the FLOOD only.  The ocean stays pinned at uSeaLevel; between them
  // the surface elevation is blended by the same coastal factor the fragment uses, so the
  // geometry and the shading agree everywhere.
  float wsE   = mix(W + uWaterOffset, uSeaLevel, sea);
  // ...but a sea-flagged cell IS the permanent ocean, so the cross-fade must never drag it
  // below uSeaLevel.  Without this, a negative slider value pulls the coastal half of the
  // blend band down with the flood and strands ~500 m of "dry seabed" along the whole
  // coast.  The fragment stage applies the identical clamp so the two agree.
  if (flagSea(uv) > 0.5) wsE = max(wsE, uSeaLevel);
  float depth = max(wsE - G, 0.0);

  // Kill the swell as the sheet gets thin, otherwise the waterline visibly breathes.
  float fade = smoothstep(0.05, 0.90, depth) * clamp(uWaveAmp, 0.0, 2.0);
  vec2 sg;
  float y = (wsE + swell(position.xz, uTime, sea, sg) * fade) * uVertExag;

  vec4 wp = modelMatrix * vec4(position.x, y, position.z, 1.0);
  vWorld  = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vViewPos = mv.xyz;
  vClip = projectionMatrix * mv;
  gl_Position = vClip;
}
`;

/* `cube_uv_reflection_fragment` is what makes a PMREM (CubeUVReflectionMapping) texture
 * samplable with a roughness.  It is a three internal, so probe for it instead of
 * hard-failing: without it we simply fall back to the procedural dome below. */
const HAS_CUBE_UV = !!(THREE.ShaderChunk && THREE.ShaderChunk.cube_uv_reflection_fragment);

const FRAG = /* glsl */`
#include <common>
#include <packing>
` + (HAS_CUBE_UV ? '#include <cube_uv_reflection_fragment>\n' : '') + /* glsl */`
uniform sampler2D tTerrain;
uniform sampler2D tNeed;
uniform sampler2D tWsurf;
uniform sampler2D tFlags;
uniform sampler2D tSea;       // precomputed coastal blend: 0 flood, 1 open sea
uniform sampler2D tSceneColor;
uniform sampler2D tSceneDepth;
uniform vec2  uResolution;
uniform float uCameraNear;
uniform float uCameraFar;
uniform float uTime;
uniform float uWaterOffset;
uniform float uVertExag;
uniform float uWaveAmp;
uniform float uTurbidity;
uniform float uFoam;
uniform float uScience;
uniform float uRampMax;
uniform float uSeaLevel;
uniform float uRefract;
uniform float uEnvIntensity;
uniform float uHazeDensity;
uniform float uHoverStrength; // 0 = off, eases in/out as the pointer enters/leaves water
uniform sampler2D tHoverMask; // 1 inside the connected body under the pointer, 0 elsewhere
uniform vec2  uMaskTexel;     // 1/nx, 1/ny of tHoverMask - for the body-outline taps
uniform float uSaturation;
uniform float uContrast;
uniform float uLift;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uAbsorb;        // per-metre extinction at uTurbidity = 1
uniform vec3  uHazeColor;

#ifdef USE_ENVMAP
  #ifdef ENVMAP_TYPE_CUBE
    uniform samplerCube envMap;
  #else
    uniform sampler2D envMap;   // PMREM (CubeUVReflectionMapping)
  #endif
#endif

varying vec2  vUv;
varying vec3  vWorld;
varying vec4  vClip;
varying vec3  vViewPos;

/* --- palette (linear-light albedos, they get multiplied by the scene lighting) ------
 * A Macleay flood really is sediment- and CDOM-rich, i.e. brown. But the bed under it is
 * *also* brown Sentinel-2 floodwater, so a physically faithful body colour made the water
 * disappear into its own bed. These values keep the warm sediment cast in the shallows and
 * turn firmly blue with depth: the extent stays legible at a glance, which is the whole
 * point of the map. Science mode is unaffected — it bypasses this palette entirely.      */
const vec3 BODY_SHALLOW = vec3(0.115, 0.140, 0.150);
const vec3 BODY_DEEP    = vec3(0.014, 0.052, 0.105);
const vec3 BODY_SEA     = vec3(0.086, 0.196, 0.258);   // clear coastal water, not ink
const vec3 FOAM_ALBEDO  = vec3(0.88, 0.90, 0.92);
const vec3 SILT_RIM     = vec3(0.46, 0.44, 0.34);   // wet-sand / silt line at the edge
const vec3 EDGE_TINT    = vec3(0.020, 0.085, 0.150);   // crisp darker-blue waterline

/* ---------- small utilities ------------------------------------------------------- */

float flagsAt(vec2 uv) {
  float f = texture2D(tFlags, uv).r;
  f = (f > 0.0 && f < 0.9) ? f * 255.0 : f;   // tolerate a normalised flags texture
  return floor(f + 0.5);
}
float bitOf(float f, float b) { return mod(floor(f / b), 2.0); }


// Hash without sin(): stays well-conditioned for lattice coordinates in the +-20000 range.
float hash21(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash21(i), b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0)), d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
float fbm2(vec2 p) { return 0.62 * vnoise(p) + 0.38 * vnoise(p * 2.17 + 11.3); }

/* ---------- sky ------------------------------------------------------------------- */

// Fallback dome, used when no PMREM env map has been handed over yet.  Values are linear
// HDR on the same scale as the Sky addon (bright horizon band, Mie forward glow, disc).
vec3 skyDome(vec3 d) {
  float up = max(d.y, 0.0);
  vec3 col = mix(vec3(0.72, 0.80, 0.95), vec3(0.16, 0.33, 0.78), pow(up, 0.65)) * 1.9;
  float mu = max(dot(d, uSunDir), 0.0);
  col += uSunColor * (0.30 * pow(mu, 8.0) + 0.07 * pow(mu, 2.0));
  col += uSunColor * 55.0 * smoothstep(0.99985, 0.99995, mu);   // 0.53 deg solar disc
  col *= mix(0.35, 1.0, smoothstep(-0.06, 0.02, d.y));
  return col;
}

vec3 sampleEnv(vec3 d, float rough) {
#if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV ) && defined( WATER_CUBEUV )
  return textureCubeUV(envMap, d, rough).rgb;
#elif defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE )
  return textureCube(envMap, d, rough * 6.0).rgb;
#else
  return skyDome(d);
#endif
}

` + SWELL_GLSL + /* glsl */`

/* ---------- ripple field ---------------------------------------------------------- */

// One directional wind wave with a sharpened crest, w = exp(sin(x) - 1): flat troughs,
// narrow crests, much closer to a real short-gravity wave than a plain sine.  We return
// its ANALYTIC gradient (dh/dx, dh/dz), so the normal below is a true surface normal.
// px is the world size of one pixel; a band whose wavelength drops under ~3 samples per
// period is faded out (Nyquist) and its lost slope variance is handed to lost, which
// becomes microfacet roughness — the standard variance-to-roughness trade that keeps the
// far plain a smooth mirror instead of a field of aliased sparkles.
vec2 waveGrad(vec2 p, vec2 dir, float L, float A, float t, float px, float sea, inout float lost) {
  float k = 6.2831853 / L;
  // Deep-water dispersion, c = sqrt(g/k).  Inland this is a damped wind chop on standing
  // floodwater; offshore let it run at the true celerity so the swell visibly travels
  // (L = 720 m gives c = 33 m/s, T = 21 s, which is a real long-period Tasman swell).
  float c = sqrt(9.81 / k) * mix(0.5, 1.0, sea);
  // Nyquist.  A wave sampled at one pixel per L/4 is already aliasing, and a SPECULAR
  // signal aliases far worse than a diffuse one: the sun glitter beats against the wave
  // period and the ocean comes out as woven cloth (visible at every grazing angle). Fade
  // each band out between ~12 and ~4 pixels per wavelength and hand the slope variance it
  // carried to lost, which becomes microfacet roughness a few lines below.
  float band = 1.0 - smoothstep(0.08 * L, 0.25 * L, px);
  float x = k * (dot(p, dir) - c * t);
  float w = exp(sin(x) - 1.0);
  float s = A * k;                                   // peak slope of this band
  lost += (1.0 - band) * s * s * 0.5;
  return dir * (s * cos(x) * w * band);
}

// 6 bands.  Flood: 2.2 / 4 / 6.5 / 14 / 22 / 45 m wavelengths in WORLD metres, peak slopes
// ~0.02-0.03 each => a few degrees total, which is what 30 cm of water over a paddock
// actually looks like. The sea lengthens wavelengths and modestly raises their amplitude,
// a broader offshore spectrum without the former high-contrast parallel stripe pattern.
// Offshore the six directions are pulled toward a single onshore heading. A wind sea is
// short-crested and can come from anywhere; a SWELL has travelled far enough that only a
// narrow directional band survives, and that is what makes an ocean read as an ocean —
// long parallel crests marching one way, not an isotropic cross-sea. The Tasman swell here
// runs onshore, i.e. westward, so the six headings collapse to a +-20 deg fan around it as
// sea goes 0 -> 1. Inland (sea = 0) the original scattered directions are untouched: wind
// chop on standing floodwater genuinely has no preferred direction.  SWELL_DIR itself comes
// from SWELL_GLSL above, so the ripples and the long swell agree on which way the sea runs.
vec2 swellward(vec2 dir, float sea) {
  return normalize(mix(dir, SWELL_DIR, sea * 0.35) + vec2(1e-4, 0.0));
}

vec2 rippleGrad(vec2 p, float t, float px, float sea, float amp, out float lost) {
  lost = 0.0;
  float ls = mix(1.0, 10.0, sea);
  // Six fixed-direction waves summed at equal strength interfere into a regular lattice —
  // it reads as woven cloth, not water. Real swell arrives in GROUPS, so modulate the
  // amplitude by a slow, drifting envelope (~1.3 km, well above every wavelength here).
  // Its gradient is ignored: dA/dx is three orders below dsin/dx at these scales.
  float env = mix(1.0,
        0.40 + 0.85 * fbm2(p * 0.00075 + vec2(t * 0.0015, -t * 0.0011))
             + 0.35 * fbm2(p * 0.0031 + vec2(-t * 0.010, t * 0.008)), sea);
  float as = mix(1.0, 4.0, sea) * amp * env;
  vec2 g = vec2(0.0);
  g += waveGrad(p, swellward(vec2( 0.951,  0.309), sea),  2.2 * ls, 0.0080 * as, t, px, sea, lost);
  g += waveGrad(p, swellward(vec2(-0.588,  0.809), sea),  4.0 * ls, 0.0200 * as, t, px, sea, lost);
  g += waveGrad(p, swellward(vec2( 0.669, -0.743), sea),  6.5 * ls, 0.0280 * as, t, px, sea, lost);
  g += waveGrad(p, swellward(vec2( 0.276,  0.961), sea), 14.0 * ls, 0.0550 * as, t, px, sea, lost);
  g += waveGrad(p, swellward(vec2(-0.940, -0.342), sea), 22.0 * ls, 0.0700 * as, t, px, sea, lost);
  g += waveGrad(p, swellward(vec2( 0.996,  0.087), sea), 45.0 * ls, 0.1600 * as, t, px, sea, lost);
  return g;
}

/* ---------- matplotlib / ColorBrewer "Blues", 9 classes (science mode) ------------- */
vec3 bluesRamp(float t) {
  vec3 B[9];
  B[0] = vec3(0.96863, 0.98431, 1.00000);   // #f7fbff
  B[1] = vec3(0.87059, 0.92157, 0.96863);   // #deebf7
  B[2] = vec3(0.77647, 0.85882, 0.93725);   // #c6dbef
  B[3] = vec3(0.61961, 0.79216, 0.88235);   // #9ecae1
  B[4] = vec3(0.41961, 0.68235, 0.83922);   // #6baed6
  B[5] = vec3(0.25882, 0.57255, 0.77647);   // #4292c6
  B[6] = vec3(0.12941, 0.44314, 0.70980);   // #2171b5
  B[7] = vec3(0.03137, 0.31765, 0.61176);   // #08519c
  B[8] = vec3(0.03137, 0.18824, 0.41961);   // #08306b
  float x = clamp(t, 0.0, 1.0) * 8.0;
  float i = min(floor(x), 7.0);
  return mix(B[int(i)], B[int(i) + 1], x - i);   // matplotlib interpolates in sRGB
}
vec3 srgbToLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(vec3(0.04045), c));
}

/* =================================================================================== */

void main() {
  /* --- 1. data lookups, wet test ------------------------------------------------- */
  float fl = flagsAt(vUv);
  float isSea = bitOf(fl, 2.0);

  float G    = texture2D(tTerrain, vUv).r;            // ground elevation, m
  float need = texture2D(tNeed, vUv).r;               // connectivity fill level, m
  float W    = texture2D(tWsurf, vUv).r;              // base water surface, m
  // One tap. data.js precomputes this field: blurring the binary sea flag in the shader
  // cost nine taps per stage, quantised to ninths (speckle along the beach) and, when
  // taken per vertex, followed the water-mesh triangulation as a zigzag surf line.
  float sea  = clamp(texture2D(tSea, vUv).r, 0.0, 1.0);

  float wsE   = mix(W + uWaterOffset, uSeaLevel, sea);
  wsE = (isSea > 0.5) ? max(wsE, uSeaLevel) : wsE;    // ocean is pinned, see vertex stage

  // Water column. tWsurf is a deliberately coarse 384x357 raster (a water surface is
  // smooth, so storing it fine is wasted bytes) while tNeed is full resolution and, on
  // every cell the published run mapped as wet, holds exactly -depth. wsE - G alone
  // therefore loses the shallowest fringe: ~7 km2, 3.8% of the published extent, went dry
  // purely to the resampling. Taking the max with (offset - need) restores it. The bound is
  // safe in both directions: need >= G - W_full everywhere by construction, so this can
  // never claim more water than the full-resolution surface would, and it leaves the
  // coastal wsE cross-fade untouched.
  float depth = wsE - G;
  if (isSea < 0.5) {
    // On a cell the published run mapped as wet (flag bit 1), need holds exactly -depth, so
    // offset - need reproduces final_depth.tif to the bit at offset 0. Elsewhere fall back
    // to the coarse surface, floored by the same bound so the column can never go negative
    // where the wet test passed.
    depth = mix(max(depth, uWaterOffset - need), uWaterOffset - need, bitOf(fl, 1.0));
  }

  // Every screen-space derivative in this shader has to be taken HERE, before the first
  // discard: once part of a 2x2 quad is discarded the helper invocations may stop and
  // fwidth() on the survivors is undefined (GLSL ES 3.0 s8.14, derivatives in non-uniform
  // control flow).  Both quantities are pure functions of the interpolants above, so
  // hoisting them costs nothing.
  float px = max(fwidth(vWorld.x), fwidth(vWorld.z));  // world metres covered by one pixel
  float dw = fwidth(depth);                            // metres of depth across one pixel

  if (bitOf(fl, 4.0) > 0.5) discard;                  // outside the data footprint
  // Hydrological connectivity gates the flood; the ocean is wet by definition (its cells
  // may carry the "never floodable" sentinel in tNeed).
  bool baseline = abs(uWaterOffset) < 0.0005;
  bool publishedWet = bitOf(fl, 1.0) > 0.5;
  bool wet = (isSea > 0.5 || (baseline ? publishedWet : uWaterOffset >= need)) && depth > 0.0;
  if (!wet) discard;

  /* --- 2. manual depth test against the terrain pass ------------------------------ */
  vec2 sUV = vClip.xy / max(vClip.w, 1e-6) * 0.5 + 0.5;
  float waterVZ = vViewPos.z;                          // negative, metres
  float sceneVZ = perspectiveDepthToViewZ(texture2D(tSceneDepth, sUV).r, uCameraNear, uCameraFar);
  // Slack for the depth comparison.  One LSB of a 24-bit non-linear depth buffer is worth
  // dz = z^2 * (far-near) / (near*far*2^24) of view-space range, so the slack has to grow
  // as z^2, not linearly: a linear law that is safe at 40 km is ~500x too loose at 1 km and
  // lets the sheet climb over near-field banks.  12 LSB + a 25 cm floor.
  float lsb = waterVZ * waterVZ * (uCameraFar - uCameraNear)
            / (max(uCameraNear * uCameraFar, 1.0) * 16777216.0);
  // ...and a second, larger slack for TESSELLATION, which is not a precision problem at all.
  // The water sheet is a coarse regular grid whose height is linearly interpolated between
  // vertices; the terrain it is tested against is a separate, FINER mesh off the 1536x1426
  // DEM (43.8 m vs 25.5 m pitch at high, 87.6 vs 76.6 at low — finer at all three tiers).
  // Over rough ground the flat water quad cuts under the terrain's own interpolation, the
  // fragment is discarded, and the flood comes out perforated; the swell then moves the
  // sheet every frame so the holes crawl. Measured before this term existed: 6.2% of the
  // water body was being punched out. After: 0.08%.
  //
  // The bracket is an assumed vertical disagreement in TRUE metres (~0.25 m of relief across
  // one water cell on a floodplain, plus up to 1.1 m of swell), which the exaggeration then
  // scales into world units along with everything else. At the 8x default this is ~6.4 m
  // of view-space slack — i.e. water may composite over terrain up to about 0.8 m of REAL
  // elevation nearer the camera, not "a few centimetres". Measured cost of that at a grazing
  // view from a 307 m ridge: +0.6-0.8% extra water, all of it below the horizon line, none
  // punched through a ridge into the sky.
  //
  // It cannot invent water on dry ground in any case — the wet test above is per-fragment
  // against this fragment's own need/flags texels, so only occlusion is at stake here, never
  // membership. The cap keeps the 30x end of the exaggeration slider from turning 0.8 m of
  // tolerated error into 2.9 m.
  float geo = min(uVertExag * (0.25 + 0.55 * clamp(uWaveAmp, 0.0, 2.0)), 18.0);
  float tol = max(0.25, 12.0 * lsb) + geo;
  if (sceneVZ > waterVZ + tol) discard;                // terrain is in front of the water

  /* --- 3. procedural ripple normal ------------------------------------------------ */
  // Ripples need a water column to exist in: 8 cm over a road is a mirror, the 6 m channel
  // is alive.  (Also physically true - shallow water damps short gravity waves fast.)
  float amp = max(smoothstep(0.0, 1.2, depth), sea * 0.9) * clamp(uWaveAmp, 0.0, 2.0);
  float lost;
  vec2 grad = rippleGrad(vWorld.xz, uTime, px, sea, amp, lost);
  // Fold in the slope of the long swell the VERTEX stage displaced the sheet by. Without
  // this the geometry moves but the shading does not, so the far ocean — where every short
  // band has been filtered out by the Nyquist fade above — goes glassy and dead. It is
  // multiplied by uVertExag because that displacement IS exaggerated: this is the true
  // normal of the surface actually being drawn. Offshore only (sea): inland the 26 m
  // component is shorter than one water-mesh cell, so the vertex sheet there is aliased and
  // matching its nominal slope would be matching something that is not on screen.
  vec2 sgrad;
  swell(vWorld.xz, uTime, sea, sgrad);
  grad += sgrad * (smoothstep(0.05, 0.90, depth) * clamp(uWaveAmp, 0.0, 2.0))
                * uVertExag * sea;

  vec3 N = normalize(vec3(-grad.x, 1.0, -grad.y));
  // Offshore the surface carries far more sub-pixel structure than the six resolved
  // bands admit, so give the sea a roughness floor as well: it widens the sun lobe into
  // a glitter path instead of a field of individually aliasing highlights.
  float rough = clamp(sqrt(max(lost, 0.0)) * 1.4 + 0.02 + sea * 0.045, 0.02, 0.55);

  vec3 V = normalize(cameraPosition - vWorld);
  if (dot(N, V) < 0.0) N = -N;                         // camera under the surface (DoubleSide)
  float ndv = clamp(dot(N, V), 1e-3, 1.0);

  /* --- 4. screen-space refraction ------------------------------------------------- */
  // Snell bends the ray toward the normal, so the bottom appears displaced by roughly
  // (n-1) * columnThickness * slope.  The column is drawn uVertExag times thicker than it
  // is, and a metre on the bottom shrinks with range, hence the 1/(-viewZ).  Direction:
  // N.xz rotated into view space, which is the screen basis (world N.xz alone is only
  // right for a top-down camera).
  vec2 dirScreen = (viewMatrix * vec4(N.x, 0.0, N.z, 0.0)).xy;
  float thick = clamp(depth * uVertExag, 0.0, 9.0);
  vec2 offPx = dirScreen * uRefract * thick * 0.35 * uResolution.y / max(-waterVZ, 1.0);
  vec2 rUV = clamp(sUV + offPx / max(uResolution, vec2(1.0)), vec2(0.0), vec2(1.0));
  // Back-projection guard: if the offset lands on something IN FRONT of the water we would
  // smear a riverbank across the river, so fall back to the unoffset sample.
  float rVZ = perspectiveDepthToViewZ(texture2D(tSceneDepth, rUV).r, uCameraNear, uCameraFar);
  if (rVZ > waterVZ + tol) rUV = sUV;
  vec3 bottom = texture2D(tSceneColor, rUV).rgb;

  /* --- 5. Beer-Lambert extinction + sediment body colour -------------------------- */
  // Slant path: inside the water the refracted ray never exceeds 48.6 deg from vertical
  // (Snell, n = 1.333), so 1/cos is bounded by ~1.51 - grazing views see a longer column
  // and therefore darker, more opaque water, which is exactly what a flooded plain does.
  float cosT = sqrt(max(1.0 - (1.0 - ndv * ndv) / 1.7769, 0.0));
  float path = depth / max(cosT, 0.35);
  // Offshore the seabed is a synthetic fill and should not show; inshore a bit of sand
  // through the shallows is what stops the coast reading as a black band. Ramp the floor
  // in with distance from the shoreline rather than clamping it everywhere.
  float absDepth = mix(path, max(path, 1.6), sea);
  // Coastal sea water is far clearer than a sediment-laden flood, so the ocean gets a much
  // lower extinction — but ONLY in the shallows. There is no bathymetry in this dataset:
  // offshore the "seabed" is a flat -6 m synthetic fill and the basemap over it is a dark
  // push-pull inpaint, so any transmission out there just multiplies a black texture into
  // the water and is exactly what made the sea read as ink. Granting the clarity in the
  // shallows and withdrawing it again over the first 5 m of column gives both halves of
  // what we want: sand and surf visible through the near-shore water, and a deep ocean
  // whose colour is its own body radiance rather than a fill nobody measured.
  float clarity = sea * (1.0 - smoothstep(1.0, 5.0, depth));
  vec3 absorbHere = uAbsorb * mix(1.0, 0.16, clarity);
  vec3 T = exp(-absorbHere * max(uTurbidity, 0.0) * absDepth);

  vec3 amb = sampleEnv(vec3(0.0, 1.0, 0.0), 1.0) * uEnvIntensity;   // sky irradiance
  vec3 lit = amb * 0.55 + uSunColor * max(uSunDir.y, 0.0) * 0.55;
  vec3 body = mix(BODY_SHALLOW, BODY_DEEP, smoothstep(0.10, 1.8, depth));
  body = mix(body, BODY_SEA, sea) * lit;
  vec3 col = bottom * T + body * (1.0 - T);            // saturating single scatter

  /* --- 6. shoreline foam + silt rim ----------------------------------------------- */
  vec2 drift = vec2(uTime * 0.06, uTime * -0.043);
  float n = fbm2(vWorld.xz * 0.33 + drift);            // ~3 m cells, drifting slowly
  n = mix(n, 0.5, smoothstep(1.0, 4.0, px));           // band-limit: no crawling sparkle
  // Shoreline width in SCREEN space, not in metres. On a floodplain this flat a fixed
  // 0.2 m depth threshold paints white over square kilometres; scaling the band by
  // fwidth(depth) keeps the foam a constant few pixels wide wherever the waterline is.
  float wFoam = clamp(4.0 * dw, 0.03, 0.50);
  float wRim  = clamp(1.6 * dw, 0.015, 0.20);
  // A third, wider band that is pure colour rather than foam: it darkens and saturates the
  // last metre or so before the waterline, which is what actually draws the outline of the
  // flood at map scale. Foam alone is too fine to survive at 39 km.
  float wEdge = clamp(12.0 * dw, 0.06, 0.90);
  // Where the bank is steep or the view grazing the clamps bite and the band goes thinner
  // than one pixel; a hard 0/1 rim then crawls along the coast as the camera moves. Fade
  // by the fraction of the pixel the band actually covers - proper prefiltering, and a
  // no-op (>=1) whenever the band is resolved.
  float cov = min(1.0, wFoam / max(dw, 1e-5));
  float covR = min(1.0, wRim / max(dw, 1e-5));
  float edge = 1.0 - smoothstep(0.0, wEdge, depth);
  col = mix(col, EDGE_TINT * lit, edge * edge * edge * 0.50 * min(1.0, wEdge / max(dw, 1e-5)));
  float shore = 1.0 - smoothstep(0.0, wFoam, depth);
  float foam = clamp(smoothstep(0.42, 0.86, n * 0.65 + shore * 0.55) * shore, 0.0, 1.0)
             * clamp(uFoam, 0.0, 1.0) * cov;
  float rim = (1.0 - smoothstep(0.0, wRim, depth)) * (0.55 + 0.45 * n)
             * clamp(uFoam, 0.0, 1.0) * covR;
  col = mix(col, FOAM_ALBEDO * lit, foam * 0.55);
  col = mix(col, (SILT_RIM + FOAM_ALBEDO * 0.35) * lit, rim * 0.40);
  float wash = clamp(foam * 0.85 + rim * 0.5, 0.0, 1.0);   // foam is diffuse: no mirror

  /* --- 6a2. surf and whitecaps (ocean only) ----------------------------------------
   * There is no bathymetry here — the pipeline sets the sea bed to a flat -6 m — so the
   * shoaling coordinate is sea, the smooth 0..1 coastal blend, which runs from 0 at the
   * waterline to 1 a few hundred metres out. Crest lines therefore follow the coast, and
   * driving the phase negatively in time marches them shoreward, which is what refraction
   * over a real shelf produces anyway. Offshore, whitecaps key off the actual steepness of
   * the wave field: |grad| is already the surface slope, so the caps appear on the crests
   * that are genuinely steep and move with them rather than being a scrolling texture.  */
  if (sea > 0.02) {
    float surfZone = sea * (1.0 - smoothstep(0.55, 1.0, sea));      // the breaker band
    // Wobble the phase with a ~600 m noise so the breaker lines bow and bend along the
    // beach instead of running as perfect coast-parallel stripes.
    float sp = sea * 11.0 - uTime * 0.85 + fbm2(vWorld.xz * 0.0017) * 2.6;
    float band = smoothstep(0.30, 0.92, sin(sp) * 0.5 + 0.5);
    float back = smoothstep(0.55, 0.98, sin(sp * 0.5 + 1.7) * 0.5 + 0.5) * 0.55;
    float surf = (band + back) * surfZone * (0.55 + 0.45 * n) * clamp(uFoam, 0.0, 1.0);
    col = mix(col, FOAM_ALBEDO * lit, clamp(surf, 0.0, 1.0) * 0.72);

    float steep = clamp(length(grad) * 2.6, 0.0, 1.5);
    float caps = smoothstep(0.55, 1.30, steep) * sea * (0.35 + 0.65 * n)
               * clamp(uFoam, 0.0, 1.0);
    col = mix(col, FOAM_ALBEDO * lit, clamp(caps, 0.0, 1.0) * 0.52);
  }

  /* --- 6b. hover highlight --------------------------------------------------------
   * Hovering lights up only the connected body the pointer is in — one of HOTA's 247 pools
   * at Δ = 0, or whatever they have merged into at a higher water level — the way hovering
   * a feature highlights it in a GIS. main.js flood-fills that body and hands it over as a
   * mask; nothing here decides membership. The waterline does the visual work:
   * a bright rim traced along the whole boundary is what makes the extent readable at a
   * glance, far more than tinting the interior would. The interior only gets a small lift,
   * which also keeps the two bodies separable where they meet at the coast.          */
  float hm = texture2D(tHoverMask, vUv).r;
  float hl = uHoverStrength * hm;
  // Gated on the OUTLINE as well as the interior. Gating on hl alone meant the block only
  // ran where the centre texel was already inside the body, so the outer half of the mask's
  // linear ramp never drew and the outline sat wholly inside the water rather than on it.
  float he = 0.0;
  if (uHoverStrength > 0.001) {
    he = max(
      abs(texture2D(tHoverMask, vUv + vec2(uMaskTexel.x, 0.0)).r
        - texture2D(tHoverMask, vUv - vec2(uMaskTexel.x, 0.0)).r),
      abs(texture2D(tHoverMask, vUv + vec2(0.0, uMaskTexel.y)).r
        - texture2D(tHoverMask, vUv - vec2(0.0, uMaskTexel.y)).r));
  }
  if (hl > 0.001 || he > 0.004) {
    col = mix(col, col * 1.20 + vec3(0.008, 0.026, 0.044) * lit, hl);
    // Outline the BODY, not the shoreline.
    //
    // This rim used to key off depth, as 1 - smoothstep(0, w, depth), on the assumption
    // that shallow water only occurs at the body's edge. On a floodplain this flat that is
    // badly wrong: the interior is littered with sub-metre patches where the column passes
    // through zero, so the rim drew a bright ring around every one of them and the body read
    // as a sheet full of holes.
    //
    // The mask itself is the correct source. It is 0 outside the hovered body and 255 inside,
    // sampled with LinearFilter, so it only varies across the boundary — and nowhere in the
    // interior, however shallow the water gets. Four explicit neighbour taps rather than
    // fwidth(hm): this is downstream of three discards, and GLSL ES 3.0 s8.14 leaves
    // derivatives undefined in a partly-retired quad — which is exactly the quad on every
    // waterline. (The taps are hoisted above this branch so the outline can gate it.)
    col += vec3(0.34, 0.68, 0.88) * lit * he * uHoverStrength * 1.15;
  }

  /* --- 7. fresnel + sky reflection ------------------------------------------------ */
  // Schlick, F0 = 0.02 (n = 1.333).  Capped at 0.85 so 39 km of grazing water reads as
  // water and not as chrome; this term is the single strongest realism cue in the scene.
  float F = mix(0.02, 0.85, pow(1.0 - ndv, 5.0)) * (1.0 - 0.75 * wash);
  vec3 R = reflect(-V, N);
  R.y = max(R.y, 0.015);                               // never sample under the horizon
  vec3 refl = sampleEnv(normalize(R), rough) * uEnvIntensity;
  col = mix(col, refl, F);

  /* --- 8. sun specular ------------------------------------------------------------ */
  // Blinn-Phong whose exponent follows the filtered roughness, so the glitter broadens
  // with distance instead of aliasing.  Modulated by F: at nadir only 2% reflects.
  float shin = clamp(2.0 / max(rough * rough, 1e-4) - 2.0, 48.0, 900.0);
  float spec = pow(max(dot(N, normalize(uSunDir + V)), 0.0), shin)
             * (shin + 8.0) / (8.0 * PI) * 0.25
             * smoothstep(-0.02, 0.08, uSunDir.y) * mix(1.0, 1.8, sea);
  col += uSunColor * spec * F * (1.0 - wash * 0.8);

  /* --- 9. science mode: HOTA "Blues" depth ramp ----------------------------------- */
  float sciMix = clamp(uScience, 0.0, 1.0);
  vec3 sciCol = vec3(0.0);
  if (sciMix > 0.001) {
    sciCol = srgbToLinear(bluesRamp(depth / max(uRampMax, 1e-3)));
    sciCol *= 0.94 + 0.12 * clamp(dot(N, normalize(uSunDir + vec3(0.0, 1.2, 0.0))), 0.0, 1.0);
    // A little glint keeps it reading as 3D, but it is now written straight to the frame
    // buffer with no tone curve to roll it off, so bound it: an unclamped spec peaks near
    // 9 and would blow a white hole through the middle of the depth ramp.
    sciCol += uSunColor * min(spec, 1.0) * 0.10;
    col = mix(col, sciCol, sciMix);                    // keeps haze / NaN guard consistent
  }

  /* --- 10. optional distance haze, guard, output ---------------------------------- */
  if (uHazeDensity > 0.0) {
    float h = 1.0 - exp(-uHazeDensity * (-waterVZ));
    col = mix(col, uHazeColor, clamp(h, 0.0, 1.0) * (1.0 - clamp(uScience, 0.0, 1.0)));
  }
  // NaN never survives a >= test; without this any bad division shows up as a black hole.
  if (!(col.r >= 0.0) || !(col.g >= 0.0) || !(col.b >= 0.0)) col = BODY_DEEP * 4.0;
  // sciCol bypasses the tone map below, so it has to be sanitised on its own.
  if (!(sciCol.r >= 0.0) || !(sciCol.g >= 0.0) || !(sciCol.b >= 0.0)) sciCol = vec3(0.0);

  // Antialias the waterline. The wet test is a hard discard, so at 25.5 m grid resolution a
  // one-texel river came out visibly stair-stepped. depth/dw is the sub-pixel coverage of
  // the water within this fragment, so blending the last pixel back toward the untouched
  // scene colour gives a clean edge for the cost of one lerp.
  float aaCov = clamp(depth / max(dw, 1e-5), 0.0, 1.0);
  col = mix(texture2D(tSceneColor, sUV).rgb, col, aaCov);

  gl_FragColor = vec4(max(col, vec3(0.0)), 1.0);       // compositing is manual: opaque

  #include <tonemapping_fragment>
  // The terrain reaches the canvas through main.js's blit, which grades after tone mapping.
  // The water pass draws straight to the canvas and never runs that shader, so without
  // repeating the grade here the two diverge and every shoreline carries a faint tonal seam.
  // Same constants, same position in the chain. Applied before the science paste, which must
  // stay ungraded to keep its published hex values.
  {
    vec3 g = gl_FragColor.rgb;
    float lum = dot(g, vec3(0.2126, 0.7152, 0.0722));
    g = mix(vec3(lum), g, uSaturation);
    gl_FragColor.rgb = clamp((g - 0.5) * uContrast + 0.5 + uLift * (1.0 - lum), 0.0, 1.0);
  }
  // Science mode has to land on the PUBLISHED ColorBrewer hex, and no tone curve (ACES,
  // AgX, ...) is invertible in general, so bypass it instead of trying to cancel it: paste
  // the raw linear ramp back over the tone-mapped photoreal pixel here, after the tone map
  // and before colorspace_fragment.  That leaves exactly one transform on it - the
  // linear->sRGB OETF, which is the space #f7fbff...#08306b are defined in - so the pixel
  // leaves the pipeline at the legend's colour to within a rounding step, at any exposure.
  gl_FragColor.rgb = mix(gl_FragColor.rgb, max(sciCol, vec3(0.0)), sciMix);
  #include <colorspace_fragment>
}
`;

/* ------------------------------------------------------------------------------------
 * Material
 * ---------------------------------------------------------------------------------- */

/**
 * @param {object} opts
 * @param {object} opts.textures  { tTerrain, tNeed, tWsurf, tFlags }
 * @param {object} opts.grid      { EW, EH, nx, ny }  nx/ny size the hover-mask texel
 * @param {THREE.Texture} [opts.envMap]  PMREM output from the Sky (CubeUVReflectionMapping)
 * @returns {THREE.ShaderMaterial}
 */
export function createWaterMaterial(opts = {}) {
  const tex = opts.textures || {};
  const grid = opts.grid || {};
  const EW = Number.isFinite(grid.EW) ? grid.EW : DEFAULT_EW;
  const EH = Number.isFinite(grid.EH) ? grid.EH : DEFAULT_EH;

  // Default sun: azimuth 135 deg (from north, clockwise), elevation 32 deg, in the
  // X = east / Z = south frame of SPEC §1.  main.js overwrites this every frame.
  const az = THREE.MathUtils.degToRad(135);
  const el = THREE.MathUtils.degToRad(32);
  const sun = new THREE.Vector3(
    Math.cos(el) * Math.sin(az),
    Math.sin(el),
    -Math.cos(el) * Math.cos(az)
  ).normalize();

  const uniforms = {
    // data
    tTerrain: { value: tex.tTerrain || null },
    tNeed: { value: tex.tNeed || null },
    tWsurf: { value: tex.tWsurf || null },
    tFlags: { value: tex.tFlags || null },
    tSea: { value: tex.tSea || null },
    // scene feedback (SPEC §3)
    tSceneColor: { value: null },
    tSceneDepth: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uCameraNear: { value: 1 },
    uCameraFar: { value: 100000 },
    // controls
    uTime: { value: 0 },
    uWaterOffset: { value: 0 },
    uVertExag: { value: 5 },
    uWaveAmp: { value: 1 },
    uTurbidity: { value: 1 },
    uFoam: { value: 1 },
    uScience: { value: 0 },
    uRampMax: { value: 2.5 },
    uSunDir: { value: sun },
    uSunColor: { value: new THREE.Color(1.95, 1.78, 1.55) },
    uSeaLevel: { value: 0.0 },
    envMap: { value: opts.envMap || null },
    // extras owned by this module (safe defaults, exposed for tuning)
    // Screen-space refraction strength.  uRefract ~= 0.8 is physically exact for n = 1.333;
    // at 39 km range that is a sub-pixel shift, so the default is ~5x for legibility.
    uRefract: { value: 4.0 },
    uEnvIntensity: { value: 0.5 },
    // Per-metre extinction at uTurbidity = 1. Ordered R > G > B, as in real water, but
    // steepened so the column closes up fast and the flood reads as water rather than as a
    // varnish over the bed. 0.3 m -> transmit (0.68, 0.79, 0.88), a blue-tinted veil that
    // still shows the submerged paddocks; 1.0 m -> (0.31, 0.49, 0.67); 2.5 m -> (0.05,
    // 0.17, 0.37), essentially opaque and clearly blue. The turbidity slider scales all
    // three, so 0.5 restores something close to the old translucency.
    uAbsorb: { value: new THREE.Vector3(1.18, 0.72, 0.42) },
    uHazeColor: { value: new THREE.Color(0.62, 0.70, 0.82) },
    uHazeDensity: { value: 0.0 }, // 0 = off; set it only if the terrain pass is fogged
    uHoverStrength: { value: 0.0 },
    tHoverMask: { value: null },
    // One texel of tHoverMask, for the body-outline taps in section 6b. Defaults to the
    // 1536x1426 data grid so the material is still correct if the caller omits nx/ny.
    uMaskTexel: {
      value: new THREE.Vector2(
        1 / (Number.isFinite(grid.nx) ? grid.nx : 1536),
        1 / (Number.isFinite(grid.ny) ? grid.ny : 1426)
      )
    },
    // Must mirror main.js's blit grade exactly, or terrain and water drift apart in tone.
    uSaturation: { value: 1.22 },
    uContrast: { value: 1.10 },
    uLift: { value: -0.012 }
  };

  const material = new THREE.ShaderMaterial({
    name: 'FloodWaterMaterial',
    defines: HAS_CUBE_UV ? { WATER_CUBEUV: 1 } : {},
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: false,   // SPEC §3 — blending stays off, the shader composites itself
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
    fog: false,
    toneMapped: true      // makes three inject TONE_MAPPING + the tonemapping_fragment body
  });

  // three derives USE_ENVMAP / ENVMAP_TYPE_CUBE_UV / CUBEUV_* from material.envMap, so the
  // property must be set as well as the uniform.  The Sky PMREM usually only exists after
  // the material is built, hence this helper.
  material.envMap = null;   // must exist as a real property, not undefined
  material.userData.setEnvMap = (t) => {
    material.uniforms.envMap.value = t || null;
    const had = !!material.envMap;
    material.envMap = t || null;
    if (had !== !!t) material.needsUpdate = true;   // recompile: the defines changed
  };
  if (opts.envMap) material.userData.setEnvMap(opts.envMap);

  return material;
}

/** Convenience; main.js may equivalently set mat.uniforms.uTime.value directly. */
export function updateWaterTime(mat, t) {
  if (mat && mat.uniforms && mat.uniforms.uTime) mat.uniforms.uTime.value = t;
}
