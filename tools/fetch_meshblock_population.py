"""Build the local ABS 2021 Mesh Block population layer.

This combines two official ABS releases:

* the ASGS 2021 Mesh Block boundary MapServer, queried only for the current
  flood-scene extent; and
* the 2021 Census Mesh Block Counts workbook, joined by MB_CODE_2021.

The workbook is downloaded into the ignored ``.tmp/`` workspace cache and is
not committed to the project.  The generated JSON is the small, browser-ready
snapshot used by the static viewer.

Usage (requires Python with openpyxl):

    python tools/fetch_meshblock_population.py
"""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

try:
    import openpyxl
except ImportError as exc:  # pragma: no cover - the bundled runtime supplies it
    raise SystemExit(
        "openpyxl is required; use the bundled workspace Python or install it with pip."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]
META_PATH = ROOT / "data3d" / "meta.json"
OUTPUT_PATH = ROOT / "data" / "layers" / "population_meshblock.json"
R_EARTH = 6378137.0
BOUNDARY_URL = (
    "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/MB/MapServer/0/query"
)
COUNTS_URL = (
    "https://www.abs.gov.au/census/guide-census-data/mesh-block-counts/2021/"
    "Mesh%20Block%20Counts%2C%202021.xlsx"
)


def request_json(url: str) -> dict:
    request = Request(url, headers={"User-Agent": "3D-flood-depth-map-demo/1.0"})
    with urlopen(request, timeout=120) as response:
        return json.loads(response.read().decode("utf-8"))


def request_bytes(url: str) -> bytes:
    request = Request(url, headers={"User-Agent": "3D-flood-depth-map-demo/1.0"})
    with urlopen(request, timeout=180) as response:
        return response.read()


def round_value(value: float, digits: int = 1) -> float:
    factor = 10**digits
    return round(value * factor) / factor


def same_point(a: list[float], b: list[float], tolerance: float = 0.01) -> bool:
    return bool(a and b and abs(a[0] - b[0]) < tolerance and abs(a[1] - b[1]) < tolerance)


def sq_segment_distance(point: list[float], a: list[float], b: list[float]) -> float:
    x, y = a
    dx = b[0] - x
    dy = b[1] - y
    if dx or dy:
        t = ((point[0] - x) * dx + (point[1] - y) * dy) / (dx * dx + dy * dy)
        if t > 1:
            x, y = b
        elif t > 0:
            x += dx * t
            y += dy * t
    return (point[0] - x) ** 2 + (point[1] - y) ** 2


def simplify(points: list[list[float]], tolerance: float, closed: bool = False) -> list[list[float]]:
    if len(points) <= (4 if closed else 2):
        return points
    source = points[:-1] if closed and same_point(points[0], points[-1]) else points[:]
    if len(source) <= (3 if closed else 2):
        return source
    keep = [False] * len(source)
    keep[0] = True
    keep[-1] = True
    sq_tolerance = tolerance * tolerance
    stack = [(0, len(source) - 1)]
    while stack:
        first, last = stack.pop()
        max_sq = sq_tolerance
        index = -1
        for i in range(first + 1, last):
            distance = sq_segment_distance(source[i], source[first], source[last])
            if distance > max_sq:
                index = i
                max_sq = distance
        if index >= 0:
            keep[index] = True
            stack.extend(((first, index), (index, last)))
    output = [point for i, point in enumerate(source) if keep[i]]
    if closed:
        output.append(output[0])
    return output


def clip_intersection(a: list[float], b: list[float], axis: int, value: float) -> list[float]:
    delta = b[axis] - a[axis]
    t = 0.0 if abs(delta) < 1e-9 else (value - a[axis]) / delta
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]


def clip_ring(points: list[list[float]], bounds: dict[str, float]) -> list[list[float]]:
    source = points[:-1] if len(points) > 1 and same_point(points[0], points[-1]) else points[:]
    if len(source) < 3:
        return []
    edges = (
        (lambda p: p[0] >= bounds["min_x"], 0, bounds["min_x"]),
        (lambda p: p[0] <= bounds["max_x"], 0, bounds["max_x"]),
        (lambda p: p[1] >= bounds["min_z"], 1, bounds["min_z"]),
        (lambda p: p[1] <= bounds["max_z"], 1, bounds["max_z"]),
    )
    clipped = source
    for inside, axis, value in edges:
        if not clipped:
            break
        output: list[list[float]] = []
        previous = clipped[-1]
        previous_inside = inside(previous)
        for current in clipped:
            current_inside = inside(current)
            if current_inside:
                if not previous_inside:
                    output.append(clip_intersection(previous, current, axis, value))
                output.append(current)
            elif previous_inside:
                output.append(clip_intersection(previous, current, axis, value))
            previous = current
            previous_inside = current_inside
        clipped = output
    clean: list[list[float]] = []
    for point in clipped:
        rounded = [round_value(point[0]), round_value(point[1])]
        if not clean or not same_point(clean[-1], rounded):
            clean.append(rounded)
    if len(clean) > 1 and same_point(clean[0], clean[-1]):
        clean.pop()
    if len(clean) < 3:
        return []
    clean.append(clean[0])
    return clean


def polygon_area(ring: list[list[float]]) -> float:
    area = 0.0
    for i, point in enumerate(ring):
        previous = ring[i - 1]
        area += previous[0] * point[1] - point[0] * previous[1]
    return abs(area) * 0.5


def scene_extent() -> tuple[dict[str, float], dict[str, float]]:
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    extent = meta["extent"]
    west = extent["left"] / R_EARTH * 180 / math.pi
    east = extent["right"] / R_EARTH * 180 / math.pi
    south = (2 * math.atan(math.exp(extent["bottom"] / R_EARTH)) - math.pi / 2) * 180 / math.pi
    north = (2 * math.atan(math.exp(extent["top"] / R_EARTH)) - math.pi / 2) * 180 / math.pi
    bbox = {"west": west, "east": east, "south": south, "north": north}
    bounds = {
        "min_x": extent["left"] - extent["cx"],
        "max_x": extent["right"] - extent["cx"],
        "min_z": extent["cy"] - extent["top"],
        "max_z": extent["cy"] - extent["bottom"],
    }
    return bbox, bounds


def load_counts(workbook_path: Path) -> dict[str, dict[str, object]]:
    workbook = openpyxl.load_workbook(workbook_path, read_only=True, data_only=True)
    counts: dict[str, dict[str, object]] = {}
    for worksheet in workbook.worksheets:
        if not worksheet.title.startswith("Table"):
            continue
        rows = worksheet.iter_rows(values_only=True)
        header = None
        for row in rows:
            if row and str(row[0]).strip() == "MB_CODE_2021":
                header = row
                break
        if header is None:
            continue
        for row in rows:
            if not row or row[0] is None:
                continue
            code = str(row[0]).strip()
            if not code.isdigit():
                continue
            counts[code] = {
                "category": str(row[1]).strip() if row[1] is not None else "",
                "areaKm2": float(row[2]) if row[2] is not None else 0.0,
                "dwelling": int(row[3] or 0),
                "population": int(row[4] or 0),
            }
    return counts


def fetch_boundaries(bbox: dict[str, float]) -> list[dict]:
    features: list[dict] = []
    offset = 0
    page_size = 2000
    while True:
        params = {
            "where": "1=1",
            "geometry": f"{bbox['west']},{bbox['south']},{bbox['east']},{bbox['north']}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": "4326",
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "mb_code_2021,mb_category_2021,area_albers_sqkm",
            "returnGeometry": "true",
            "outSR": "3857",
            "maxAllowableOffset": "1",
            "geometryPrecision": "1",
            "resultOffset": str(offset),
            "resultRecordCount": str(page_size),
            "returnExceededLimitFeatures": "true",
            "f": "geojson",
        }
        page = request_json(f"{BOUNDARY_URL}?{urlencode(params)}")
        if "error" in page:
            raise RuntimeError(f"ABS Mesh Block boundary query failed: {page['error']}")
        page_features = page.get("features", [])
        features.extend(page_features)
        if not page.get("exceededTransferLimit") or len(page_features) < page_size:
            break
        offset += page_size
    return features


def local_ring(ring: list[list[float]], cx: float, cy: float, bounds: dict[str, float]) -> list[list[float]]:
    projected = [[round_value(x - cx), round_value(cy - y)] for x, y in ring]
    return clip_ring(simplify(projected, 2, closed=True), bounds)


def build_features(boundaries: list[dict], counts: dict[str, dict[str, object]], bounds: dict[str, float], cx: float, cy: float) -> tuple[list[dict], int]:
    output: list[dict] = []
    missing = 0
    for feature in boundaries:
        properties = feature.get("properties") or {}
        code = str(properties.get("mb_code_2021") or "").strip()
        if not code:
            continue
        count = counts.get(code)
        if count is None:
            missing += 1
            count = {
                "category": str(properties.get("mb_category_2021") or ""),
                "areaKm2": float(properties.get("area_albers_sqkm") or 0),
                "dwelling": 0,
                "population": 0,
            }
        area_km2 = float(count.get("areaKm2") or properties.get("area_albers_sqkm") or 0)
        population = int(count.get("population") or 0)
        density = round_value(population / area_km2, 1) if area_km2 > 0 else 0
        geometry = feature.get("geometry") or {}
        polygons = geometry.get("coordinates") or []
        if geometry.get("type") == "Polygon":
            polygons = [polygons]
        part_index = 0
        for polygon in polygons:
            rings = [local_ring(ring, cx, cy, bounds) for ring in polygon]
            rings = [ring for ring in rings if len(ring) >= 4]
            if not rings:
                continue
            outer = rings[0]
            if len(outer) < 4:
                continue
            output.append({
                "id": code if part_index == 0 else f"{code}:{part_index}",
                "sourceId": code,
                "partIndex": part_index,
                "mbCode": code,
                "category": count.get("category", ""),
                "population": population if part_index == 0 else 0,
                "dwelling": int(count.get("dwelling") or 0) if part_index == 0 else 0,
                "density": density,
                "areaKm2": round_value(area_km2, 4) if part_index == 0 else 0,
                "rings": rings,
            })
            part_index += 1
    output.sort(key=lambda item: item["id"])
    return output, missing


def main() -> None:
    bbox, bounds = scene_extent()
    meta = json.loads(META_PATH.read_text(encoding="utf-8"))
    extent = meta["extent"]
    temporary_root = ROOT / ".tmp"
    temporary_root.mkdir(parents=True, exist_ok=True)
    # Keep the 14 MB source workbook in the workspace cache rather than in the
    # generated layer or the repository.  A later run refreshes this file.
    workbook_path = temporary_root / "Mesh Block Counts, 2021.xlsx"
    workbook_path.write_bytes(request_bytes(COUNTS_URL))
    counts = load_counts(workbook_path)
    boundaries = fetch_boundaries(bbox)
    features, missing = build_features(
        boundaries,
        counts,
        bounds,
        float(extent["cx"]),
        float(extent["cy"]),
    )
    if missing:
        print(f"warning: {missing} boundary features had no matching count row; population set to 0")
    generated_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    output = {
        "version": 1,
        "generatedAt": generated_at,
        "source": "Australian Bureau of Statistics, 2021 Census Mesh Block Counts + ASGS 2021 Mesh Block boundaries",
        "bbox": bbox,
        "year": 2021,
        "geography": "Mesh Block (MB)",
        "populationField": "Persons Usually Resident",
        "dwellingField": "Dwellings",
        "value": "Persons Usually Resident / full Mesh Block area (people per km²)",
        "areaMethod": "ABS AREA_ALBERS_SQKM; displayed geometry is clipped to the flood-scene extent",
        "boundarySource": "https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/MB/MapServer",
        "countSource": "https://www.abs.gov.au/census/guide-census-data/mesh-block-counts/latest-release",
        "features": features,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(output, separators=(",", ":")), encoding="utf-8")
    densities = [float(feature["density"]) for feature in features]
    print(f"mesh blocks: {len(boundaries)} boundaries -> {len(features)} rendered parts")
    print(f"population rows: {len(counts)}; density max={max(densities, default=0):.1f} people/km²")
    print(f"wrote {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
