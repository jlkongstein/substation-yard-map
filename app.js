// Substation Yard Map: loads data/*.json, renders yards on a Leaflet map with a searchable,
// sortable platform list. All data is static; the weekly updater rewrites the JSON files.

const STATUSES = ["Contracted", "Fabrication", "Outfitting", "Sailed away", "Installed"];
const STATUS_VAR = {
  "Contracted": "--s-contracted", "Fabrication": "--s-fabrication", "Outfitting": "--s-outfitting",
  "Sailed away": "--s-sailed", "Installed": "--s-installed",
};

const state = {
  yards: [], platforms: [], meta: {},
  yardById: new Map(),
  q: "", sort: "news", type: "",
  statuses: new Set(["Contracted", "Fabrication", "Outfitting", "Sailed away"]),
  showJackets: false, tab: "platforms", selected: null,
};

const $ = (id) => document.getElementById(id);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const statusColor = (s) => css(STATUS_VAR[s] || "--s-installed");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtNum = (n) => (n == null ? "–" : n.toLocaleString("en-GB"));
const latestNews = (p) => (p.sources || []).map((s) => s.date || "").sort().pop() || "";
const isTopsideRole = (role) => !/^jacket$/i.test(role);

let map, markers = new Map();

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
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19, className: "basemap",
  }).addTo(map);

  $("legend").innerHTML =
    STATUSES.map((s) => `<span><i style="background:${statusColor(s)}"></i>${s}</span>`).join("") +
    `<span><i style="background:${css("--jacket")}"></i>Jacket only</span>` +
    `<span style="color:${css("--muted")}">Colour = most active topside</span>`;
}

function initControls() {
  $("statusChips").innerHTML = STATUSES.map((s) =>
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
  $("stats").textContent = `${state.platforms.length} platforms · ${state.yards.length} yards · updated ${m.last_updated || "–"}`;
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
    state.statuses.has(p.status) &&
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
  renderList(vis, idx);
}

function renderMarkers(idx) {
  markers.forEach((m) => m.remove());
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
    const color = jacketOnly ? css("--jacket") : statusColor(STATUSES[Math.min(...active)]);
    const n = jacketOnly ? items.length : topsideItems.length;
    const size = 22 + Math.min(n, 8) * 4;
    const icon = L.divIcon({
      className: "",
      html: `<div class="yard-marker${jacketOnly ? " jacket" : ""}" style="width:${size}px;height:${size}px;background:${color}">${n || ""}</div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2],
    });
    const mk = L.marker([y.lat, y.lon], { icon, title: y.name, riseOnHover: true })
      .bindPopup(() => yardPopup(y, items), { maxWidth: 320 })
      .addTo(map);
    markers.set(y.id, mk);
  }
}

function yardPopup(y, items) {
  const div = document.createElement("div");
  div.className = "pop";
  const rows = items.length
    ? items.map(({ p, role }) =>
        `<li><a data-p="${esc(p.id)}"><span><span class="n">${esc(p.name)}</span><span class="role">${esc(role)}</span></span>
         <span class="pill" style="--c:${statusColor(p.status)}">${esc(p.status)}</span></a></li>`).join("")
    : `<li class="m">No platforms match the current filters.</li>`;
  div.innerHTML = `<h3>${esc(y.name)}</h3>
    <div class="m">${esc(y.operator)} · ${esc(y.city)}, ${esc(y.country)}</div>
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
      const meta = [y ? `${y.name}, ${y.country}` : "Yard unknown", p.capacity_mw ? `${fmtNum(p.capacity_mw)} MW` : null, p.cod ? `COD ${p.cod}` : null]
        .filter(Boolean).join(" · ");
      return `<li data-p="${esc(p.id)}" class="${state.selected === p.id ? "sel" : ""}">
        <div class="t"><span>${esc(p.name)}</span><span class="pill" style="--c:${statusColor(p.status)}">${esc(p.status)}</span></div>
        <div class="m">${esc(p.client)} · ${esc(p.type)}${p.confidence === "low" ? ` · <span class="conf-low">unverified</span>` : ""}</div>
        <div class="m">${esc(meta)}</div></li>`;
    });
    list.innerHTML = rows.join("") || `<li class="empty">No platforms match.</li>`;
  } else {
    const rows = [...yardsShown]
      .sort((a, b) => (idx.get(b.id)?.length || 0) - (idx.get(a.id)?.length || 0) || a.name.localeCompare(b.name))
      .map((y) => {
        const items = idx.get(y.id) || [];
        const names = items.map((i) => i.p.name).join(", ");
        return `<li data-y="${esc(y.id)}"><div class="t"><span>${esc(y.name)}</span><span class="m">${items.length}</span></div>
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
  map.flyTo([y.lat, y.lon], Math.max(map.getZoom(), zoom), { duration: 0.8 });
  const mk = markers.get(id);
  if (mk) setTimeout(() => mk.openPopup(), 850);
}

function showPlatform(id, { fly = true } = {}) {
  const p = state.platforms.find((x) => x.id === id); if (!p) return;
  state.selected = id;
  history.replaceState(null, "", `#${encodeURIComponent(id)}`);
  const yardsHtml = p.yards.map((r) => {
    const yy = state.yardById.get(r.yard);
    return `<li><a href="#" data-y="${esc(r.yard)}">${esc(yy ? yy.name : r.yard)}</a> – ${esc(r.role)}${yy ? `<br><span class="m">${esc(yy.city)}, ${esc(yy.country)}</span>` : ""}</li>`;
  }).join("");
  const src = [...(p.sources || [])].sort((a, b) => (b.date || "").localeCompare(a.date || ""))
    .map((s) => `<li>${s.date ? `<span class="m">${esc(s.date)}</span> ` : ""}<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a></li>`).join("");

  $("detailBody").innerHTML = `
    <h2>${esc(p.name)}</h2>
    <div class="m">${esc(p.project)} · ${esc(p.site_country)}</div>
    <span class="pill" style="--c:${statusColor(p.status)}">${esc(p.status)}</span>
    <dl>
      <dt>Type</dt><dd>${esc(p.type)}</dd>
      <dt>Client</dt><dd>${esc(p.client)}</dd>
      <dt>EPC / consortium</dt><dd>${esc(p.epc || "–")}</dd>
      <dt>Capacity</dt><dd>${p.capacity_mw ? `${fmtNum(p.capacity_mw)} MW` : "–"}</dd>
      <dt>Topside weight</dt><dd>${p.topside_t ? `~${fmtNum(p.topside_t)} t` : "–"}</dd>
      <dt>Sail-away</dt><dd>${esc(p.sailaway || "–")}</dd>
      <dt>Expected COD</dt><dd>${esc(p.cod || "–")}</dd>
      <dt>Data confidence</dt><dd>${esc(p.confidence || "–")}</dd>
      <dt>Last checked</dt><dd>${esc(p.updated || "–")}</dd>
    </dl>
    ${p.notes ? `<div class="note">${esc(p.notes)}</div>` : ""}
    <h4>Yards</h4><ul>${yardsHtml}</ul>
    <h4>Sources & news</h4><ul>${src || "<li>None</li>"}</ul>`;
  $("detail").hidden = false;
  $("detailBody").querySelectorAll("a[data-y]").forEach((a) =>
    a.addEventListener("click", (e) => { e.preventDefault(); focusYard(a.dataset.y); }));
  renderList();
  // The detail panel changes the map's size, so measure before moving the view.
  map.invalidateSize();
  if (fly) {
    // Fit all yards involved (e.g. Thailand + Norway) or go to the single one.
    const pts = p.yards.map((r) => state.yardById.get(r.yard)).filter(Boolean).map((yy) => [yy.lat, yy.lon]);
    const small = map.getSize().x < 500;
    if (pts.length > 1) map.fitBounds(pts, { padding: small ? [20, 20] : [60, 60], maxZoom: 8 });
    else if (pts.length) map.setView(pts[0], Math.max(map.getZoom(), 7));
  }
}

function closeDetail() {
  $("detail").hidden = true;
  state.selected = null;
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
      const p = byId.get(c.id);
      const link = c.url ? ` <a href="${esc(c.url)}" target="_blank" rel="noopener">source</a>` : "";
      return `<li><strong>${esc(p ? p.name : c.id)}</strong>: ${esc(c.description)}${link}</li>`;
    }).join("")}</ul>`).join("") || "<p>No updates yet.</p>";
  $("newsDialog").showModal();
}

load().catch((err) => {
  $("stats").textContent = "Could not load data – serve this folder over HTTP (see README).";
  console.error(err);
});
