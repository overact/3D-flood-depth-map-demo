# Kempsey 3D Flood Viewer — implementation contract

Zero-build, ESM + importmap, **three.js r185** from jsDelivr. Target: a single static folder
served over HTTP that works on GitHub Pages. No TypeScript, no bundler, no npm.

```
index.html          importmap + DOM shell
style.css           all page chrome
js/main.js          orchestration  (written by the integrator)
js/data.js          asset loading -> DataTextures + typed arrays (integrator)
js/terrain.js       terrain + sea geometry/material (integrator)
js/water.js         >>> AGENT A <<<  flood water ShaderMaterial
js/ui.js            >>> AGENT B <<<  all DOM/controls/panels
data/…              prebuilt assets (already generated, do not change)
```

## 0. Import style (every module)

```js
import * as THREE from 'three';
```
Addons: `import { Sky } from 'three/addons/objects/Sky.js';` etc.
Never import a second copy of three. Never use `dat.gui` (use `lil-gui` from `three/addons/libs/lil-gui.module.min.js`).

## 1. World space

* Right-handed, **Y up**, units = **metres**.
* Local origin at the dataset centre (EPSG:3857 `17023665.0, -3634079.5289436853`).
  Web-Mercator coordinates are ~1.7e7 and float32 ULP there is 2 m — nothing that large
  ever reaches a shader.
* `X` = east, `Z` = **south** (north is −Z).
* `X ∈ [-EW/2, +EW/2]`, `Z ∈ [-EH/2, +EH/2]`, `EW = 39230`, `EH = 36414.1748046875`.
* Height: `y = elevation_metres * vertExag`. `vertExag` is a live uniform/scale (default 5).
* **UV convention (all textures, including the basemap):** `u = (x + EW/2)/EW`,
  `v = (z + EH/2)/EH`. So **v = 0 is NORTH** (data row 0). The basemap texture is created
  with `flipY = false` so it obeys the same rule. Do not "fix" this.

## 2. Data available to shaders (all created in `js/data.js`)

| uniform | type | contents |
|---|---|---|
| `tTerrain` | `DataTexture` `RedFormat/FloatType`, 1536×1426, Linear filter, ClampToEdge | ground elevation, **metres**, NOT exaggerated |
| `tNeed`    | `DataTexture` `RedFormat/FloatType`, 1536×1426, Linear | connectivity fill level, metres. Cell is wet ⟺ `waterOffset >= need`. `+999` = never floodable |
| `tWsurf`   | `DataTexture` `RedFormat/FloatType`, 384×357, Linear | base water-surface elevation `W`, metres (smooth) |
| `tFlags`   | `DataTexture` `RedFormat/FloatType`, 1536×1426, **NearestFilter** | bit 1 = observed wet, bit 2 = sea, bit 4 = outside data footprint |
| `tSea`     | `DataTexture` `RedFormat/FloatType`, 768×713, Linear | precomputed coastal blend, 0 = flood regime, 1 = open ocean. Built in `data.js` by blurring flag bit 2 (two box passes, R = 5 cells ≈ 500 m). Replaces the old 9-tap in-shader blur, which quantised to ninths and speckled along the beach |
| `tBasemap` | sRGB `Texture`, 4096×3800 WebP | aerial/S2 basemap. Inundated pixels are a smooth fill, not imagery |

Derived quantities (compute in the shader, do not precompute):

```
float W      = texture2D(tWsurf , uv).r;          // base water surface, m
float G      = texture2D(tTerrain, uv).r;         // ground, m
float need   = texture2D(tNeed  , uv).r;          // m
float wsE    = W + uWaterOffset;                  // water-surface elevation, m
float depth  = wsE - G;                           // water column, m  (>0 where wet)
bool  wet    = (uWaterOffset >= need) && (depth > 0.0);
```

`uWaterOffset` (metres, GUI range −3 … +5, default 0) is the ONLY thing the water-level
slider changes. At `uWaterOffset == 0` the wet set reproduces the published HOTA
inundation exactly, and `depth` equals HOTA's `final_depth.tif` exactly.

## 3. Render architecture (implemented in `main.js`, relied on by `water.js`)

Two-pass, one geometry pass:

1. `camera.layers` — terrain + sea + sky on layer 0, water on **layer 1**.
2. Pass 1: render layer 0 into `sceneRT` (`HalfFloatType`, `samples: 0`) which has an
   attached `DepthTexture` (`DepthFormat`, `UnsignedIntType`, Nearest).
3. Pass 2: fullscreen blit of `sceneRT.texture` to the canvas.
4. Pass 3: `autoClear = false`, render layer 1 (water) on top.

The water material therefore receives:

```
uniform sampler2D tSceneColor;   // pass-1 colour  (already tone-mapped? NO — linear HDR)
uniform sampler2D tSceneDepth;   // pass-1 depth
uniform vec2  uResolution;       // drawing-buffer size in px
uniform float uCameraNear, uCameraFar;
```

Because the water pass has no populated depth buffer, **the water shader does its own
depth test** (`if (sceneViewZ > waterViewZ) discard;`). Water material is
`transparent: false`, `depthWrite: false`, `depthTest: false`, `side: THREE.DoubleSide`.
It composites manually against `tSceneColor`, so it must end with
`#include <tonemapping_fragment>` and `#include <colorspace_fragment>` — the blit quad
does the same for the terrain, so both paths tone-map identically.

## 4. `js/water.js` — AGENT A

Export exactly:

```js
export function createWaterMaterial(opts) -> THREE.ShaderMaterial
export function createWaterGeometry(nx, ny, EW, EH) -> THREE.BufferGeometry
```

`createWaterGeometry` builds a regular grid over the full extent, `position.y = 0`
(the vertex shader raises it), with a `uv` attribute following §1, and correct indices.
Default `nx, ny = 768, 713`.

`createWaterMaterial(opts)` where `opts = { textures: {tTerrain,tNeed,tWsurf,tFlags},
grid:{EW,EH}, envMap }`. It must own these uniforms (names exact — `main.js` and `ui.js`
drive them):

```
uTime            float   seconds
uWaterOffset     float   metres, −3…+5
uVertExag        float   1…20      (vertical exaggeration; y = elev * uVertExag)
uWaveAmp         float   0…2       ripple strength multiplier, default 1
uTurbidity       float   0.05…1.5  Beer–Lambert extinction scale, default 1
uFoam            float   0…1       shoreline foam strength, default 1
uScience         float   0 or 1    0 = photoreal, 1 = HOTA Blues depth ramp
uRampMax         float   2.5       depth (m) that maps to the top of the Blues ramp
uSunDir          vec3    normalised, world space
uSunColor        vec3
uSeaLevel        float   0.0       elevation of the permanent sea surface
tSceneColor, tSceneDepth, uResolution, uCameraNear, uCameraFar, envMap
```

### Vertex shader
* `y = (W + uWaterOffset) * uVertExag` sampled from `tWsurf` (vertex texture fetch is
  fine on WebGL2). Sea cells (`flag & 2`) use `uSeaLevel` instead of `W`.
* Add 2 shallow Gerstner-ish waves, **amplitude ≤ 0.12 m × uWaveAmp**, so the waterline
  does not visibly wobble. Fade wave amplitude to 0 as `depth → 0`.
* Pass to fragment: `vUv`, `vWorld` (world position), `vClip` (`gl_Position`).

### Fragment shader — required features, in this order
1. Sample `G`, `need`, `W`, `flags`. Compute `depth`, `wet`. `if (!wet) discard;`
   Also `discard` if `flags & 4` (outside footprint).
2. **Manual depth test** against `tSceneDepth` (`#include <packing>`,
   `perspectiveDepthToViewZ`). `discard` when terrain is in front.
3. **Ripple normal**: 3 scrolling normal-map-like octaves generated procedurally
   (no external texture files — this must work offline). Sum of derivative-of-noise or
   sin-based directional waves at ~4 m / ~14 m / ~45 m wavelengths, scrolled at
   different speeds and angles. **Modulate normal strength by `smoothstep(0.0, 1.2, depth)`**
   so 10 cm of water over a road is near-mirror-flat and the river channel is lively.
   In the sea region use a stronger, longer-wavelength swell.
4. **Screen-space refraction**: `screenUV = vClip.xy/vClip.w*0.5+0.5`, offset by
   `N.xz * uRefract / max(-waterViewZ, 1.0)`; **re-sample depth at the offset UV and fall
   back to the unoffset UV when the sample is in front of the water** (back-projection
   guard). Sample `tSceneColor`.
5. **Beer–Lambert**: `transmit = exp(-absorb * uTurbidity * depth)` with a per-channel
   `absorb` (red extinguishes fastest). Blend refracted colour toward a deep-water body
   colour by `1 - transmit`.
6. **Shoreline foam**: `foam = 1 - smoothstep(0.0, 0.35, depth)` (metres), broken up by
   procedural noise scrolling slowly, multiplied by `uFoam`. Also add a thin brighter
   wet-sand rim just inside the waterline.
7. **Fresnel + reflection**: Schlick, F0 = 0.02; reflect the view vector about `N` and
   sample `envMap` (a PMREM cube from the Sky). Never let fresnel exceed ~0.85 at
   grazing angles or the map reads as chrome.
8. **Sun specular**: Blinn-Phong-ish, sharp, modulated by fresnel.
9. **Science mode** (`uScience`): replace the *body* colour with the matplotlib **Blues**
   ramp evaluated at `clamp(depth/uRampMax, 0, 1)` — implement the 9 ColorBrewer anchors
   `#f7fbff #deebf7 #c6dbef #9ecae1 #6baed6 #4292c6 #2171b5 #08519c #08306b` and
   interpolate. Keep a *little* specular and ripple so it still reads as 3D, but the hue
   must be quantitatively faithful. Crossfade smoothly with `uScience`.
10. Alpha: opaque (`1.0`) — compositing is manual. End with the tonemapping + colorspace
    includes.

Also export `export function updateWaterTime(mat, t)` if you prefer, but `main.js` will
just set `mat.uniforms.uTime.value`.

**Constraints**: GLSL ES 3.0 via three's ShaderMaterial (so `texture2D`/`varying` still
work — three rewrites them). No external image assets. No `#extension` directives.
Keep the fragment shader under ~250 lines and comment the physical meaning of constants.

## 5. `js/ui.js` — AGENT B

Export exactly:

```js
export function createUI(opts) -> { setStats, setQuery, setStatus, gui, state }
```

`opts = { state, onChange, onAction, meta }`

`state` is a plain object owned by `main.js`; the UI mutates it in place and calls
`onChange(key, value)`:

```js
state = {
  waterOffset: 0,      // m, -3 … 5, step 0.05
  vertExag: 5,         // 1 … 20
  sunAzimuth: 135,     // deg
  sunElevation: 32,    // deg, 1 … 88
  waveAmp: 1,          // 0 … 2
  turbidity: 1,        // 0.05 … 1.5
  foam: 1,             // 0 … 1
  science: false,      // bool  -> uScience
  showWater: true,
  autoRotate: false,
  quality: 'high',     // 'high' | 'medium' | 'low'
}
onAction(name)  // 'screenshot' | 'flyTour' | 'resetView' | 'topView'
```

Returned helpers, called by `main.js`:
* `setStats({areaKm2, volumeMm3, maxDepth, meanDepth, offset})` — updates the readout panel.
* `setQuery(q | null)` — `q = {lon, lat, x, y, ground, waterSurface, depth}`; renders the
  click-query card, or hides it when `null`.
* `setStatus(text | null)` — a small transient status line (loading progress, "computing…").

Requirements:
* A **lil-gui** panel (collapsed groups: 水位 / 光照与地形 / 水体材质 / 显示) — labels in
  Chinese with the English term in parentheses, e.g. `水位偏移 (Δ water level)`.
* A **depth legend**: a vertical Blues gradient bar 0 → 2.5 m with tick labels, plus a
  note that > 2.5 m is clipped to the darkest blue (this matches the published figure).
  Show it always; highlight it in science mode.
* A **stats card**: inundated area (km²), water volume (Mm³), max/mean depth, and the
  current Δ. Numbers must be monospaced and right-aligned so they do not jitter.
* A **title/credit block** reproducing the existing attribution: "Created by Wenfeng Jia
  @CSU · wjia@csu.edu.au" and a link to `https://doi.org/10.1007/978-981-95-4398-4_14`.
* A **help/keys** popover: R orbit, T top view, F fly tour, S screenshot, W water toggle,
  D science mode, Esc close.
* A **loading overlay** with a progress bar, removed via `setStatus(null)`.
* Everything must be styled from `style.css` — do not inline more than a couple of
  declarations. Use CSS custom properties for colours.
* Must degrade gracefully on a narrow (mobile) viewport: the GUI collapses to a bottom
  sheet, the legend shrinks.

## 6. Verification

`main.js` will be screenshot-tested headlessly. Both agents must ensure their module
throws no exception when `document.body` is empty and WebGL2 is available, and must not
reference any global that `main.js` does not provide.
