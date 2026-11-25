/* Bonn Apartment Map — plain JS, no build step.
 *
 * Data:     data/pois.json (OSM via Overpass, refreshed weekly by GitHub Actions)
 *           data/stations.json (direct trains from GTFS, refreshed weekly)
 *           data/gym_prices.json (hand-curated)
 * Services (called from the browser, all free / no key):
 *           Photon (komoot)           – address search
 *           Valhalla (FOSSGIS)        – walking areas, walking/bike times
 *           Transitous (MOTIS)        – public-transport journeys
 */
"use strict";

const CFG = {
  center: [50.722, 7.11],
  bbox: { s: 50.62, w: 6.98, n: 50.83, e: 7.25 },
  photon: "https://photon.komoot.io/api/",
  valhalla: "https://valhalla1.openstreetmap.de",
  transitous: "https://api.transitous.org/api/v5/plan",
  overpass: ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"],
  analysisVersion: 6,
};

const DEFAULT_SETTINGS = {
  workName: "DHL Consulting",
  workAddr: "Fritz-Erler-Straße 5, 53113 Bonn",
  workLat: 50.7155811,
  workLon: 7.1264088,
  arrive: "09:00",
  weights: { discounter: 3, gym: 2, station: 2, commute: 2, pharmacy: 0 },
};

// Category definitions. good/bad = walking minutes for full / zero score.
const CATS = {
  discounter: { label: "Discounters", one: "Discounter", sub: "Aldi, Lidl, Penny, Netto, Norma", icon: "🛒", color: "--c-discounter", on: true, good: 5, bad: 20 },
  gym: { label: "Gyms", one: "Gym", icon: "🏋️", color: "--c-gym", on: true, good: 5, bad: 25 },
  station: { label: "Train stations", one: "Train station", sub: "RE/RB/S-Bahn/ICE", icon: "🚆", color: "--c-station", on: true, good: 8, bad: 30 },
  supermarket: { label: "Other supermarkets", one: "Supermarket", sub: "Rewe, Edeka, Kaufland…", icon: "🛍️", color: "--c-supermarket", on: false, good: 5, bad: 20 },
  tram: { label: "Stadtbahn / tram stops", one: "Stadtbahn stop", icon: "🚊", color: "--c-tram", on: false },
  pharmacy: { label: "Pharmacies", one: "Pharmacy", icon: "💊", color: "--c-pharmacy", on: false, good: 5, bad: 20 },
  bakery: { label: "Bakeries", one: "Bakery", icon: "🥐", color: "--c-bakery", on: false },
  doctor: { label: "Family doctors", one: "Family doctor (GP)", sub: "Allgemeinmedizin", icon: "🩺", color: "--c-doctor", on: false },
  park: { label: "Parks", one: "Park", icon: "🌳", color: "--c-park", on: false },
  parcel: { label: "Packstation & post", one: "Parcel / post", sub: "DHL Packstation, post offices", icon: "📦", color: "--c-parcel", on: false },
  kiosk: { label: "Kiosks", one: "Kiosk", sub: "late-night Büdchen", icon: "🏪", color: "--c-kiosk", on: false },
};
const EXTRA_CATS = ["bakery", "doctor", "park", "parcel", "kiosk"];
const SCORE_KEYS = {
  discounter: { label: "Discounter", good: 5, bad: 20 },
  gym: { label: "Gym", good: 5, bad: 25 },
  station: { label: "Station → Köln", good: 8, bad: 30 },
  commute: { label: "Commute", good: 15, bad: 50 },
  pharmacy: { label: "Pharmacy", good: 5, bad: 20 },
};

// ---------- small helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};
function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (bLat - aLat) * r, dLon = (bLon - aLon) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}
const fmtMin = (s) => (s == null ? "–" : `${Math.max(1, Math.round(s / 60))} min`);
const fmtDist = (m) => (m == null ? "" : m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);
const eur = (n) => {
  if (n == null || n === "") return "";
  const v = Number(n);
  return `${v.toLocaleString("de-DE", { minimumFractionDigits: Number.isInteger(v) ? 0 : 2, maximumFractionDigits: 2 })} €`;
};
function grade(min, good, bad) {
  if (min == null) return "bad";
  return min <= good ? "good" : min <= (good + bad) / 2 ? "ok" : "bad";
}
function partScore(min, good, bad) {
  if (min == null) return 0;
  return Math.max(0, Math.min(1, (bad - min) / (bad - good)));
}
function toast(msg, ms = 3500) {
  const t = document.createElement("div");
  t.className = "toast"; t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
async function getJSON(url, opts = {}, timeout = 30000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ctl.signal });
    if (!r.ok) throw new Error(`${r.status} ${r.statusText} (${new URL(url, location.href).host})`);
    return await r.json();
  } finally { clearTimeout(timer); }
}
const postJSON = (url, body, timeout) =>
  getJSON(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, timeout);

// Links for a place: Google Maps (shows reviews/ratings), website, OSM.
function googleLink(p) {
  const q = p.address ? `${p.name}, ${p.address}` : `${p.name} ${p.lat},${p.lon}`;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

// Local time in Europe/Berlin as ISO string with offset, for the next weekday (Tue) at hh:mm.
function nextWeekdayISO(hhmm, weekday = 2) {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== weekday) d.setDate(d.getDate() + 1); // default: next Tuesday
  const date = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); // YYYY-MM-DD
  const probe = new Date(`${date}T12:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return { iso: `${date}T${hhmm}:00${off}`, date };
}
// GTFS times can exceed 24:00 ("25:10" = 01:10 the next morning)
const gtfsTime = (t) => { if (!t) return "–"; const [h, m] = t.split(":").map(Number); return `${String(h % 24).padStart(2, "0")}:${String(m).padStart(2, "0")}`; };
const hhmmBerlin = (iso) => new Date(iso).toLocaleTimeString("de-DE", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit" });

// ---------- state ----------
let settings = { ...DEFAULT_SETTINGS, ...store.get("settings", {}) };
settings.weights = { ...DEFAULT_SETTINGS.weights, ...(settings.weights || {}) };
let apts = store.get("apartments", []);
let selectedId = null;
let picking = false;
const DATA = { pois: {}, stations: [], gymPrices: [], poisMeta: null, stationsMeta: null };

// ---------- map ----------
const map = L.map("map", { zoomControl: true, preferCanvas: true }).setView(CFG.center, 13);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
}).addTo(map);
map.attributionControl.addAttribution('Routing <a href="https://valhalla1.openstreetmap.de">FOSSGIS Valhalla</a> · Transit <a href="https://transitous.org">Transitous</a>');

const layers = {};
const isoLayer = L.layerGroup().addTo(map);
const highlightLayer = L.layerGroup().addTo(map);
const aptLayer = L.layerGroup().addTo(map);
let workMarker = null;

function poiPopup(cat, p) {
  const c = CATS[cat];
  let h = `<div class="pop"><div class="pop-cat">${c.icon} ${esc(c.one)}</div><div class="pop-title">${esc(p.name)}</div>`;
  if (p.address) h += `<div class="small muted">${esc(p.address)}</div>`;
  if (p.hours) h += `<div class="small">🕑 ${esc(p.hours)}</div>`;
  if (p.late) h += `<div class="small"><span class="pill">🌙 Open late (22:00+)</span></div>`;
  if (cat === "parcel") h += `<div class="small muted">${p.kind === "locker" ? "Parcel locker" : "Post office / parcel shop"}</div>`;
  if (p.studio) h += `<div class="small"><span class="pill">Studio / specialised</span></div>`;
  if (p.women) h += `<div class="small"><span class="pill">Women only</span></div>`;
  if (p.price) {
    const pr = p.price;
    h += `<div class="pop-price"><b>${eur(pr.monthly_eur)}/month</b>`;
    const extra = [pr.joining_fee_eur != null ? `${eur(pr.joining_fee_eur)} joining fee` : "", pr.min_term_months ? `${pr.min_term_months} months min. term` : ""].filter(Boolean).join(" · ");
    if (extra) h += `<div class="small">${esc(extra)}</div>`;
    if (pr.note) h += `<div class="small muted">${esc(pr.note)}</div>`;
    h += `<div class="small muted">Approx. ${esc(pr.checked || "")}${pr.source ? ` · <a href="${esc(pr.source)}" target="_blank" rel="noopener">source</a>` : ""}, verify on website</div></div>`;
  } else if (cat === "gym") {
    h += `<div class="pop-price small muted">No price on file. Check the website, or add the chain to data/gym_prices.json.</div>`;
  }
  if (cat === "station") {
    h += `<div class="small" style="margin-top:4px">${p.lines.map((l) => `<span class="pill">${esc(l)}</span>`).join("")}</div>`;
    const d = p.direct || {};
    const rows = ["koeln", "koeln_deutz", "duesseldorf", "airport"].filter((k) => d[k]);
    if (rows.length) {
      h += `<table style="margin-top:6px"><tr><th>Direct to</th><th>trains/day</th><th>fastest</th><th>first–last</th></tr>`;
      for (const k of rows) h += `<tr><td>${esc(d[k].label)}</td><td>${d[k].trips_per_day}</td><td>${d[k].fastest_min} min</td><td>${esc(d[k].first)}–${esc(d[k].last)}</td></tr>`;
      h += `</table>`;
      h += `<table style="margin-top:6px"><tr><th>Weekend / night</th><th>Sat</th><th>Sun</th><th>last back (Mon–Thu / Fri / Sat)</th></tr>`;
      for (const k of rows) {
        const b = d[k].back || {};
        h += `<tr><td>${esc(d[k].label)}</td><td>${d[k].sat?.trips ?? "–"}</td><td>${d[k].sun?.trips ?? "–"}</td>
          <td>${gtfsTime(b.wd?.last)} / ${gtfsTime(b.fri?.last)} / ${gtfsTime(b.sat?.last)}</td></tr>`;
      }
      h += `</table>`;
    } else h += `<div class="small muted" style="margin-top:4px">No direct trains to Köln/Düsseldorf.</div>`;
    h += `<div class="small muted">Direct regional + long-distance trains. Weekday = Tuesday; "last back" = last direct train from there to this station (night trains included).</div>`;
  }
  const links = [];
  if (p.website) links.push(`<a href="${esc(p.website)}" target="_blank" rel="noopener">Website</a>`);
  links.push(`<a href="${googleLink(p)}" target="_blank" rel="noopener">Google Maps / reviews</a>`);
  if (p.osm) links.push(`<a href="${esc(p.osm)}" target="_blank" rel="noopener">OSM</a>`);
  if (cat === "station") links.push(`<a href="https://www.bahn.de/buchung/fahrplan/suche#sts=true&so=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">DB timetable</a>`);
  h += `<div class="pop-links small">${links.join("")}</div>`;
  return h + "</div>";
}

// ---------- filters (gyms, discounter chains) ----------
const CHAINS = ["aldi", "lidl", "penny", "netto", "norma"];
const STUDIO_RX = /yoga|pilates|personal|boxing|box\b|thai|kick|reha|rücken|physio|tanz|dance|\bems\b|ems-|körperformen|crossfit|mbsr|kampf|judo|karate|stunt|namalia|miriya|butterfly|kopfk|visio-?life/i;
const WOMEN_RX = /frauen|ladies|donna|women|lady/i;
let filters = { gymStudios: false, gymPricedOnly: false, gymMaxPrice: null, chains: Object.fromEntries(CHAINS.map((c) => [c, true])), ...store.get("filters", {}) };
function chainOf(p) {
  const m = `${p.brand || ""} ${p.name}`.toLowerCase().match(/aldi|lidl|penny|netto|norma/);
  return m ? m[0] : null;
}
function passes(cat, p) {
  if (cat === "gym") {
    if (!filters.gymStudios && p.studio) return false;
    if (filters.gymPricedOnly && !p.price) return false;
    if (filters.gymMaxPrice && (!p.price || p.price.monthly_eur > filters.gymMaxPrice)) return false;
  }
  if (cat === "discounter") {
    const c = chainOf(p);
    if (c && !filters.chains[c]) return false;
  }
  return true;
}
function poisOf(cat) {
  const list = cat === "station" ? DATA.stations : DATA.pois[cat] || [];
  return list.filter((p) => passes(cat, p));
}
function filtersKey() { return JSON.stringify([filters.gymStudios, filters.gymPricedOnly, filters.gymMaxPrice, CHAINS.filter((c) => filters.chains[c])]); }
function setFilters(patch) {
  filters = { ...filters, ...patch };
  store.set("filters", filters);
  for (const cat of ["gym", "discounter"]) rebuildMarkers(cat);
  renderApts();
  renderHeat();
  if (selectedId) selectApt(selectedId, { keepView: true }); else analyzeRest();
}

function rebuildMarkers(cat) {
  const c = CATS[cat];
  const g = layers[cat] || (layers[cat] = L.layerGroup());
  g.clearLayers();
  const list = poisOf(cat);
  for (const p of list) {
    let m;
    if (cat === "station") {
      const major = p.direct && (p.direct.koeln || p.direct.koeln_deutz);
      m = L.circleMarker([p.lat, p.lon], {
        radius: major ? 9 : 6, color: "#fff", weight: 2, fillColor: cssVar(c.color), fillOpacity: major ? 1 : 0.6,
      });
      m.bindTooltip(p.name, { permanent: true, direction: "right", offset: [8, 0], className: "station-label" });
    } else {
      m = L.circleMarker([p.lat, p.lon], {
        radius: cat === "tram" ? 4 : 6, color: "#fff", weight: 1.5, fillColor: cssVar(c.color), fillOpacity: 0.95,
      });
      m.bindTooltip(esc(p.name), { direction: "top", offset: [0, -6] });
    }
    m.bindPopup(() => poiPopup(cat, p), { maxWidth: 320 });
    g.addLayer(m);
  }
  const cnt = document.querySelector(`.check[data-cat="${cat}"] .count`);
  if (cnt) cnt.textContent = list.length;
  if (cat === "station") updateStationLabels();
}

function filterControls(cat) {
  const div = document.createElement("div");
  div.className = "subfilters";
  if (cat === "gym") {
    div.innerHTML = `
      <label class="check small"><input type="checkbox" data-f="gymStudios" ${filters.gymStudios ? "checked" : ""}> Include studios (yoga, EMS, boxing, personal training, rehab)</label>
      <label class="check small"><input type="checkbox" data-f="gymPricedOnly" ${filters.gymPricedOnly ? "checked" : ""}> Only gyms with a known price</label>
      <label class="check small">Max. price <input type="number" min="0" step="5" class="tiny" data-f="gymMaxPrice" value="${filters.gymMaxPrice ?? ""}" placeholder="any"> €/month</label>`;
    div.addEventListener("change", (e) => {
      const f = e.target.dataset.f;
      if (!f) return;
      if (f === "gymMaxPrice") setFilters({ gymMaxPrice: e.target.value ? Number(e.target.value) : null });
      else setFilters({ [f]: e.target.checked });
    });
  } else if (cat === "discounter") {
    div.innerHTML = `<div class="chips">${CHAINS.map((ch) =>
      `<button type="button" class="chip${filters.chains[ch] ? " on" : ""}" data-chain="${ch}">${ch[0].toUpperCase() + ch.slice(1)}</button>`).join("")}</div>`;
    div.addEventListener("click", (e) => {
      const ch = e.target.dataset.chain;
      if (!ch) return;
      const next = { ...filters.chains, [ch]: !filters.chains[ch] };
      if (!CHAINS.some((x) => next[x])) { toast("Keep at least one chain selected."); return; }
      e.target.classList.toggle("on", next[ch]);
      setFilters({ chains: next });
    });
  }
  return div;
}

function buildLayers() {
  const box = $("#layers");
  box.innerHTML = "";
  const savedOn = store.get("layersOn", null);
  for (const [cat, c] of Object.entries(CATS)) {
    rebuildMarkers(cat);
    const g = layers[cat];
    const on = savedOn && cat in savedOn ? !!savedOn[cat] : c.on;
    if (on) g.addTo(map);
    const lab = document.createElement("label");
    lab.className = "check";
    lab.dataset.cat = cat;
    lab.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}><span class="dot" style="background:${cssVar(c.color)}"></span>
      <span>${c.icon} ${esc(c.label)}${c.sub ? ` <span class="muted small">${esc(c.sub)}</span>` : ""}</span><span class="count">${poisOf(cat).length}</span>`;
    lab.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? g.addTo(map) : map.removeLayer(g);
      const state = store.get("layersOn", {}) || {};
      for (const k of Object.keys(CATS)) state[k] = map.hasLayer(layers[k]);
      store.set("layersOn", state);
    });
    box.appendChild(lab);
    if (cat === "gym" || cat === "discounter") box.appendChild(filterControls(cat));
  }
  updateStationLabels();
}
function updateStationLabels() {
  const show = map.getZoom() >= 12;
  layers.station?.eachLayer((m) => {
    const t = m.getTooltip();
    if (t) t.setOpacity(show ? 1 : 0);
  });
}
map.on("zoomend", updateStationLabels);

function drawWork() {
  if (workMarker) workMarker.remove();
  workMarker = L.marker([settings.workLat, settings.workLon], {
    icon: L.divIcon({ className: "", html: '<div class="marker-work"><span>💼</span></div>', iconSize: [30, 30], iconAnchor: [15, 30] }),
    zIndexOffset: 1000,
  }).addTo(map).bindPopup(`<div class="pop"><div class="pop-cat">Work</div><div class="pop-title">${esc(settings.workName)}</div><div class="small muted">${esc(settings.workAddr)}</div></div>`);
}

// ---------- transport lines ----------
map.createPane("lines");
map.getPane("lines").style.zIndex = 350;
const lineRenderer = L.canvas({ pane: "lines", tolerance: 6 });
const lineLayer = L.layerGroup().addTo(map);
const LINES = { rail: null, bus: null };
let linesOn = { rail: false, bus: false, ...store.get("linesOn", {}) };
let activeLine = null;
const MODE_LABEL = { train: "Train", tram: "Stadtbahn / tram", bus: "Bus" };

async function loadLines(kind) {
  if (!LINES[kind]) {
    try { LINES[kind] = (await getJSON(`data/lines_${kind}.json`)).lines; }
    catch (e) { LINES[kind] = []; toast(`Transport lines not available yet (${e.message}).`); }
  }
  return LINES[kind];
}
const allLines = () => [...(LINES.rail || []), ...(LINES.bus || [])];
function textOn(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  if (!m) return "#fff";
  const n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? "#111" : "#fff";
}
const chipHTML = (l) => `<button type="button" class="line-chip${activeLine === l.id ? " active" : ""}" data-line="${esc(l.id)}"
  style="background:${esc(l.colour)};color:${textOn(l.colour)}" title="${esc(l.name)}">${esc(l.ref)}</button>`;

function renderLines() {
  lineLayer.clearLayers();
  const shown = [];
  for (const kind of ["rail", "bus"]) if (linesOn[kind] && LINES[kind]) shown.push(...LINES[kind]);
  const active = allLines().find((l) => l.id === activeLine);
  if (active && !shown.includes(active)) shown.push(active);
  for (const l of shown) {
    const on = l === active;
    const dim = active && !on;
    const base = l.mode === "bus" ? 2.5 : 3.5;
    if (on) L.polyline(l.segs, { renderer: lineRenderer, color: "#fff", weight: base + 7, opacity: 0.9, interactive: false }).addTo(lineLayer);
    const pl = L.polyline(l.segs, {
      renderer: lineRenderer, color: l.colour, weight: on ? base + 3 : base, opacity: dim ? 0.12 : on ? 1 : 0.75,
    }).addTo(lineLayer);
    pl.on("click", (e) => { L.DomEvent.stopPropagation(e); if (!picking) highlightLine(l.id === activeLine ? null : l.id); });
    pl.bindTooltip(`${MODE_LABEL[l.mode]} ${esc(l.ref)}`, { sticky: true });
  }
  if (active) {
    for (const [lat, lon, name] of active.stops) {
      L.circleMarker([lat, lon], { renderer: lineRenderer, radius: 4.5, color: active.colour, weight: 2.5, fillColor: "#fff", fillOpacity: 1 })
        .bindTooltip(esc(name), { permanent: map.getZoom() >= 14, direction: "right", offset: [6, 0], className: "stop-label" })
        .addTo(lineLayer);
    }
  }
  renderLineChips();
}
map.on("zoomend", () => { if (activeLine) renderLines(); });

function renderLineChips() {
  const box = $("#line-chips");
  const groups = [["train", "Trains & S-Bahn"], ["tram", "Stadtbahn / tram"], ["bus", "Buses"]];
  box.innerHTML = groups.map(([mode, label]) => {
    const ls = allLines().filter((l) => l.mode === mode && (mode === "bus" ? linesOn.bus : linesOn.rail));
    if (!ls.length) return "";
    return `<details class="line-group" ${mode !== "bus" || ls.length < 40 ? "open" : ""}><summary>${label} (${ls.length})</summary><div class="chips">${ls.map(chipHTML).join("")}</div></details>`;
  }).join("");
  const info = $("#line-info");
  const l = allLines().find((x) => x.id === activeLine);
  info.hidden = !l;
  if (l) {
    const variants = (l.variants || [l.name]).map(esc).join("<br>");
    info.innerHTML = `<div class="row-between"><div>${chipHTML(l)} <b>${MODE_LABEL[l.mode]} ${esc(l.ref)}</b></div>
      <div class="row gap-s"><button class="btn small ghost" type="button" id="line-zoom">Zoom</button><button class="btn small ghost" type="button" id="line-clear">✕</button></div></div>
      <div class="small" style="margin-top:4px">${variants}</div>
      ${l.stops.length ? `<details class="stops"><summary>${l.stops.length} stops</summary>${l.stops.map((s) => esc(s[2])).join(" · ")}</details>` : ""}
      <div class="small" style="margin-top:4px"><a href="https://www.openstreetmap.org/relation/${l.osm[0]}" target="_blank" rel="noopener">OSM</a></div>`;
    $("#line-zoom").onclick = () => zoomToLine(l);
    $("#line-clear").onclick = () => highlightLine(null);
  }
}
$("#lines-block").addEventListener("click", (e) => {
  const id = e.target.closest(".line-chip")?.dataset.line;
  if (id && !e.target.closest("#line-info")) highlightLine(id === activeLine ? null : id, true);
});
function zoomToLine(l) {
  map.fitBounds(L.latLngBounds(l.segs.flat()).pad(0.05), { maxZoom: 15 });
}
function highlightLine(id, zoom = false) {
  activeLine = id;
  renderLines();
  const l = allLines().find((x) => x.id === id);
  if (l && zoom) zoomToLine(l);
  if (l && matchMedia("(max-width: 760px)").matches) $("#line-info").scrollIntoView({ block: "nearest", behavior: "smooth" });
}
// Highlight a line by its public name, e.g. from a journey leg ("611", "RB30", "16").
async function highlightByRef(ref, mode) {
  await Promise.all([loadLines("rail"), loadLines("bus")]);
  // OSM refs can carry extras, e.g. "RE 5 (RRX)" for "RE5"
  const norm = (s) => String(s).replace(/\(.*?\)/g, "").replace(/\s+/g, "").toUpperCase();
  const want = mode === "BUS" ? ["bus"] : /TRAM|SUBWAY|METRO/.test(mode) ? ["tram"] : /RAIL|SUBURBAN|TRAIN|DISTANCE/.test(mode) ? ["train"] : ["train", "tram", "bus"];
  const r = norm(ref);
  const hit = allLines().find((l) => norm(l.ref) === r && want.includes(l.mode)) || allLines().find((l) => norm(l.ref) === r);
  if (hit) highlightLine(hit.id, true); else toast(`Line ${ref} not found in map data.`);
}
for (const kind of ["rail", "bus"]) {
  const cb = $(`#lines-${kind}`);
  cb.checked = linesOn[kind];
  cb.addEventListener("change", async () => {
    linesOn = { ...linesOn, [kind]: cb.checked };
    store.set("linesOn", linesOn);
    if (cb.checked) await loadLines(kind);
    renderLines();
  });
}
async function initLines() {
  for (const kind of ["rail", "bus"]) if (linesOn[kind]) await loadLines(kind);
  renderLines();
}

// ---------- neighbourhood heatmap ----------
map.createPane("heat");
map.getPane("heat").style.zIndex = 300;
const heatRenderer = L.canvas({ pane: "heat" });
const heatLayer = L.layerGroup();
const HEAT = { box: { s: 50.655, w: 7.025, n: 50.775, e: 7.205 }, stepM: 250 };
let heatStops = null, heatStopsKey = null, heatLegend = null;
const heatCells = new Map();
let heatGrid = null;
const WALK_M_PER_MIN = 80 / 1.3; // straight-line metres per walking minute (80 m/min on streets, 1.3 detour)

async function commuteStops() {
  const key = `${settings.workLat},${settings.workLon},${settings.arrive}`;
  if (heatStops && heatStopsKey === key) return heatStops;
  const when = nextWeekdayISO(settings.arrive);
  const d = await getJSON(`https://api.transitous.org/api/v1/one-to-all?one=${settings.workLat},${settings.workLon}&time=${encodeURIComponent(when.iso)}&maxTravelTime=90&arriveBy=true`, {}, 60000);
  const best = new Map();
  for (const x of d.all || []) {
    const k = `${x.place.lat.toFixed(4)},${x.place.lon.toFixed(4)}`;
    if (!best.has(k) || best.get(k).min > x.duration) best.set(k, { lat: x.place.lat, lon: x.place.lon, name: x.place.name, min: x.duration });
  }
  heatStops = [...best.values()];
  heatStopsKey = key;
  return heatStops;
}
function flatDist(lat1, lon1, lat2, lon2) {
  const kx = 111320 * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot((lon2 - lon1) * kx, (lat2 - lat1) * 111320);
}
function nearestFlat(list, lat, lon) {
  let best = null, bd = Infinity;
  for (const p of list) { const d = flatDist(lat, lon, p.lat, p.lon); if (d < bd) { bd = d; best = p; } }
  return best ? { p: best, d: bd } : null;
}
function heatColor(s) {
  // red (0) → amber (50) → green (100)
  const stops = [[0, [194, 65, 45]], [50, [224, 173, 58]], [100, [30, 138, 76]]];
  let i = 0;
  while (i < stops.length - 2 && s > stops[i + 1][0]) i++;
  const [s0, c0] = stops[i], [s1, c1] = stops[i + 1];
  const t = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
  return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(",")})`;
}
async function renderHeat() {
  heatLayer.clearLayers();
  heatCells.clear();
  if (!map.hasLayer(heatLayer)) return;
  let stops = [];
  try { stops = await commuteStops(); } catch (e) { toast(`Commute times for heatmap unavailable: ${e.message}`); }
  const allStops = [...stops, ...poisOf("tram"), ...DATA.stations];
  const disc = poisOf("discounter"), gym = poisOf("gym"), pharm = poisOf("pharmacy");
  const stK = DATA.stations.filter((s) => s.direct?.koeln || s.direct?.koeln_deutz);
  const { s, w, n, e } = HEAT.box;
  const dLat = HEAT.stepM / 111320, dLon = HEAT.stepM / (111320 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  const W = settings.weights;
  heatGrid = { s, w, dLat, dLon };
  for (let lat = s; lat < n; lat += dLat) {
    for (let lon = w; lon < e; lon += dLon) {
      const c = [lat + dLat / 2, lon + dLon / 2];
      const ns = nearestFlat(allStops, ...c);
      if (!ns || ns.d > 650) continue; // outside the built-up / served area
      const mins = {};
      const nd = nearestFlat(disc, ...c), ng = nearestFlat(gym, ...c), np = nearestFlat(pharm, ...c), nk = nearestFlat(stK, ...c);
      mins.discounter = nd && nd.d / WALK_M_PER_MIN;
      mins.gym = ng && ng.d / WALK_M_PER_MIN;
      mins.pharmacy = np && np.d / WALK_M_PER_MIN;
      mins.station = nk && nk.d / WALK_M_PER_MIN;
      let commute = flatDist(...c, settings.workLat, settings.workLon) / WALK_M_PER_MIN, via = null;
      for (const st of stops) {
        const dd = flatDist(...c, st.lat, st.lon);
        if (dd > 1200) continue;
        const t = dd / WALK_M_PER_MIN + st.min;
        if (t < commute) { commute = t; via = st.name; }
      }
      mins.commute = commute;
      let sum = 0, ws = 0;
      for (const [k, wt] of Object.entries(W)) { if (!wt) continue; sum += wt * partScore(mins[k], SCORE_KEYS[k].good, SCORE_KEYS[k].bad); ws += wt; }
      const score = ws ? Math.round((sum / ws) * 100) : 0;
      L.rectangle([[lat, lon], [lat + dLat, lon + dLon]], {
        renderer: heatRenderer, stroke: false, fillColor: heatColor(score), fillOpacity: 0.5, interactive: false,
      }).addTo(heatLayer);
      heatCells.set(`${Math.floor((lat - s) / dLat)},${Math.floor((lon - w) / dLon)}`, { score, mins, nd, ng, nk, via });
    }
  }
}
map.on("click", (ev) => {
  if (picking || !map.hasLayer(heatLayer) || !heatGrid) return;
  const g = heatGrid;
  const cell = heatCells.get(`${Math.floor((ev.latlng.lat - g.s) / g.dLat)},${Math.floor((ev.latlng.lng - g.w) / g.dLon)}`);
  if (!cell) return;
  const { score, mins, nd, ng, nk, via } = cell;
  const f = (m) => (m == null ? "–" : `~${Math.max(1, Math.round(m))} min`);
  L.popup().setLatLng(ev.latlng).setContent(`<div class="pop"><div class="pop-cat">Area score</div><div class="pop-title">${score} / 100</div>
    <table>
    <tr><td>🛒 ${esc(nd?.p.name || "")}</td><td>${f(mins.discounter)}</td></tr>
    <tr><td>🏋️ ${esc(ng?.p.name || "")}</td><td>${f(mins.gym)}</td></tr>
    <tr><td>🚆 ${esc(nk?.p.name || "")}</td><td>${f(mins.station)}</td></tr>
    <tr><td>💼 ${esc(settings.workName)}${via ? ` <span class="muted">via ${esc(via)}</span>` : " (walk)"}</td><td>${f(mins.commute)}</td></tr>
    </table><div class="small muted">Estimates from straight-line distance. Add an apartment for exact times.</div>
    <div class="pop-links"><a href="#" data-addhere="${ev.latlng.lat},${ev.latlng.lng}">+ Add apartment here</a></div></div>`).openOn(map);
});
map.on("popupopen", (e) => {
  const a = e.popup.getElement()?.querySelector("[data-addhere]");
  if (!a) return;
  a.addEventListener("click", async (ev) => {
    ev.preventDefault();
    const [lat, lon] = a.dataset.addhere.split(",").map(Number);
    map.closePopup();
    let addr = `${lat.toFixed(5)}, ${lon.toFixed(5)}`, label = "Area pick";
    try {
      const d = await getJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lon}&lang=de`, {}, 8000);
      if (d.features?.[0]) { const l = photonLabel(d.features[0]); addr = l.full; label = l.l1 || label; }
    } catch { /* keep coordinates */ }
    openAptDialog({ addr, lat, lon, label });
  });
});
function setHeat(on) {
  if (on) {
    heatLayer.addTo(map);
    if (!heatLegend) {
      heatLegend = L.control({ position: "bottomleft" });
      heatLegend.onAdd = () => {
        const d = L.DomUtil.create("div", "heat-legend");
        d.innerHTML = `<div class="small"><b>Area score</b> (your priorities)</div><div class="bar"></div><div class="row-between small"><span>0</span><span>50</span><span>100</span></div>`;
        return d;
      };
    }
    heatLegend.addTo(map);
    renderHeat();
  } else {
    map.removeLayer(heatLayer);
    heatLegend?.remove();
  }
  store.set("heatOn", on);
}
$("#heat-toggle").addEventListener("change", (e) => setHeat(e.target.checked));

// ---------- data loading ----------
async function loadData() {
  const [stations, prices] = await Promise.all([
    getJSON("data/stations.json").catch(() => null),
    getJSON("data/gym_prices.json").catch(() => ({ chains: [] })),
  ]);
  DATA.rents = await getJSON("data/rents.json").catch(() => null);
  if (stations) { DATA.stations = stations.stations; DATA.stationsMeta = stations; }
  DATA.gymPrices = prices.chains.map((c) => ({ ...c, rx: new RegExp(c.match, "i") }));

  let pois = await getJSON("data/pois.json").catch(() => null);
  if (!pois) pois = await livePois();
  DATA.poisMeta = pois;
  DATA.pois = pois ? pois.categories : {};
  for (const g of DATA.pois.gym || []) {
    const label = `${g.brand || ""} ${g.name}`;
    g.studio = STUDIO_RX.test(`${label} ${g.website || ""}`);
    g.women = WOMEN_RX.test(label);
    const hit = DATA.gymPrices.find((c) => c.rx.test(label));
    if (hit) {
      g.chain = hit.chain;
      g.price = { monthly_eur: hit.monthly_eur, joining_fee_eur: hit.joining_fee_eur, min_term_months: hit.min_term_months, note: hit.note, source: hit.source, checked: hit.checked };
      g.website = g.website || hit.website;
    }
  }
  renderDataInfo();
}

// Fallback when data/pois.json has not been generated yet: ask Overpass directly (cached 1 day).
async function livePois() {
  const cached = store.get("poisCache", null);
  if (cached && Date.now() - cached.t < 864e5) return cached.data;
  const b = CFG.bbox;
  const q = `[out:json][timeout:90][bbox:${b.s},${b.w},${b.n},${b.e}];(
    nwr["shop"~"^(supermarket|discount)$"];nwr["leisure"="fitness_centre"];nwr["amenity"="gym"];
    nwr["leisure"="sports_centre"]["sport"~"fitness"];nwr["amenity"="pharmacy"];
    node["railway"="tram_stop"];node["railway"~"^(station|halt)$"]["station"~"^(light_rail|subway)$"];);out center tags;`;
  for (const url of CFG.overpass) {
    try {
      const d = await getJSON(url, { method: "POST", body: new URLSearchParams({ data: q }) }, 120000);
      const out = { discounter: [], supermarket: [], gym: [], pharmacy: [], tram: [] };
      const seenTram = new Set();
      for (const el of d.elements) {
        const t = el.tags || {};
        const lat = el.lat ?? el.center?.lat, lon = el.lon ?? el.center?.lon;
        if (lat == null || t.disused) continue;
        let cat;
        if (/^(supermarket|discount)$/.test(t.shop)) cat = /\b(aldi|lidl|penny|netto|norma)\b/i.test(`${t.brand || ""} ${t.name || ""}`) || t.shop === "discount" ? "discounter" : "supermarket";
        else if (t.amenity === "pharmacy") cat = "pharmacy";
        else if (t.railway) cat = "tram";
        else cat = "gym";
        const name = t.name || t.brand || (cat === "pharmacy" ? "Apotheke" : cat === "discounter" ? "Discounter" : cat === "supermarket" ? "Supermarket" : null);
        if (!name) continue;
        if (cat === "tram") { const k = `${name}|${lat.toFixed(3)}|${lon.toFixed(3)}`; if (seenTram.has(k)) continue; seenTram.add(k); }
        const street = [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" ");
        const city = [t["addr:postcode"], t["addr:city"]].filter(Boolean).join(" ");
        out[cat].push({
          name, lat, lon, brand: t.brand, hours: t.opening_hours, website: t.website || t["contact:website"],
          address: [street, city].filter(Boolean).join(", ") || undefined, osm: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        });
      }
      const data = { generated: new Date().toISOString(), source: "© OpenStreetMap contributors (live Overpass query)", categories: out };
      store.set("poisCache", { t: Date.now(), data });
      return data;
    } catch (e) { console.warn("Overpass failed", url, e); }
  }
  toast("Could not load shops/gyms from OpenStreetMap right now. Try reloading later.");
  return null;
}

function renderDataInfo() {
  const p = DATA.poisMeta, s = DATA.stationsMeta;
  $("#data-info").innerHTML = `
    <p>Shops, gyms, pharmacies: ${p ? `${esc(p.source)}, updated ${esc((p.generated || "").slice(0, 10))}` : "not loaded"}.</p>
    <p>Trains: ${s ? `${esc(s.source)}, timetable of ${esc(s.sample_days.join(", "))}` : "not loaded"}.</p>
    <p>Gym prices are approximate (comparison portals, ${esc(DATA.gymPrices[0]?.checked || "")}). Always check the gym's site.</p>
    <p>Missing or wrong place? Fix it on <a href="https://www.openstreetmap.org" target="_blank" rel="noopener">OpenStreetMap</a>; the map picks it up within a week.</p>`;
}

// ---------- geocoding / search ----------
let searchTimer = null, suggestionItems = [], activeIdx = -1;
function photonLabel(f) {
  const p = f.properties;
  const street = p.street ? `${p.street}${p.housenumber ? " " + p.housenumber : ""}` : "";
  const l1 = p.name && p.name !== street ? p.name : street || p.name || "";
  const l2 = [p.name && p.name !== street ? street : "", [p.postcode, p.city || p.locality].filter(Boolean).join(" "), p.district].filter(Boolean).join(", ");
  return { l1, l2, full: [l1, l2].filter(Boolean).join(", ") };
}
async function geocode(q, limit = 6) {
  const b = CFG.bbox;
  const box = [b.w - 0.1, b.s - 0.1, b.e + 0.1, b.n + 0.1].map((x) => x.toFixed(2));
  try {
    const url = `${CFG.photon}?q=${encodeURIComponent(q)}&limit=${limit}&lang=de&lat=${CFG.center[0]}&lon=${CFG.center[1]}&bbox=${box.join(",")}`;
    return (await getJSON(url, {}, 8000)).features;
  } catch (e) {
    // Fallback: Nominatim (OSM's own geocoder), converted to Photon-like features.
    console.warn("Photon failed, using Nominatim", e);
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=${limit}&countrycodes=de&viewbox=${box[0]},${box[3]},${box[2]},${box[1]}&q=${encodeURIComponent(q)}`;
    const d = await getJSON(url, { headers: { "Accept-Language": "de" } });
    return d.map((r) => {
      const a = r.address || {};
      return {
        geometry: { coordinates: [Number(r.lon), Number(r.lat)] },
        properties: {
          name: r.name && r.name !== a.road ? r.name : undefined, street: a.road, housenumber: a.house_number, postcode: a.postcode,
          city: a.city || a.town || a.village, district: a.suburb || a.city_district,
        },
      };
    });
  }
}
$("#search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { hideSuggestions(); return; }
  searchTimer = setTimeout(async () => {
    try {
      suggestionItems = await geocode(q);
      const ul = $("#suggestions");
      ul.innerHTML = suggestionItems.map((f, i) => { const l = photonLabel(f); return `<li data-i="${i}"><div>${esc(l.l1)}</div><div class="s2">${esc(l.l2)}</div></li>`; }).join("")
        || `<li class="muted">No results</li>`;
      ul.hidden = false; activeIdx = -1;
    } catch (err) { console.warn(err); }
  }, 300);
});
$("#search").addEventListener("keydown", (e) => {
  const lis = [...$("#suggestions").querySelectorAll("li[data-i]")];
  if (!lis.length) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    activeIdx = (activeIdx + (e.key === "ArrowDown" ? 1 : -1) + lis.length) % lis.length;
    lis.forEach((li, i) => li.classList.toggle("active", i === activeIdx));
  } else if (e.key === "Enter") {
    e.preventDefault();
    chooseSuggestion(activeIdx >= 0 ? activeIdx : 0);
  } else if (e.key === "Escape") hideSuggestions();
});
$("#suggestions").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-i]");
  if (li) chooseSuggestion(+li.dataset.i);
});
document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideSuggestions(); });
function hideSuggestions() { $("#suggestions").hidden = true; }
function chooseSuggestion(i) {
  const f = suggestionItems[i];
  if (!f) return;
  hideSuggestions();
  $("#search").value = "";
  const [lon, lat] = f.geometry.coordinates;
  const l = photonLabel(f);
  openAptDialog({ addr: l.full, lat, lon, label: l.l1 });
}

$("#pick-on-map").addEventListener("click", () => setPicking(!picking));
function setPicking(on) {
  picking = on;
  document.body.classList.toggle("picking", on);
  $("#pick-on-map").classList.toggle("active", on);
  $("#pick-on-map").textContent = on ? "Click a spot on the map… (Esc to cancel)" : "…or click on the map";
}
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && picking) setPicking(false); });
map.on("click", async (e) => {
  if (!picking) return;
  setPicking(false);
  const { lat, lng } = e.latlng;
  let addr = `${lat.toFixed(5)}, ${lng.toFixed(5)}`, label = "Picked location";
  try {
    const d = await getJSON(`https://photon.komoot.io/reverse?lat=${lat}&lon=${lng}&lang=de`);
    if (d.features?.[0]) { const l = photonLabel(d.features[0]); addr = l.full; label = l.l1 || label; }
  } catch { /* keep coordinates */ }
  openAptDialog({ addr, lat, lon: lng, label });
});

// ---------- apartment dialog ----------
let editing = null;
function openAptDialog(apt) {
  editing = apt;
  const f = $("#apt-form");
  $("#apt-dialog-title").textContent = apt.id ? "Edit apartment" : "New apartment";
  $("#apt-dialog-addr").textContent = apt.addr;
  for (const k of ["label", "coldRent", "rent", "size", "rooms", "available", "url", "notes"]) f.elements[k].value = apt[k] ?? "";
  $("#apt-delete").hidden = !apt.id;
  $("#apt-dialog").showModal();
}
$("#apt-dialog").addEventListener("close", () => {
  if ($("#apt-dialog").returnValue !== "save" || !editing) return;
  const f = $("#apt-form");
  const vals = {};
  for (const k of ["label", "coldRent", "rent", "size", "rooms", "available", "url", "notes"]) vals[k] = f.elements[k].value.trim();
  for (const k of ["coldRent", "rent", "size", "rooms"]) vals[k] = vals[k] === "" ? null : Number(vals[k]);
  if (editing.id) {
    Object.assign(apts.find((a) => a.id === editing.id), vals, { updatedAt: Date.now() });
  } else {
    const a = { id: Math.random().toString(36).slice(2, 10), addr: editing.addr, lat: editing.lat, lon: editing.lon, ...vals, createdAt: Date.now(), updatedAt: Date.now() };
    apts.push(a);
    selectedId = a.id;
  }
  saveApts();
  renderApts();
  if (selectedId) selectApt(selectedId);
});
$("#apt-delete").addEventListener("click", () => {
  if (!editing?.id || !confirm(`Delete “${editing.label}”?`)) return;
  apts = apts.filter((a) => a.id !== editing.id);
  tombstone(editing.id);
  if (selectedId === editing.id) { selectedId = null; $("#detail").hidden = true; isoLayer.clearLayers(); highlightLayer.clearLayers(); }
  editing = null;
  $("#apt-dialog").close("deleted");
  saveApts(); renderApts();
});
function saveApts(changed = true) {
  store.set("apartments", apts);
  if (changed) Sync.schedule();
}

// ---------- analysis ----------
function analysisKey() {
  return [CFG.analysisVersion, filtersKey(), DATA.poisMeta?.generated, DATA.stationsMeta?.generated, settings.workLat, settings.workLon, settings.arrive].join("|");
}
function nearestByAir(list, lat, lon, n, filter = () => true) {
  return list.filter(filter).map((p) => ({ p, d: haversine(lat, lon, p.lat, p.lon) })).sort((a, b) => a.d - b.d).slice(0, n);
}
function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeom(lon, lat, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((poly) => pointInRing(lon, lat, poly[0]) && !poly.slice(1).some((h) => pointInRing(lon, lat, h)));
}

async function analyze(apt) {
  const { lat, lon } = apt;
  const res = { key: analysisKey(), nearest: {}, within: {}, errors: [] };

  // 1) walking isochrones
  try {
    const iso = await postJSON(`${CFG.valhalla}/isochrone`, {
      locations: [{ lat, lon }], costing: "pedestrian", contours: [{ time: 5 }, { time: 10 }, { time: 15 }], polygons: true, denoise: 0.3, generalize: 15,
    });
    res.iso = iso.features.map((f) => ({ min: f.properties.contour, geometry: f.geometry }));
    const c10 = res.iso.find((f) => f.min === 10), c15 = res.iso.find((f) => f.min === 15);
    for (const cat of ["discounter", "supermarket", "gym", "pharmacy"]) {
      const list = poisOf(cat);
      res.within[cat] = {
        10: c10 ? list.filter((p) => inGeom(p.lon, p.lat, c10.geometry)).length : null,
        15: c15 ? list.filter((p) => inGeom(p.lon, p.lat, c15.geometry)).length : null,
      };
    }
  } catch (e) { res.errors.push(`Walking areas: ${e.message}`); }

  // 2) real walking times to the nearest candidates (by air) of each category
  const groups = [];
  for (const cat of ["discounter", "gym", "supermarket", "pharmacy", ...EXTRA_CATS]) {
    groups.push({ key: cat, cat, cands: nearestByAir(poisOf(cat), lat, lon, EXTRA_CATS.includes(cat) ? 3 : 5) });
  }
  groups.push({ key: "stationKoeln", cat: "station", cands: nearestByAir(DATA.stations, lat, lon, 4, (s) => s.direct?.koeln || s.direct?.koeln_deutz) });
  groups.push({ key: "stationDdf", cat: "station", cands: nearestByAir(DATA.stations, lat, lon, 3, (s) => s.direct?.duesseldorf) });
  groups.push({ key: "tram", cat: "tram", cands: nearestByAir(poisOf("tram"), lat, lon, 4) });
  const targets = [];
  for (const g of groups) for (const c of g.cands) { c.ti = targets.length; targets.push({ lat: c.p.lat, lon: c.p.lon }); }
  let times = null;
  if (targets.length) {
    try {
      // the public server limits matrix size, so ask in chunks
      times = [];
      for (let i = 0; i < targets.length; i += 25) {
        const m = await postJSON(`${CFG.valhalla}/sources_to_targets`, { sources: [{ lat, lon }], targets: targets.slice(i, i + 25), costing: "pedestrian" });
        times.push(...m.sources_to_targets[0]);
      }
    } catch (e) { res.errors.push(`Walking times: ${e.message} (showing straight-line estimates)`); }
  }
  for (const g of groups) {
    let best = null;
    for (const c of g.cands) {
      const t = times?.[c.ti];
      // fallback: straight line × 1.3 detour at 4.8 km/h
      const sec = t?.time ?? (c.d * 1.3) / (4.8 / 3.6);
      const dist = t?.distance != null ? t.distance * 1000 : c.d * 1.3;
      if (!best || sec < best.sec) best = { name: c.p.name, lat: c.p.lat, lon: c.p.lon, sec, dist, estimated: !t, cat: g.cat };
      if (best.name === c.p.name && best.lat === c.p.lat) best.ref = c.p;
    }
    if (best) {
      const p = best.ref;
      if (p?.price) best.price = p.price;
      if (p?.direct) best.direct = p.direct;
      if (p?.lines) best.lines = p.lines;
      delete best.ref;
    }
    res.nearest[g.key] = best;
  }

  // 2b) which Stadtteil is this? (for rent comparison)
  try {
    const r = await getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=16&addressdetails=1`, { headers: { "Accept-Language": "de" } }, 10000);
    const ad = r.address || {};
    res.area = { suburb: ad.suburb || ad.quarter || null, district: ad.city_district || ad.borough || null, quarter: ad.quarter || null };
  } catch (e) { res.area = null; }

  // 3) commute to work: public transport, bike, walk
  res.commute = {};
  const when = nextWeekdayISO(settings.arrive);
  res.commute.date = when.date;
  try {
    const url = `${CFG.transitous}?fromPlace=${lat},${lon}&toPlace=${settings.workLat},${settings.workLon}&time=${encodeURIComponent(when.iso)}&arriveBy=true`;
    const d = await getJSON(url);
    const its = (d.itineraries || []);
    if (its.length) {
      const it = its.reduce((a, b) => (b.duration < a.duration ? b : a));
      res.commute.transit = {
        sec: it.duration, transfers: it.transfers, dep: hhmmBerlin(it.startTime), arr: hhmmBerlin(it.endTime),
        legs: it.legs.map((l) => ({ mode: l.mode, line: l.displayName || l.routeShortName || "", from: l.from?.name, to: l.to?.name, sec: l.duration })),
      };
    }
    if (d.direct?.length) res.commute.walkDirect = d.direct[0].duration;
  } catch (e) { res.errors.push(`Public transport: ${e.message}`); }
  // 3b) getting home after a Friday night out in Köln (leave Köln Hbf after 00:30 Saturday)
  try {
    const sat = nextWeekdayISO("00:30", 6);
    const d = await getJSON(`${CFG.transitous}?fromPlace=50.94303,6.958727&toPlace=${lat},${lon}&time=${encodeURIComponent(sat.iso)}`);
    const it = (d.itineraries || [])[0];
    if (it) {
      res.night = {
        dep: hhmmBerlin(it.startTime), arr: hhmmBerlin(it.endTime), sec: it.duration, transfers: it.transfers,
        lines: it.legs.filter((l) => l.mode !== "WALK").map((l) => l.displayName || l.routeShortName || l.mode),
      };
    }
  } catch (e) { res.errors.push(`Night connection: ${e.message}`); }

  for (const costing of ["bicycle", "pedestrian"]) {
    try {
      const r = await postJSON(`${CFG.valhalla}/route`, { locations: [{ lat, lon }, { lat: settings.workLat, lon: settings.workLon }], costing, units: "kilometers" });
      res.commute[costing === "bicycle" ? "bike" : "walk"] = { sec: r.trip.summary.time, km: r.trip.summary.length };
    } catch (e) { res.errors.push(`${costing} route: ${e.message}`); }
  }
  return res;
}

function scoreOf(an) {
  if (!an) return null;
  const mins = {
    discounter: an.nearest.discounter && an.nearest.discounter.sec / 60,
    gym: an.nearest.gym && an.nearest.gym.sec / 60,
    station: an.nearest.stationKoeln && an.nearest.stationKoeln.sec / 60,
    commute: an.commute?.transit ? Math.min(an.commute.transit.sec, an.commute.walk?.sec ?? Infinity) / 60 : an.commute?.walk ? an.commute.walk.sec / 60 : null,
    pharmacy: an.nearest.pharmacy && an.nearest.pharmacy.sec / 60,
  };
  let sum = 0, wsum = 0;
  for (const [k, w] of Object.entries(settings.weights)) {
    if (!w) continue;
    sum += w * partScore(mins[k], SCORE_KEYS[k].good, SCORE_KEYS[k].bad);
    wsum += w;
  }
  return wsum ? Math.round((sum / wsum) * 100) : null;
}
const scoreClass = (s) => (s == null ? "" : s >= 70 ? "good" : s >= 45 ? "ok" : "bad");

// ---------- rent check ----------
// Cold rent per m² (entered, or estimated from warm rent) vs typical asking rents of the area.
function rentCheck(a, area) {
  const R = DATA.rents;
  if (!R || !a.size) return null;
  let cold = a.coldRent, estimated = false;
  if (!cold && a.rent) { cold = a.rent - R.utilities_eur_m2 * a.size; estimated = true; }
  if (!cold || cold <= 0) return null;
  const sqm = cold / a.size;
  const norm = (s) => (s || "").toLowerCase().replace(/[^a-zäöüß]/g, "");
  const find = (name) => name && Object.entries(R.areas).find(([k]) => norm(k) === norm(name) || norm(name).includes(norm(k)));
  let hit = null;
  for (const n of [area?.quarter, area?.suburb, area?.district]) { hit = find(n); if (hit) break; }
  const [areaName, vals] = hit || ["Bonn (city average)", R.bonn];
  const vs = vals.map((x) => x.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const verdict = sqm < lo * 0.92 ? "cheap" : sqm > hi * 1.08 ? "expensive" : "typical";
  const srcs = [...new Set(vals.map((x) => x.s))].map((s) => R.sources[s]);
  return { sqm, cold, estimated, areaName, lo, hi, verdict, srcs, matched: !!hit, suburb: area?.suburb };
}
const VERDICT = { cheap: ["good", "Below typical"], typical: ["ok", "Typical"], expensive: ["bad", "Above typical"] };

// ---------- rendering ----------
function renderApts() {
  const ul = $("#apt-list");
  $("#no-apts").hidden = apts.length > 0;
  $("#apt-count").textContent = apts.length ? `(${apts.length})` : "";
  ul.innerHTML = "";
  aptLayer.clearLayers();
  apts.forEach((a, i) => {
    const sc = a.analysis?.key === analysisKey() ? scoreOf(a.analysis) : null;
    const li = document.createElement("li");
    li.className = `apt${a.id === selectedId ? " selected" : ""}`;
    const meta = [a.rent ? eur(a.rent) : a.coldRent ? `${eur(a.coldRent)} kalt` : "", a.size ? `${a.size} m²` : "", a.rooms ? `${a.rooms} Zi.` : "", a.rent && a.size ? `${(a.rent / a.size).toFixed(1)} €/m²` : ""].filter(Boolean).join(" · ");
    li.innerHTML = `<span class="num">${i + 1}</span><span class="title">${esc(a.label || a.addr)}</span>
      <span class="score ${scoreClass(sc)}" title="Score 0–100 based on your priorities">${sc ?? "…"}</span>
      <span class="meta">${esc(meta || a.addr)}</span>`;
    li.addEventListener("click", () => selectApt(a.id));
    ul.appendChild(li);
    L.marker([a.lat, a.lon], {
      icon: L.divIcon({ className: "", html: `<div class="marker-apt${a.id === selectedId ? " selected" : ""}"><span>${i + 1}</span></div>`, iconSize: [30, 30], iconAnchor: [15, 30] }),
      zIndexOffset: a.id === selectedId ? 2000 : 1500,
    }).on("click", () => selectApt(a.id)).bindTooltip(esc(a.label || a.addr), { direction: "top", offset: [0, -28] }).addTo(aptLayer);
  });
}

async function selectApt(id, opts = {}) {
  selectedId = id;
  const a = apts.find((x) => x.id === id);
  if (!a) return;
  renderApts();
  const panel = $("#panel");
  if (panel.classList.contains("collapsed")) panel.classList.remove("collapsed");
  if (!opts.keepView && !map.getBounds().pad(-0.1).contains([a.lat, a.lon])) map.setView([a.lat, a.lon], Math.max(map.getZoom(), 14));
  if (a.analysis?.key !== analysisKey()) {
    renderDetail(a, true);
    try {
      a.analysis = await analyze(a);
      saveApts(false);
    } catch (e) {
      console.error(e);
      toast(`Analysis failed: ${e.message}`);
    }
    if (selectedId !== id) return;
    renderApts();
  }
  renderDetail(a, false);
  drawAnalysis(a);
  const outer = a.analysis?.iso?.find((f) => f.min === 15);
  if (outer && !opts.keepView) map.fitBounds(L.geoJSON(outer.geometry).getBounds().pad(0.15), { maxZoom: 16 });
  if (!opts.keepView && matchMedia("(max-width: 760px)").matches) $("#detail").scrollIntoView({ block: "start", behavior: "smooth" });
  analyzeRest();
}

// Analyse other apartments one by one in the background so scores/compare are complete.
let restRunning = false;
async function analyzeRest() {
  if (restRunning) return;
  restRunning = true;
  try {
    for (const a of apts) {
      if (a.analysis?.key === analysisKey()) continue;
      try { a.analysis = await analyze(a); saveApts(false); renderApts(); } catch (e) { console.warn("background analysis", e); }
    }
  } finally { restRunning = false; }
}

function drawAnalysis(a) {
  isoLayer.clearLayers();
  highlightLayer.clearLayers();
  const an = a.analysis;
  if (!an) return;
  if (an.iso && $("#iso-toggle").checked) {
    const shades = { 15: 0.08, 10: 0.12, 5: 0.18 };
    for (const f of [...an.iso].sort((x, y) => y.min - x.min)) {
      L.geoJSON(f.geometry, { interactive: false, style: { color: cssVar("--accent"), weight: 1.5, opacity: 0.7, fillColor: cssVar("--accent"), fillOpacity: shades[f.min] ?? 0.1, dashArray: f.min === 15 ? "4 4" : null } }).addTo(isoLayer);
    }
  }
  for (const key of ["discounter", "gym", "stationKoeln"]) {
    const n = an.nearest[key];
    if (!n) continue;
    const color = cssVar(CATS[n.cat].color);
    L.polyline([[a.lat, a.lon], [n.lat, n.lon]], { color, weight: 2, dashArray: "2 6", interactive: false }).addTo(highlightLayer);
    L.circleMarker([n.lat, n.lon], { radius: 13, color, weight: 2.5, fill: false, interactive: false }).addTo(highlightLayer);
  }
}
$("#iso-toggle").addEventListener("change", () => { const a = apts.find((x) => x.id === selectedId); if (a) drawAnalysis(a); });

function fact(icon, what, val, cls, sub) {
  return `<li class="fact"><span class="ico">${icon}</span><span class="what">${what}</span><span class="val ${cls || ""}">${val}</span>${sub ? `<span class="sub2">${sub}</span>` : ""}</li>`;
}
function renderDetail(a, loading) {
  const el = $("#detail");
  el.hidden = false;
  const an = a.analysis?.key === analysisKey() ? a.analysis : null;
  const sc = scoreOf(an);
  const head = `<div class="detail-head"><div><h3>${esc(a.label || "Apartment")}</h3><div class="small muted">${esc(a.addr)}</div></div>
    ${sc != null ? `<span class="score ${scoreClass(sc)}" style="font-size:16px">${sc}</span>` : ""}</div>`;
  const facts0 = [];
  if (a.rent || a.size || a.rooms) {
    facts0.push(fact("💶", "Rent", a.rent ? `${eur(a.rent)} warm` : a.coldRent ? `${eur(a.coldRent)} cold` : "–", "", [a.coldRent && a.rent ? `${eur(a.coldRent)} cold` : "", a.size ? `${a.size} m²` : "", a.rooms ? `${a.rooms} rooms` : "", a.rent && a.size ? `${(a.rent / a.size).toFixed(2)} €/m²` : "", a.available ? `from ${esc(a.available)}` : ""].filter(Boolean).join(" · ")));
  }
  const rc = an ? rentCheck(a, an.area) : null;
  if (rc) {
    const [cls, word] = VERDICT[rc.verdict];
    facts0.push(fact("📊", `Rent check: ${word}`, `${rc.sqm.toFixed(2)} €/m²`, cls,
      `Cold rent${rc.estimated ? " (estimated: warm − ~" + DATA.rents.utilities_eur_m2 + " €/m² utilities)" : ""} vs. typical asking rents in ${esc(rc.areaName)}: ${rc.lo.toFixed(2)}${rc.hi !== rc.lo ? "–" + rc.hi.toFixed(2) : ""} €/m²` +
      `${!rc.matched && rc.suburb ? ` (no data for ${esc(rc.suburb)})` : ""}<br>Sources: ${rc.srcs.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>`).join(", ")} · <a href="${esc(DATA.rents.official.url)}" target="_blank" rel="noopener">official Mietspiegel</a>`));
  } else if (an?.area?.suburb) {
    facts0.push(fact("📍", `Stadtteil: ${esc(an.area.suburb)}`, "", "", a.size ? "Add the rent to compare it with the area." : "Add size (m²) and rent to compare with typical rents."));
  }
  if (loading || !an) {
    el.innerHTML = `${head}<ul class="facts">${facts0.join("")}</ul><p class="small muted"><span class="spinner"></span> Calculating walking areas, distances and commute…</p>`;
    return;
  }
  const f = [...facts0];
  const n = an.nearest;
  const w = an.within || {};
  const within = (cat) => (w[cat]?.[10] != null ? `${w[cat][10]} within 10 min, ${w[cat][15]} within 15 min walk` : "");
  const est = (x) => (x?.estimated ? " (est.)" : "");

  if (n.discounter) f.push(fact("🛒", `Discounter: ${esc(n.discounter.name)}`, fmtMin(n.discounter.sec) + est(n.discounter), grade(n.discounter.sec / 60, 5, 20), `${fmtDist(n.discounter.dist)} · ${within("discounter")}`));
  if (n.gym) {
    const pr = n.gym.price ? `${eur(n.gym.price.monthly_eur)}/month · ` : "";
    f.push(fact("🏋️", `Gym: ${esc(n.gym.name)}`, fmtMin(n.gym.sec) + est(n.gym), grade(n.gym.sec / 60, 5, 25), `${pr}${fmtDist(n.gym.dist)} · ${within("gym")}`));
  }
  const st = n.stationKoeln;
  if (st) {
    const d = st.direct || {};
    const parts = [];
    if (d.koeln) parts.push(`Köln Hbf ${d.koeln.trips_per_day}×/day, ${d.koeln.fastest_min} min`);
    else if (d.koeln_deutz) parts.push(`Köln Messe/Deutz ${d.koeln_deutz.trips_per_day}×/day, ${d.koeln_deutz.fastest_min} min`);
    if (d.duesseldorf) parts.push(`Düsseldorf ${d.duesseldorf.trips_per_day}×/day, ${d.duesseldorf.fastest_min} min`);
    const kb = (d.koeln || d.koeln_deutz)?.back;
    const kw = d.koeln || d.koeln_deutz;
    const night = kb ? `<br>Last direct train back from ${esc(kw.label)}: ${gtfsTime(kb.wd?.last)} (Fri ${gtfsTime(kb.fri?.last)}, Sat ${gtfsTime(kb.sat?.last)}) · Weekend: ${kw.sat?.trips ?? "–"} trains Sat, ${kw.sun?.trips ?? "–"} Sun` : "";
    f.push(fact("🚆", `Station: ${esc(st.name)}`, fmtMin(st.sec) + est(st), grade(st.sec / 60, 8, 30), `Direct: ${parts.join(" · ")}${night}`));
  }
  const sd = n.stationDdf;
  if (sd && (!st || sd.name !== st.name)) {
    const d = sd.direct.duesseldorf;
    f.push(fact("🚆", `To Düsseldorf: ${esc(sd.name)}`, fmtMin(sd.sec) + est(sd), grade(sd.sec / 60, 8, 30), `Direct ${d.trips_per_day}×/day, fastest ${d.fastest_min} min`));
  }
  if (n.tram) {
    // which Stadtbahn/tram lines stop here (matched by stop name and proximity)
    const served = (LINES.rail || []).filter((l) => l.mode === "tram" && l.stops.some(([la, lo, nm]) =>
      flatDist(la, lo, n.tram.lat, n.tram.lon) < 250 && (nm.includes(n.tram.name) || n.tram.name.includes(nm.replace(/^Bonn[ -]/, "")))));
    const refs = served.map((l) => `<span class="pill clickable" data-ref="${esc(l.ref)}" data-mode="TRAM">${esc(l.ref)}</span>`).join(" ");
    const koeln = served.some((l) => l.ref === "16" || l.ref === "18") ? " · 16/18 run direct to Köln (≈60 min)" : "";
    f.push(fact("🚊", `Stadtbahn: ${esc(n.tram.name)}`, fmtMin(n.tram.sec) + est(n.tram), grade(n.tram.sec / 60, 5, 15), `${refs ? "Lines " + refs : ""}${koeln}`));
  }
  if (n.supermarket) f.push(fact("🛍️", `Supermarket: ${esc(n.supermarket.name)}`, fmtMin(n.supermarket.sec) + est(n.supermarket), grade(n.supermarket.sec / 60, 5, 20), within("supermarket")));
  if (n.pharmacy) f.push(fact("💊", `Pharmacy: ${esc(n.pharmacy.name)}`, fmtMin(n.pharmacy.sec) + est(n.pharmacy), grade(n.pharmacy.sec / 60, 5, 20), ""));
  const more = EXTRA_CATS.filter((c) => n[c]).map((c) => `<li>${CATS[c].icon} ${esc(n[c].name)} <span class="muted">· ${fmtMin(n[c].sec)}${est(n[c])}</span></li>`);
  if (more.length) f.push(`<li class="fact"><span class="ico">➕</span><details class="more-nearby"><summary class="what">More nearby (walking)</summary><ul>${more.join("")}</ul></details></li>`);

  const c = an.commute || {};
  const t = c.transit;
  if (t) {
    const legs = t.legs.filter((l) => l.mode !== "WALK").map((l) => `<span class="pill clickable" data-ref="${esc(l.line)}" data-mode="${esc(l.mode)}" title="Show this line on the map">${esc(l.line || l.mode)}</span> ${esc(l.from)} → ${esc(l.to)}`).join("<br>");
    f.push(fact("💼", `To ${esc(settings.workName)} (public transport)`, fmtMin(t.sec), grade(t.sec / 60, 15, 50),
      `Leave ${t.dep}, arrive ${t.arr} · ${t.transfers} transfer${t.transfers === 1 ? "" : "s"}${legs ? "<br>" + legs : " · walking only"}`));
  }
  if (c.bike) f.push(fact("🚲", "By bike", fmtMin(c.bike.sec), grade(c.bike.sec / 60, 10, 30), `${c.bike.km.toFixed(1)} km`));
  if (c.walk) f.push(fact("🚶", "On foot", fmtMin(c.walk.sec), grade(c.walk.sec / 60, 15, 45), `${c.walk.km.toFixed(1)} km`));
  if (an.night) {
    const nt = an.night;
    const wait = (() => { const [h, m] = nt.dep.split(":").map(Number); return ((h * 60 + m) - 30 + 1440) % 1440; })();
    f.push(fact("🌙", "Home from Köln Hbf, Fri night", `${nt.arr}`, wait <= 30 && nt.sec <= 3600 ? "good" : wait <= 75 ? "ok" : "bad",
      `Leaving after 00:30: next departs ${nt.dep}, arrives ${nt.arr} · ${nt.transfers} transfer${nt.transfers === 1 ? "" : "s"} · ${nt.lines.map(esc).join(" → ") || "walk"}`));
  }

  const g = (q) => `https://www.google.com/maps/dir/?api=1&origin=${a.lat},${a.lon}&destination=${q}`;
  const links = [
    `<a href="${g(`${settings.workLat},${settings.workLon}`)}&travelmode=transit" target="_blank" rel="noopener">Google Maps route to work</a>`,
    `<a href="https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${a.lat},${a.lon}" target="_blank" rel="noopener">Street View</a>`,
    a.url ? `<a href="${esc(a.url)}" target="_blank" rel="noopener">Listing</a>` : "",
  ].filter(Boolean).join("");
  el.innerHTML = `${head}<ul class="facts">${f.join("")}</ul>
    ${a.notes ? `<p class="small">${esc(a.notes)}</p>` : ""}
    ${an.errors?.length ? `<p class="small" style="color:var(--bad)">${an.errors.map(esc).join("<br>")}</p>` : ""}
    <div class="links">${links}</div>
    <div class="row gap-s" style="margin-top:10px">
      <button class="btn small" id="edit-apt" type="button">Edit</button>
      <button class="btn small ghost" id="reanalyze" type="button">Recalculate</button>
    </div>
    <p class="small muted">Commute for ${esc(c.date || "")} (Tue), arriving by ${esc(settings.arrive)}.</p>`;
  $("#edit-apt").onclick = () => openAptDialog(a);
  el.querySelectorAll(".pill.clickable").forEach((p) => { p.onclick = () => highlightByRef(p.dataset.ref, p.dataset.mode); });
  $("#reanalyze").onclick = () => { a.analysis = null; selectApt(a.id); };
}

// ---------- compare ----------
$("#compare-btn").addEventListener("click", () => {
  if (!apts.length) { toast("Add some apartments first."); return; }
  if (apts.some((a) => a.analysis?.key !== analysisKey())) toast("Some apartments are still being analysed. Reopen in a moment.");
  const rows = apts.map((a, i) => {
    const an = a.analysis?.key === analysisKey() ? a.analysis : null;
    const n = an?.nearest || {};
    return {
      rc: an ? rentCheck(a, an.area) : null, coldSqm: an ? rentCheck(a, an.area)?.sqm : null,
      i: i + 1, a, score: scoreOf(an), rent: a.rent, size: a.size, sqm: a.rent && a.size ? a.rent / a.size : null,
      disc: n.discounter?.sec, gym: n.gym?.sec, gymPrice: n.gym?.price?.monthly_eur, station: n.stationKoeln?.sec, stationName: n.stationKoeln?.name,
      transit: an?.commute?.transit?.sec, bike: an?.commute?.bike?.sec,
      discCount: an?.within?.discounter?.[10], gymCount: an?.within?.gym?.[10],
    };
  });
  const cols = [
    ["#", (r) => r.i], ["Apartment", (r) => esc(r.a.label || r.a.addr)], ["Score", (r) => r.score ?? "–", "score", "max"],
    ["Rent", (r) => eur(r.rent), "rent", "min"], ["Cold €/m²", (r) => (r.rc ? `${r.rc.sqm.toFixed(1)} <span class="val ${VERDICT[r.rc.verdict][0]}">${VERDICT[r.rc.verdict][1].toLowerCase()}</span>` : "–"), "coldSqm", "min"], ["m²", (r) => r.size ?? "", "size", "max"], ["Warm €/m²", (r) => (r.sqm ? r.sqm.toFixed(1) : ""), "sqm", "min"],
    ["🛒 Discounter", (r) => fmtMin(r.disc), "disc", "min"], ["🛒 in 10 min", (r) => r.discCount ?? "–", "discCount", "max"],
    ["🏋️ Gym", (r) => fmtMin(r.gym), "gym", "min"], ["🏋️ €/mo", (r) => eur(r.gymPrice), "gymPrice", "min"],
    ["🚆 Station→Köln", (r) => (r.station != null ? `${fmtMin(r.station)} <span class="muted">${esc(r.stationName)}</span>` : "–"), "station", "min"],
    ["💼 Transit", (r) => fmtMin(r.transit), "transit", "min"], ["🚲 Bike", (r) => fmtMin(r.bike), "bike", "min"],
  ];
  const best = {};
  for (const [, , key, dir] of cols) {
    if (!key) continue;
    const vals = rows.map((r) => r[key]).filter((v) => v != null && v !== "");
    if (vals.length > 1) best[key] = dir === "min" ? Math.min(...vals) : Math.max(...vals);
  }
  $("#compare-table").innerHTML = `<thead><tr>${cols.map((c) => `<th>${c[0]}</th>`).join("")}</tr></thead><tbody>${rows.map((r) =>
    `<tr>${cols.map(([, fn, key]) => `<td class="${key && best[key] != null && r[key] === best[key] ? "best" : ""}">${fn(r)}</td>`).join("")}</tr>`).join("")}</tbody>`;
  $("#compare-dialog").showModal();
});

// ---------- sync between devices (secret GitHub Gist) ----------
function tombstone(id) {
  const t = store.get("deletedApts", {});
  t[id] = Date.now();
  store.set("deletedApts", t);
}
const Sync = {
  api: "https://api.github.com",
  file: "bonn-apartments.json",
  desc: "Bonn Apartment Map – synced apartments (private)",
  timer: null, busy: false, again: false,
  get token() { return store.get("syncToken", null); },
  get gistId() { return store.get("syncGistId", null); },
  status(msg, cls = "") {
    const el = $("#sync-status");
    if (el) { el.textContent = msg; el.className = `small sync-status ${cls}`; }
    const d = $("#sync-dialog-status");
    if (d) d.textContent = msg;
  },
  async gh(path, opts = {}) {
    const r = await fetch(this.api + path, {
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.body ? { "Content-Type": "application/json" } : {}) },
    });
    if (!r.ok) throw new Error(r.status === 401 ? "token invalid or expired" : r.status === 404 ? "gist not found (check the token has the 'gist' scope)" : `GitHub ${r.status}`);
    return r.status === 204 ? null : r.json();
  },
  async connect(token) {
    store.set("syncToken", token.trim());
    store.set("syncGistId", null);
    // Reuse an existing gist made by this app (e.g. on another device).
    for (let page = 1; page <= 5; page++) {
      const list = await this.gh(`/gists?per_page=100&page=${page}`);
      const hit = list.find((g) => g.description === this.desc && g.files[this.file]);
      if (hit) { store.set("syncGistId", hit.id); break; }
      if (list.length < 100) break;
    }
    if (!this.gistId) {
      const g = await this.gh("/gists", { method: "POST", body: JSON.stringify({ description: this.desc, public: false, files: { [this.file]: { content: JSON.stringify(this.local()) } } }) });
      store.set("syncGistId", g.id);
    }
    await this.run();
  },
  disconnect() {
    store.set("syncToken", null);
    store.set("syncGistId", null);
    this.status("");
    renderSyncBadge();
  },
  local() {
    return {
      v: 1,
      apartments: apts.map(({ analysis, ...a }) => a),
      deleted: store.get("deletedApts", {}),
      settings,
    };
  },
  merge(remote) {
    const deleted = { ...(remote.deleted || {}) };
    for (const [id, t] of Object.entries(store.get("deletedApts", {}))) deleted[id] = Math.max(deleted[id] || 0, t);
    const byId = new Map();
    for (const a of [...(remote.apartments || []), ...apts]) {
      const cur = byId.get(a.id);
      if (!cur || (a.updatedAt || 0) > (cur.updatedAt || 0)) byId.set(a.id, a);
    }
    const localById = new Map(apts.map((a) => [a.id, a]));
    const merged = [];
    for (const a of byId.values()) {
      if (deleted[a.id] && deleted[a.id] >= (a.updatedAt || 0)) continue;
      const loc = localById.get(a.id);
      // keep the locally cached analysis if the location did not change
      merged.push(loc && loc.lat === a.lat && loc.lon === a.lon && loc.analysis ? { ...a, analysis: loc.analysis } : { ...a });
    }
    // order: by first creation on any device (stable list numbers everywhere)
    const order = new Map([...(remote.apartments || []), ...apts].map((a, i) => [a.id, i]));
    merged.sort((x, y) => (x.createdAt || 0) - (y.createdAt || 0) || order.get(x.id) - order.get(y.id));
    const rs = remote.settings;
    const mergedSettings = rs && (rs.updatedAt || 0) > (settings.updatedAt || 0) ? { ...settings, ...rs } : settings;
    return { apartments: merged, deleted, settings: mergedSettings };
  },
  schedule() {
    if (!this.token) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.run(), 1500);
  },
  async run() {
    if (!this.token || !this.gistId) return;
    if (this.busy) { this.again = true; return; }
    this.busy = true;
    this.status("Syncing…");
    try {
      const g = await this.gh(`/gists/${this.gistId}`);
      const f = g.files[this.file];
      let remote = {};
      if (f) {
        const text = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
        try { remote = JSON.parse(text || "{}"); } catch { remote = {}; }
      }
      const m = this.merge(remote);
      const settingsChanged = JSON.stringify(m.settings) !== JSON.stringify(settings);
      apts = m.apartments;
      store.set("deletedApts", m.deleted);
      settings = m.settings;
      store.set("settings", settings);
      store.set("apartments", apts);
      const out = this.local();
      if (JSON.stringify(out) !== JSON.stringify({ v: 1, apartments: remote.apartments, deleted: remote.deleted, settings: remote.settings })) {
        await this.gh(`/gists/${this.gistId}`, { method: "PATCH", body: JSON.stringify({ files: { [this.file]: { content: JSON.stringify(out) } } }) });
      }
      if (settingsChanged) drawWork();
      if (selectedId && !apts.some((a) => a.id === selectedId)) { selectedId = null; $("#detail").hidden = true; isoLayer.clearLayers(); highlightLayer.clearLayers(); }
      renderApts();
      analyzeRest();
      this.status(`Synced ${new Date().toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" })}`, "ok");
    } catch (e) {
      console.warn("sync", e);
      this.status(`Sync failed: ${e.message}`, "err");
    } finally {
      this.busy = false;
      if (this.again) { this.again = false; this.run(); }
    }
  },
};
function renderSyncBadge() {
  const el = $("#sync-status");
  if (el) el.hidden = !Sync.token;
}
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") Sync.run(); });

function openSyncDialog() {
  const on = !!Sync.token;
  $("#sync-connected").hidden = !on;
  $("#sync-setup").hidden = on;
  $("#sync-token").value = "";
  $("#sync-dialog").showModal();
}
$("#sync-connect").addEventListener("click", async () => {
  const t = $("#sync-token").value.trim();
  if (!t) return;
  $("#sync-dialog-status").textContent = "Connecting…";
  try {
    await Sync.connect(t);
    renderSyncBadge();
    $("#sync-dialog").close();
    toast("Sync is on. Connect your other devices with the same token.");
  } catch (e) {
    store.set("syncToken", null);
    $("#sync-dialog-status").textContent = `Could not connect: ${e.message}`;
  }
});
$("#sync-now").addEventListener("click", () => Sync.run());
$("#sync-off").addEventListener("click", () => { Sync.disconnect(); $("#sync-dialog").close(); toast("Sync turned off on this device. Your apartments stay here."); });

// ---------- menu: export / import / settings ----------
$("#menu-btn").addEventListener("click", () => { $("#menu").hidden = !$("#menu").hidden; });
$("#menu").addEventListener("click", (e) => {
  const act = e.target.dataset.action;
  if (!act) return;
  $("#menu").hidden = true;
  if (act === "export") {
    const blob = new Blob([JSON.stringify({ apartments: apts.map(({ analysis, ...a }) => a), settings }, null, 1)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement("a"), { href: url, download: `bonn-apartments-${new Date().toISOString().slice(0, 10)}.json` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } else if (act === "import") $("#import-file").click();
  else if (act === "settings") openSettings();
  else if (act === "sync") openSyncDialog();
});
$("#import-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    const incoming = (d.apartments || []).filter((a) => typeof a.lat === "number" && typeof a.lon === "number");
    let added = 0;
    for (const a of incoming) {
      if (apts.some((x) => x.id === a.id || (Math.abs(x.lat - a.lat) < 1e-5 && Math.abs(x.lon - a.lon) < 1e-5))) continue;
      apts.push({ ...a, id: a.id || Math.random().toString(36).slice(2, 10), updatedAt: Date.now() });
      added++;
    }
    if (d.settings && confirm("Also import settings (work place, priorities)?")) { settings = { ...settings, ...d.settings, updatedAt: Date.now() }; store.set("settings", settings); Sync.schedule(); drawWork(); }
    saveApts(); renderApts();
    toast(`Imported ${added} apartment${added === 1 ? "" : "s"}.`);
  } catch (err) { toast(`Import failed: ${err.message}`); }
  e.target.value = "";
});

function openSettings() {
  const f = $("#settings-form");
  f.elements.workName.value = settings.workName;
  f.elements.workAddr.value = settings.workAddr;
  f.elements.arrive.value = settings.arrive;
  $("#weights").innerHTML = Object.entries(SCORE_KEYS).map(([k, s]) =>
    `<label>${esc(s.label)} <input name="w_${k}" type="number" min="0" max="3" step="1" value="${settings.weights[k] ?? 0}"></label>`).join("");
  $("#settings-dialog").showModal();
}
$("#settings-dialog").addEventListener("close", async () => {
  if ($("#settings-dialog").returnValue !== "save") return;
  const f = $("#settings-form");
  const next = { ...settings, workName: f.elements.workName.value.trim(), arrive: f.elements.arrive.value, weights: {} };
  for (const k of Object.keys(SCORE_KEYS)) next.weights[k] = Number(f.elements[`w_${k}`].value) || 0;
  const addr = f.elements.workAddr.value.trim();
  if (addr !== settings.workAddr) {
    try {
      const [hit] = await geocode(addr, 1);
      if (!hit) throw new Error("address not found");
      [next.workLon, next.workLat] = hit.geometry.coordinates;
      next.workAddr = addr;
    } catch (e) { toast(`Could not find work address: ${e.message}`); return; }
  }
  settings = { ...next, updatedAt: Date.now() };
  store.set("settings", settings);
  Sync.schedule();
  drawWork(); renderApts(); renderHeat();
  if (selectedId) selectApt(selectedId);
});

// ---------- mobile panel ----------
$("#panel-toggle").addEventListener("click", () => {
  const p = $("#panel");
  if (p.classList.contains("expanded")) { p.classList.remove("expanded"); p.classList.add("collapsed"); }
  else if (p.classList.contains("collapsed")) p.classList.remove("collapsed");
  else p.classList.add("expanded");
  setTimeout(() => map.invalidateSize(), 250);
});

// ---------- boot ----------
(async function boot() {
  drawWork();
  renderApts();
  try { await loadData(); } catch (e) { console.error(e); toast(`Data load failed: ${e.message}`); }
  buildLayers();
  renderApts();
  await loadLines("rail"); // also used to list the lines at the nearest Stadtbahn stop
  initLines();
  if (selectedId) renderDetail(apts.find((x) => x.id === selectedId), false);
  if (store.get("heatOn", false)) { $("#heat-toggle").checked = true; setHeat(true); }
  renderSyncBadge();
  Sync.run();
  if (apts.length) {
    const b = L.latLngBounds(apts.map((a) => [a.lat, a.lon])).extend([settings.workLat, settings.workLon]);
    map.fitBounds(b.pad(0.3), { maxZoom: 15 });
    analyzeRest();
  }
})();
