"""Live viewer regressions. Requires Python Playwright and installed Google Chrome.

Serve the repository, then run: python3 tests/browser-depth.py http://127.0.0.1:8000
"""
import json
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

base = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
out = Path(__file__).resolve().parents[1] / "output" / "depth-regression"
out.mkdir(parents=True, exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="chrome")
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto(base + "/?autoRotate=false&quality=low", wait_until="domcontentloaded")
    page.wait_for_function("window.__done === true", timeout=60000)
    page.keyboard.press("t")
    page.wait_for_timeout(300)
    page.mouse.click(750, 450)
    query = page.locator(".fv-query")
    assert query.is_visible(), "Point selection did not open the query"

    def depth():
        return float(query.locator(".fv-row--hero .fv-row-val > span").nth(1).inner_text())

    baseline = depth()
    assert baseline > 0, "Probe should select baseline floodwater"
    slider = page.locator("input[type=range]")
    slider.fill("1")
    assert abs(depth() - baseline - 1) < 0.011, "Selected point did not refresh"
    slider.fill("-3")
    assert depth() == 0 and query.locator(".fv-dry").is_visible(), "Drained point is not dry"
    slider.fill("0")
    assert abs(depth() - baseline) < 0.011, "Baseline reset did not refresh"

    parity = page.evaluate("""async () => {
      const {queryFloodDepth} = await import('./js/flood-depth.js');
      const d=__fv.dataset,g=d.grid;
      let count=0,maxError=0,contextError=0;
      for(let iz=1;iz<g.ny-1;iz+=4)for(let ix=1;ix<g.nx-1;ix+=4){
        const i=iz*g.nx+ix;
        if(!(d.arrays.flags[i]&1)||(d.arrays.flags[i]&6))continue;
        const x=((ix+.5)/g.nx-.5)*g.EW,z=((iz+.5)/g.ny-.5)*g.EH;
        const depth=queryFloodDepth(d,x,z,0).depth;
        maxError=Math.max(maxError,Math.abs(depth+d.arrays.need[i]));
        contextError=Math.max(contextError,Math.abs(depth-__fv.contextLayers.floodDepthAt(x,z)));
        count++;
      }
      return {count,maxError,contextError};
    }""")
    assert parity["count"] > 20000 and parity["maxError"] < 1e-8 and parity["contextError"] == 0, parity

    # Cached geometry samples must not read rasters again while the level moves.
    # Also prove invalidation when a different dataset object is supplied.
    cache = page.evaluate("""async () => {
      const { ContextLayers } = await import('./js/context-layers.js');
      let reads = 0;
      const track = a => new Proxy(a, {get(t, k) { if (/^\\d+$/.test(String(k))) reads++; return t[k]; }});
      const dataset = {grid:{nx:2,ny:2,EW:4,EH:4},meta:{wsurfGrid:{nx:1,ny:1}},arrays:{
        terrain:track([2,2,2,2]),need:track([-3,-3,-3,-3]),
        flags:track([1,1,1,1]),wsurf:track([1])}};
      const state = {waterOffset:0};
      const layer = new ContextLayers({dataset,state});
      const points = [[-1,-1],[1,-1],[1,1]];
      const a = layer.sampleFeatureFlood(points, true);
      const coldReads = reads;
      state.waterOffset = 1;
      const b = layer.sampleFeatureFlood(points, true);
      const warmReads = reads - coldReads;
      layer.dataset = {...dataset, arrays:{...dataset.arrays, need:track([-4,-4,-4,-4])}};
      const c = layer.sampleFeatureFlood(points, true);
      layer.dispose();
      return {coldReads,warmReads,depths:[a.maxDepth,b.maxDepth,c.maxDepth]};
    }""")
    assert cache["coldReads"] > 0 and cache["warmReads"] == 0, cache
    assert cache["depths"] == [3, 4, 5], cache

    # Multiple real input events in one JS task must cause one recolour at render.
    updates = page.evaluate("""async () => {
      await new Promise(requestAnimationFrame);
      const layer=__fv.contextLayers, original=layer.updateFloodState;
      let calls=0;
      layer.updateFloodState=function(...args){calls++;return original.apply(this,args);};
      const slider=document.querySelector('input[type=range]');
      for(let i=1;i<=20;i++){slider.value=String(i/20);slider.dispatchEvent(new Event('input',{bubbles:true}));}
      const beforeRender=calls;
      __fv.renderOnce();
      const afterRender=calls;
      layer.updateFloodState=original;
      return {events:20,beforeRender,afterRender,offset:__fv.state.waterOffset};
    }""")
    assert updates == {"events": 20, "beforeRender": 0, "afterRender": 1, "offset": 1}, updates
    assert abs(depth() - baseline - 1) < 0.011
    page.screenshot(path=str(out / "selected-point.png"))
    page.get_by_role("button", name="Close query").click()
    slider.fill("0")
    assert not query.is_visible(), "Slider reopened a dismissed query"

    # Slider updates must not steal the mobile tab from the user's controls.
    page.set_viewport_size({"width": 390, "height": 844})
    page.mouse.click(195, 280)
    assert query.is_visible(), "Mobile point query did not open"
    page.get_by_role("tab", name="Controls", exact=True).click()
    slider.fill("0.5")
    assert page.locator(".fv-ui").get_attribute("data-tab") == "controls"
    page.screenshot(path=str(out / "mobile-controls.png"))
    page.get_by_role("button", name="Context layers", exact=False).last.click()
    page.get_by_role("checkbox", name="Population density", exact=True).check()
    population = page.evaluate("""() => ({
      source:__fv.contextLayers.data.population.source,
      year:__fv.contextLayers.data.population.year,
      cells:__fv.contextLayers.data.population.cells.length,
      vertices:__fv.contextLayers.objects.population.geometry.attributes.position.count,
      visible:__fv.contextLayers.objects.population.visible,
      legendHidden:document.querySelector('.fv-population-legend').hidden,
    })""")
    assert population["source"] == "WorldPop Global2 R2025A v1" and population["year"] == 2021
    assert population["visible"] and not population["legendHidden"]
    assert population["vertices"] == population["cells"] * 4
    page.get_by_role("tab", name="Legend", exact=True).click()
    assert "Estimated people/km²" in page.locator(".fv-population-legend").inner_text()
    page.screenshot(path=str(out / "worldpop-mobile.png"))
    page.set_viewport_size({"width": 1440, "height": 900})
    page.screenshot(path=str(out / "worldpop-desktop.png"))
    assert not errors, errors
    result = {"baselineDepth": baseline, "parity": parity, "cache": cache,
              "coalescing": updates, "population": population, "pageErrors": errors}
    (out / "result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    browser.close()
