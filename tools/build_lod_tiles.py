#!/usr/bin/env python3
"""Build a shared-edge terrain/depth tile pyramid for the Three.js flood viewer."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

TILE_SAMPLES = 257
TILE_CELLS = TILE_SAMPLES - 1
FLAG_WET = 1
FLAG_OUTSIDE = 4


def require_dependencies() -> None:
    global np, rasterio, Image, from_bounds, Resampling, reproject, Window
    try:
        import numpy as np_module
        import rasterio as rasterio_module
        from PIL import Image as image_module
        from rasterio.transform import from_bounds as from_bounds_function
        from rasterio.warp import Resampling as resampling_enum, reproject as reproject_function
        from rasterio.windows import Window as window_class
    except ModuleNotFoundError as error:
        raise SystemExit(
            "Missing LOD build dependency. Install tools/requirements-lod.txt in a virtual environment."
        ) from error
    np, rasterio, Image = np_module, rasterio_module, image_module
    from_bounds, Resampling, reproject, Window = (
        from_bounds_function, resampling_enum, reproject_function, window_class
    )


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--dem", required=True, type=Path, help="Aligned elevation GeoTIFF")
    p.add_argument("--depth", required=True, type=Path, help="Aligned flood-depth GeoTIFF")
    p.add_argument("--mask", type=Path, help="Optional aligned binary wet-mask GeoTIFF")
    p.add_argument("--imagery", type=Path, help="Optional RGB imagery GeoTIFF")
    p.add_argument("--output", required=True, type=Path, help="Region output directory")
    p.add_argument("--region-id", default="region")
    p.add_argument("--title", default="Flood map region")
    p.add_argument("--min-level", type=int, default=0)
    p.add_argument("--max-level", type=int, help="Native level; inferred from raster size")
    p.add_argument("--png-compress-level", type=int, default=7, choices=range(0, 10))
    p.add_argument("--imagery-quality", type=int, default=82, choices=range(1, 101))
    return p


def valid_values(dataset: rasterio.DatasetReader):
    for _, window in dataset.block_windows(1):
        block = dataset.read(1, window=window, masked=True)
        values = block.compressed()
        if values.size:
            yield values.astype(np.float64, copy=False)


def range_of(dataset: rasterio.DatasetReader) -> tuple[float, float]:
    lo, hi = math.inf, -math.inf
    for values in valid_values(dataset):
        lo = min(lo, float(values.min()))
        hi = max(hi, float(values.max()))
    if not math.isfinite(lo) or not math.isfinite(hi):
        raise ValueError(f"{dataset.name} has no valid samples")
    if hi <= lo:
        hi = lo + 1.0
    return lo, hi


def max_of(dataset: rasterio.DatasetReader) -> float:
    value = 0.0
    for values in valid_values(dataset):
        value = max(value, float(np.maximum(values, 0).max()))
    return max(value, 0.001)


def assert_aligned(reference: rasterio.DatasetReader, other: rasterio.DatasetReader, label: str) -> None:
    if reference.width != other.width or reference.height != other.height:
        raise ValueError(f"{label} dimensions do not match the DEM")
    if reference.crs != other.crs or not reference.transform.almost_equals(other.transform):
        raise ValueError(f"{label} grid/CRS does not match the DEM")


def infer_max_level(width: int, height: int) -> int:
    cells = max(width - 1, height - 1)
    return max(0, int(math.floor(math.log2(max(1, cells / TILE_CELLS)))))


def read_shared_tile(dataset: rasterio.DatasetReader, x: int, y: int, decimation: int,
                     fill: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
    x0, y0 = x * TILE_CELLS * decimation, y * TILE_CELLS * decimation
    width = min(TILE_CELLS * decimation + 1, dataset.width - x0)
    height = min(TILE_CELLS * decimation + 1, dataset.height - y0)
    source = dataset.read(1, window=Window(x0, y0, width, height), masked=True)
    sampled = source[::decimation, ::decimation]
    values = np.asarray(sampled.filled(fill), dtype=np.float32)
    invalid = np.ma.getmaskarray(sampled)
    pad_y, pad_x = TILE_SAMPLES - values.shape[0], TILE_SAMPLES - values.shape[1]
    if pad_x or pad_y:
        values = np.pad(values, ((0, pad_y), (0, pad_x)), mode="edge")
        invalid = np.pad(invalid, ((0, pad_y), (0, pad_x)), mode="edge")
    return values, invalid


def encode_u16(values: np.ndarray, lo: float, hi: float) -> tuple[np.ndarray, np.ndarray]:
    scaled = np.rint(np.clip((values - lo) / (hi - lo), 0, 1) * 65535).astype(np.uint16)
    return (scaled >> 8).astype(np.uint8), (scaled & 255).astype(np.uint8)


def save_packed(path: Path, values: np.ndarray, lo: float, hi: float, flags: np.ndarray,
                compress_level: int) -> None:
    high, low = encode_u16(values, lo, hi)
    rgb = np.dstack((high, low, flags.astype(np.uint8)))
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgb, "RGB").save(path, compress_level=compress_level, optimize=False)


def tile_bounds(dem: rasterio.DatasetReader, x: int, y: int, decimation: int):
    x0, y0 = x * TILE_CELLS * decimation, y * TILE_CELLS * decimation
    x1 = min(dem.width - 1, x0 + TILE_CELLS * decimation)
    y1 = min(dem.height - 1, y0 + TILE_CELLS * decimation)
    left, top = dem.transform * (x0, y0)
    right, bottom = dem.transform * (x1, y1)
    return min(left, right), min(bottom, top), max(left, right), max(bottom, top)


def save_imagery(path: Path, imagery: rasterio.DatasetReader, dem: rasterio.DatasetReader,
                 x: int, y: int, decimation: int, quality: int) -> None:
    bounds = tile_bounds(dem, x, y, decimation)
    destination = np.zeros((3, TILE_CELLS, TILE_CELLS), dtype=np.uint8)
    bands = list(range(1, min(3, imagery.count) + 1))
    for output_band, source_band in enumerate(bands):
        reproject(
            source=rasterio.band(imagery, source_band),
            destination=destination[output_band],
            src_transform=imagery.transform,
            src_crs=imagery.crs,
            dst_transform=from_bounds(*bounds, TILE_CELLS, TILE_CELLS),
            dst_crs=dem.crs,
            resampling=Resampling.bilinear,
        )
    if len(bands) == 1:
        destination[1:] = destination[0]
    elif len(bands) == 2:
        destination[2] = destination[1]
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.moveaxis(destination, 0, -1), "RGB").save(path, "WEBP", quality=quality, method=4)


def main() -> None:
    args = parser().parse_args()
    require_dependencies()
    args.output.mkdir(parents=True, exist_ok=True)

    with rasterio.open(args.dem) as dem, rasterio.open(args.depth) as depth:
        assert_aligned(dem, depth, "Depth")
        mask_context = rasterio.open(args.mask) if args.mask else None
        imagery_context = rasterio.open(args.imagery) if args.imagery else None
        try:
            if mask_context:
                assert_aligned(dem, mask_context, "Mask")
            if imagery_context and imagery_context.crs is None:
                raise ValueError("Imagery has no CRS")

            terrain_min, terrain_max = range_of(dem)
            depth_max = max_of(depth)
            native_level = args.max_level if args.max_level is not None else infer_max_level(dem.width, dem.height)
            if args.min_level < 0 or native_level < args.min_level:
                raise ValueError("Invalid level range")

            levels = []
            for level in range(args.min_level, native_level + 1):
                decimation = 1 << (native_level - level)
                count_x = math.ceil((dem.width - 1) / (TILE_CELLS * decimation))
                count_y = math.ceil((dem.height - 1) / (TILE_CELLS * decimation))
                print(f"level {level}: {count_x} x {count_y} tiles, decimation {decimation}")
                levels.append({
                    "level": level,
                    "decimation": decimation,
                    "resolutionMetres": abs(dem.transform.a) * decimation,
                    "tilesX": count_x,
                    "tilesY": count_y,
                })
                for y in range(count_y):
                    for x in range(count_x):
                        tile_dir = args.output / "tiles" / str(level) / str(x) / str(y)
                        terrain, terrain_invalid = read_shared_tile(dem, x, y, decimation, terrain_min)
                        flood_depth, depth_invalid = read_shared_tile(depth, x, y, decimation, 0.0)
                        if mask_context:
                            wet_values, mask_invalid = read_shared_tile(mask_context, x, y, decimation, 0.0)
                            wet = (wet_values > 0) & ~mask_invalid
                        else:
                            wet = (flood_depth > 0) & ~depth_invalid
                        terrain_flags = np.where(terrain_invalid, FLAG_OUTSIDE, 0).astype(np.uint8)
                        depth_flags = np.where(wet, FLAG_WET, 0).astype(np.uint8)
                        save_packed(tile_dir / "terrain.png", terrain, terrain_min, terrain_max,
                                    terrain_flags, args.png_compress_level)
                        save_packed(tile_dir / "depth.png", flood_depth, 0.0, depth_max,
                                    depth_flags, args.png_compress_level)
                        if imagery_context:
                            save_imagery(tile_dir / "imagery.webp", imagery_context, dem, x, y,
                                         decimation, args.imagery_quality)

            bounds = [dem.bounds.left, dem.bounds.bottom, dem.bounds.right, dem.bounds.top]
            manifest = {
                "schemaVersion": 1,
                "id": args.region_id,
                "title": args.title,
                "crs": dem.crs.to_string(),
                "bounds": bounds,
                "sourceResolution": {
                    "terrainMetres": abs(dem.transform.a),
                    "depthMetres": abs(depth.transform.a),
                    "imageryMetres": abs(imagery_context.transform.a) if imagery_context else abs(dem.transform.a),
                },
                "encoding": {
                    "terrain": {"format": "u16-rg", "min": terrain_min, "max": terrain_max, "flagsChannel": "b"},
                    "depth": {"format": "u16-rg", "min": 0.0, "max": depth_max, "flagsChannel": "b"},
                },
                "lod": {
                    "tileSamples": TILE_SAMPLES,
                    "minLevel": args.min_level,
                    "maxLevel": native_level,
                    "levelZeroDecimation": 1 << (native_level - args.min_level),
                    "urlTemplate": "tiles/{z}/{x}/{y}",
                    "available": True,
                    "levels": levels,
                },
            }
            (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        finally:
            if mask_context:
                mask_context.close()
            if imagery_context:
                imagery_context.close()


if __name__ == "__main__":
    main()
