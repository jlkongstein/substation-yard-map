// Substation Yard Map: loads data/*.json, renders yards on a Leaflet map with a searchable,
// sortable platform list. All data is static; the weekly updater rewrites the JSON files.

const STATUSES = ["Contracted", "Fabrication", "Outfitting", "Sailed away", "Installed"];
// This is a production tracker: installed platforms stay in the data but are never shown.
const TRACKED = STATUSES.filter((s) => s !== "Installed");
const STATUS_VAR = {
  "Contracted": "--s-contracted", "Fabrication": "--s-fabrication", "Outfitting": "--s-outfitting",
  "Sailed away": "--s-sailed", "Installed": "--s-installed",
};

const state = {
  yards: [], platforms: [], meta: {},
  yardById: new Map(),
  q: "", sort: "news", type: "",
  statuses: new Set(["Contracted", "Fabrication", "Outfitting", "Sailed away"]),
  showJackets: false, hideUnverified: false, tab: "platforms", selected: null,
};

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const statusColor = (s) => css(STATUS_VAR[s] || "--s-installed");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (n) => (n == null ? "–" : n.toLocaleString("en-GB"));
const fmtGW = (mw) => (mw == null ? null : `${+(mw / 1000).toFixed(mw >= 1000 ? 1 : 2)} GW`);
const sumGW = (ps) => fmtGW(ps.reduce((s, p) => s + (p.capacity_mw || 0), 0) || null);
const latestNews = (p) => (p.sources || []).map((s) => s.date || "").sort().pop() || "";
const isTopsideRole = (role) => !/^jacket$/i.test(role);

let map, cluster, routeLayer, sitesLayer, markers = new Map();

async function load() {
  const get = (f) => fetch(`data/${f}?v=${Date.now()}`).then((r) => r.json());
  const [yards, platforms, meta] = await Promise.all([get("yards.json"), get("platforms.json"), get("meta.json")]);
  Object.assign(state, { yards, platforms, meta });
  yards.forEach((y) => state.yardById.set(y.id, y));
  initMap();
  initControls();
  restoreFromHash();
  render();
}

function initMap() {
  map = L.map("map", { worldCopyJump: true, zoomControl: true }).setView([45, 40], 3);
  // Plain grey land/sea basemap without roads or labels: only the coastlines matter here.
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  L.tileLayer(`https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_${dark ? "Dark" : "Light"}_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    maxZoom: 16,
  }).addTo(map);

  // Yards that would overlap merge into one ball (numbers summed) and split again as you zoom in.
  cluster = L.markerClusterGroup({
    maxClusterRadius: 48,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    iconCreateFunction: (c) => {
      const kids = c.getAllChildMarkers().map((m) => m.options.yard);
      const topside = kids.filter((k) => !k.jacket);
      // Count each platform once, even when several of its yards sit inside the same ball.
      const n = clusterPlatforms(topside.length ? topside : kids).length;
      const color = topside.length ? statusColor(STATUSES[Math.min(...topside.map((k) => k.statusIdx))]) : css("--jacket");
      return yardIcon(n, color, { jacket: !topside.length, group: kids.length });
    },
  }).addTo(map);
  cluster.on("clustermouseover", (e) => {
    const kids = e.layer.getAllChildMarkers();
    const names = kids.map((m) => m.options.title).sort();
    const ps = clusterPlatforms(kids.map((m) => m.options.yard));
    const gw = sumGW(ps);
    e.layer.bindTooltip(`${names.length} yards · ${ps.length} platforms${gw ? ` · ${gw}` : ""}<br>${names.map(esc).join("<br>")}`,
      { direction: "top" }).openTooltip();
  });
  // Close popups on pointerup as well as click: on touch screens the click on the small × is
  // sometimes swallowed (e.g. while the map is still settling after a zoom).
  map.on("popupopen", (e) => {
    const btn = e.popup.getElement()?.querySelector(".leaflet-popup-close-button");
    btn?.addEventListener("pointerup", (ev) => { ev.preventDefault(); ev.stopPropagation(); e.popup.close(); });
  });
  sitesLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);

  $("legend").innerHTML =
    TRACKED.map((s) => `<span><i style="background:${statusColor(s)}"></i>${s}</span>`).join("") +
    `<span><i style="background:${css("--jacket")}"></i>Jacket only</span>` +
    `<span><i class="lg-site small"></i>Installation site</span>` +
    `<span><i class="lg-route"></i>Likely sea route</span>` +
    `<span style="color:${css("--muted")}">Colour = most active topside</span>`;
}

function initControls() {
  $("statusChips").innerHTML = TRACKED.map((s) =>
    `<button type="button" class="chip${state.statuses.has(s) ? " on" : ""}" data-s="${s}" style="--c:${statusColor(s)}"><span class="dot"></span>${s}</button>`
  ).join("");
  $("statusChips").addEventListener("click", (e) => {
    const b = e.target.closest(".chip"); if (!b) return;
    const s = b.dataset.s;
    state.statuses.has(s) ? state.statuses.delete(s) : state.statuses.add(s);
    b.classList.toggle("on");
    render();
  });
  $("search").addEventListener("input", (e) => { state.q = e.target.value.trim().toLowerCase(); render(); });
  $("sort").addEventListener("change", (e) => { state.sort = e.target.value; render(); });
  $("type").addEventListener("change", (e) => { state.type = e.target.value; render(); });
  $("showJackets").addEventListener("change", (e) => { state.showJackets = e.target.checked; render(); });
  $("hideUnverified").addEventListener("change", (e) => { state.hideUnverified = e.target.checked; render(); });
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x === t));
    state.tab = t.dataset.tab; renderList();
  }));
  $("detailClose").addEventListener("click", closeDetail);
  $("listToggle").addEventListener("click", () => {
    $("listToggle").textContent = $("sidebar").classList.toggle("open") ? "Map" : "List";
  });
  $("newsBtn").addEventListener("click", openNews);

  const m = state.meta;
  const inProduction = state.platforms.filter((p) => p.status !== "Installed");
  $("stats").textContent = `${inProduction.length} platforms in production · ${sumGW(inProduction)} · updated ${m.last_updated || "–"}`;
}

// ---------- filtering ----------

function haystack(p) {
  const yardText = p.yards.map((r) => {
    const y = state.yardById.get(r.yard);
    return y ? `${y.name} ${y.operator} ${y.city} ${y.country}` : r.yard;
  }).join(" ");
  return `${p.name} ${p.project} ${p.client} ${p.epc} ${p.site_country} ${p.type} ${p.notes} ${yardText}`.toLowerCase();
}

function visiblePlatforms() {
  return state.platforms.filter((p) =>
    state.statuses.has(p.status) && p.status !== "Installed" &&
    !(state.hideUnverified && p.confidence === "low") &&
    (!state.type || p.type === state.type) &&
    (!state.q || haystack(p).includes(state.q))
  );
}

function primaryYard(p) {
  const r = p.yards.find((r) => isTopsideRole(r.role)) || p.yards[0];
  return r ? state.yardById.get(r.yard) : null;
}

function sortPlatforms(list) {
  const by = {
    name: (a, b) => a.name.localeCompare(b.name),
    status: (a, b) => STATUSES.indexOf(b.status) - STATUSES.indexOf(a.status) || a.name.localeCompare(b.name),
    yard: (a, b) => (primaryYard(a)?.name || "").localeCompare(primaryYard(b)?.name || ""),
    client: (a, b) => (a.client || "").localeCompare(b.client || ""),
    capacity: (a, b) => (b.capacity_mw ?? -1) - (a.capacity_mw ?? -1),
    weight: (a, b) => (b.topside_t ?? -1) - (a.topside_t ?? -1),
    cod: (a, b) => (a.cod ?? 9999) - (b.cod ?? 9999),
    news: (a, b) => latestNews(b).localeCompare(latestNews(a)),
  }[state.sort];
  return [...list].sort(by);
}

// Yard summary for the current filter: which visible platforms touch it, and in what role.
function yardIndex(platforms) {
  const idx = new Map();
  for (const p of platforms) {
    for (const r of p.yards) {
      if (!idx.has(r.yard)) idx.set(r.yard, []);
      idx.get(r.yard).push({ p, role: r.role });
    }
  }
  return idx;
}

// ---------- rendering ----------

function render() {
  const vis = visiblePlatforms();
  const idx = yardIndex(vis);
  renderMarkers(idx);
  renderSites(vis);
  renderList(vis, idx);
}

// Small diamonds for where each visible platform will be installed; platforms sharing a site share one.
function renderSites(vis) {
  sitesLayer.clearLayers();
  const bySite = new Map();
  for (const p of vis) {
    if (!p.site) continue;
    const k = `${p.site.lat.toFixed(2)},${p.site.lon.toFixed(2)}`;
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k).push(p);
  }
  for (const ps of bySite.values()) {
    const s = ps[0].site;
    const color = statusColor(STATUSES[Math.min(...ps.map((p) => STATUSES.indexOf(p.status)))]);
    const icon = L.divIcon({ className: "", html: `<div class="site-dot" style="background:${color}"></div>`, iconSize: [12, 12], iconAnchor: [6, 6] });
    const label = ps.map((p) => `${esc(p.name)}${fmtGW(p.capacity_mw) ? ` · ${fmtGW(p.capacity_mw)}` : ""} · ${esc(p.status)}`).join("<br>");
    L.marker([s.lat, s.lon], { icon, zIndexOffset: -500 })
      .bindTooltip(`<strong>${esc(s.name)}</strong><br>${label}`, { direction: "top", offset: [0, -6] })
      .on("click", () => showPlatform(ps[0].id))
      .addTo(sitesLayer);
  }
}

function clusterPlatforms(yardInfos) {
  const seen = new Map();
  for (const y of yardInfos) for (const p of y.platforms) seen.set(p.id, p);
  return [...seen.values()];
}

function yardIcon(n, color, { jacket = false, group = 0 } = {}) {
  const size = 22 + Math.min(n, 8) * 4 + (group ? 6 : 0);
  return L.divIcon({
    className: "",
    html: `<div class="yard-marker${jacket ? " jacket" : ""}${group ? " group" : ""}" style="width:${size}px;height:${size}px;background:${color}">${n || ""}</div>`,
    iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
  });
}

function renderMarkers(idx) {
  cluster.clearLayers();
  markers.clear();
  for (const y of state.yards) {
    const items = idx.get(y.id) || [];
    const topsideItems = items.filter((i) => isTopsideRole(i.role));
    const jacketOnly = topsideItems.length === 0;
    const yardMatches = state.q && `${y.name} ${y.operator} ${y.city} ${y.country}`.toLowerCase().includes(state.q);
    if (!items.length && !yardMatches) continue;
    if (jacketOnly && !state.showJackets) continue;

    // Colour by the least advanced active topside (most "in-yard" work).
    const active = topsideItems.map((i) => STATUSES.indexOf(i.p.status)).filter((i) => i >= 0);
    const statusIdx = active.length ? Math.min(...active) : STATUSES.length - 1;
    const color = jacketOnly ? css("--jacket") : statusColor(STATUSES[statusIdx]);
    const n = jacketOnly ? items.length : topsideItems.length;
    const mk = L.marker([y.lat, y.lon], {
      icon: yardIcon(n, color, { jacket: jacketOnly }), title: y.name, riseOnHover: true,
      yard: { n, statusIdx, jacket: jacketOnly, platforms: (jacketOnly ? items : topsideItems).map((i) => i.p) },
    }).bindPopup(() => yardPopup(y, items), { maxWidth: 320 });
    markers.set(y.id, mk);
  }
  cluster.addLayers([...markers.values()]);
}

function yardPopup(y, items) {
  const div = document.createElement("div");
  div.className = "pop";
  const rows = items.length
    ? items.map(({ p, role }) =>
        `<li><a data-p="${esc(p.id)}"><span><span class="n">${esc(p.name)}</span>${fmtGW(p.capacity_mw) ? ` <span class="gw">${fmtGW(p.capacity_mw)}</span>` : ""}
         <span class="role">${esc(role)}</span>
         ${p.site ? `<span class="role">→ Site: ${esc(p.site.name)}</span>` : ""}</span>
         <span class="pill" style="--c:${statusColor(p.status)}">${esc(p.status)}</span></a></li>`).join("")
    : `<li class="m">No platforms match the current filters.</li>`;
  const topside = items.filter((i) => isTopsideRole(i.role)).map((i) => i.p);
  const total = sumGW(topside);
  div.innerHTML = `<h3>${esc(y.name)}</h3>
    <div class="m">${esc(y.operator)} · ${esc(y.city)}, ${esc(y.country)}</div>
    ${topside.length ? `<div class="m"><strong>${topside.length} topside${topside.length > 1 ? "s" : ""}${total ? ` · ${total} in total` : ""}</strong></div>` : ""}
    ${y.notes ? `<div class="m">${esc(y.notes)}</div>` : ""}
    <ul>${rows}</ul>`;
  div.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-p]"); if (a) showPlatform(a.dataset.p, { fly: false });
  });
  return div;
}

function renderList(vis = visiblePlatforms(), idx = yardIndex(vis)) {
  const list = $("list");
  $("pCount").textContent = `(${vis.length})`;
  const yardsShown = state.yards.filter((y) => markers.has(y.id));
  $("yCount").textContent = `(${yardsShown.length})`;

  if (state.tab === "platforms") {
    const rows = sortPlatforms(vis).map((p) => {
      const y = primaryYard(p);
      const meta = [y ? `${y.name}, ${y.country}` : "Yard unknown", p.site ? `→ ${p.site.name.split(",")[1]?.trim() || p.site.name}` : null, p.cod ? `COD ${p.cod}` : null]
        .filter(Boolean).join(" · ");
      return `<li data-p="${esc(p.id)}" class="${state.selected === p.id ? "sel" : ""}">
        <div class="t"><span>${esc(p.name)}${fmtGW(p.capacity_mw) ? ` <span class="gw">${fmtGW(p.capacity_mw)}</span>` : ""}</span><span class="pill" style="--c:${statusColor(p.status)}">${esc(p.status)}</span></div>
        <div class="m">${esc(p.client)} · ${esc(p.type)}${p.confidence === "low" ? ` · <span class="conf-low">unverified</span>` : ""}${p.suggested ? ` · <span class="conf-low">possibly ${esc(p.suggested.status.toLowerCase())}</span>` : ""}</div>
        <div class="m">${esc(meta)}</div></li>`;
    });
    list.innerHTML = rows.join("") || `<li class="empty">No platforms match.</li>`;
  } else {
    const rows = [...yardsShown]
      .sort((a, b) => (idx.get(b.id)?.length || 0) - (idx.get(a.id)?.length || 0) || a.name.localeCompare(b.name))
      .map((y) => {
        const items = idx.get(y.id) || [];
        const names = items.map((i) => i.p.name).join(", ");
        const gw = sumGW(items.filter((i) => isTopsideRole(i.role)).map((i) => i.p));
        return `<li data-y="${esc(y.id)}"><div class="t"><span>${esc(y.name)}${gw ? ` <span class="gw">${gw}</span>` : ""}</span><span class="m">${items.length}</span></div>
          <div class="m">${esc(y.operator)} · ${esc(y.city)}, ${esc(y.country)}${y.kind === "jacket" ? " · jacket yard" : ""}</div>
          ${names ? `<div class="m">${esc(names)}</div>` : ""}</li>`;
      });
    list.innerHTML = rows.join("") || `<li class="empty">No yards match.</li>`;
  }
}

$("list").addEventListener("click", (e) => {
  const li = e.target.closest("li"); if (!li) return;
  if (li.dataset.p) showPlatform(li.dataset.p);
  if (li.dataset.y) focusYard(li.dataset.y);
  if (window.matchMedia("(max-width: 820px)").matches) {
    $("sidebar").classList.remove("open");
    $("listToggle").textContent = "List";
  }
});

function focusYard(id, zoom = 8) {
  const y = state.yardById.get(id); if (!y) return;
  const mk = markers.get(id);
  if (!mk) { map.setView([y.lat, y.lon], Math.max(map.getZoom(), zoom)); return; }
  // Zoom in just far enough for the yard to split out of any merged ball, then open its popup.
  // markercluster keeps the deepest cluster holding the marker in __parent; one level below it the yard stands alone.
  const parentZoom = mk.__parent && mk.__parent._zoom != null ? mk.__parent._zoom : -1;
  const target = Math.max(map.getZoom(), zoom, parentZoom + 1);
  const open = () => (cluster.getVisibleParent(mk) === mk ? mk.openPopup() : cluster.zoomToShowLayer(mk, () => mk.openPopup()));
  if (map.getZoom() !== target || !map.getBounds().contains(mk.getLatLng())) {
    map.once("moveend", () => setTimeout(open, 300));
    map.setView([y.lat, y.lon], target);
  } else open();
}

function showPlatform(id, { fly = true } = {}) {
  const p = state.platforms.find((x) => x.id === id); if (!p) return;
  state.selected = id;
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  const yardsHtml = p.yards.map((r) => {
    const yy = state.yardById.get(r.yard);
    return `<li><a href="#" data-y="${esc(r.yard)}">${esc(yy ? yy.name : r.yard)}</a> – ${esc(r.role)}${yy ? `<br><span class="m">${esc(yy.city)}, ${esc(yy.country)}</span>` : ""}</li>`;
  }).join("");
  const voyage = drawVoyage(p);
  const src = [...(p.sources || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .map((s) => `<li>${s.date ? `<span class="m">${esc(s.date)}</span> ` : ""}<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>${
      (s.also || []).length ? `<br><span class="m">also reported by ${(s.also).map((a) =>
        `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(new URL(a.url).hostname.replace(/^www\./, ""))}</a>`).join(", ")}</span>` : ""}</li>`).join("");

  $("detailBody").innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="m">${esc(p.project)} · ${esc(p.site_country)}</div>
    <span class="pill" style="--c:${statusColor(p.status)}">${esc(p.status)}</span>
    ${p.suggested ? `<div class="note suggest">Possible update (not yet confirmed): <strong>${esc(p.suggested.status)}</strong>, from
      <a href="${esc(p.suggested.url)}" target="_blank" rel="noopener">${esc(p.suggested.title)}</a> (${esc(p.suggested.date)})</div>` : ""}
    <dl>
      <dt>Type</dt><dd>${esc(p.type)}</dd>
      <dt>Client</dt><dd>${esc(p.client)}</dd>
      <dt>EPC / consortium</dt><dd>${esc(p.epc || "–")}</dd>
      <dt>Capacity</dt><dd>${p.capacity_mw ? `<strong>${fmtGW(p.capacity_mw)}</strong> (${fmtNum(p.capacity_mw)} MW)` : "–"}</dd>
      <dt>Installation site</dt><dd>${p.site ? `<a href="#" data-site>${esc(p.site.name)}</a>${p.site.approx ? ' <span class="m">(approx. position)</span>' : ""}` : "–"}</dd>
      <dt>Topside weight</dt><dd>${p.topside_t ? `~${fmtNum(p.topside_t)} t` : "–"}</dd>
      <dt>Sail-away</dt><dd>${esc(p.sailaway || "–")}</dd>
      <dt>Expected COD</dt><dd>${esc(p.cod || "–")}</dd>
      <dt>Data confidence</dt><dd>${esc(p.confidence || "–")}</dd>
      <dt>Last checked</dt><dd>${esc(p.updated || "–")}</dd>
    </dl>
    ${p.notes ? `<div class="note">${esc(p.notes)}</div>` : ""}
    <h4>Yards</h4><ul>${yardsHtml}</ul>
    ${voyage ? `<h4>Likely sea route</h4>
      <div class="note route">${voyage.stops.map(esc).join(" → ")}<br>
        ≈ ${fmtNum(Math.round(voyage.km / 1.852 / 100) * 100)} nm (${fmtNum(Math.round(voyage.km / 100) * 100)} km)${voyage.via.length ? `, via ${esc(voyage.via.join(", "))}` : ""}<br>
        <span class="m">≈ ${Math.round(voyage.km / 1.852 / (8 * 24))} days at 8 knots, a typical heavy-transport/tow speed.
        Estimated from main shipping lanes${voyage.via.includes("Cape of Good Hope") ? "; Asia/Gulf–Europe voyages assumed to avoid the Red Sea" : ""}.</span></div>` : ""}
    <h4>Sources & news</h4><ul>${src || "<li>None</li>"}</ul>`;
  $("detail").hidden = false;
  $("detailBody").querySelectorAll("a[data-y]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); focusYard(a.dataset.y); }));
  $("detailBody").querySelector("a[data-site]")?.addEventListener("click", (e) => {
    e.preventDefault(); map.setView([p.site.lat, p.site.lon], 8);
  });
  renderList();
  // The detail panel changes the map's size, so measure before moving the view.
  map.invalidateSize();
  if (fly) {
    // Show the whole voyage: every yard involved plus the installation site.
    const pts = p.yards.map((r) => state.yardById.get(r.yard)).filter(Boolean).map((yy) => [yy.lat, yy.lon]);
    if (voyage) voyage.legs.flat().forEach((pt) => pts.push(pt));
    else if (p.site) pts.push([p.site.lat, p.site.lon]);
    const small = map.getSize().x < 500;
    if (pts.length > 1) map.fitBounds(pts, { padding: small ? [20, 20] : [50, 50], maxZoom: 8 });
    else if (pts.length) map.setView(pts[0], Math.max(map.getZoom(), 7));
  }
}

// Order the yards along the voyage: steel/modules -> fabrication/assembly -> outfitting, then the site.
function voyageStops(p) {
  const rank = (role) => (/module|steel/i.test(role) ? 0 : /outfit|complet|commission/i.test(role) ? 2 : 1);
  const byRank = new Map();
  for (const r of p.yards) {
    if (!isTopsideRole(r.role)) continue;
    const y = state.yardById.get(r.yard);
    const k = rank(r.role);
    if (y && !byRank.has(k)) byRank.set(k, y);
  }
  return [...byRank.entries()].sort((a, b) => a[0] - b[0]).map(([, y]) => y);
}

function drawVoyage(p) {
  routeLayer.clearLayers();
  if (!p.site) return null;
  const yards = voyageStops(p);
  const site = p.site;
  const siteIcon = L.divIcon({ className: "", html: '<div class="site-marker"></div>', iconSize: [22, 22], iconAnchor: [11, 11] });
  // A small closable label (not a permanent tooltip, which can't be dismissed). Tap the diamond to bring it back.
  const label = L.popup({ autoClose: false, closeOnClick: false, autoPan: false, className: "site-pop", offset: [0, -6] })
    .setLatLng([site.lat, site.lon])
    .setContent(`<strong>${esc(p.name)}</strong><br>Installation site: ${esc(site.name)}`);
  L.marker([site.lat, site.lon], { icon: siteIcon, zIndexOffset: 1000 })
    .on("click", () => label.openOn(map))
    .addTo(routeLayer);
  routeLayer.addLayer(label);
  if (!yards.length) return null;

  const r = SeaRoute.route([...yards, site]);
  const color = css("--accent");
  r.legs.forEach((leg, i) => {
    const last = i === r.legs.length - 1;
    L.polyline(leg, { color, weight: 3, opacity: 0.9, dashArray: last ? "8 6" : "3 6", interactive: false }).addTo(routeLayer);
    // Arrow halfway along each leg, pointing in the direction of travel.
    const mid = Math.floor((leg.length - 1) / 2);
    const [a, b] = [leg[mid], leg[mid + 1]];
    const pa = map.project(a, 5), pb = map.project(b, 5);
    const deg = (Math.atan2(pb.y - pa.y, pb.x - pa.x) * 180) / Math.PI;
    const arrow = L.divIcon({ className: "", html: `<div class="route-arrow" style="transform:rotate(${deg}deg);color:${color}">➤</div>`, iconSize: [16, 16], iconAnchor: [8, 8] });
    L.marker([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], { icon: arrow, interactive: false }).addTo(routeLayer);
  });
  return { ...r, stops: [...yards.map((y) => y.name), site.name.split(",")[0]] };
}

function closeDetail() {
  $("detail").hidden = true;
  state.selected = null;
  routeLayer.clearLayers();
  history.replaceState(null, "", location.pathname);
  renderList();
  setTimeout(() => map.invalidateSize(), 50);
}

function restoreFromHash() {
  const id = decodeURIComponent(location.hash.slice(1));
  if (id && id !== state.selected && state.platforms.some((p) => p.id === id)) setTimeout(() => showPlatform(id), 300);
}
window.addEventListener("hashchange", restoreFromHash);

function openNews() {
  const log = state.meta.changelog || [];
  const byId = new Map(state.platforms.map((p) => [p.id, p]));
  $("newsBody").innerHTML = log.slice(0, 12).map((entry) => `
    <h3>${esc(entry.date)}</h3>
    <p>${esc(entry.summary || "")}</p>
    <ul>${(entry.changes || []).map((c) => {
      const names = (c.ids || [c.id]).map((id) => byId.get(id)?.name || id).join(", ");
      const link = c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">source</a>` : "";
      return `<li><strong>${esc(names)}</strong>: ${esc(c.description)}${link}</li>`;
    }).join("")}</ul>`).join("") || "<p>No updates yet.</p>";
  $("newsDialog").showModal();
}

load().catch((err) => {
  $("stats").textContent = "Could not load data – serve this folder over HTTP (see README).";
  console.error(err);
});
