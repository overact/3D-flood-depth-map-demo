# Kempsey 3D Flood Viewer — true-3D rebuild

A ground-up replacement for the Qgis2threejs export. The old page was a **2.5D** view: a DEM
mesh with the flood-depth map *painted onto it as an image*. There was no water — just blue
pixels on a hillshade. This version renders the flood as an actual **water surface in 3D**,
with the published HOTA depth field driving its geometry.

Live entry point: `index.html`. The original export is preserved as
`legacy_qgis2threejs.html` (it still reads `data/index/scene.js`).

---

## What is actually different

| | old (Qgis2threejs) | new |
|---|---|---|
| Flood representation | colour ramp baked into a 4096 px texture | separate water **mesh**, height = HOTA water surface |
| Water optics | none | screen-space refraction, Beer–Lambert absorption, Fresnel + sky reflection, sun specular, depth-modulated ripples, shoreline foam |
| Ocean | flat blue polygon | its own regime: directional onshore swell (displaced *and* shaded from one shared wave function), band-limited wind ripples, breaker lines, whitecaps, clear-water shallows |
| Water level | fixed | live slider, −3 … +5 m, re-solves the inundated extent by hydraulic connectivity |
| Basemap under the flood | blue ramp (imagery destroyed) | real Sentinel-2 26 Mar 2021 imagery |
| Terrain | 520 × 483 (75 m) | 1536 × 1426 (25.5 m), resampled from the 5.84 m LiDAR DEM |
| Depth source | inverted from the picture | `final_depth.tif` itself |
| First load | 39 MB `scene.js` | **9.7 MB** total |
| three.js | r1xx bundled build | r185, ESM, vendored |

---

## Data pipeline

Everything in `data3d/` is derived from the HOTA project rasters:

* `3D_flood/3D_results/final_depth.tif` — 6188 × 6242, 5.84 m, EPSG:3857, flood depth (m).
* `3D_flood/data/input/Kempsey_dem_aligned.tif` — 8356 × 6575, 5.84 m, GA 5 m LiDAR DEM (AHD).
* `Sentinel2 data/kempsey/Kempsey_sentinel2_DW_2021_march1_S2.tif` — B4/B3/B2 true colour,
  26 March 2021.

Both rasters are cropped/resampled to the demo extent (EPSG:3857, centre
`17023665, −3634079.529`, 39230 × 36414 m) on a common **1536 × 1426** grid (25.54 m).

Note on Web Mercator: at φ = −31.08° a projected square metre is only `cos²φ = 0.7335` real
square metres. Every area and volume figure in the UI applies that correction, so they are
smaller than the raw pixel-count figures in the HOTA CSVs by 1/0.7335 ≈ 1.36×. With the
correction applied, this viewer reports **138.07 Mm³** over the demo extent against HOTA's
**187.2 Mm³ × 0.7335 = 137.3 Mm³** — a 0.5 % match, which is the end-to-end check that the
pipeline is faithful. Against the pipeline's own figures (`data3d/meta.json`) the live
readout is exact to 0.1 %: 189.19 vs 188.97 km², 138.07 vs 138.04 Mm³.

Max depth reads **6.94 m**, not the 7.37 m you get from `final_depth.tif` directly. The
difference is the 3×3 smoothing applied to the water surface before resampling to 25.5 m;
the deepest single 5.84 m pixel does not survive aggregation, which is correct behaviour for
a 25.5 m grid.

### The water-level model

The slider adds a uniform offset `Δ` to the water surface. Three rasters make that work:

* `terrain.png` — ground elevation, 16-bit split across R/G; the flag bitfield rides in B.
* `wsurf.png` — the HOTA water-surface elevation `W = DEM + depth`, extended off the
  flood by nearest-shoreline allocation and smoothed. Stored coarse (384 × 357) because a
  water surface is smooth by definition.
* `need.png` — the **connectivity fill level**: the minimum `Δ` at which a cell becomes
  wet *and hydraulically connected* to the flood body. Computed offline as a minimax-path
  (priority-flood) over the barrier field `b = terrain − W`, seeded from the published
  inundation and the ocean.

A cell is wet ⟺ `Δ ≥ need`, and `depth = W + Δ − terrain`. That is one texture lookup and one
comparison per fragment, so raising and lowering the flood is free at 60 fps — no per-frame
flood fill.

At **Δ = 0 the wet set and the depth field reproduce `final_depth.tif` exactly.** For Δ > 0
the DEM decides where the water goes, subject to two documented assumptions:

1. Cells the DEM puts *below* the published water surface but which HOTA mapped as dry are
   treated as protected (levee, embankment, road) and are raised by a small monotone amount
   so they flood progressively rather than all at once.
2. Cells more than 4 km from the flood, or more than 6 m below the local water surface, are
   excluded — those are cross-catchment artefacts of nearest-shoreline allocation.

Negative Δ is exact and assumption-free: the water simply drains, shallowest first.

### The basemap

`imagery.jpg` (4096 × 3800, 2.6 MB; `basemap.webp` is kept as a fallback) is the QGIS project's aerial/S2 canvas render with the
opaque Blues overlay removed and replaced by the **Sentinel-2 26 Mar 2021 true-colour image**
inside the inundated area — so what you see under the 3D water is the actual sediment-laden
floodwater as the satellite saw it, not a fabricated fill. The Sentinel-2 patch is
mean/std-matched to the aerial over dry land so the seam is invisible. The Tasman Sea and the
handful of pixels outside every source raster are the only synthetic areas; they are a smooth
push–pull fill and are labelled as such in the UI's "About the data" panel.

---

## Rendering architecture

`js/main.js`. Three passes, **one** geometry pass:

1. Terrain + sky → an HDR `WebGLRenderTarget` (HalfFloat) with an attached `DepthTexture`.
2. Fullscreen blit of that target to the canvas (ACES tone mapping + a light grade).
3. The water mesh, on its own camera layer, composited **manually** against the pass-1 colour
   and depth.

The water material is `transparent: false, depthTest: false` and does its own depth test in
the fragment shader. That one decision buys three things at once: correct occlusion by
terrain, the water-column thickness needed for Beer–Lambert, and immunity to both
transparent-object sorting and z-fighting against a near-coincident surface.

Other things worth knowing before editing:

* **Coordinates are rebased to the dataset centre.** float32 ULP at Web Mercator 1.7e7 is 2 m;
  nothing that large ever reaches a shader.
* **Vertical exaggeration** is a group `scale.y` on the terrain and a `uVertExag` uniform on
  the water. They must stay in sync. Water *optics* always use true metres.
* **Reflections use a plain `WebGLCubeRenderTarget`, not PMREM.** Water is near-mirror, so the
  prefiltered roughness chain buys nothing, and `textureCubeUV` returns NaN on some software
  GL stacks — which turns the whole surface black. The solar disc is disabled while the cube
  is captured; leaving it in bakes a 19000× hotspot into every mip and the water goes milky.
* **The r183+ `Sky` addon is linear HDR with no gamma.** Its radiance sits far above anything
  the terrain reflects, so it is scaled by 0.075 in `main.js` rather than dragging
  `toneMappingExposure` down until the ground goes black.
* **Shoreline foam is band-limited in screen space** (`fwidth(depth)`), not by a fixed depth
  threshold. On a floodplain this flat, "depth < 0.2 m" paints white over square kilometres.
* **`fwidth()` is taken before the first `discard`.** Once part of a 2×2 quad is discarded
  the helper invocations may retire, and derivatives on the survivors are undefined (GLSL ES
  3.0 §8.14) — which is exactly the quads straddling the waterline.
* **The water column is `max(wsE − ground, Δ − need)`, and exactly `Δ − need` on cells the
  published run mapped wet.** `wsurf` ships coarse (384×357 — a water surface is smooth, so
  storing it fine is wasted bytes) while `need` is full resolution and holds exactly −depth
  on those cells. Using the coarse surface alone drops the shallowest fringe: ~7 km², 3.8 %
  of the published extent, went dry purely to resampling.
* **The coastal blend is precomputed, not blurred in the shader.** The sea flag is binary
  per 25.5 m cell, and three separate things need a smooth 0…1 "how much open ocean is
  here": the regime cross-fade (the sea is pinned at 0 m AHD, the flood rides the slider),
  the clarity/body-colour split, and the surf band — which needs a shoaling coordinate that
  this dataset cannot otherwise supply, because it carries no bathymetry. Blurring in the
  shader cost nine taps per stage and still quantised to ninths: visible as speckle along
  the beach, and as a zigzag following the water-mesh triangulation when taken per vertex.
  `data.js` now ships it as `tSea` (768×713, two box passes ≈ 500 m). One tap, exact.
* **The long swell is one function shared by both shader stages.** The vertex stage
  displaces the sheet by it; the fragment stage folds its *slope* into the shading normal
  (times the vertical exaggeration, because that displacement is exaggerated). Two copies
  would drift apart and you would see geometry that moves without shading. It is also the
  only wave term **not** band-limited away with distance, which is what keeps the far ocean
  alive after the Nyquist fade has removed every short band.
* **Offshore the six ripple directions collapse onto one onshore heading.** A wind sea is
  short-crested and comes from everywhere; a swell that has travelled is directionally
  narrow. Isotropic directions at ocean amplitude interfere into a woven lattice; a ±20°
  fan reads as an ocean. Inland the original scattered directions are kept — wind chop on
  standing floodwater really has no preferred direction.
* **A wave band is faded out between 12 and 4 pixels per wavelength**, not at Nyquist.
  A *specular* signal aliases far worse than a diffuse one: the sun glitter beats against
  the wave period and the whole sea reads as cloth. The lost slope variance becomes
  microfacet roughness, and the ocean carries an extra roughness floor on top.
* **Sea clarity is granted in the shallows and withdrawn again with depth.** There is no
  bathymetry: offshore the "seabed" is a flat −6 m synthetic fill under a dark inpainted
  basemap, so any transmission out there just multiplies a black texture into the water —
  which is what made the ocean read as ink. Inshore, letting the sand shelf show through is
  exactly what makes the shallows read as clear water.
* **The `need` "never floodable" sentinel decodes to +9 m, not +999.** That array is also a
  LinearFilter texture; interpolating between a wet cell and a 999 neighbour puts hundreds of
  metres halfway across the cell and leaves a one-cell dry seam along every excluded boundary.

## Performance notes

* **Click-to-query ray-marches the heightfield**, it does not raycast the mesh.
  `Raycaster.intersectObject` is brute force over the index buffer: 4.3 M triangles and a
  measured **389–456 ms** of blocked main thread per click. Marching the ray and bisecting
  the sign change costs **0.4 ms**, is independent of mesh resolution, is *more* accurate
  than the decimated mesh, and sees the water surface as well as the ground.
* **Area/volume come from a prefix-summed histogram over `need`**, built once at load. Since
  a cell is wet ⟺ Δ ≥ need, and depth is affine in Δ, both integrals separate:
  `volume = Δ·N(Δ) + Σ(W − ground)`, `maxDepth = Δ − min(ground − W)`. A query is three array
  reads — **0.004 ms** against **22.6 ms** for the 2.2 M-cell sweep it replaced, which is what
  makes the slider smooth. `computeStats()` is kept as the exact reference; the index agrees
  with it to within one 1 mm bin.
* A query fires on pointer-**up** only if the pointer moved < 5 px, so orbiting never
  triggers one.
* Initial quality is guessed from pointer type / screen size / core count, then corrected
  once by measuring the first ~100 frames and stepping down if the average is worse than
  28 fps.

## Controls

Mouse: left-drag pan, right-drag orbit, wheel zoom (MapControls).
Keys: `R` orbit · `T` top view · `F` fly tour · `S` screenshot · `W` water on/off ·
`D` science colouring · `Esc` close panel.

`科研着色 (science mode)` swaps the photoreal water body for the published matplotlib **Blues**
ramp, 0 → 2.5 m, clipped above — the exact `classificationMax` from `kempsey_segformer.qgz`.
It divides out the renderer exposure so the pixels leave the pipeline at the published hex
values, which makes it usable for figures.

## Running it

It is a static folder — no build step. ES modules need a real origin, so open it through a
server rather than `file://`:

```
python -m http.server 8000
# then http://localhost:8000/
```

On GitHub Pages just push the folder; three.js is vendored in `vendor/three/`, so there is no
CDN dependency and nothing to install.

Requires WebGL2 and `DecompressionStream` (all current browsers). Quality drops to a 2048 px
basemap and a coarser mesh automatically on small or low-limit devices.

## Provenance

Depth and DEM: **HOTA — Hierarchical Overlap-Tiling Aggregation for Large-Area 3D Flood
Mapping**. Jia, Liang, Lu, Wilaiwongsakul, Khan & Zheng, in *Pattern Recognition and Computer
Vision* (ACPR 2025), Springer, 2026. https://doi.org/10.1007/978-981-95-4398-4_14
Imagery: Copernicus Sentinel-2, 26 March 2021.
