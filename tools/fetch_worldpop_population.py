"""Build the Kempsey population overlay from WorldPop Global2 2021.

Requires rasterio, numpy and pyproj. The official FTP service supports range
reads; only the scene crop is cached in ignored .tmp/. Positive native cells
clipped to the viewer extent enter the browser JSON.
Run: python tools/fetch_worldpop_population.py
"""
import hashlib
import json
import math
from datetime import datetime, timezone
from pathlib import Path
from ftplib import FTP

import numpy as np
import rasterio
from pyproj import Geod, Transformer
from rasterio.windows import Window, from_bounds

ROOT = Path(__file__).resolve().parents[1]
NAME = "aus_pop_2021_CN_100m_R2025A_v1.tif"
SOURCE_URL = "https://data.worldpop.org/GIS/Population/Global_2015_2030/R2025A/2021/AUS/v1/100m/constrained/" + NAME
FTP_PATH = "/GIS/Population/Global_2015_2030/R2025A/2021/AUS/v1/100m/constrained/" + NAME
FTP_URL = "ftp://ftp.worldpop.org" + FTP_PATH
SOURCE = "WorldPop Global2 R2025A v1"
ATTRIBUTION = "WorldPop, University of Southampton, Global2 R2025A v1 (CC BY 4.0)"
GEOD = Geod(ellps="WGS84")
TO_LOCAL = Transformer.from_crs(4326, 3857, always_xy=True)
TO_GEO = Transformer.from_crs(3857, 4326, always_xy=True)


def area_km2(west, south, east, north):
    area, _ = GEOD.polygon_area_perimeter(
        [west, east, east, west], [south, south, north, north])
    return abs(area) / 1e6


def build_cells(values, transform, bbox, origin):
    """Preserve source counts/density; fractionally allocate clipped edge cells.

    Zero is valid but transparent; NoData is excluded, never filled/interpolated.
    Fractional edge allocation assumes uniform density within a native cell.
    """
    cells = []
    valid = zero = nodata = 0
    total = 0.0
    west, south, east, north = bbox
    for row in range(values.shape[0]):
        for col in range(values.shape[1]):
            left, top = transform * (col, row)
            right, bottom = transform * (col + 1, row + 1)
            w, s, e, n = max(left, west), max(bottom, south), min(right, east), min(top, north)
            if w >= e or s >= n:
                continue
            value = values[row, col]
            if np.ma.is_masked(value) or not np.isfinite(value):
                nodata += 1
                continue
            count = float(value)
            if count < 0:
                raise ValueError("Negative unmasked population count")
            valid += 1
            if count == 0:
                zero += 1
                continue
            full_area = area_km2(left, bottom, right, top)
            clipped_area = area_km2(w, s, e, n)
            density = count / full_area
            clipped_count = density * clipped_area
            total += clipped_count
            cells.append([row * values.shape[1] + col, round(clipped_count, 8), round(density, 3)])
    x_edges = [round(TO_LOCAL.transform(min(east, max(west, (transform * (c, 0))[0])), north)[0] - origin[0], 2)
               for c in range(values.shape[1] + 1)]
    z_edges = [round(origin[1] - TO_LOCAL.transform(west, min(north, max(south, (transform * (0, r))[1])))[1], 2)
               for r in range(values.shape[0] + 1)]
    return cells, {"validCells": valid, "zeroCells": zero, "noDataCells": nodata,
                   "positiveCells": len(cells), "populationWithinBounds": total,
                   "maxDensity": max((c[2] for c in cells), default=0)}, {
                       "nx": values.shape[1], "ny": values.shape[0], "xEdges": x_edges, "zEdges": z_edges}


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def acquire_crop(bbox):
    cache = ROOT / ".tmp/worldpop-2021-kempsey.tif"
    receipt_path = ROOT / ".tmp/worldpop-crop-source.json"
    cache.parent.mkdir(exist_ok=True)
    if cache.exists() and receipt_path.exists():
        receipt = json.loads(receipt_path.read_text())
        if receipt.get("bbox") == list(bbox) and receipt.get("cropSha256") == file_hash(cache):
            return cache, receipt
    with FTP("ftp.worldpop.org", timeout=30) as ftp:
        ftp.login()
        ftp.voidcmd("TYPE I")
        size = ftp.size(FTP_PATH)
        modified = ftp.sendcmd("MDTM " + FTP_PATH)
    print("Reading the native Kempsey window from WorldPop FTP", flush=True)
    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR",
                      CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif", GDAL_HTTP_TIMEOUT="30"):
        with rasterio.open("/vsicurl/" + FTP_URL) as src:
            floating = from_bounds(*bbox, transform=src.transform)
            c0, r0 = math.floor(floating.col_off), math.floor(floating.row_off)
            c1 = math.ceil(floating.col_off + floating.width)
            r1 = math.ceil(floating.row_off + floating.height)
            window = Window(c0, r0, c1 - c0, r1 - r0)
            values = src.read(1, window=window, masked=True)
            profile = src.profile.copy()
            profile.update(width=values.shape[1], height=values.shape[0],
                           transform=src.window_transform(window), compress="deflate")
            temporary = cache.with_suffix(".part.tif")
            with rasterio.open(temporary, "w", **profile) as dest:
                dest.write(values.filled(src.nodata), 1)
            temporary.replace(cache)
            receipt = {"sourceUrl": FTP_URL, "sourceSize": size, "sourceModified": modified,
                       "sourceWindow": [c0, r0, c1 - c0, r1 - r0], "sourceShape": list(src.shape),
                       "bbox": list(bbox), "cropSha256": file_hash(cache),
                       "retrievedAt": datetime.now(timezone.utc).isoformat()}
            receipt_path.write_text(json.dumps(receipt, indent=2) + "\n")
    return cache, receipt


def main():
    extent = json.loads((ROOT / "data3d/meta.json").read_text())["extent"]
    west, south = TO_GEO.transform(extent["left"], extent["bottom"])
    east, north = TO_GEO.transform(extent["right"], extent["top"])
    bbox = (west, south, east, north)
    cache, receipt = acquire_crop(bbox)
    with rasterio.open(cache) as src:
        if src.crs.to_epsg() != 4326 or not np.allclose(src.res, [1 / 1200, 1 / 1200]):
            raise ValueError("Expected the WGS84 3-arcsecond WorldPop count grid")
        floating = from_bounds(*bbox, transform=src.transform)
        c0, r0 = math.floor(floating.col_off), math.floor(floating.row_off)
        c1 = math.ceil(floating.col_off + floating.width)
        r1 = math.ceil(floating.row_off + floating.height)
        window = Window(c0, r0, c1 - c0, r1 - r0)
        values = src.read(1, window=window, masked=True)
        transform = src.window_transform(window)
        cells, stats, grid = build_cells(values, transform, bbox, (extent["cx"], extent["cy"]))
        source_grid = {"crs": str(src.crs), "resolutionDegrees": list(src.res),
                       "window": [c0, r0, c1 - c0, r1 - r0],
                       "windowTransform": list(transform)[:6], "noData": src.nodata}
    if not cells:
        raise ValueError("The scene contains no positive WorldPop population cells")
    generated = datetime.now(timezone.utc).isoformat()
    payload = {
        "version": 1, "generatedAt": generated, "source": SOURCE, "year": 2021,
        "country": "AUS", "release": "R2025A", "releaseVersion": "v1", "releaseStatus": "alpha",
        "sourceUrl": SOURCE_URL, "acquisition": receipt,
        "doi": "10.5258/SOTON/WP00839", "license": "CC BY 4.0", "attribution": ATTRIBUTION,
        "geography": "Native 3-arcsecond grid (approximately 100 m at the equator)",
        "populationField": "Estimated residents per source grid cell, all ages and sexes",
        "value": "Estimated residents per geodesic cell area (people per km²)",
        "areaMethod": "WGS84 ellipsoidal cell area; edge counts weighted by clipped area",
        "uncertainty": "Modelled residential population; not observed occupants or real-time presence. Edge allocation assumes uniform within-cell density.",
        "bboxWgs84": dict(zip(["west", "south", "east", "north"], bbox)),
        "sourceGrid": source_grid, "stats": stats,
        "display": {"legendMax": math.ceil(stats["maxDensity"] / 1000) * 1000, "scale": "log1p"},
        "format": "population-grid-v1", "grid": grid,
        "cellFields": ["rowMajorIndex", "estimatedResidentsWithinClippedCell", "peoplePerKm2"],
        "cells": cells,
    }
    name = "population_worldpop_2021.json"
    output = ROOT / "data/layers" / name
    output.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    manifest_path = ROOT / "data/layers/manifest.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["generatedAt"] = generated
    manifest["layers"]["population"] = {"file": name, "count": len(cells),
        "source": SOURCE, "year": 2021, "sourceUrl": SOURCE_URL, "cropSha256": receipt["cropSha256"],
        "sha256": hashlib.sha256(output.read_bytes()).hexdigest(), "license": "CC BY 4.0",
        "geography": payload["geography"], "populationField": payload["populationField"]}
    manifest["attribution"] = [a for a in manifest.get("attribution", [])
        if not a.startswith(("Australian Bureau of Statistics", "WorldPop"))] + [ATTRIBUTION]
    manifest_path.write_text(json.dumps(manifest, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(json.dumps({"file": name, "bytes": output.stat().st_size, "stats": stats,
                      "cropSha256": receipt["cropSha256"]}, indent=2))


if __name__ == "__main__":
    main()
