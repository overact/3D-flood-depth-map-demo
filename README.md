# 3D-flood-depth-map-demo

## Live visualization

**[Open the interactive true-3D flood depth map →](https://overact.github.io/3D-flood-depth-map-demo/)**

An interactive 3D flood depth map of Kempsey, NSW, Australia — the 26 March 2021 Macleay
River flood.

The default viewer renders a separate water surface, supports water-level scenarios, and uses
the published HOTA mask and statistics exactly at Δ = 0.

**Method** — SegFormer + **HOTA** (Hierarchical Overlap-Tiling Aggregation) + a 3D depth
refinement module.

**Paper** — Jia, Liang, Lu, Wilaiwongsakul, Khan & Zheng, *HOTA: Hierarchical Overlap-Tiling
Aggregation for Large-Area 3D Flood Mapping*, in Pattern Recognition and Computer Vision
(ACPR 2025), Springer, 2026. [10.1007/978-981-95-4398-4_14](https://doi.org/10.1007/978-981-95-4398-4_14)

Built with [three.js](https://threejs.org/) r185. Imagery: Copernicus Sentinel-2, 26 March
2021. Terrain: Geoscience Australia 5 m LiDAR DEM (AHD).

Implementation notes, the native-resolution LOD pipeline and the water-level model are
documented in [README_3D.md](README_3D.md). Region metadata lives in
`regions/kempsey/manifest.json`; `tools/build_lod_tiles.py` can generate native 5.843 m tiles
for CDN/object-storage deployment without committing the full tile package to this repository.
