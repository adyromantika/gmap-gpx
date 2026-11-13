(() => {
  if (window.__gpxOverlayLoaded) return;
  window.__gpxOverlayLoaded = true;

  const PALETTE = ["#e6194b", "#4363d8", "#3cb44b", "#f58231", "#911eb4", "#42d4f4", "#f032e6", "#9a6324", "#000075", "#808000"];
  const MAX_LAT = 85.05112878;

  const state = {
    tracks: [],
    settings: { width: 4, opacity: 0.9, showWaypoints: true, showKm: false, showArrows: false, gradient: false, satK: 1 },
    panel: { visible: true, collapsed: false },
  };

  let host = null;
  let canvas = null;
  let ctx = null;
  let lastHref = "";
  let lastSize = "";
  let lastView = null;
  let drag = null;
  let hideTimer = null;
  let statusMsg = "";
  let hitTracks = [];
  let tip = null;
  let tipDot = null;
  let hoverFrame = 0;

  // ---------- Geometry ----------

  function project(lat, lng) {
    const clamped = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
    const s = Math.sin((clamped * Math.PI) / 180);
    return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }

  function unprojectY(y) {
    const n = Math.PI - 2 * Math.PI * y;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  }

  function haversine(a, b) {
    const R = 6371008.8;
    const toRad = Math.PI / 180;
    const dLat = (b[0] - a[0]) * toRad;
    const dLng = (b[1] - a[1]) * toRad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * toRad) * Math.cos(b[0] * toRad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // Parses the "@lat,lng,ZOOMz" or "@lat,lng,METERSm" part of a Google Maps URL.
  function parseView(href) {
    const m = href.match(/@([^/?#]+)/);
    if (!m) return { error: "No map position in URL" };
    const parts = m[1].split(",");
    if (parts.length < 3) return { error: "Unrecognised map URL" };
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    if (!isFinite(lat) || !isFinite(lng)) return { error: "Unrecognised map URL" };
    for (const p of parts.slice(3)) {
      const unit = p.slice(-1);
      const val = parseFloat(p);
      if ((unit === "t" || unit === "h") && Math.abs(val) > 0.01) {
        return { error: "Tilted/rotated view – reset to a flat, north-up view" };
      }
    }
    const zm = parts[2].match(/^(\d+(?:\.\d+)?)([zma])$/);
    if (!zm) return { error: "Unsupported view" };
    if (zm[2] === "a") return { error: "Street View / 3D view not supported" };
    return { lat, lng, value: parseFloat(zm[1]), unit: zm[2] };
  }

  function resolveZoom(v, h) {
    if (v.unit === "z") return v.value;
    const mpp = v.value / (h * state.settings.satK);
    return Math.log2((156543.03392 * Math.cos((v.lat * Math.PI) / 180)) / mpp);
  }

  // When Google switches between "z" and "m" units at the same spot, learn the scale factor.
  function maybeCalibrate(prev, cur, h) {
    if (!prev || prev.unit === cur.unit) return;
    if (Math.abs(prev.lat - cur.lat) > 1e-4 || Math.abs(prev.lng - cur.lng) > 1e-4) return;
    const z = prev.unit === "z" ? prev.value : cur.value;
    const meters = prev.unit === "m" ? prev.value : cur.value;
    const mppAtZ = (156543.03392 * Math.cos((cur.lat * Math.PI) / 180)) / 2 ** z;
    const k = meters / (h * mppAtZ);
    if (k > 0.2 && k < 5) {
      state.settings.satK = k;
      saveSettings();
    }
  }

  // ---------- GPX parsing ----------

  function parseGpx(text, fileName) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("Invalid XML");
    const tag = (el, name) => Array.from(el.getElementsByTagNameNS("*", name));
    const pt = (el) => {
      const lat = parseFloat(el.getAttribute("lat"));
      const lng = parseFloat(el.getAttribute("lon"));
      return isFinite(lat) && isFinite(lng) ? [+lat.toFixed(6), +lng.toFixed(6)] : null;
    };
    const segments = [];
    for (const seg of tag(doc, "trkseg")) {
      const pts = tag(seg, "trkpt").map(pt).filter(Boolean);
      if (pts.length) segments.push(pts);
    }
    for (const rte of tag(doc, "rte")) {
      const pts = tag(rte, "rtept").map(pt).filter(Boolean);
      if (pts.length) segments.push(pts);
    }
    const waypoints = tag(doc, "wpt")
      .map((w) => {
        const p = pt(w);
        if (!p) return null;
        const n = tag(w, "name")[0];
        return { lat: p[0], lng: p[1], name: n ? n.textContent.trim() : "" };
      })
      .filter(Boolean);
    if (!segments.length && !waypoints.length) throw new Error("No track, route or waypoint data");

    let minLat = 90, maxLat = -90, minLng = 180, maxLng = -180, distance = 0;
    const extend = (lat, lng) => {
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      minLng = Math.min(minLng, lng); maxLng = Math.max(maxLng, lng);
    };
    for (const s of segments) {
      for (let i = 0; i < s.length; i++) {
        extend(s[i][0], s[i][1]);
        if (i) distance += haversine(s[i - 1], s[i]);
      }
    }
    for (const w of waypoints) extend(w.lat, w.lng);

    const nameEl = tag(doc, "metadata").flatMap((m) => tag(m, "name"))[0] || tag(doc, "trk").flatMap((t) => tag(t, "name"))[0];
    const name = (nameEl && nameEl.textContent.trim()) || fileName.replace(/\.gpx$/i, "");
    return { name, segments, waypoints, distance, bounds: [minLat, minLng, maxLat, maxLng] };
  }

  async function addFiles(files) {
    const errors = [];
    for (const f of files) {
      if (!/\.gpx$/i.test(f.name)) continue;
      try {
        const parsed = parseGpx(await f.text(), f.name);
        state.tracks.push({
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          color: PALETTE[state.tracks.length % PALETTE.length],
          visible: true,
          ...parsed,
        });
      } catch (e) {
        errors.push(`${f.name}: ${e.message}`);
      }
    }
    saveTracks();
    renderPanel();
    draw();
    if (errors.length) alert("GPX Overlay – could not load:\n" + errors.join("\n"));
  }

  // ---------- Storage ----------

  function saveTracks() { chrome.storage.local.set({ tracks: state.tracks }); }
  function saveSettings() { chrome.storage.local.set({ settings: state.settings }); }
  function savePanel() { chrome.storage.local.set({ panel: state.panel }); }

  // ---------- Overlay canvas ----------

  // Google's class names are obfuscated, so use the parent of the largest map canvas.
  function findHost() {
    const legacy = document.querySelector("#scene, .widget-scene");
    if (legacy) return legacy;
    let best = null, bestArea = 0;
    for (const c of document.getElementsByTagName("canvas")) {
      if (c === canvas) continue;
      const area = c.clientWidth * c.clientHeight;
      if (area > bestArea) { bestArea = area; best = c; }
    }
    return bestArea > 40000 ? best.parentElement : null;
  }

  function ensureCanvas() {
    const h = findHost();
    if (canvas && canvas.isConnected && h === host) return;
    host = h;
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.id = "gpx-overlay-canvas";
      canvas.style.cssText = "pointer-events:none;top:0;left:0;width:100%;height:100%;z-index:1;transition:opacity .15s;";
      ctx = canvas.getContext("2d");
    }
    if (host) {
      if (getComputedStyle(host).position === "static") host.style.position = "relative";
      canvas.style.position = "absolute";
      host.appendChild(canvas);
    } else {
      canvas.style.position = "fixed";
      document.body.appendChild(canvas);
    }
  }

  function draw() {
    ensureCanvas();
    lastHref = location.href;
    const rect = (host || document.documentElement).getBoundingClientRect();
    const w = Math.round(rect.width) || window.innerWidth;
    const h = Math.round(rect.height) || window.innerHeight;
    lastSize = w + "x" + h;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
    }
    canvas.style.transform = "";
    canvas.style.opacity = "1";
    if (drag) { drag.x += drag.dx; drag.y += drag.dy; drag.dx = drag.dy = 0; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    hitTracks = [];
    hideTooltip();

    const v = parseView(location.href);
    const prevStatus = statusMsg;
    if (v.error) {
      statusMsg = state.tracks.length ? v.error : "";
      if (statusMsg !== prevStatus) renderStatus();
      return;
    }
    maybeCalibrate(lastView, v, h);
    lastView = v;
    statusMsg = v.unit === "m" ? "Satellite view: alignment is approximate" : "";
    if (statusMsg !== prevStatus) renderStatus();

    const zoom = resolveZoom(v, h);
    const world = 256 * 2 ** zoom;
    const [cx, cy] = project(v.lat, v.lng);
    const toPx = (lat, lng) => {
      const [x, y] = project(lat, lng);
      let dx = x - cx;
      if (dx > 0.5) dx -= 1; else if (dx < -0.5) dx += 1;
      return [dx * world + w / 2, (y - cy) * world + h / 2];
    };
    const { width, opacity, showWaypoints, showKm, showArrows, gradient } = state.settings;
    const pad = 50;
    const pxPerKm = (world / 40075.016686) / Math.cos((v.lat * Math.PI) / 180);
    const kmStep = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000].find((s) => s * pxPerKm >= 45) || 2000;
    const onScreen = (p) => p[0] > -pad && p[0] < w + pad && p[1] > -pad && p[1] < h + pad;

    for (const t of state.tracks) {
      if (!t.visible) continue;
      const [bx1, by1] = toPx(t.bounds[2], t.bounds[1]);
      const [bx2, by2] = toPx(t.bounds[0], t.bounds[3]);
      if (bx2 < -pad || bx1 > w + pad || by2 < -pad || by1 > h + pad) continue;

      ctx.globalAlpha = opacity;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const cum = cumulative(t);
      const total = cum.total || 1;
      const fracs = [];
      const paths = t.segments.map((seg, si) => {
        const out = [], fr = [];
        let px = null, py = null;
        for (let i = 0; i < seg.length; i++) {
          const [x, y] = toPx(seg[i][0], seg[i][1]);
          if (px !== null && i < seg.length - 1 && Math.abs(x - px) < 0.7 && Math.abs(y - py) < 0.7) continue;
          out.push(x, y);
          fr.push(cum.segs[si][i] / total);
          px = x; py = y;
        }
        fracs.push(fr);
        return out;
      });
      hitTracks.push({ t, paths, fracs, total, pxPerKm, color: gradient ? null : t.color });
      if (gradient) {
        // Bucket line pieces by progress and draw in order, so later passes sit on top with their own casing.
        const BINS = 48;
        const buckets = Array.from({ length: BINS }, () => []);
        paths.forEach((p, pi) => {
          const fr = fracs[pi];
          if (p.length === 2) buckets[Math.min(BINS - 1, Math.floor(fr[0] * BINS))].push(p[0], p[1], p[0] + 0.01, p[1]);
          for (let i = 2; i < p.length; i += 2) {
            const b = Math.min(BINS - 1, Math.floor(((fr[i / 2 - 1] + fr[i / 2]) / 2) * BINS));
            buckets[b].push(p[i - 2], p[i - 1], p[i], p[i + 1]);
          }
        });
        buckets.forEach((seg, b) => {
          if (!seg.length) return;
          for (const [style, lw] of [["rgba(255,255,255,0.9)", width + 3], [progressColor((b + 0.5) / BINS), width]]) {
            ctx.strokeStyle = style;
            ctx.lineWidth = lw;
            ctx.beginPath();
            for (let i = 0; i < seg.length; i += 4) { ctx.moveTo(seg[i], seg[i + 1]); ctx.lineTo(seg[i + 2], seg[i + 3]); }
            ctx.stroke();
          }
        });
      } else {
        for (const [style, lw] of [["rgba(255,255,255,0.85)", width + 3], [t.color, width]]) {
          ctx.strokeStyle = style;
          ctx.lineWidth = lw;
          ctx.beginPath();
          for (const p of paths) {
            ctx.moveTo(p[0], p[1]);
            for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i], p[i + 1]);
            if (p.length === 2) ctx.lineTo(p[0] + 0.01, p[1]);
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
      if (showArrows) drawArrows(paths, width, gradient ? "#333" : t.color, onScreen);
      if (showKm) drawKmMarkers(t, kmStep, toPx, onScreen, gradient ? (km) => progressColor((km * 1000) / total) : () => t.color);
      const first = t.segments[0];
      const last = t.segments[t.segments.length - 1];
      if (first) dot(toPx(first[0][0], first[0][1]), "#2ecc40", width + 2);
      if (last) dot(toPx(last[last.length - 1][0], last[last.length - 1][1]), "#ff4136", width + 2);

      if (showWaypoints) {
        ctx.font = "600 12px Roboto, Arial, sans-serif";
        for (const wp of t.waypoints) {
          const p = toPx(wp.lat, wp.lng);
          if (p[0] < -pad || p[0] > w + pad || p[1] < -pad || p[1] > h + pad) continue;
          dot(p, t.color, 5);
          if (wp.name) {
            ctx.lineWidth = 3;
            ctx.strokeStyle = "white";
            ctx.strokeText(wp.name, p[0] + 8, p[1] + 4);
            ctx.fillStyle = "#222";
            ctx.fillText(wp.name, p[0] + 8, p[1] + 4);
          }
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  // Blue (start) → cyan → green → yellow → red (end).
  function progressColor(f) {
    const c = Math.max(0, Math.min(1, f));
    return `hsl(${Math.round(240 * (1 - c))}, 90%, ${c > 0.35 && c < 0.65 ? 40 : 48}%)`;
  }

  const cumCache = new WeakMap();
  function cumulative(t) {
    let c = cumCache.get(t);
    if (c) return c;
    let d = 0;
    const segs = t.segments.map((seg) => seg.map((p, i) => (d += i ? haversine(seg[i - 1], p) : 0)));
    c = { segs, total: d };
    cumCache.set(t, c);
    return c;
  }

  function drawArrows(paths, width, color, onScreen) {
    const spacing = 100;
    const size = Math.max(8, width * 2.2);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.fillStyle = "white";
    ctx.lineJoin = "round";
    for (const p of paths) {
      let carry = spacing / 2;
      for (let i = 2; i < p.length; i += 2) {
        const x0 = p[i - 2], y0 = p[i - 1], dx = p[i] - x0, dy = p[i + 1] - y0;
        const len = Math.hypot(dx, dy);
        if (!len) continue;
        const ang = Math.atan2(dy, dx);
        let s = carry;
        while (s <= len) {
          const pos = [x0 + (dx * s) / len, y0 + (dy * s) / len];
          if (onScreen(pos)) {
            ctx.save();
            ctx.translate(pos[0], pos[1]);
            ctx.rotate(ang);
            ctx.beginPath();
            ctx.moveTo(-size * 0.7, -size * 0.8);
            ctx.lineTo(size * 0.8, 0);
            ctx.lineTo(-size * 0.7, size * 0.8);
            ctx.lineTo(-size * 0.3, 0);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            ctx.restore();
          }
          s += spacing;
        }
        carry = s - len;
      }
    }
  }

  function drawKmMarkers(t, step, toPx, onScreen, colorAt) {
    ctx.font = "700 11px Roboto, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    let dist = 0;
    let next = step;
    for (const seg of t.segments) {
      for (let i = 1; i < seg.length; i++) {
        const d = haversine(seg[i - 1], seg[i]) / 1000;
        while (d > 0 && dist + d >= next) {
          const f = (next - dist) / d;
          const p = toPx(seg[i - 1][0] + (seg[i][0] - seg[i - 1][0]) * f, seg[i - 1][1] + (seg[i][1] - seg[i - 1][1]) * f);
          if (onScreen(p)) {
            const label = String(next);
            const r = Math.max(9, label.length * 3.5 + 4);
            ctx.beginPath();
            ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
            ctx.fillStyle = colorAt(next);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = "white";
            ctx.stroke();
            ctx.fillStyle = "white";
            ctx.fillText(label, p[0], p[1] + 0.5);
          }
          next += step;
        }
        dist += d;
      }
    }
    ctx.textAlign = "start";
    ctx.textBaseline = "alphabetic";
  }

  function dot([x, y], color, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "white";
    ctx.stroke();
  }

  // ---------- Fit to bounds ----------

  function fitBounds(bounds) {
    if (!bounds) return;
    const rect = (host || document.documentElement).getBoundingClientRect();
    const w = rect.width || window.innerWidth;
    const h = rect.height || window.innerHeight;
    const [x1, y1] = project(bounds[2], bounds[1]);
    const [x2, y2] = project(bounds[0], bounds[3]);
    const dx = Math.max(x2 - x1, 1e-9);
    const dy = Math.max(y2 - y1, 1e-9);
    let zoom = Math.min(Math.log2((w * 0.75) / (dx * 256)), Math.log2((h * 0.75) / (dy * 256)));
    zoom = Math.max(2, Math.min(19, zoom));
    const lat = unprojectY((y1 + y2) / 2);
    const lng = (x1 + x2) / 2 * 360 - 180;
    const at = `@${lat.toFixed(7)},${lng.toFixed(7)},${zoom.toFixed(2)}z`;
    const href = /@[^/?#]+/.test(location.href)
      ? location.href.replace(/@[^/?#]+/, at)
      : `${location.origin}/maps/${at}`;
    location.href = href;
  }

  function unionBounds(tracks) {
    const b = tracks.map((t) => t.bounds);
    if (!b.length) return null;
    return [
      Math.min(...b.map((x) => x[0])), Math.min(...b.map((x) => x[1])),
      Math.max(...b.map((x) => x[2])), Math.max(...b.map((x) => x[3])),
    ];
  }

  // ---------- Panel UI ----------

  let panelHost, root;

  function buildPanel() {
    panelHost = document.createElement("div");
    panelHost.id = "gpx-overlay-panel";
    panelHost.style.cssText = "position:fixed;top:72px;right:12px;z-index:2147483000;";
    root = panelHost.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .box { font: 13px Roboto, Arial, sans-serif; color: #202124; background: #fff; border-radius: 8px;
               box-shadow: 0 2px 8px rgba(0,0,0,.3); width: 280px; max-height: 70vh; display: flex; flex-direction: column; }
        .hdr { display: flex; align-items: center; padding: 8px 10px; cursor: pointer; user-select: none; font-weight: 600; }
        .hdr span { flex: 1; }
        .body { padding: 0 10px 10px; overflow: auto; }
        .collapsed .body { display: none; }
        button { font: inherit; border: 1px solid #dadce0; background: #fff; border-radius: 4px; padding: 3px 8px; cursor: pointer; }
        button:hover { background: #f1f3f4; }
        .row { display: flex; gap: 6px; margin-bottom: 8px; }
        .track { display: flex; align-items: center; gap: 6px; padding: 4px 0; border-top: 1px solid #eee; }
        .track .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .track .dist { color: #5f6368; font-size: 11px; }
        .track button { padding: 0 5px; border: none; }
        input[type=color] { width: 22px; height: 22px; padding: 0; border: none; background: none; cursor: pointer; }
        .settings { border-top: 1px solid #eee; padding-top: 6px; margin-top: 4px; }
        .settings label { display: flex; align-items: center; gap: 6px; margin: 4px 0; }
        .settings input[type=range] { flex: 1; }
        .status { color: #b06000; font-size: 12px; margin: 4px 0; }
        .hint { color: #5f6368; font-size: 11px; margin-top: 6px; }
        .empty { color: #5f6368; padding: 6px 0; }
      </style>
      <div class="box">
        <div class="hdr"><span>GPX Overlay</span><b class="chev"></b></div>
        <div class="body">
          <div class="row">
            <button class="add">Add GPX…</button>
            <button class="fitall">Fit all</button>
            <button class="clear">Clear</button>
            <input class="file" type="file" accept=".gpx,application/gpx+xml" multiple hidden>
          </div>
          <div class="status"></div>
          <div class="list"></div>
          <div class="settings">
            <label>Width <input class="width" type="range" min="1" max="12" step="1"></label>
            <label>Opacity <input class="opacity" type="range" min="0.1" max="1" step="0.05"></label>
            <label><input class="wpts" type="checkbox"> Show waypoints</label>
            <label><input class="km" type="checkbox"> Show KM markers</label>
            <label><input class="arrows" type="checkbox"> Show direction arrows</label>
            <label><input class="grad" type="checkbox"> Colour by progress
              <span style="flex:1;height:6px;border-radius:3px;background:linear-gradient(90deg,hsl(240,90%,48%),hsl(180,90%,48%),hsl(120,90%,40%),hsl(60,90%,48%),hsl(0,90%,48%))"></span></label>
          </div>
          <div class="hint">Tip: drag &amp; drop .gpx files onto the map. Click the extension icon to hide this panel.</div>
        </div>
      </div>`;
    const $ = (s) => root.querySelector(s);
    $(".hdr").onclick = () => { state.panel.collapsed = !state.panel.collapsed; savePanel(); renderPanel(); };
    $(".add").onclick = () => $(".file").click();
    $(".file").onchange = (e) => { addFiles(Array.from(e.target.files)); e.target.value = ""; };
    $(".fitall").onclick = () => fitBounds(unionBounds(state.tracks.filter((t) => t.visible)));
    $(".clear").onclick = () => {
      if (state.tracks.length && confirm("Remove all GPX tracks?")) { state.tracks = []; saveTracks(); renderPanel(); draw(); }
    };
    $(".width").oninput = (e) => { state.settings.width = +e.target.value; saveSettings(); draw(); };
    $(".opacity").oninput = (e) => { state.settings.opacity = +e.target.value; saveSettings(); draw(); };
    $(".wpts").onchange = (e) => { state.settings.showWaypoints = e.target.checked; saveSettings(); draw(); };
    $(".km").onchange = (e) => { state.settings.showKm = e.target.checked; saveSettings(); draw(); };
    $(".arrows").onchange = (e) => { state.settings.showArrows = e.target.checked; saveSettings(); draw(); };
    $(".grad").onchange = (e) => { state.settings.gradient = e.target.checked; saveSettings(); draw(); };
    document.documentElement.appendChild(panelHost);
  }

  function renderStatus() {
    if (root) root.querySelector(".status").textContent = statusMsg;
  }

  function renderPanel() {
    if (!root) return;
    const $ = (s) => root.querySelector(s);
    panelHost.style.display = state.panel.visible ? "" : "none";
    $(".box").classList.toggle("collapsed", state.panel.collapsed);
    $(".chev").textContent = state.panel.collapsed ? "▸" : "▾";
    $(".width").value = state.settings.width;
    $(".opacity").value = state.settings.opacity;
    $(".wpts").checked = state.settings.showWaypoints;
    $(".km").checked = state.settings.showKm;
    $(".arrows").checked = state.settings.showArrows;
    $(".grad").checked = state.settings.gradient;
    renderStatus();

    const list = $(".list");
    list.textContent = "";
    if (!state.tracks.length) {
      list.innerHTML = '<div class="empty">No GPX files loaded.</div>';
      return;
    }
    for (const t of state.tracks) {
      const row = document.createElement("div");
      row.className = "track";
      const vis = Object.assign(document.createElement("input"), { type: "checkbox", checked: t.visible, title: "Show/hide" });
      vis.onchange = () => { t.visible = vis.checked; saveTracks(); draw(); };
      const color = Object.assign(document.createElement("input"), { type: "color", value: t.color, title: "Colour" });
      color.oninput = () => { t.color = color.value; draw(); };
      color.onchange = () => saveTracks();
      const name = Object.assign(document.createElement("span"), { className: "name", textContent: t.name, title: t.name });
      const dist = Object.assign(document.createElement("span"), { className: "dist", textContent: t.distance ? (t.distance / 1000).toFixed(1) + " km" : `${t.waypoints.length} wpt` });
      const fit = Object.assign(document.createElement("button"), { textContent: "⤢", title: "Zoom to track" });
      fit.onclick = () => fitBounds(t.bounds);
      const del = Object.assign(document.createElement("button"), { textContent: "✕", title: "Remove" });
      del.onclick = () => { state.tracks = state.tracks.filter((x) => x !== t); saveTracks(); renderPanel(); draw(); };
      row.append(vis, color, name, dist, fit, del);
      list.appendChild(row);
    }
  }

  // ---------- Interaction tracking (keeps overlay in sync while panning/zooming) ----------

  function inMap(e) {
    return host ? host.contains(e.target) : !(panelHost && panelHost.contains(e.target));
  }

  window.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && inMap(e)) drag = { x: e.clientX, y: e.clientY, dx: 0, dy: 0 };
  }, true);
  window.addEventListener("pointermove", (e) => {
    if (!drag || !canvas) return;
    if (!(e.buttons & 1)) { drag = null; return; }
    drag.dx = e.clientX - drag.x;
    drag.dy = e.clientY - drag.y;
    canvas.style.transform = `translate(${drag.dx}px, ${drag.dy}px)`;
  }, true);
  window.addEventListener("pointerup", () => {
    if (!drag) return;
    drag = null;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(draw, 1500);
  }, true);

  const hideWhileZooming = (e) => {
    if (!canvas || !inMap(e)) return;
    canvas.style.opacity = "0";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(draw, 1200);
  };
  window.addEventListener("wheel", hideWhileZooming, { capture: true, passive: true });
  window.addEventListener("dblclick", hideWhileZooming, true);

  window.addEventListener("dragover", (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault();
  }, true);
  window.addEventListener("drop", (e) => {
    const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []).filter((f) => /\.gpx$/i.test(f.name));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    addFiles(files);
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "gpx-toggle-panel") {
      state.panel.visible = !state.panel.visible;
      savePanel();
      renderPanel();
    }
  });

  // ---------- Hover tooltip ----------

  function hideTooltip() {
    if (tip) tip.style.display = "none";
    if (tipDot) tipDot.style.display = "none";
  }

  function fmtKm(m) {
    const km = m / 1000;
    return (km < 10 ? km.toFixed(2) : km.toFixed(1)) + " km";
  }

  // Returns every pass of every visible track within `radius` px of (x, y), one entry per distinct pass.
  function hitTest(x, y, radius) {
    const results = [];
    for (const ht of hitTracks) {
      const hits = [];
      ht.paths.forEach((p, pi) => {
        const fr = ht.fracs[pi];
        if (p.length === 2) {
          const dd = Math.hypot(x - p[0], y - p[1]);
          if (dd <= radius) hits.push({ px: dd, x: p[0], y: p[1], f: fr[0] });
        }
        for (let i = 2; i < p.length; i += 2) {
          const x0 = p[i - 2], y0 = p[i - 1], x1 = p[i], y1 = p[i + 1];
          if (Math.min(x0, x1) - radius > x || Math.max(x0, x1) + radius < x || Math.min(y0, y1) - radius > y || Math.max(y0, y1) + radius < y) continue;
          const dx = x1 - x0, dy = y1 - y0, l2 = dx * dx + dy * dy;
          const u = l2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / l2)) : 0;
          const sx = x0 + u * dx, sy = y0 + u * dy;
          const dd = Math.hypot(x - sx, y - sy);
          if (dd <= radius) hits.push({ px: dd, x: sx, y: sy, f: fr[i / 2 - 1] + u * (fr[i / 2] - fr[i / 2 - 1]) });
        }
      });
      if (!hits.length) continue;
      // Merge hits that are the same pass (close together along the route).
      const gap = ((radius * 3) / ht.pxPerKm) * 1000;
      hits.sort((a, b) => a.f - b.f);
      const groups = [];
      for (const hit of hits) {
        hit.m = hit.f * ht.total;
        const g = groups[groups.length - 1];
        if (g && hit.m - g.last <= gap) {
          g.last = hit.m;
          if (hit.px < g.best.px) g.best = hit;
        } else groups.push({ last: hit.m, best: hit });
      }
      for (const g of groups) results.push({ ...g.best, ht });
    }
    return results;
  }

  function onHover(e) {
    if (!hitTracks.length || drag || !canvas || canvas.style.opacity === "0" || !inMap(e)) { hideTooltip(); return; }
    const rect = canvas.getBoundingClientRect();
    const hits = hitTest(e.clientX - rect.left, e.clientY - rect.top, Math.max(8, state.settings.width + 4));
    if (!hits.length) { hideTooltip(); return; }
    if (!tip) {
      tip = document.createElement("div");
      tip.style.cssText = "position:fixed;z-index:2147483001;pointer-events:none;background:rgba(32,33,36,.92);color:#fff;font:12px/1.45 Roboto,Arial,sans-serif;padding:5px 8px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.3);white-space:nowrap;";
      tipDot = document.createElement("div");
      tipDot.style.cssText = "position:fixed;z-index:2147483001;pointer-events:none;width:10px;height:10px;margin:-7px 0 0 -7px;border-radius:50%;background:#fff;border:2px solid #202124;";
      document.documentElement.append(tipDot, tip);
    }
    const multiTrack = new Set(hits.map((h) => h.ht)).size > 1 || state.tracks.filter((t) => t.visible).length > 1;
    tip.textContent = "";
    let lastTrack = null;
    for (const h of hits) {
      if (multiTrack && h.ht !== lastTrack) {
        const name = document.createElement("div");
        name.style.cssText = "font-weight:600;opacity:.8;";
        name.textContent = h.ht.t.name;
        tip.appendChild(name);
        lastTrack = h.ht;
      }
      const row = document.createElement("div");
      const sw = document.createElement("span");
      sw.style.cssText = `display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:${h.ht.color || progressColor(h.f)};`;
      row.append(sw, `${fmtKm(h.m)}  ·  ${Math.round(h.f * 100)}%`);
      tip.appendChild(row);
    }
    const best = hits.reduce((a, b) => (b.px < a.px ? b : a));
    tipDot.style.left = rect.left + best.x + "px";
    tipDot.style.top = rect.top + best.y + "px";
    tipDot.style.display = "block";
    tip.style.display = "block";
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let left = e.clientX + 14, top = e.clientY + 14;
    if (left + tw > window.innerWidth - 4) left = e.clientX - tw - 14;
    if (top + th > window.innerHeight - 4) top = e.clientY - th - 14;
    tip.style.left = left + "px";
    tip.style.top = top + "px";
  }

  window.addEventListener("mousemove", (e) => {
    cancelAnimationFrame(hoverFrame);
    hoverFrame = requestAnimationFrame(() => onHover(e));
  }, { capture: true, passive: true });
  document.addEventListener("mouseleave", hideTooltip);

  window.addEventListener("resize", () => draw());

  // ---------- Init ----------

  chrome.storage.local.get(["tracks", "settings", "panel"]).then((d) => {
    if (Array.isArray(d.tracks)) state.tracks = d.tracks;
    if (d.settings) Object.assign(state.settings, d.settings);
    if (d.panel) Object.assign(state.panel, d.panel);
    buildPanel();
    renderPanel();
    draw();
    setInterval(() => {
      const rect = (host || document.documentElement).getBoundingClientRect();
      const size = Math.round(rect.width) + "x" + Math.round(rect.height);
      if (location.href !== lastHref || size !== lastSize || !canvas.isConnected || findHost() !== host) draw();
    }, 100);
  });
})();
