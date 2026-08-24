/**
 * js/ui.js — section 5 of the implementation contract.
 *
 * Owns every piece of DOM chrome that sits on top of the WebGL canvas:
 *
 *   · lil-gui control panel   (folders: water level / light & terrain /
 *                              water material / display / context layers)
 *   · a hero "Δ water level" scrubber pinned to the bottom of the viewport
 *   · the Blues depth legend (0 → 2.5 m, exactly the published ramp)
 *   · the flood statistics card
 *   · the click-query card
 *   · title / credit block + "About the data" expander
 *   · keyboard-shortcut popover
 *   · determinate loading overlay
 *
 * Public API (contract §5):
 *
 *   createUI({ state, onChange, onAction, meta })
 *     -> { setStats, setQuery, setStatus, gui, state, refresh, dispose, root }
 *
 * Only `state` is mutated in place; every mutation is followed by
 * `onChange(key, value)`. Buttons and keys go through `onAction(name)`.
 *
 * Styling: all rules live in a single stylesheet that this module injects as the
 * FIRST child of <head>, so a later-loaded style.css always wins on equal
 * specificity and the integrator can restyle or fully replace any `fv-` rule.
 * Colours are CSS custom properties on :root. The only per-element inline
 * declarations are genuinely dynamic ones, and they are all custom properties
 * (--fv-ramp, --fv-p, --fv-mk, --fv-swatch) consumed by the stylesheet.
 */

import * as LilGUI from 'three/addons/libs/lil-gui.module.min.js';

// lil-gui ships GUI as a named export; some builds also expose it as default.
const GUI = LilGUI.GUI || LilGUI.default;

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * The nine ColorBrewer "Blues" anchors, i.e. matplotlib's `Blues` colormap
 * sampled at 0, 1/8 … 1. The published figure uses this ramp over 0–2.5 m of
 * water depth, so the legend, the query-card swatch and the water shader
 * (uScience) must all agree on these exact hex values.
 */
const BLUES = [
  '#f7fbff', '#deebf7', '#c6dbef', '#9ecae1', '#6baed6',
  '#4292c6', '#2171b5', '#08519c', '#08306b'
];

/** Contract §5 defaults — filled in for any key `main.js` left undefined. */
const STATE_DEFAULTS = {
  waterOffset: 0,
  vertExag: 8,
  sunAzimuth: 135,
  sunElevation: 32,
  waveAmp: 1,
  turbidity: 1,
  foam: 1,
  science: false,
  showWater: true,
  showBuildings: true,
  showRoads: true,
  showOsmWater: false,
  showPopulation: false,
  autoRotate: false,
  quality: 'high'
};

/** Water-level slider domain (metres). Shared by lil-gui and the scrubber. */
const OFFSET_MIN = -3;
const OFFSET_MAX = 5;
const OFFSET_STEP = 0.05;

/** Top of the depth colour ramp, in metres (meta.rampMax, kept as a fallback). */
const RAMP_MAX_FALLBACK = 2.5;

/**
 * If nobody calls setStatus() for this long the overlay lets go of the screen.
 * Must comfortably exceed the longest gap between two progress callbacks —
 * data.js reports once per file and terrain.u16.gz alone is 3 MB, which is well
 * over half a minute on a poor mobile link.
 */
const OVERLAY_WATCHDOG_MS = 60000;

/** Overlay fade-out, ms. Kept in step with the CSS transition on .fv-overlay. */
const OVERLAY_FADE_MS = 240;

const STYLE_ID = 'fv-ui-style';

/**
 * Skip purely decorative fades when the page is driven by automation (the
 * headless screenshot test in contract §6 grabs the frame immediately after
 * main.js calls setStatus(null) — a 0.2 s fade would still be at full opacity
 * and the splash would land in the screenshot) or when the user asked for
 * reduced motion.
 */
const NO_ANIM = (() => {
  try {
    if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
    return !!(typeof window !== 'undefined' && window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch (e) {
    return false;
  }
})();

/* ------------------------------------------------------------------ *
 * Tiny DOM helpers
 * ------------------------------------------------------------------ */

function h(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function add(parent, ...kids) {
  for (const k of kids) if (k) parent.appendChild(k);
  return parent;
}

function attrs(node, map) {
  for (const k in map) {
    const v = map[k];
    if (v === false || v == null) node.removeAttribute(k);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  return node;
}

/** Inline SVG icon. `d` is one or more path commands; 24x24 viewBox, stroked. */
function icon(...d) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '17');
  svg.setAttribute('height', '17');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const spec of d) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', spec);
    svg.appendChild(p);
  }
  return svg;
}

const ICON_EYE = ['M2.2 12S6 5.5 12 5.5 21.8 12 21.8 12 18 18.5 12 18.5 2.2 12 2.2 12Z', 'M12 9.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2Z'];
const ICON_EYE_OFF = ['M3 3l18 18', 'M10.6 6.1A9.9 9.9 0 0 1 12 6c6 0 9.8 6 9.8 6a18 18 0 0 1-3.3 3.9', 'M6.4 8.2A18 18 0 0 0 2.2 12S6 18 12 18a9.6 9.6 0 0 0 3.5-.65'];

/**
 * The narrow-viewport chrome is a bottom drawer, and everything about it —
 * which cards are reachable, whether the drawer is open — has to agree with
 * the CSS breakpoint in style.css. One source of truth, matched here.
 */
const MOBILE_QUERY = '(max-width: 860px)';
function isNarrow() {
  return typeof matchMedia === 'function' && matchMedia(MOBILE_QUERY).matches;
}

/* ------------------------------------------------------------------ *
 * Formatting — every number the user reads goes through here so the
 * decimal count is stable and the glyphs are tabular (no jitter while
 * the slider is being dragged).
 * ------------------------------------------------------------------ */

const DASH = '—';

function fixed(v, d) {
  return Number.isFinite(v) ? v.toFixed(d) : DASH;
}

/** Always-signed fixed format: "+0.00" / "-1.25" (ASCII sign keeps widths equal). */
function signedFixed(v, d) {
  if (!Number.isFinite(v)) return DASH;
  const s = v < 0 ? '-' : '+';
  // -0 must print as +0.00, not -0.00.
  const a = Math.abs(v);
  return s + a.toFixed(d);
}

/* ------------------------------------------------------------------ *
 * Blues ramp evaluation (JS mirror of the shader / CSS gradient)
 * ------------------------------------------------------------------ */

const BLUES_RGB = BLUES.map((hex) => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16)
]);

/**
 * Piecewise-linear interpolation of the Blues anchors at t ∈ [0,1].
 * Interpolation happens in plain sRGB byte space on purpose: that is exactly
 * what the CSS `linear-gradient` in the legend does, so the swatch on the query
 * card and the position on the legend bar are guaranteed to match pixel-wise.
 */
function bluesAt(t) {
  const u = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0)) * (BLUES_RGB.length - 1);
  const i = Math.min(BLUES_RGB.length - 2, Math.floor(u));
  const f = u - i;
  const a = BLUES_RGB[i];
  const b = BLUES_RGB[i + 1];
  const c = [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f)
  ];
  return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')';
}

/* ------------------------------------------------------------------ *
 * Stylesheet
 * ------------------------------------------------------------------ */

const CSS = `
/* ============================================================
   Kempsey 3D Flood Viewer — UI chrome (js/ui.js)
   Injected first in <head> so style.css can override anything.
   ============================================================ */
/* ---- integrator fallbacks ---------------------------------
   index.html links ./style.css. If that file is missing (or has
   not been written yet) the page would otherwise show the UA's
   8 px body margin, scrollbars and an inline-layout gap under
   the canvas. These four rules are the only non-".fv-" selectors
   in this sheet; style.css loads afterwards and overrides them.  */
html,body{ margin:0; padding:0; height:100%; }
body{ overflow:hidden; background:#0e1a26; }
canvas.fv-canvas{ display:block; position:fixed; left:0; top:0; }
.fv-fatal{                                  /* main.js's init-failure <pre> */
  position:fixed; z-index:20; left:14px; right:14px; bottom:14px;
  max-height:60vh; overflow:auto; margin:0; padding:12px 14px;
  border-radius:6px; background:rgba(251,253,255,.975);
  border:1px solid rgba(18,38,60,.14); box-shadow:0 10px 28px rgba(10,25,45,.13);
  color:#8f1d1d; font:11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  white-space:pre-wrap;
}

:root{
  --fv-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue",
             "Noto Sans SC", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
  --fv-mono: ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono",
             "Roboto Mono", Menlo, Consolas, monospace;
  --fv-ink: #17222e;
  --fv-ink-soft: #57646f;
  --fv-ink-faint: #8b97a3;
  --fv-panel: rgba(251,253,255,.90);
  --fv-panel-strong: rgba(251,253,255,.975);
  --fv-line: rgba(18,38,60,.14);
  --fv-line-soft: rgba(18,38,60,.07);
  --fv-accent: #2171b5;
  --fv-accent-deep: #08306b;
  --fv-accent-soft: rgba(33,113,181,.12);
  --fv-shadow: 0 1px 2px rgba(10,25,45,.10), 0 10px 28px rgba(10,25,45,.13);
  --fv-radius: 6px;
  --fv-gap: 10px;
  --fv-sheet-h: 40px;
}

/* ---- root ------------------------------------------------- */
.fv-ui{
  position:fixed; inset:0; z-index:10;
  pointer-events:none;
  font-family:var(--fv-sans); color:var(--fv-ink);
  font-size:12px; line-height:1.45;
  -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
}
.fv-ui *{ box-sizing:border-box; }
.fv-ui button,.fv-ui input,.fv-ui select,.fv-ui summary{ font-family:inherit; color:inherit; }
.fv-ui a{ color:var(--fv-accent); text-decoration:none; border-bottom:1px solid rgba(33,113,181,.35); }
.fv-ui a:hover{ border-bottom-color:var(--fv-accent); }
.fv-ui :focus-visible{ outline:2px solid var(--fv-accent); outline-offset:2px; border-radius:3px; }

/* ---- layout zones -----------------------------------------
   Position is a ZONE concern, never a card concern: .fv-panel is a skin and
   (in style.css) carries position:relative, so any card that positioned
   itself would lose the cascade to it. Every card therefore sits in a zone. */
.fv-zone{ position:absolute; display:flex; flex-direction:column; gap:var(--fv-gap); }
.fv-zone > *{ pointer-events:auto; }
.fv-zone--tl{ top:14px; left:14px; width:322px; max-height:calc(100% - 28px); overflow-y:auto; overflow-x:hidden; }
.fv-zone--tr{ top:14px; right:14px; width:272px; align-items:flex-end; }
.fv-zone--bl{ left:14px; bottom:14px; width:270px; align-items:stretch; justify-content:flex-end; }
.fv-zone--br{ right:14px; bottom:14px; align-items:flex-end; }
/* bottom centre: the hero water-level scrubber */
.fv-zone--bc{
  left:50%; bottom:14px; transform:translateX(-50%);
  width:min(520px, 42vw); min-width:300px;
  max-width:calc(100vw - 596px);   /* stay clear of the bl / br columns */
  align-items:stretch;
}
.fv-zone--tl::-webkit-scrollbar{ width:6px; }
.fv-zone--tl::-webkit-scrollbar-thumb{ background:var(--fv-line); border-radius:3px; }

/* ---- generic panel ---------------------------------------- */
.fv-panel{
  background:var(--fv-panel);
  -webkit-backdrop-filter:blur(12px) saturate(1.15);
  backdrop-filter:blur(12px) saturate(1.15);
  border:1px solid var(--fv-line);
  border-radius:var(--fv-radius);
  box-shadow:var(--fv-shadow);
}
.fv-head{
  display:flex; align-items:baseline; justify-content:space-between; gap:10px;
  padding:7px 10px 6px; border-bottom:1px solid var(--fv-line-soft);
}
.fv-head-zh{ font-size:12px; font-weight:650; letter-spacing:.01em; }
.fv-head-en{ font-size:9.5px; color:var(--fv-ink-faint); text-transform:uppercase; letter-spacing:.09em; white-space:nowrap; }
.fv-body{ padding:6px 0 8px; }
.fv-note{ padding:2px 10px 0; font-size:10px; line-height:1.5; color:var(--fv-ink-faint); }

/* ---- key/value rows --------------------------------------- */
.fv-row{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; padding:2.5px 10px; }
.fv-row-label{ font-size:11px; color:var(--fv-ink-soft); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.fv-row-label i{ font-style:normal; color:var(--fv-ink-faint); }
.fv-row-val{
  font-family:var(--fv-mono); font-variant-numeric:tabular-nums; font-feature-settings:"tnum" 1;
  font-size:12.5px; font-weight:600; text-align:right; white-space:nowrap; letter-spacing:-.01em;
}
.fv-row-unit{ font-size:9.5px; font-weight:400; color:var(--fv-ink-faint); margin-left:4px; }
.fv-row--hero .fv-row-val{ font-size:15px; color:var(--fv-accent-deep); }
.fv-sub{
  padding:0 10px 3px; text-align:right; font-size:10px; color:var(--fv-ink-faint);
  font-family:var(--fv-mono); font-variant-numeric:tabular-nums;
}
.fv-sub[hidden]{ display:none; }
.fv-rule{ height:1px; margin:5px 10px; background:var(--fv-line-soft); }

/* ---- title / credit --------------------------------------- */
.fv-title{ padding:11px 12px 10px; }
.fv-eyebrow{ font-size:9.5px; letter-spacing:.16em; text-transform:uppercase; color:var(--fv-accent); font-weight:600; }
.fv-title h1{ margin:3px 0 1px; font-size:17px; font-weight:680; letter-spacing:.01em; line-height:1.2; }
.fv-title h2{ margin:0 0 7px; font-size:11px; font-weight:500; color:var(--fv-ink-soft); letter-spacing:.02em; }
.fv-title-src{ font-size:10.5px; color:var(--fv-ink-soft); line-height:1.5; }
.fv-credit{ margin-top:7px; padding-top:7px; border-top:1px solid var(--fv-line-soft); font-size:10.5px; color:var(--fv-ink-soft); line-height:1.55; }
.fv-credit-doi{ font-family:var(--fv-mono); font-size:10px; }

/* ---- about expander --------------------------------------- */
.fv-about{ margin-top:8px; border-top:1px solid var(--fv-line-soft); padding-top:6px; }
.fv-about > summary{
  cursor:pointer; list-style:none; font-size:10.5px; font-weight:600; color:var(--fv-accent);
  display:flex; align-items:center; gap:5px; user-select:none;
}
.fv-about > summary::-webkit-details-marker{ display:none; }
.fv-about > summary::before{
  content:""; width:0; height:0; border-left:4px solid currentColor;
  border-top:3.5px solid transparent; border-bottom:3.5px solid transparent;
  transition:transform .15s ease; transform-origin:2px 50%;
}
.fv-about[open] > summary::before{ transform:rotate(90deg); }
.fv-about-body{ padding:6px 0 1px; font-size:10.5px; line-height:1.62; color:var(--fv-ink-soft); }
.fv-about-body p{ margin:0 0 5px; }
.fv-about-body b{ font-weight:640; color:var(--fv-ink); }
.fv-about-body code{ font-family:var(--fv-mono); font-size:9.5px; background:var(--fv-accent-soft); padding:0 3px; border-radius:3px; }
.fv-facts{
  margin-top:6px; padding-top:6px; border-top:1px solid var(--fv-line-soft);
  font-family:var(--fv-mono); font-variant-numeric:tabular-nums; font-size:9.5px;
  color:var(--fv-ink-faint); line-height:1.7;
}

/* ---- toolbar buttons -------------------------------------- */
.fv-toolbar{ display:flex; gap:6px; }
.fv-btn{
  pointer-events:auto; cursor:pointer;
  background:var(--fv-panel); border:1px solid var(--fv-line); border-radius:var(--fv-radius);
  box-shadow:var(--fv-shadow); -webkit-backdrop-filter:blur(12px); backdrop-filter:blur(12px);
  padding:4px 9px; font-size:11px; font-weight:560; color:var(--fv-ink-soft);
  display:inline-flex; align-items:center; gap:5px; transition:color .12s, border-color .12s;
}
.fv-btn:hover{ color:var(--fv-accent); border-color:rgba(33,113,181,.45); }
.fv-btn[aria-expanded="true"], .fv-btn.fv-btn--on{ color:var(--fv-accent); border-color:rgba(33,113,181,.55); background:var(--fv-panel-strong); }
.fv-btn kbd{ font-family:var(--fv-mono); font-size:9px; color:var(--fv-ink-faint); }

/* ---- lil-gui host / bottom sheet -------------------------- */
.fv-sheet{ width:100%; }
.fv-sheet-head{ display:none; }
.fv-gui-host{ width:100%; }
.fv-gui-host .lil-gui{
  --background-color: rgba(251,253,255,.92);
  --text-color: #17222e;
  --title-background-color: rgba(232,239,246,.94);
  --title-text-color: #10263c;
  --widget-color: rgba(18,44,74,.09);
  --hover-color: rgba(18,44,74,.15);
  --focus-color: rgba(33,113,181,.30);
  --number-color: #08519c;
  --string-color: #2171b5;
  --font-size: 11px;
  --input-font-size: 11px;
  --font-family: var(--fv-sans);
  --font-family-mono: var(--fv-mono);
  --padding: 5px;
  --spacing: 5px;
  --widget-height: 18px;
  --name-width: 62%;
  --width: 100%;
  width:100%;
  border-radius:var(--fv-radius);
  border:1px solid var(--fv-line);
  box-shadow:var(--fv-shadow);
  -webkit-backdrop-filter:blur(12px) saturate(1.15);
  backdrop-filter:blur(12px) saturate(1.15);
  overflow:hidden;
}
.fv-gui-host .lil-gui .title{ font-weight:620; letter-spacing:.01em; }
.fv-gui-host .lil-gui .controller .name{ color:var(--fv-ink-soft); }
.fv-gui-host .lil-gui input,
.fv-gui-host .lil-gui .display{ font-variant-numeric:tabular-nums; }

/* ---- depth legend ----------------------------------------- */
.fv-legend{ padding:8px 10px 9px; width:132px; opacity:.82; transition:opacity .2s, border-color .2s, box-shadow .2s; }
.fv-legend--active{ opacity:1; border-color:rgba(33,113,181,.55); box-shadow:var(--fv-shadow), 0 0 0 2px var(--fv-accent-soft); }
.fv-legend-title{ font-size:11px; font-weight:620; }
.fv-legend-sub{ font-size:9.5px; color:var(--fv-ink-faint); text-transform:uppercase; letter-spacing:.07em; margin-bottom:7px; }
/* The bar is the card's flexible part: it shrinks on short viewports so the
   whole legend (title + ramp + footnote) always fits above the bottom edge. */
.fv-legend-scale{ position:relative; display:flex; gap:7px; height:clamp(112px, 21vh, 168px); }
.fv-legend-bar{
  position:relative; width:15px; flex:0 0 15px; border-radius:2px;
  border:1px solid var(--fv-line);
  background-image:var(--fv-ramp);
}
.fv-legend-marker{
  position:absolute; left:-4px; right:-4px; bottom:calc(var(--fv-mk, 0) * 100%);
  height:0; border-top:1.5px solid var(--fv-ink); opacity:.9;
  transform:translateY(.75px); pointer-events:none;
}
.fv-legend-marker::after{
  content:""; position:absolute; left:-4px; top:-3.5px;
  border-left:5px solid var(--fv-ink); border-top:3.5px solid transparent; border-bottom:3.5px solid transparent;
}
.fv-legend-marker[hidden]{ display:none; }
.fv-legend-ticks{ position:relative; flex:1 1 auto; }
.fv-legend-tick{
  position:absolute; left:0; bottom:calc(var(--fv-t, 0) * 100%); transform:translateY(50%);
  font-family:var(--fv-mono); font-variant-numeric:tabular-nums; font-size:9.5px; color:var(--fv-ink-soft);
  white-space:nowrap;
}
.fv-legend-tick::before{
  content:""; position:absolute; left:-6px; top:50%; width:4px; height:1px; background:var(--fv-line);
}
.fv-legend-foot{ margin-top:7px; font-size:9px; line-height:1.45; color:var(--fv-ink-faint); }

/* ---- flood statistics ------------------------------------- */
.fv-stats .fv-row-val{ min-width:74px; }

/* ---- click query ------------------------------------------ */
.fv-query[hidden]{ display:none; }
.fv-query .fv-head{ padding-right:6px; }
.fv-query-close{
  cursor:pointer; border:0; background:transparent; color:var(--fv-ink-faint);
  font-size:14px; line-height:1; padding:2px 4px; border-radius:3px;
}
.fv-query-close:hover{ color:var(--fv-ink); background:var(--fv-line-soft); }
.fv-swatch{
  display:inline-block; width:9px; height:9px; border-radius:2px; margin-right:5px;
  border:1px solid var(--fv-line); background:var(--fv-swatch, transparent);
  vertical-align:baseline;
}
.fv-dry{ padding:2px 10px 4px; font-size:10.5px; color:var(--fv-ink-faint); }
.fv-dry[hidden]{ display:none; }
.fv-tags{ display:flex; flex-wrap:wrap; gap:4px; padding:3px 10px 1px; }
.fv-tags:empty{ display:none; }
.fv-tag{
  font-size:9px; line-height:1.6; padding:0 6px; border-radius:99px;
  border:1px solid var(--fv-line); color:var(--fv-ink-soft); background:rgba(18,38,60,.04);
}
.fv-tag[hidden]{ display:none; }
.fv-tag--obs{ color:var(--fv-accent-deep); border-color:rgba(33,113,181,.42); background:var(--fv-accent-soft); }

/* ---- water-level scrubber ---------------------------------
   Layout (bottom centre) belongs to .fv-zone--bc; this is only the card. */
.fv-scrub{
  width:100%; pointer-events:auto;
  padding:8px 13px 9px;
}
.fv-scrub-head{ display:flex; align-items:baseline; justify-content:space-between; gap:10px; }
.fv-scrub-label{ font-size:11px; font-weight:620; }
.fv-scrub-label i{ font-style:normal; font-weight:400; color:var(--fv-ink-faint); }
.fv-scrub-val{
  font-family:var(--fv-mono); font-variant-numeric:tabular-nums;
  font-size:15px; font-weight:660; color:var(--fv-accent-deep); letter-spacing:-.01em;
}
.fv-scrub-val span{ font-size:10px; font-weight:400; color:var(--fv-ink-faint); margin-left:3px; }
.fv-range{
  -webkit-appearance:none; appearance:none; width:100%; height:16px;
  margin:5px 0 0; background:transparent; cursor:ew-resize; display:block;
}
.fv-range::-webkit-slider-runnable-track{
  height:3px; border-radius:2px;
  background:linear-gradient(to right,
    var(--fv-accent) 0 calc(var(--fv-p, .375) * 100%),
    var(--fv-line) calc(var(--fv-p, .375) * 100%) 100%);
}
.fv-range::-moz-range-track{ height:3px; border-radius:2px; background:var(--fv-line); }
.fv-range::-moz-range-progress{ height:3px; border-radius:2px; background:var(--fv-accent); }
.fv-range::-webkit-slider-thumb{
  -webkit-appearance:none; appearance:none; width:13px; height:13px; margin-top:-5px;
  border-radius:50%; background:#fff; border:2px solid var(--fv-accent);
  box-shadow:0 1px 3px rgba(10,25,45,.35);
}
.fv-range::-moz-range-thumb{
  width:11px; height:11px; border-radius:50%; background:#fff;
  border:2px solid var(--fv-accent); box-shadow:0 1px 3px rgba(10,25,45,.35);
}
.fv-scrub-axis{ position:relative; height:12px; margin-top:1px; }
.fv-scrub-tick{
  position:absolute; left:calc(var(--fv-t, 0) * 100%); transform:translateX(-50%);
  font-family:var(--fv-mono); font-variant-numeric:tabular-nums; font-size:9px; color:var(--fv-ink-faint);
  white-space:nowrap;
}
.fv-scrub-tick--zero{ color:var(--fv-accent); font-weight:600; }
.fv-scrub-tick::before{
  content:""; position:absolute; left:50%; top:-4px; width:1px; height:3px; background:var(--fv-line);
}

/* ---- transient status line -------------------------------- */
.fv-status{
  position:absolute; left:50%; bottom:102px; transform:translateX(-50%);
  pointer-events:none; padding:4px 11px; border-radius:99px;
  background:rgba(23,34,46,.86); color:#eef4fa; font-size:11px; letter-spacing:.01em;
  box-shadow:0 6px 18px rgba(10,25,45,.28);
  opacity:0; transition:opacity .18s ease;
}
.fv-status--on{ opacity:1; }

/* ---- loading overlay -------------------------------------- */
.fv-overlay{
  /* z-index: the narrow-viewport bottom sheet is position:fixed with z-index 2,
     so without this it would paint on top of the splash and the help dialog. */
  position:absolute; inset:0; z-index:8; pointer-events:auto;
  display:flex; align-items:center; justify-content:center;
  background:radial-gradient(120% 90% at 50% 42%, rgba(238,244,250,.94), rgba(214,226,238,.97));
  opacity:1; transition:opacity .22s ease;
}
.fv-overlay[hidden]{ display:none; }
.fv-overlay--out{ opacity:0; }
.fv-overlay-card{ width:min(340px, 78vw); text-align:left; }
.fv-overlay-eyebrow{ font-size:9.5px; letter-spacing:.17em; text-transform:uppercase; color:var(--fv-accent); font-weight:600; }
.fv-overlay-title{ margin:4px 0 2px; font-size:18px; font-weight:680; letter-spacing:.01em; }
.fv-overlay-en{ font-size:11px; color:var(--fv-ink-soft); margin-bottom:16px; }
.fv-bar{ position:relative; height:3px; border-radius:2px; background:var(--fv-line); overflow:hidden; }
.fv-bar-fill{
  position:absolute; inset:0 auto 0 0; width:calc(var(--fv-p, 0) * 100%);
  background:var(--fv-accent); border-radius:2px; transition:width .22s ease;
}
.fv-bar--indeterminate .fv-bar-fill{
  width:32%; transition:none; animation:fv-slide 1.15s ease-in-out infinite;
}
@keyframes fv-slide{ 0%{ left:-34%; } 100%{ left:100%; } }
.fv-overlay-foot{
  display:flex; align-items:baseline; justify-content:space-between; gap:10px; margin-top:7px;
  font-size:10.5px; color:var(--fv-ink-soft);
}
.fv-overlay-pct{ font-family:var(--fv-mono); font-variant-numeric:tabular-nums; font-size:10.5px; color:var(--fv-ink-faint); }

/* ---- shortcut popover ------------------------------------- */
.fv-modal{ position:absolute; inset:0; z-index:9; display:flex; align-items:center; justify-content:center; pointer-events:auto; }
.fv-modal[hidden]{ display:none; }
.fv-modal-backdrop{ position:absolute; inset:0; background:rgba(16,26,38,.30); -webkit-backdrop-filter:blur(2px); backdrop-filter:blur(2px); }
.fv-modal-card{ position:relative; width:min(390px, 88vw); max-height:82vh; overflow:auto; background:var(--fv-panel-strong); }
.fv-keys{ width:100%; border-collapse:collapse; }
.fv-keys th{
  text-align:left; font-size:9.5px; text-transform:uppercase; letter-spacing:.08em;
  color:var(--fv-ink-faint); font-weight:600; padding:6px 12px 3px;
}
.fv-keys td{ padding:3px 12px; font-size:11px; vertical-align:baseline; }
.fv-keys td:first-child{ width:74px; white-space:nowrap; }
.fv-keys tr:hover td{ background:var(--fv-line-soft); }
.fv-keys kbd{
  font-family:var(--fv-mono); font-size:10px; font-weight:600; color:var(--fv-ink);
  border:1px solid var(--fv-line); border-bottom-width:2px; border-radius:4px;
  padding:1px 5px; background:#fff; display:inline-block; min-width:20px; text-align:center;
}
.fv-modal-foot{ padding:6px 12px 10px; font-size:10px; color:var(--fv-ink-faint); line-height:1.55; }

/* Between the bottom-sheet breakpoint and ~1024px the centred scrubber zone
   (min-width 300px) reaches into the bottom-left column, so lift that column
   above it instead of letting the two cards overlap. */
@media (min-width: 861px) and (max-width: 1023px){
  .fv-zone--bl{ bottom:106px; }
}

/* ---- narrow-viewport chrome (drawer trigger surfaces) ------
   Hidden on desktop; the 860px block below turns them on. This file is the
   BASELINE sheet: style.css restyles all of it, but the contract is that the
   viewer still works if style.css is absent, so the drawer's own controls need
   enough here to be legible and hittable on their own. */
.fv-cap, .fv-mobtools, .fv-tabs{ display:none; }
.fv-tab{
  flex:1 1 0; min-width:0; min-height:40px; padding:0 2px;
  border:0; border-top:2px solid transparent; background:transparent;
  color:var(--fv-ink-soft); font-size:11px; font-weight:600; cursor:pointer;
}
.fv-tab-label{ display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fv-tab--on{ color:var(--fv-accent); border-top-color:var(--fv-accent); }
.fv-icon-btn{
  display:inline-flex; align-items:center; justify-content:center;
  width:34px; height:34px; padding:0; cursor:pointer;
  border:1px solid var(--fv-line); border-radius:99px;
  background:var(--fv-panel); color:var(--fv-ink-soft);
}
.fv-icon-btn[aria-pressed="true"]{ color:var(--fv-accent); }
.fv-cap-dot{ flex:0 0 7px; width:7px; height:7px; border-radius:50%; background:var(--fv-accent); }
.fv-cap-text{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Hide-interface mode is NOT breakpoint-scoped: wanting the scene without the
   chrome is not a small-screen need. Mirrors style.css section 3. */
.fv-ui--hidden > *:not(.fv-mobtools){ visibility:hidden; pointer-events:none; }

/* ============================================================
   Narrow viewport: every card becomes a tab in ONE bottom
   drawer, so the canvas keeps the screen. See js/ui.js.
   ============================================================ */
@media (max-width: 860px){
  .fv-ui{
    display:flex; flex-direction:column; justify-content:flex-end;
    padding:0; gap:0;
  }
  .fv-zone{ position:static; width:auto; max-height:none; flex:0 1 auto; transform:none; }

  /* the four tab panels — only the selected one is laid out at all */
  .fv-zone--tl, .fv-zone--tr, .fv-zone--bl, .fv-zone--br{
    order:1; display:none; min-width:0; align-items:stretch;
    max-height:45vh; overflow-y:auto; overflow-x:hidden;
    padding:8px 10px; gap:8px;
  }
  .fv-ui[data-tab="info"]     .fv-zone--tl,
  .fv-ui[data-tab="controls"] .fv-zone--tr,
  .fv-ui[data-tab="stats"]    .fv-zone--bl,
  .fv-ui[data-tab="legend"]   .fv-zone--br{ display:flex; }

  .fv-tabs{ order:2; display:flex; pointer-events:auto; }
  .fv-zone--bc{ order:3; width:auto; min-width:0; max-width:none; }

  /* Inside the drawer the cards are not separate objects any more: one glass
     surface, so drop every card's own frame. */
  .fv-ui .fv-panel{ background:none; border:0; box-shadow:none;
    -webkit-backdrop-filter:none; backdrop-filter:none; }

  .fv-cap, .fv-mobtools{ display:flex; position:absolute; pointer-events:auto; }
  .fv-cap{
    top:8px; left:8px; max-width:calc(100% - 128px);
    align-items:center; gap:7px; min-height:34px; padding:0 10px;
    border:1px solid var(--fv-line); border-radius:99px; background:var(--fv-panel);
    font-size:11.5px; font-weight:620; color:var(--fv-ink); cursor:pointer;
  }
  .fv-mobtools{ top:8px; right:8px; gap:6px; }
  .fv-tabs{ border-top:1px solid var(--fv-line-soft); background:var(--fv-panel-strong); }
  .fv-zone--bc{ pointer-events:auto; background:var(--fv-panel-strong); }

  .fv-toolbar{ display:none; }            /* replaced by .fv-mobtools */
  .fv-sheet-head{ display:none; }         /* replaced by the Controls tab */
  .fv-sheet{ width:100%; }
  .fv-gui-host{ max-height:none; overflow:visible; }
  .fv-gui-host .lil-gui{ border:0; border-radius:0; box-shadow:none; width:100%; }

  .fv-legend{ width:auto; }
  .fv-status{ bottom:auto; top:56px; }
}

@media (prefers-reduced-motion: reduce){
  .fv-ui *{ animation-duration:.001ms !important; transition-duration:.001ms !important; }
}
`;

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const head = document.head || document.documentElement;
  const el = h('style');
  el.id = STYLE_ID;
  el.textContent = CSS;
  // First child of <head>: any later stylesheet (style.css) wins ties, so the
  // integrator can restyle without fighting !important.
  head.insertBefore(el, head.firstChild);
}

/* ------------------------------------------------------------------ *
 * Keyboard helpers
 * ------------------------------------------------------------------ */

const TEXTY_INPUT = /^(text|number|search|email|url|tel|password|date|time|month|week|datetime-local)$/;

/** True when the element eats keystrokes (lil-gui number fields are type=text). */
function isTextEntry(node) {
  if (!node || node.nodeType !== 1) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return true;
  if (tag === 'INPUT') {
    // range / checkbox / radio / button do not consume letter keys, so shortcuts
    // stay live after the user has touched the water-level scrubber.
    return TEXTY_INPUT.test((node.getAttribute('type') || 'text').toLowerCase());
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * createUI
 * ------------------------------------------------------------------ */

/**
 * @param {object}   opts
 * @param {object}   opts.state     live state object owned by main.js (mutated in place)
 * @param {function} opts.onChange  (key, value) => void
 * @param {function} opts.onAction  (name) => void  'screenshot'|'flyTour'|'resetView'|'topView'
 * @param {object}   opts.meta      parsed data/meta.json
 */
export function createUI(opts = {}) {
  injectStyles();

  // meta.json may not be loaded yet at construction time (main.js passes
  // `meta: null` and calls setMeta() once data/meta.json has arrived), so every
  // meta-derived value lives in a `let` and is (re)applied by applyMeta().
  let meta = opts.meta || {};
  let rampMax = RAMP_MAX_FALLBACK;

  // Published-baseline figures — used for the "vs baseline" deltas and to seed
  // the stats card before main.js has computed anything.
  let baseArea = NaN;
  let baseVolume = NaN;
  let baseMaxDepth = NaN;
  let baseMeanDepth = NaN;

  // state: main.js owns the object; fill any hole with the contract default.
  const state = opts.state && typeof opts.state === 'object' ? opts.state : {};
  for (const k in STATE_DEFAULTS) {
    if (state[k] === undefined) state[k] = STATE_DEFAULTS[k];
  }

  const emitChange = (key, value) => {
    if (typeof opts.onChange !== 'function') return;
    try { opts.onChange(key, value); }
    catch (err) { console.error('[fv-ui] onChange(' + key + ') threw:', err); }
  };
  const emitAction = (name) => {
    if (typeof opts.onAction !== 'function') return;
    try { opts.onAction(name); }
    catch (err) { console.error('[fv-ui] onAction(' + name + ') threw:', err); }
  };

  /* ---------------- root ---------------- */

  // `fv-root` is the hook main.js's `?nogui` dev switch looks for
  // (`document.querySelectorAll('.fv-root, .lil-gui')`); `fv-ui` is what this
  // stylesheet targets. Both live on the same element.
  const root = h('div', 'fv-ui fv-root');
  attrs(root, { 'data-fv': 'ui' });

  const zoneTL = h('div', 'fv-zone fv-zone--tl');
  const zoneTR = h('div', 'fv-zone fv-zone--tr');
  const zoneBL = h('div', 'fv-zone fv-zone--bl');
  const zoneBR = h('div', 'fv-zone fv-zone--br');
  // Bottom centre. The scrubber used to position itself, which lost the cascade
  // to `.fv-ui .fv-panel{position:relative}` in style.css — it then laid out in
  // normal flow at the top of the (fixed, inset:0) root and its own `bottom:14px`
  // shifted it 14px further up, off the top edge. Layout now lives in a zone,
  // which is not a `.fv-panel`, so the two rules can never collide again.
  const zoneBC = h('div', 'fv-zone fv-zone--bc');
  add(root, zoneTL, zoneTR, zoneBR, zoneBL, zoneBC); // BR before BL: narrow-mode stacking order

  /* ---------------- title / credit / about ---------------- */

  const titleCard = h('section', 'fv-panel fv-title');
  add(titleCard, h('div', 'fv-eyebrow', 'Kempsey · NSW · EPSG:3857'));
  const hTitle = h('h1', null, 'Kempsey 3D Flood Viewer');
  add(titleCard, hTitle, h('h2', null, 'Interactive 3D flood depth map'));

  const srcLine = h('div', 'fv-title-src');
  srcLine.textContent = 'Depth: HOTA final_depth.tif · Terrain (DEM): GA 5 m LiDAR (AHD)';
  add(titleCard, srcLine);

  const credit = h('div', 'fv-credit');
  add(credit, document.createTextNode('Created by Wenfeng Jia @CSU · '));
  const mail = h('a', null, 'wjia@csu.edu.au');
  attrs(mail, { href: 'mailto:wjia@csu.edu.au' });
  add(credit, mail, h('br'));
  const doi = h('a', 'fv-credit-doi', 'ACPR 2025 · doi:10.1007/978-981-95-4398-4_14');
  attrs(doi, {
    href: 'https://doi.org/10.1007/978-981-95-4398-4_14',
    target: '_blank',
    rel: 'noopener noreferrer'
  });
  add(credit, doi);
  add(titleCard, credit);

  // --- About the data -------------------------------------------------
  const about = h('details', 'fv-about');
  const aboutSummary = h('summary', null, 'About the data');
  add(about, aboutSummary);
  const aboutBody = h('div', 'fv-about-body');

  const para = (label, rest) => {
    const p = h('p');
    add(p, h('b', null, label), document.createTextNode(rest));
    return p;
  };

  add(aboutBody,
    para('Depth layer',
      ' — HOTA’s final_depth.tif, native pixel size 5.84 m, resampled to 25.5 m ' +
      'for this visualisation.'),
    para('Colour ramp',
      ' — matplotlib Blues over 0–2.5 m, exactly as published; depths greater ' +
      'than 2.5 m are clipped to the darkest blue.'),
    para('Water-level slider',
      ' — applies a uniform offset Δ to the HOTA water surface and re-solves the ' +
      'inundated extent by hydraulic connectivity. Δ = 0 reproduces the published ' +
      'HOTA extent and depths exactly; Δ > 0 is a scenario, not a hydraulic simulation.'),
    para('Basemap',
      ' — the pixels under the water are real Sentinel-2 imagery from 26 March 2021. ' +
      'Only the ocean and a handful of pixels outside every source raster are a ' +
      'smooth fill.'),
    para('Context layers',
      ' — building footprints and heights use the local GlobalBuildingAtlas LoD1 snapshot; ' +
      'roads and waterways use an OpenStreetMap snapshot. The population layer uses ABS.'),
    para('Building heights',
      ' — the displayed building height is the GBA.LoD1 height attribute in metres; it is ' +
      'a PlanetScope/ML estimate supplied by GBA, not a value calculated by this project. ' +
      'The accompanying var field records model prediction variance. Vertical exaggeration ' +
      'changes display scale, not the stored source height.'),
    para('Overview readability',
      ' — at a wide scene scale, detailed solids switch to screen-space building markers ' +
      'and a road skeleton so small features stay visible; zooming in restores the metric ' +
      'extrusions and road ribbons.'),
    para('Population density',
      ' — the population layer uses Australian Bureau of Statistics (ABS) 2021 Census ' +
      'Mesh Block Counts (Persons Usually Resident) joined to official ASGS 2021 Mesh ' +
      'Block boundaries. Density is people per km² using the full ABS Mesh Block area; ' +
      'the displayed geometry is clipped to the scene and draped onto the terrain. It is ' +
      'contextual information, not flood depth.')
  );

  // Numeric facts, straight out of meta.json (filled in by applyMeta).
  const facts = h('div', 'fv-facts');

  function renderFacts() {
    const grid = meta.grid || {};
    const metaStats = meta.stats || {};
    const cell = Number.isFinite(metaStats.cellX) ? metaStats.cellX : NaN;
    const lines = [
      'Grid  ' +
        (Number.isFinite(grid.nx) && Number.isFinite(grid.ny) ? grid.nx + ' × ' + grid.ny : DASH) +
        ' · ' + (Number.isFinite(cell) ? cell.toFixed(1) + ' m' : DASH),
      'Baseline area  ' + fixed(baseArea, 2) + ' km²',
      'Baseline volume  ' + fixed(baseVolume, 2) + ' Mm³',
      'Max observed depth  ' + fixed(baseMaxDepth, 2) + ' m'
    ];
    facts.textContent = '';
    lines.forEach((t, i) => {
      if (i) add(facts, h('br'));
      add(facts, document.createTextNode(t));
    });
  }

  add(aboutBody, facts);
  add(about, aboutBody);
  add(titleCard, about);
  add(zoneTL, titleCard);

  /* ---------------- toolbar + lil-gui sheet ---------------- */

  const toolbar = h('div', 'fv-toolbar');

  const helpBtn = h('button', 'fv-btn');
  attrs(helpBtn, { type: 'button', 'aria-expanded': 'false', 'aria-haspopup': 'dialog' });
  add(helpBtn, h('span', null, 'Shortcuts'), h('kbd', null, 'H'));
  add(toolbar, helpBtn);
  add(zoneTR, toolbar);

  const sheet = h('div', 'fv-sheet');
  const sheetHead = h('button', 'fv-sheet-head');
  attrs(sheetHead, { type: 'button', 'aria-expanded': 'false' });
  add(sheetHead, h('span', null, 'Controls'));
  const guiHost = h('div', 'fv-gui-host');
  add(sheet, sheetHead, guiHost);
  add(zoneTR, sheet);

  sheetHead.addEventListener('click', () => {
    const open = !sheet.classList.contains('fv-sheet--open');
    sheet.classList.toggle('fv-sheet--open', open);
    sheetHead.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  /* ---------------- depth legend ---------------- */

  const legend = h('section', 'fv-panel fv-legend');
  attrs(legend, { 'aria-label': 'Depth legend' });
  add(legend,
    h('div', 'fv-legend-title', 'Depth'),
    h('div', 'fv-legend-sub', 'metres · Blues')
  );

  const scale = h('div', 'fv-legend-scale');
  const bar = h('div', 'fv-legend-bar');
  // Exact 9 ColorBrewer Blues anchors, evenly spaced, light (0 m) at the bottom.
  const gradient = 'linear-gradient(to top, ' +
    BLUES.map((c, i) => c + ' ' + ((i / (BLUES.length - 1)) * 100).toFixed(3) + '%').join(', ') + ')';
  bar.style.setProperty('--fv-ramp', gradient);

  // Caret showing where the last queried depth falls on the ramp.
  const legendMarker = h('div', 'fv-legend-marker');
  attrs(legendMarker, { hidden: true });
  add(bar, legendMarker);

  const ticks = h('div', 'fv-legend-ticks');
  const legendFoot = h('div', 'fv-legend-foot');

  /** Ticks depend on rampMax, which can arrive later via setMeta(). */
  function renderLegendTicks() {
    ticks.textContent = '';
    // Five even steps over the ramp, always ending on the clipped top value.
    const steps = 5;
    for (let i = 0; i <= steps; i++) {
      const v = (rampMax * i) / steps;
      const t = h('div', 'fv-legend-tick', (i === steps ? '≥ ' : '') + v.toFixed(1));
      t.style.setProperty('--fv-t', String(i / steps));
      add(ticks, t);
    }
    // Kept short on purpose: the card is bottom-anchored and this footnote is
    // the only part of it that grows, so a long sentence is what used to push
    // the legend past the viewport on shorter screens.
    legendFoot.textContent =
      '> ' + rampMax.toFixed(1) + ' m clipped (as published)';
  }

  add(scale, bar, ticks);
  add(legend, scale, legendFoot);
  add(zoneBR, legend);

  /* ---------------- context-layer legend ------------------------------- */

  // This deliberately stays separate from the quantitative depth ramp: these
  // colours describe optional map overlays, not water depth or flood severity.
  const contextLegend = h('section', 'fv-panel fv-context-legend');
  attrs(contextLegend, { 'aria-label': 'Context layer legend' });
  add(contextLegend,
    h('div', 'fv-context-legend-title', 'Context layers'),
    h('div', 'fv-context-legend-sub', 'map overlay colours')
  );
  const contextItems = [
    ['population', 'Population density'],
    ['buildings', 'Buildings'],
    ['roads', 'Roads'],
    ['water', 'Water']
  ];
  const contextList = h('div', 'fv-context-legend-list');
  for (const [kind, label] of contextItems) {
    const item = h('div', 'fv-context-legend-item');
    const swatch = h('span', 'fv-context-swatch fv-context-swatch--' + kind);
    attrs(swatch, { 'aria-hidden': 'true' });
    add(item, swatch, h('span', null, label));
    add(contextList, item);
  }
  add(contextLegend, contextList);
  add(zoneBR, contextLegend);

  /* ---------------- flood statistics card ---------------- */

  /**
   * One label/value row. `unit` is a static span so only the digits are
   * replaced on update — the unit never reflows. `sub` is an optional
   * de-emphasised qualifier set in parentheses after the name.
   */
  function makeRow(name, sub, unit, cls) {
    const row = h('div', 'fv-row' + (cls ? ' ' + cls : ''));
    const label = h('span', 'fv-row-label');
    add(label, document.createTextNode(sub ? name + ' ' : name));
    if (sub) add(label, h('i', null, '(' + sub + ')'));
    const val = h('span', 'fv-row-val');
    const num = h('span', null, DASH);
    add(val, num);
    if (unit) add(val, h('span', 'fv-row-unit', unit));
    add(row, label, val);
    return { row, num, val, label };
  }

  const statsCard = h('section', 'fv-panel fv-stats');
  const statsHead = h('div', 'fv-head');
  add(statsHead,
    h('span', 'fv-head-zh', 'Flood statistics'),
    h('span', 'fv-head-en', 'HOTA'));
  add(statsCard, statsHead);

  const statsBody = h('div', 'fv-body');
  const rArea = makeRow('Inundated area', null, 'km²');
  const subArea = h('div', 'fv-sub');
  attrs(subArea, { hidden: true });
  const rVolume = makeRow('Water volume', null, 'Mm³');
  const subVolume = h('div', 'fv-sub');
  attrs(subVolume, { hidden: true });
  const rMax = makeRow('Max depth', null, 'm');
  const rMean = makeRow('Mean depth', null, 'm');
  const rOffset = makeRow('Δ water level', null, 'm', 'fv-row--hero');

  add(statsBody,
    rArea.row, subArea,
    rVolume.row, subVolume,
    rMax.row, rMean.row,
    h('div', 'fv-rule'),
    rOffset.row);
  add(statsCard, statsBody);
  add(statsCard, h('div', 'fv-note', 'Δ = 0 is the published baseline'));

  /* ---------------- click-query card ---------------- */

  const queryCard = h('section', 'fv-panel fv-query');
  attrs(queryCard, { hidden: true, 'aria-live': 'polite' });
  const qHead = h('div', 'fv-head');
  add(qHead,
    h('span', 'fv-head-zh', 'Query point'),
    h('span', 'fv-head-en', 'click sample'));
  const qClose = h('button', 'fv-query-close', '×');
  attrs(qClose, { type: 'button', 'aria-label': 'Close query' });
  add(qHead, qClose);
  add(queryCard, qHead);

  const qBody = h('div', 'fv-body');
  const qLonLat = makeRow('Lon / lat', null, '°');
  const qLocal = makeRow('Local X / Z', null, 'm');
  const qGround = makeRow('Ground elevation', null, 'm');
  const qWsurf = makeRow('Water surface', null, 'm');
  const qDepth = makeRow('Depth', null, 'm', 'fv-row--hero');
  const qSwatch = h('span', 'fv-swatch');
  qDepth.val.insertBefore(qSwatch, qDepth.num);
  const qDry = h('div', 'fv-dry', 'Dry at this water level');
  attrs(qDry, { hidden: true });

  // Optional flags main.js sends along with the sample.
  const qTags = h('div', 'fv-tags');
  const tagSea = h('span', 'fv-tag fv-tag--sea', 'Sea');
  const tagObs = h('span', 'fv-tag fv-tag--obs', 'HOTA observed');
  attrs(tagSea, { hidden: true });
  attrs(tagObs, { hidden: true });
  add(qTags, tagSea, tagObs);

  add(qBody, qLonLat.row, qLocal.row, h('div', 'fv-rule'),
    qGround.row, qWsurf.row, qDepth.row, qDry, qTags);
  add(queryCard, qBody);

  add(zoneBL, queryCard, statsCard);

  /* ---------------- water-level scrubber ---------------- */

  const scrub = h('section', 'fv-panel fv-scrub');
  const scrubHead = h('div', 'fv-scrub-head');
  const scrubLabel = h('div', 'fv-scrub-label');
  add(scrubLabel, document.createTextNode('Δ water level'));
  const scrubVal = h('div', 'fv-scrub-val');
  const scrubNum = h('span', null, '+0.00');
  // The unit is a separate span so the digits keep a fixed box.
  add(scrubVal, scrubNum, h('span', null, 'm'));
  add(scrubHead, scrubLabel, scrubVal);
  add(scrub, scrubHead);

  const range = h('input', 'fv-range');
  attrs(range, {
    type: 'range',
    min: String(OFFSET_MIN),
    max: String(OFFSET_MAX),
    step: String(OFFSET_STEP),
    'aria-label': 'Δ water level (m)'
  });
  add(scrub, range);

  const axis = h('div', 'fv-scrub-axis');
  const axisTicks = [
    { v: OFFSET_MIN, label: '-3' },
    { v: 0, label: '0 · baseline' },
    { v: 2, label: '+2' },
    { v: OFFSET_MAX, label: '+5' }
  ];
  for (const t of axisTicks) {
    const el = h('div', 'fv-scrub-tick' + (t.v === 0 ? ' fv-scrub-tick--zero' : ''), t.label);
    el.style.setProperty('--fv-t', String((t.v - OFFSET_MIN) / (OFFSET_MAX - OFFSET_MIN)));
    add(axis, el);
  }
  add(scrub, axis);
  add(zoneBC, scrub);

  // Track drags so an external setStats({offset}) cannot yank the knob mid-gesture.
  // The release listeners have to sit on `window`: a pointerup delivered outside
  // the input (no implicit pointer capture, a drag that ends over the canvas, a
  // context menu, a dropped touch) would otherwise leave `scrubbing` stuck true
  // for the rest of the session, and paintOffset() would then never move the
  // knob again — the slider would silently desync from the water level.
  let scrubbing = false;
  const endScrub = () => { scrubbing = false; };
  range.addEventListener('pointerdown', () => { scrubbing = true; });
  range.addEventListener('change', endScrub);
  range.addEventListener('blur', endScrub);
  window.addEventListener('pointerup', endScrub);
  window.addEventListener('pointercancel', endScrub);

  range.addEventListener('input', () => {
    const v = clampOffset(parseFloat(range.value));
    state.waterOffset = v;
    paintOffset(v);
    if (ctrlOffset) ctrlOffset.updateDisplay();
    emitChange('waterOffset', v);
  });

  function clampOffset(v) {
    if (!Number.isFinite(v)) return 0;
    // Snap to the slider step so the readout and the uniform never disagree.
    // Round the product back to 3 decimals as well: 27 * 0.05 is 1.3000000000000003
    // in binary floating point, which would defeat the `nv === state.waterOffset`
    // idempotence check in setOffset() and leak into range.value.
    const snapped = Math.round(Math.round(v / OFFSET_STEP) * OFFSET_STEP * 1000) / 1000;
    return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, snapped));
  }

  /** Repaint every widget that shows the water offset. */
  function paintOffset(v) {
    const txt = signedFixed(v, 2);
    scrubNum.textContent = txt;
    rOffset.num.textContent = txt;
    if (!scrubbing) range.value = String(v);
    range.setAttribute('aria-valuetext', txt + ' m');
    range.style.setProperty('--fv-p', String((v - OFFSET_MIN) / (OFFSET_MAX - OFFSET_MIN)));
    updateBaselineDeltas();
  }

  /* ---------------- transient status line ---------------- */

  const statusLine = h('div', 'fv-status');
  attrs(statusLine, { role: 'status', 'aria-live': 'polite' });
  add(root, statusLine);

  /* ---------------- loading overlay ---------------- */

  const overlay = h('div', 'fv-overlay');
  const overlayCard = h('div', 'fv-overlay-card');
  add(overlayCard,
    h('div', 'fv-overlay-eyebrow', 'Kempsey · NSW'),
    h('div', 'fv-overlay-title', 'Kempsey 3D Flood Viewer'),
    h('div', 'fv-overlay-en', 'HOTA final_depth.tif · ACPR 2025'));
  const bar2 = h('div', 'fv-bar fv-bar--indeterminate');
  const barFill = h('div', 'fv-bar-fill');
  add(bar2, barFill);
  add(overlayCard, bar2);
  const overlayFoot = h('div', 'fv-overlay-foot');
  const overlayText = h('span', null, 'Loading data…');
  const overlayPct = h('span', 'fv-overlay-pct', '');
  add(overlayFoot, overlayText, overlayPct);
  add(overlayCard, overlayFoot);
  add(overlay, overlayCard);
  add(root, overlay);

  /* ---------------- shortcut popover ---------------- */

  const modal = h('div', 'fv-modal');
  attrs(modal, { hidden: true });
  const backdrop = h('div', 'fv-modal-backdrop');
  const modalCard = h('div', 'fv-panel fv-modal-card');
  attrs(modalCard, { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts' });
  const modalHead = h('div', 'fv-head');
  add(modalHead,
    h('span', 'fv-head-zh', 'Keyboard shortcuts'),
    h('span', 'fv-head-en', 'keys'));
  const modalClose = h('button', 'fv-query-close', '×');
  attrs(modalClose, { type: 'button', 'aria-label': 'Close' });
  add(modalHead, modalClose);
  add(modalCard, modalHead);

  const keysTable = h('table', 'fv-keys');
  const tbody = h('tbody');
  const KEY_ROWS = [
    ['R', 'Auto-rotate'],
    ['T', 'Top view'],
    ['F', 'Fly tour'],
    ['S', 'Screenshot'],
    ['W', 'Show water on / off'],
    ['D', 'Science colouring (Blues ramp)'],
    ['U', 'Hide / show the interface'],
    ['H', 'This help'],
    ['Esc', 'Close']
  ];
  for (const [k, desc] of KEY_ROWS) {
    const tr = h('tr');
    const td1 = h('td');
    add(td1, h('kbd', null, k));
    add(tr, td1, h('td', null, desc));
    add(tbody, tr);
  }
  add(keysTable, tbody);
  add(modalCard, keysTable);
  add(modalCard, h('div', 'fv-modal-foot',
    'Mouse: drag to orbit, scroll to zoom, click the surface to query the depth there. '
    + 'Touch: drag to orbit, two fingers to zoom and pan, tap the surface to query it.'));
  add(modal, backdrop, modalCard);
  add(root, modal);

  let lastFocus = null;
  function setHelp(open) {
    // Both triggers, not just the desktop one: `helpBtn2` in .fv-mobtools is the only help
    // control that exists below 860px, so leaving it out meant the sole visible trigger on a
    // phone never announced the dialog's state to a screen reader.
    if (open) {
      lastFocus = document.activeElement;
      modal.removeAttribute('hidden');
      setHelpExpanded(true);
      modalClose.focus();
    } else {
      modal.setAttribute('hidden', '');
      setHelpExpanded(false);
      if (lastFocus && typeof lastFocus.focus === 'function') lastFocus.focus();
      lastFocus = null;
    }
  }
  // Every control that opens the dialog registers here. A `typeof helpBtn2 !== 'undefined'`
  // guard would NOT have been safe: helpBtn2 is a `const` declared further down, and `typeof`
  // on a let/const in its temporal dead zone throws a ReferenceError rather than returning
  // "undefined". A list that starts with the one trigger that already exists has no such edge.
  const helpTriggers = [helpBtn];
  function setHelpExpanded(v) {
    for (const t of helpTriggers) t.setAttribute('aria-expanded', v ? 'true' : 'false');
  }
  const helpOpen = () => !modal.hasAttribute('hidden');
  helpBtn.addEventListener('click', () => setHelp(!helpOpen()));
  modalClose.addEventListener('click', () => setHelp(false));
  backdrop.addEventListener('click', () => setHelp(false));

  /* ---------------- narrow-viewport drawer ----------------
   *
   * On a phone the old layout turned `.fv-ui` into a scrolling column of every
   * card at once. Measured on a 390x844 viewport that covered 83.6 % of the
   * screen — the 3D scene, which is the entire point of the page, was reduced
   * to a few gutters. So below 860px (MOBILE_QUERY above) the same cards become
   * the body of ONE bottom drawer, four tabs deep, and the canvas gets the rest.
   *
   * No card moves in the DOM. Each zone already holds exactly the group that
   * wants its own tab, so the tab state is a single `data-tab` attribute on the
   * root and the CSS shows the matching zone. That keeps the desktop layout —
   * which is carefully tuned and was not asked to change — completely untouched:
   * every rule involved lives inside the `max-width: 860px` block.
   *
   *   data-tab="none"     collapsed: tab bar + Δ scrubber only (~17 % of screen)
   *   data-tab="info"     .fv-zone--tl   title, sources, about
   *   data-tab="stats"    .fv-zone--bl   query result + flood statistics
   *   data-tab="legend"   .fv-zone--br   depth ramp
   *   data-tab="controls" .fv-zone--tr   lil-gui
   */

  const TABS = [
    { id: 'info', label: 'Info', zone: zoneTL },
    { id: 'stats', label: 'Stats', zone: zoneBL },
    { id: 'legend', label: 'Legend', zone: zoneBR },
    { id: 'controls', label: 'Controls', zone: zoneTR },
  ];

  // Title capsule, top-left. The full title card costs 224px of a 844px screen;
  // on a phone it becomes a one-line pill that opens the Info tab instead.
  const cap = h('button', 'fv-cap');
  attrs(cap, { type: 'button', 'aria-controls': 'fv-panel-info', 'aria-expanded': 'false' });
  add(cap, h('span', 'fv-cap-dot'), h('span', 'fv-cap-text', 'Kempsey 3D Flood Viewer'));
  add(root, cap);

  // Top-right icon buttons. These are additional TRIGGERS, not copies: the help
  // one calls the same setHelp() as the desktop toolbar button, so there is only
  // ever one dialog and one piece of state behind it.
  const mobTools = h('div', 'fv-mobtools');
  const hideBtn = h('button', 'fv-icon-btn');
  attrs(hideBtn, { type: 'button', 'aria-pressed': 'false', 'aria-label': 'Hide interface' });
  add(hideBtn, icon(...ICON_EYE));
  const helpBtn2 = h('button', 'fv-icon-btn');
  attrs(helpBtn2, { type: 'button', 'aria-haspopup': 'dialog', 'aria-label': 'Help and shortcuts' });
  add(helpBtn2, icon('M12 17.2v.01', 'M9.4 9.1a2.7 2.7 0 1 1 3.5 2.6c-.6.2-.9.7-.9 1.3v.6'));
  helpTriggers.push(helpBtn2);
  add(mobTools, helpBtn2, hideBtn);
  add(root, mobTools);

  // The tab bar itself.
  const tabBar = h('div', 'fv-tabs');
  attrs(tabBar, { role: 'tablist', id: 'fv-drawer' });
  const tabBtns = new Map();
  for (const t of TABS) {
    const b = h('button', 'fv-tab');
    attrs(b, {
      type: 'button', role: 'tab', 'aria-selected': 'false', 'data-tab': t.id,
      id: 'fv-tab-' + t.id, 'aria-controls': 'fv-panel-' + t.id
    });
    add(b, h('span', 'fv-tab-label', t.label));
    // Tapping the open tab closes the drawer — the same affordance as the
    // chevron, but on the control the thumb is already over.
    b.addEventListener('click', () => setTab(currentTab === t.id ? 'none' : t.id));
    add(tabBar, b);
    tabBtns.set(t.id, b);
    attrs(t.zone, { role: 'tabpanel', id: 'fv-panel-' + t.id, 'aria-labelledby': 'fv-tab-' + t.id });
  }
  add(root, tabBar);

  let currentTab = 'none';

  function setTab(id) {
    currentTab = id;
    root.setAttribute('data-tab', id);
    for (const [tid, b] of tabBtns) {
      const on = tid === id;
      b.classList.toggle('fv-tab--on', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    cap.setAttribute('aria-expanded', id === 'info' ? 'true' : 'false');
    // A tab panel that just became visible starts scrolled wherever it was left.
    const t = TABS.find((x) => x.id === id);
    if (t) t.zone.scrollTop = 0;
  }

  setTab('none');
  cap.addEventListener('click', () => setTab(currentTab === 'info' ? 'none' : 'info'));
  helpBtn2.addEventListener('click', () => setHelp(!helpOpen()));

  // Hide-interface toggle. Collapses the drawer first so re-showing the UI never
  // brings back a panel the user cannot see the canvas behind.
  let uiHidden = false;
  function setUiHidden(v) {
    uiHidden = !!v;
    root.classList.toggle('fv-ui--hidden', uiHidden);
    hideBtn.setAttribute('aria-pressed', uiHidden ? 'true' : 'false');
    hideBtn.setAttribute('aria-label', uiHidden ? 'Show interface' : 'Hide interface');
    hideBtn.textContent = '';
    add(hideBtn, icon(...(uiHidden ? ICON_EYE_OFF : ICON_EYE)));
    // Collapse the drawer AND dismiss the dialog. Without the second one, `H` while hidden
    // opened a visibility:hidden modal and moved focus into it — a focus trap with nothing
    // visible on screen.
    if (uiHidden) { setTab('none'); if (helpOpen()) setHelp(false); }
  }
  hideBtn.addEventListener('click', () => setUiHidden(!uiHidden));

  /* ---------------- mount ---------------- */

  document.body.appendChild(root);

  /* ---------------- lil-gui ---------------- */

  const gui = new GUI({
    container: guiHost,
    title: 'Controls',
    width: 272,
    autoPlace: false
  });

  const controllers = [];
  /** Register a controller that mirrors `state[key]` and reports through onChange. */
  function bind(folder, key, name, a, b, c) {
    const ctrl = (a === undefined)
      ? folder.add(state, key)
      : folder.add(state, key, a, b, c);
    ctrl.name(name).onChange((v) => {
      // lil-gui has already written state[key]; keep the mirrors in sync.
      if (key === 'waterOffset') paintOffset(v);
      if (key === 'science') legend.classList.toggle('fv-legend--active', !!v);
      emitChange(key, v);
    });
    controllers.push(ctrl);
    return ctrl;
  }

  function button(folder, name, fn) {
    const holder = {};
    holder[name] = fn;
    return folder.add(holder, name).name(name);
  }

  // --- water level ----------------------------------------------------
  const fLevel = gui.addFolder('Water level');
  const ctrlOffset = bind(fLevel, 'waterOffset', 'Δ water level (m)',
    OFFSET_MIN, OFFSET_MAX, OFFSET_STEP);
  button(fLevel, 'Reset to HOTA baseline (Δ = 0)', () => setOffset(0));

  // --- light & terrain ------------------------------------------------
  const fLight = gui.addFolder('Light & terrain');
  bind(fLight, 'sunAzimuth', 'Sun azimuth (°)', 0, 360, 1);
  bind(fLight, 'sunElevation', 'Sun elevation (°)', 1, 88, 1);
  // Keep a wide diagnostic range around the 8x default.
  bind(fLight, 'vertExag', 'Vertical exaggeration (×)', 1, 30, 0.5);

  // --- water material -------------------------------------------------
  const fWater = gui.addFolder('Water material');
  bind(fWater, 'waveAmp', 'Wave amplitude', 0, 2, 0.05);
  bind(fWater, 'turbidity', 'Turbidity', 0.05, 1.5, 0.01);
  bind(fWater, 'foam', 'Shoreline foam', 0, 1, 0.05);
  bind(fWater, 'science', 'Science colouring (Blues ramp)');

  // --- display --------------------------------------------------------
  const fView = gui.addFolder('Display');
  bind(fView, 'showWater', 'Show water');
  bind(fView, 'autoRotate', 'Auto-rotate');
  bind(fView, 'quality', 'Render quality', {
    High: 'high',
    Medium: 'medium',
    Low: 'low'
  });
  button(fView, 'Top view', () => emitAction('topView'));
  button(fView, 'Fly tour', () => emitAction('flyTour'));
  button(fView, 'Reset view', () => emitAction('resetView'));
  button(fView, 'Screenshot', () => emitAction('screenshot'));

  // --- context layers ---------------------------------------------------
  const fContext = gui.addFolder('Context layers');
  bind(fContext, 'showBuildings', 'Buildings');
  bind(fContext, 'showRoads', 'Roads');
  bind(fContext, 'showOsmWater', 'OSM water');
  bind(fContext, 'showPopulation', 'Population density');

  // Folders start collapsed per the contract; the water level lives in the
  // always-visible scrubber at the bottom of the screen, so nothing essential
  // is hidden behind a disclosure triangle.
  fLevel.close();
  fLight.close();
  fWater.close();
  fView.close();
  fContext.close();

  /* ---------------- state helpers ---------------- */

  /** Programmatic offset change (reset button, keys) — mirrors + notifies. */
  function setOffset(v) {
    const nv = clampOffset(v);
    if (nv === state.waterOffset) { paintOffset(nv); return; }
    state.waterOffset = nv;
    paintOffset(nv);
    if (ctrlOffset) ctrlOffset.updateDisplay();
    emitChange('waterOffset', nv);
  }

  /** Boolean toggle used by the keyboard shortcuts. */
  function toggle(key) {
    const v = !state[key];
    state[key] = v;
    if (key === 'science') legend.classList.toggle('fv-legend--active', v);
    refresh();
    emitChange(key, v);
  }

  /** Re-read `state` into every widget. Safe to call from main.js at any time. */
  function refresh() {
    for (const c of controllers) {
      try { c.updateDisplay(); } catch (e) { /* controller destroyed */ }
    }
    paintOffset(clampOffset(state.waterOffset));
    legend.classList.toggle('fv-legend--active', !!state.science);
  }

  /* ---------------- statistics ---------------- */

  // Latest values, so the baseline deltas can be recomputed when Δ changes.
  const current = { areaKm2: NaN, volumeMm3: NaN, maxDepth: NaN, meanDepth: NaN };
  let statsFromApp = false;   // true once main.js has pushed real numbers

  function updateBaselineDeltas() {
    const off = state.waterOffset;
    const show = Number.isFinite(off) && Math.abs(off) > 1e-6;

    const dA = show && Number.isFinite(current.areaKm2) && Number.isFinite(baseArea)
      ? current.areaKm2 - baseArea : NaN;
    if (Number.isFinite(dA)) {
      subArea.textContent = 'vs baseline ' + signedFixed(dA, 2) + ' km²';
      subArea.removeAttribute('hidden');
    } else {
      subArea.setAttribute('hidden', '');
    }

    const dV = show && Number.isFinite(current.volumeMm3) && Number.isFinite(baseVolume)
      ? current.volumeMm3 - baseVolume : NaN;
    if (Number.isFinite(dV)) {
      subVolume.textContent = 'vs baseline ' + signedFixed(dV, 2) + ' Mm³';
      subVolume.removeAttribute('hidden');
    } else {
      subVolume.setAttribute('hidden', '');
    }
  }

  function writeStats(s) {
    if (!s || typeof s !== 'object') return;

    if (Number.isFinite(s.areaKm2)) {
      current.areaKm2 = s.areaKm2;
      rArea.num.textContent = s.areaKm2.toFixed(2);
    }
    if (Number.isFinite(s.volumeMm3)) {
      current.volumeMm3 = s.volumeMm3;
      rVolume.num.textContent = s.volumeMm3.toFixed(2);
    }
    if (Number.isFinite(s.maxDepth)) {
      current.maxDepth = s.maxDepth;
      rMax.num.textContent = s.maxDepth.toFixed(2);
    }
    if (Number.isFinite(s.meanDepth)) {
      current.meanDepth = s.meanDepth;
      rMean.num.textContent = s.meanDepth.toFixed(2);
    }
    if (Number.isFinite(s.offset)) {
      // main.js is authoritative about the offset (a fly tour may animate it),
      // but never fight a live drag.
      const v = clampOffset(s.offset);
      state.waterOffset = v;
      paintOffset(v);
      if (ctrlOffset) ctrlOffset.updateDisplay();
    } else {
      updateBaselineDeltas();
    }
  }

  /**
   * setStats({areaKm2, volumeMm3, maxDepth, meanDepth, offset})
   * Every field is optional; anything non-finite leaves that row untouched.
   */
  function setStats(s) {
    if (!s || typeof s !== 'object') return;
    statsFromApp = true;
    writeStats(s);
  }

  /**
   * setMeta(meta) — adopt (or re-adopt) data/meta.json after construction.
   * main.js passes `meta: null` to createUI and calls this once the dataset has
   * loaded, so the baselines, the "About the data" facts and the legend ticks
   * are only known at that point.
   */
  function applyMeta(m) {
    meta = m && typeof m === 'object' ? m : {};
    const ms = meta.stats || {};

    rampMax = Number.isFinite(meta.rampMax) && meta.rampMax > 0 ? meta.rampMax : RAMP_MAX_FALLBACK;
    baseArea = Number.isFinite(ms.observedAreaKm2) ? ms.observedAreaKm2 : NaN;
    baseVolume = Number.isFinite(ms.observedVolumeMm3) ? ms.observedVolumeMm3 : NaN;
    baseMaxDepth = Number.isFinite(meta.depthMaxObserved) ? meta.depthMaxObserved : NaN;
    // Volume is in Mm³ (1e6 m³) and area in km² (1e6 m²), so the 1e6 factors
    // cancel and the mean depth is simply V / A in metres.
    baseMeanDepth = (Number.isFinite(baseArea) && Number.isFinite(baseVolume) && baseArea > 0)
      ? baseVolume / baseArea
      : NaN;

    renderFacts();
    renderLegendTicks();

    // Until main.js computes its own numbers, show the published baseline.
    if (!statsFromApp) {
      writeStats({
        areaKm2: baseArea,
        volumeMm3: baseVolume,
        maxDepth: baseMaxDepth,
        meanDepth: baseMeanDepth,
        offset: state.waterOffset
      });
    } else {
      updateBaselineDeltas();
    }
  }

  applyMeta(opts.meta);

  /* ---------------- click query ---------------- */

  /**
   * setQuery(q | null) — q = {lon, lat, x, y, ground, waterSurface, depth}
   * `x, y` are local metres (X east, Z south) as defined in contract §1;
   * `q.z` is accepted as an alias for `q.y` because that is the axis name the
   * world space actually uses, and main.js sends it that way.
   * Optional extras: `sea` and `observed` booleans → shown as small tags.
   */
  function setQuery(q) {
    if (!q || typeof q !== 'object') {
      queryCard.setAttribute('hidden', '');
      legendMarker.setAttribute('hidden', '');
      return;
    }

    const localZ = Number.isFinite(q.z) ? q.z : q.y;

    qLonLat.num.textContent = (Number.isFinite(q.lon) && Number.isFinite(q.lat))
      ? q.lon.toFixed(5) + ', ' + q.lat.toFixed(5)
      : DASH;
    qLocal.num.textContent = (Number.isFinite(q.x) && Number.isFinite(localZ))
      ? Math.round(q.x) + ', ' + Math.round(localZ)
      : DASH;
    qGround.num.textContent = fixed(q.ground, 2);
    qWsurf.num.textContent = fixed(q.waterSurface, 2);

    const d = q.depth;
    const wet = Number.isFinite(d) && d > 0;
    qDepth.num.textContent = wet ? d.toFixed(2) : (Number.isFinite(d) ? d.toFixed(2) : DASH);
    if (wet) {
      qDry.setAttribute('hidden', '');
      qSwatch.style.setProperty('--fv-swatch', bluesAt(d / rampMax));
      // Same normalisation as the legend, so the caret lands on the same colour.
      legendMarker.style.setProperty('--fv-mk', String(Math.min(1, Math.max(0, d / rampMax))));
      legendMarker.removeAttribute('hidden');
    } else {
      qDry.removeAttribute('hidden');
      qSwatch.style.setProperty('--fv-swatch', 'transparent');
      legendMarker.setAttribute('hidden', '');
    }

    if (q.sea) tagSea.removeAttribute('hidden'); else tagSea.setAttribute('hidden', '');
    if (q.observed) tagObs.removeAttribute('hidden'); else tagObs.setAttribute('hidden', '');

    queryCard.removeAttribute('hidden');

    // On a phone the query card lives inside the drawer's Stats tab, so a tap on
    // the map has to bring that tab up — otherwise the reading the user just
    // asked for is written into a panel they cannot see. Never force the drawer
    // open while the interface is deliberately hidden.
    if (isNarrow() && !uiHidden && currentTab !== 'stats') setTab('stats');
  }

  qClose.addEventListener('click', () => setQuery(null));

  /* ---------------- status / loading overlay ---------------- */

  let overlayLive = true;     // overlay owns the status until the first setStatus(null)
  let statusTimer = 0;
  let watchdog = 0;
  let overlayFade = 0;

  function armWatchdog() {
    clearTimeout(watchdog);
    if (!overlayLive) return;
    // Safety net: if main.js never calls setStatus(null) (or dies while
    // loading) we still hand the screen back rather than sitting on a
    // permanent splash.
    watchdog = setTimeout(() => { if (overlayLive) hideOverlay(); }, OVERLAY_WATCHDOG_MS);
  }

  function hideOverlay() {
    overlayLive = false;
    clearTimeout(watchdog);
    clearTimeout(overlayFade);
    if (NO_ANIM) {
      // No fade: the splash is gone in the same frame setStatus(null) is called,
      // so an immediately-following headless screenshot sees the scene.
      overlay.classList.remove('fv-overlay--out');
      overlay.setAttribute('hidden', '');
      return;
    }
    overlay.classList.add('fv-overlay--out');
    // Keep it in the DOM until the opacity transition has finished, then take
    // it out of the hit-test entirely so it cannot eat canvas clicks.
    overlayFade = setTimeout(() => {
      overlay.setAttribute('hidden', '');
      overlay.classList.remove('fv-overlay--out');
    }, OVERLAY_FADE_MS + 20);
  }

  function showOverlay() {
    overlayLive = true;
    clearTimeout(overlayFade);   // cancel a fade-out still in flight
    overlay.classList.remove('fv-overlay--out');
    overlay.removeAttribute('hidden');
  }

  function setProgress(p) {
    if (Number.isFinite(p)) {
      const v = Math.min(1, Math.max(0, p));
      bar2.classList.remove('fv-bar--indeterminate');
      barFill.style.setProperty('--fv-p', String(v));
      overlayPct.textContent = Math.round(v * 100) + '%';
    } else {
      bar2.classList.add('fv-bar--indeterminate');
      overlayPct.textContent = '';
    }
  }

  function showLine(text, timeout) {
    statusLine.textContent = text;
    statusLine.classList.add('fv-status--on');
    clearTimeout(statusTimer);
    if (Number.isFinite(timeout) && timeout > 0) {
      statusTimer = setTimeout(() => statusLine.classList.remove('fv-status--on'), timeout);
    }
  }

  function hideLine() {
    clearTimeout(statusTimer);
    statusLine.classList.remove('fv-status--on');
  }

  /**
   * setStatus(null)                       → dismiss the overlay / hide the line
   * setStatus('text')                     → overlay caption while loading,
   *                                          transient line afterwards
   * setStatus({text, progress, timeout, overlay})
   *      progress 0…1 → determinate bar (omit for the indeterminate stripe)
   *      timeout  ms  → auto-hide the transient line
   *      overlay  true/false → force the overlay on/off for this call
   */
  function setStatus(arg) {
    if (arg == null) {
      hideLine();
      if (overlayLive) hideOverlay();
      return;
    }

    const o = (typeof arg === 'string' || typeof arg === 'number')
      ? { text: String(arg) }
      : (arg || {});
    const text = o.text != null ? String(o.text) : '';
    // Once the overlay has been dismissed it stays dismissed unless the caller
    // explicitly asks for it back (`overlay:true`). Inferring it from a finite
    // `progress` used to resurrect the full-screen splash on the next progress
    // tick after the watchdog had faded it out — a slow load would flash the
    // splash on and off over the live canvas.
    const wantOverlay = (o.overlay === undefined) ? overlayLive : !!o.overlay;

    if (wantOverlay) {
      if (!overlayLive) showOverlay();
      if (text) overlayText.textContent = text;
      setProgress(o.progress);
      hideLine();
      armWatchdog();
    } else {
      if (overlayLive) hideOverlay();
      if (text) showLine(text, o.timeout);
      else hideLine();
    }
  }

  armWatchdog();

  /* ---------------- keyboard shortcuts ---------------- */

  function onKeyDown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    // Never steal keys from a text field (lil-gui number inputs included).
    if (isTextEntry(e.target) || isTextEntry(document.activeElement)) return;

    const k = e.key;
    if (typeof k !== 'string') return;   // synthetic events may omit `key`

    if (k === 'Escape') {
      if (helpOpen()) { setHelp(false); e.preventDefault(); }
      else if (currentTab !== 'none') { setTab('none'); e.preventDefault(); }
      else if (!queryCard.hasAttribute('hidden')) { setQuery(null); e.preventDefault(); }
      return;
    }
    if (e.repeat) return;

    switch (k.toLowerCase()) {
      case 'r': toggle('autoRotate'); e.preventDefault(); break;
      case 't': emitAction('topView'); e.preventDefault(); break;
      case 'f': emitAction('flyTour'); e.preventDefault(); break;
      case 's': emitAction('screenshot'); e.preventDefault(); break;
      case 'w': toggle('showWater'); e.preventDefault(); break;
      case 'd': toggle('science'); e.preventDefault(); break;
      case 'h': case '?': setHelp(!helpOpen()); e.preventDefault(); break;
      case 'u': setUiHidden(!uiHidden); e.preventDefault(); break;
      default: break;
    }
  }

  window.addEventListener('keydown', onKeyDown);

  /* ---------------- initial paint ---------------- */

  refresh();

  /* ---------------- teardown ---------------- */

  function dispose() {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('pointerup', endScrub);
    window.removeEventListener('pointercancel', endScrub);
    clearTimeout(statusTimer);
    clearTimeout(watchdog);
    clearTimeout(overlayFade);
    try { gui.destroy(); } catch (e) { /* already gone */ }
    if (root.parentNode) root.parentNode.removeChild(root);
  }

  // Contract §5 requires setStats / setQuery / setStatus / gui / state.
  // setMeta / refresh / dispose / root are additive conveniences for main.js.
  // setTab / setUiHidden drive the narrow-viewport drawer (see above).
  return {
    setStats, setQuery, setStatus, gui, state, setMeta: applyMeta, refresh, dispose, root,
    setTab, setUiHidden, get tab() { return currentTab; },
  };
}
