"""Dual-canvas geographic, lifecycle and export checks (Playwright + Chrome)."""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser_tiles import mock_global_tiles

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:18764"
out = Path(__file__).resolve().parents[1] / "output/basemap-regression"
out.mkdir(parents=True, exist_ok=True)

ALIGNMENT = """async () => {
  const T=await import('three');
  const {worldToLonLat}=await import('./js/data.js');
  const camera=__fv.three.camera, meta=__fv.dataset.meta;
  camera.updateMatrixWorld();
  return [[0,0,0],[10000,0,10000],[-10000,0,-10000],[1000,1000,1000]].map(a=>{
    const p=new T.Vector3(...a).project(camera);
    const first=[(p.x+1)/2*innerWidth,(1-p.y)/2*innerHeight];
    const ll=worldToLonLat(meta,a[0],a[2]);
    const second=__fv.basemap.project(ll.lon,ll.lat,a[1]);
    return Math.hypot(first[0]-second[0],first[1]-second[1]);
  });
}"""

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    mock_global_tiles(page)
    errors, requests = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("request", lambda r: requests.append(r.url))
    page.goto(base + "/?quality=low&autoRotate=false", wait_until="domcontentloaded")
    page.wait_for_function("window.__fv?.basemap?.active === true", timeout=60000)
    page.wait_for_function("document.querySelector('.fv-map-status').dataset.status === 'ready'", timeout=45000)
    assert page.locator("canvas").count() == 2
    assert page.evaluate("__fv.basemap.debug.terrainProvider") == "ellipsoid-flat"
    assert page.evaluate("__fv.basemap.debug.mode") == 1
    budget = page.evaluate("__fv.basemap.debug")
    assert budget["maximumLevel"] == 18 and budget["minimumLevel"] == 0
    assert budget["tileCacheSize"] == 48 and budget["maximumRequestsPerServer"] == 6
    assert not budget["preloadAncestors"] and not budget["preloadSiblings"]
    assert not any("api.cesium.com" in u or "/terrain/" in u for u in requests), requests
    before = page.evaluate(ALIGNMENT)
    assert max(before) < 0.1, before
    page.screenshot(path=str(out / "kempsey-overlay.png"))

    page.mouse.move(740, 440)
    page.mouse.down()
    page.mouse.move(840, 480, steps=12)
    page.mouse.up()
    page.mouse.wheel(0, -180)
    page.wait_for_timeout(1200)
    moved = page.evaluate(ALIGNMENT)
    assert max(moved) < 0.1, moved
    assert page.evaluate("__fv.basemap.debug.cameraUpdates") > 2

    page.get_by_role("button", name="World", exact=True).click()
    page.wait_for_function("__fv.renderBudget.localSceneVisible === false")
    frames = page.evaluate("__fv.renderBudget.localRenderFrames")
    page.wait_for_timeout(300)
    assert page.evaluate("__fv.renderBudget.localRenderFrames") == frames, "World view still renders local flood meshes"
    page.screenshot(path=str(out / "world-overview.png"))
    assert page.get_by_role("button", name="Kempsey · flood scene", exact=True).is_visible()
    page.get_by_role("button", name="Australia", exact=True).click()
    page.wait_for_timeout(1200)
    assert page.get_by_role("button", name="Kempsey · flood scene", exact=True).is_visible()
    page.screenshot(path=str(out / "australia-overview.png"))
    with page.expect_download() as download:
        page.keyboard.press("s")
    exported = out / "australia-export.png"
    download.value.save_as(exported)
    assert exported.stat().st_size > 100000, "Composite export omitted map imagery"

    page.get_by_role("button", name="Kempsey · flood scene", exact=True).click()
    page.wait_for_function("__fv.renderBudget.localSceneVisible === true")
    page.get_by_role("button", name="Basemap", exact=True).click()
    assert not page.evaluate("__fv.basemap.active")
    count = page.evaluate("__fv.basemap.debug.renderedFrames")
    page.wait_for_timeout(300)
    assert page.evaluate("__fv.basemap.debug.renderedFrames") == count
    page.get_by_role("button", name="Basemap", exact=True).click()
    assert page.evaluate("__fv.basemap.active")
    page.wait_for_timeout(500)
    assert max(page.evaluate(ALIGNMENT)) < 0.1

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(500)
    mobile = page.evaluate(ALIGNMENT)
    assert max(mobile) < 0.1, mobile
    page.screenshot(path=str(out / "mobile-overlay.png"))
    assert not errors, errors

    # A missing remote basemap must not disable local flood data or interaction.
    failed = browser.new_page(viewport={"width": 1280, "height": 800})
    failure_errors = []
    failed.on("pageerror", lambda e: failure_errors.append(str(e)))
    failed.route("https://tile.openstreetmap.org/**", lambda route: route.abort())
    failed.goto(base + "/?quality=low&autoRotate=false", wait_until="domcontentloaded")
    failed.wait_for_function("window.__fv?.basemap?.debug.tileError === true", timeout=60000)
    assert "unavailable" in failed.locator(".fv-map-status").inner_text()
    failed.locator("input[type=range]").fill("1")
    assert failed.evaluate("__fv.state.waterOffset") == 1
    assert failed.evaluate("__fv.dataset.arrays.terrain.length") > 1000000
    assert not failure_errors, failure_errors
    failed.screenshot(path=str(out / "tile-failure.png"))
    failed.close()

    result = {"initialPixelErrors": before, "movedPixelErrors": moved,
              "mobilePixelErrors": mobile, "compositeExportBytes": exported.stat().st_size,
              "basemap": page.evaluate("__fv.basemap.debug"),
              "mockedTiles": True,
              "requestedLevels": sorted(set(int(u.split("/")[-3]) for u in requests if "tile.openstreetmap.org" in u)),
              "requestedTileCount": sum("tile.openstreetmap.org" in u for u in requests),
              "worldViewPausesLocalRendering": True,
              "pageErrors": errors, "remoteFailurePreservesFloodScene": True}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2), flush=True)
    browser.close()
