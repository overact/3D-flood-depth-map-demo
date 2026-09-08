import { projectedPosition, projectedDirection, cesiumFov } from './basemap-transform.js';

const RUNTIME = new URL('../vendor/cesium/', import.meta.url).href;
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

/** Cesium draws only a flat global imagery plane. Three.js owns all input,
 * terrain, buildings and water, with its own depth buffer above this canvas.
 */
export async function createBasemap({ meta, onStatus = () => {} }) {
  const [C, config] = await Promise.all([loadCesium(), fetch(new URL('../data/basemap.json', import.meta.url))
    .then(response => { if (!response.ok) throw new Error('Basemap configuration unavailable'); return response.json(); })]);
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
    const tilingScheme = new C.WebMercatorTilingScheme();
    const rectangle = tilingScheme.rectangle;
    scene.screenSpaceCameraController.enableInputs = false;
    scene.globe.cartographicLimitRectangle = rectangle;
    scene.globe.enableLighting = false;
    scene.globe.showGroundAtmosphere = false;
    scene.globe.showWaterEffect = false;
    scene.globe.depthTestAgainstTerrain = false;
    scene.globe.maximumScreenSpaceError = config.maximumScreenSpaceError;
    scene.globe.tileCacheSize = config.tileCacheSize;
    scene.globe.preloadAncestors = false;
    scene.globe.preloadSiblings = false;
    scene.globe.loadingDescendantLimit = 8;
    const host = new URL(config.url);
    C.RequestScheduler.requestsByServer[host.hostname + ':' + (host.port || (host.protocol === 'https:' ? '443' : '80'))]
      = config.maximumRequestsPerServer;
    scene.globe.baseColor = C.Color.fromCssColorString('#233642');
    scene.backgroundColor = C.Color.fromCssColorString('#152530');
    const provider = new C.UrlTemplateImageryProvider({
      url: config.url, tilingScheme, rectangle,
      minimumLevel: config.minimumLevel, maximumLevel: config.maximumLevel,
      hasAlphaChannel: false, enablePickFeatures: false,
      credit: new C.Credit(config.creditHtml, true),
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
      if (!tileError) onStatus(pending ? 'Loading map tiles…' : 'Global basemap · ' + config.name, pending ? 'loading' : 'ready');
    });
    widget.resolutionScale = 1;
    widget.resize();
    // Establish Columbus View's camera reference frame before copying the
    // viewer's camera. No private Cesium transform/renderer APIs are used.
    scene.globe.show = false; // establish the camera without requesting an unrelated default view
    widget.render();
    scene.globe.show = true;
    return {
      canvas: widget.canvas,
      exportCredit: config.exportCredit,
      get active() { return visible && !failed; },
      get debug() { return { mode: scene.mode,
        terrainProvider: scene.globe.terrainProvider instanceof C.EllipsoidTerrainProvider ? 'ellipsoid-flat' : 'unexpected',
        tileSource: config.url, minimumLevel: provider.minimumLevel, maximumLevel: provider.maximumLevel,
        tileCacheSize: scene.globe.tileCacheSize, preloadAncestors: scene.globe.preloadAncestors,
        preloadSiblings: scene.globe.preloadSiblings, maximumRequestsPerServer: config.maximumRequestsPerServer,
        renderedFrames, cameraUpdates, tileError, failed, visible }; },
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
