# 3D-flood-depth-map-demo

An interactive [**3D flood depth map**](https://overact.github.io/3D-flood-depth-map-demo/) of
Kempsey, NSW, Australia — the 26 March 2021 Macleay River flood.

The flood is rendered as a real water surface in 3D: its height is HOTA's published water
surface, and a slider raises or lowers it, re-solving the inundated extent by hydraulic
connectivity. At Δ = 0 the extent and the depth field reproduce the published result exactly.

**Method** — SegFormer + **HOTA** (Hierarchical Overlap-Tiling Aggregation) + a 3D depth
refinement module.

**Paper** — Jia, Liang, Lu, Wilaiwongsakul, Khan & Zheng, *HOTA: Hierarchical Overlap-Tiling
Aggregation for Large-Area 3D Flood Mapping*, in Pattern Recognition and Computer Vision
(ACPR 2025), Springer, 2026. [10.1007/978-981-95-4398-4_14](https://doi.org/10.1007/978-981-95-4398-4_14)

Built with [three.js](https://threejs.org/) r185. Imagery: Copernicus Sentinel-2, 26 March
2021. Terrain: Geoscience Australia 5 m LiDAR DEM (AHD).

Implementation notes, the data pipeline and the water-level model are documented in
[README_3D.md](README_3D.md). The original Qgis2threejs 2.5D export is preserved as
`legacy_qgis2threejs.html`.
