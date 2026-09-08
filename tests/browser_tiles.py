"""Local imagery for renderer tests; never drive OSM's public servers with bots."""
from pathlib import Path

IMAGE = (Path(__file__).resolve().parents[1] /
         "vendor/cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg").read_bytes()


def mock_global_tiles(page):
    page.route("https://tile.openstreetmap.org/**", lambda route: route.fulfill(
        status=200, content_type="image/jpeg", body=IMAGE,
        headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=604800"}))
