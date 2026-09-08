import { AUSTRALIA_BOUNDS, projectedPosition, projectedDirection, cesiumFov } from './basemap-transform.js';

const RUNTIME = new URL('../vendor/cesium/', import.meta.url).href;
const TILES = 'https://services.ga.gov.au/gis/rest/services/NationalBaseMap/MapServer/tile/{z}/{y}/{x}';
let loading;

function loadCesium() {
  if (window.Cesium) return Promise.resolve(window.Cesium);
  if (loading) return loading;
  window.CESIUM_BASE_URL = RUNTIME;
  loading = new Promise((resolve, reject) => {
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = RUNTIME + 'Widgets/widgets.css';
    document.head.appendChild(style);
    const script = document.createElement('script');
    script.src = RUNTIME + 'Cesium.js';
    script.onload = () => resolve(window.Cesium);
    script.onerror = () => { loading = null; reject(new Error('The local basemap renderer could not load')); };
    document.head.appendChild(script);
  });
  return loading;
}

/** Cesium draws only a flat Australian imagery plane. Three.js owns all input,
 * terrain, buildings and water, with its own depth buffer above this canvas.
 */
export async function createBasemap({ meta, onStatus = () => {} }) {
  const C = await loadCesium();
  const container = document.createElement('div');
  container.className = 'fv-basemap';
  container.setAttribute('aria-hidden', 'true');
  const credits = document.createElement('div');
  credits.className = 'fv-basemap-credits';
  document.body.prepend(container);
  document.body.appendChild(credits);
  let widget;
  try {
    widget = new C.CesiumWidget(container, {
      baseLayer: false,
      terrainProvider: new C.EllipsoidTerrainProvider(),
      sceneMode: C.SceneMode.COLUMBUS_VIEW,
      mapProjection: new C.WebMercatorProjection(),
      useDefaultRenderLoop: false,
      requestRenderMode: true,
      maximumRenderTimeChange: Infinity,
      skyBox: false, skyAtmosphere: false, sun: false, moon: false,
      orderIndependentTranslucency: false,
      creditContainer: credits,
      contextOptions: { webgl: { alpha: false, antialias: false, preserveDrawingBuffer: true } },
    });
    const scene = widget.scene;
    const rectangle = C.Rectangle.fromDegrees(...AUSTRALIA_BOUNDS);
    scene.screenSpaceCameraController.enableInputs = false;
    scene.globe.cartographicLimitRectangle = rectangle;
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.showWaterEffect = false;
    scene.globe.depthTestAgainstTerrain = false;
    scene.globe.maximumScreenSpaceError = 3;
    scene.globe.tileCacheSize = 80;
    scene.globe.baseColor = C.Color.fromCssColorString('#233642');
    scene.backgroundColor = C.Color.fromCssColorString('#152530');
    const provider = new C.UrlTemplateImageryProvider({
      url: TILES,
      tilingScheme: new C.WebMercatorTilingScheme(),
      rectangle, maximumLevel: 18,
      credit: new C.Credit('<a href="https://services.ga.gov.au/gis/rest/services/NationalBaseMap/MapServer" target="_blank" rel="noopener">Geoscience Australia</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>', true),
    });
    scene.imageryLayers.addImageryProvider(provider);
    let visible = true, failed = false, renderedFrames = 0, cameraUpdates = 0;
    let lastCamera = '';
    let tileError = false;
    provider.errorEvent.addEventListener(() => {
      tileError = true;
      onStatus('Basemap tiles unavailable · flood data remains local', 'error');
    });
    scene.renderError.addEventListener((_scene, error) => {
      failed = true;
      onStatus('Basemap renderer unavailable', 'error');
      console.warn('[flood-basemap]', error.message);
    });
    scene.postRender.addEventListener(() => { renderedFrames++; });
    scene.globe.tileLoadProgressEvent.addEventListener((pending) => {
      if (!tileError) onStatus(pending ? 'Loading Australia basemap…' : 'Australia basemap', pending ? 'loading' : 'ready');
    });
    widget.resolutionScale = 1;
    widget.resize();
    // Establish Columbus View's camera reference frame before copying the
    // viewer's camera. No private Cesium transform/renderer APIs are used.
    widget.render();
    return {
      canvas: widget.canvas,
      get active() { return visible && !failed; },
      get debug() { return { mode: scene.mode,
        terrainProvider: scene.globe.terrainProvider instanceof C.EllipsoidTerrainProvider ? 'ellipsoid-flat' : 'unexpected',
        tileSource: TILES, renderedFrames, cameraUpdates, tileError, failed, visible }; },
      project(lon, lat, height = 0) {
        const point = C.SceneTransforms.worldToWindowCoordinates(scene, C.Cartesian3.fromDegrees(lon, lat, height));
        return point ? [point.x, point.y] : null;
      },
      sync(camera) {
        if (!visible || failed) return;
        camera.updateMatrixWorld();
        const signature = camera.matrixWorld.elements.join(',') + '|' + camera.projectionMatrix.elements.join(',');
        if (signature === lastCamera) return;
        lastCamera = signature;
        cameraUpdates++;
        const m = camera.matrixWorld.elements;
        const direction = { x: -m[8], y: -m[9], z: -m[10] };
        const up = { x: m[4], y: m[5], z: m[6] };
        const target = scene.camera;
        target.position = new C.Cartesian3(...projectedPosition(camera.position, meta.extent));
        target.direction = new C.Cartesian3(...projectedDirection(direction));
        target.up = new C.Cartesian3(...projectedDirection(up));
        C.Cartesian3.cross(target.direction, target.up, target.right);
        target.frustum.fov = cesiumFov(camera.fov, camera.aspect);
        target.frustum.aspectRatio = camera.aspect;
        target.frustum.near = camera.near;
        target.frustum.far = camera.far;
        scene.requestRender();
      },
      render(force = false) {
        if (!visible || failed) return;
        if (force) scene.requestRender();
        widget.render();
      },
      resize() { widget.resize(); scene.requestRender(); },
      setVisible(value) {
        visible = value;
        container.hidden = credits.hidden = !visible;
        if (visible) { lastCamera = ''; scene.requestRender(); }
      },
      dispose() { widget.destroy(); container.remove(); credits.remove(); },
    };
  } catch (error) {
    if (widget && !widget.isDestroyed()) widget.destroy();
    container.remove(); credits.remove();
    throw error;
  }
}
