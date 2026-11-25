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
  analysisVersion: 3,
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
};
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
function nextWeekdayISO(hhmm) {
  const now = new Date();
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  while (d.getDay() !== 2) d.setDate(d.getDate() + 1); // next Tuesday
  const date = d.toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }); // YYYY-MM-DD
  const probe = new Date(`${date}T12:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Berlin", timeZoneName: "longOffset" })
    .formatToParts(probe).find((p) => p.type === "timeZoneName").value.replace("GMT", "") || "+00:00";
  return { iso: `${date}T${hhmm}:00${off}`, date };
}
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
    } else h += `<div class="small muted" style="margin-top:4px">No direct trains to Köln/Düsseldorf.</div>`;
    h += `<div class="small muted">Weekday (Tue) timetable, departures from this station.</div>`;
  }
  const links = [];
  if (p.website) links.push(`<a href="${esc(p.website)}" target="_blank" rel="noopener">Website</a>`);
  links.push(`<a href="${googleLink(p)}" target="_blank" rel="noopener">Google Maps / reviews</a>`);
  if (p.osm) links.push(`<a href="${esc(p.osm)}" target="_blank" rel="noopener">OSM</a>`);
  if (cat === "station") links.push(`<a href="https://www.bahn.de/buchung/fahrplan/suche#sts=true&so=${encodeURIComponent(p.name)}" target="_blank" rel="noopener">DB timetable</a>`);
  h += `<div class="pop-links small">${links.join("")}</div>`;
  return h + "</div>";
}

function buildLayers() {
  const box = $("#layers");
  box.innerHTML = "";
  const savedOn = store.get("layersOn", null);
  for (const [cat, c] of Object.entries(CATS)) {
    const list = cat === "station" ? DATA.stations : DATA.pois[cat] || [];
    const g = L.layerGroup();
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
    layers[cat] = g;
    const on = savedOn ? !!savedOn[cat] : c.on;
    if (on) g.addTo(map);
    const lab = document.createElement("label");
    lab.className = "check";
    lab.innerHTML = `<input type="checkbox" ${on ? "checked" : ""}><span class="dot" style="background:${cssVar(c.color)}"></span>
      <span>${c.icon} ${esc(c.label)}${c.sub ? ` <span class="muted small">${esc(c.sub)}</span>` : ""}</span><span class="count">${list.length}</span>`;
    lab.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? g.addTo(map) : map.removeLayer(g);
      const state = {};
      for (const k of Object.keys(CATS)) state[k] = map.hasLayer(layers[k]);
      store.set("layersOn", state);
    });
    box.appendChild(lab);
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

// ---------- data loading ----------
async function loadData() {
  const [stations, prices] = await Promise.all([
    getJSON("data/stations.json").catch(() => null),
    getJSON("data/gym_prices.json").catch(() => ({ chains: [] })),
  ]);
  if (stations) { DATA.stations = stations.stations; DATA.stationsMeta = stations; }
  DATA.gymPrices = prices.chains.map((c) => ({ ...c, rx: new RegExp(c.match, "i") }));

  let pois = await getJSON("data/pois.json").catch(() => null);
  if (!pois) pois = await livePois();
  DATA.poisMeta = pois;
  DATA.pois = pois ? pois.categories : {};
  for (const g of DATA.pois.gym || []) {
    const label = `${g.brand || ""} ${g.name}`;
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
  for (const k of ["label", "rent", "size", "rooms", "available", "url", "notes"]) f.elements[k].value = apt[k] ?? "";
  $("#apt-delete").hidden = !apt.id;
  $("#apt-dialog").showModal();
}
$("#apt-dialog").addEventListener("close", () => {
  if ($("#apt-dialog").returnValue !== "save" || !editing) return;
  const f = $("#apt-form");
  const vals = {};
  for (const k of ["label", "rent", "size", "rooms", "available", "url", "notes"]) vals[k] = f.elements[k].value.trim();
  for (const k of ["rent", "size", "rooms"]) vals[k] = vals[k] === "" ? null : Number(vals[k]);
  if (editing.id) {
    Object.assign(apts.find((a) => a.id === editing.id), vals);
  } else {
    const a = { id: Math.random().toString(36).slice(2, 10), addr: editing.addr, lat: editing.lat, lon: editing.lon, ...vals };
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
  if (selectedId === editing.id) { selectedId = null; $("#detail").hidden = true; isoLayer.clearLayers(); highlightLayer.clearLayers(); }
  editing = null;
  $("#apt-dialog").close("deleted");
  saveApts(); renderApts();
});
function saveApts() { store.set("apartments", apts); }

// ---------- analysis ----------
function analysisKey() {
  return [CFG.analysisVersion, DATA.poisMeta?.generated, DATA.stationsMeta?.generated, settings.workLat, settings.workLon, settings.arrive].join("|");
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
      const list = DATA.pois[cat] || [];
      res.within[cat] = {
        10: c10 ? list.filter((p) => inGeom(p.lon, p.lat, c10.geometry)).length : null,
        15: c15 ? list.filter((p) => inGeom(p.lon, p.lat, c15.geometry)).length : null,
      };
    }
  } catch (e) { res.errors.push(`Walking areas: ${e.message}`); }

  // 2) real walking times to the nearest candidates (by air) of each category
  const groups = [];
  for (const cat of ["discounter", "gym", "supermarket", "pharmacy"]) {
    groups.push({ key: cat, cat, cands: nearestByAir(DATA.pois[cat] || [], lat, lon, 5) });
  }
  groups.push({ key: "stationKoeln", cat: "station", cands: nearestByAir(DATA.stations, lat, lon, 4, (s) => s.direct?.koeln || s.direct?.koeln_deutz) });
  groups.push({ key: "stationDdf", cat: "station", cands: nearestByAir(DATA.stations, lat, lon, 3, (s) => s.direct?.duesseldorf) });
  groups.push({ key: "tram", cat: "tram", cands: nearestByAir(DATA.pois.tram || [], lat, lon, 4) });
  const targets = [];
  for (const g of groups) for (const c of g.cands) { c.ti = targets.length; targets.push({ lat: c.p.lat, lon: c.p.lon }); }
  let times = null;
  if (targets.length) {
    try {
      const m = await postJSON(`${CFG.valhalla}/sources_to_targets`, { sources: [{ lat, lon }], targets, costing: "pedestrian" });
      times = m.sources_to_targets[0];
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
    const meta = [a.rent ? eur(a.rent) : "", a.size ? `${a.size} m²` : "", a.rooms ? `${a.rooms} Zi.` : "", a.rent && a.size ? `${(a.rent / a.size).toFixed(1)} €/m²` : ""].filter(Boolean).join(" · ");
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

async function selectApt(id) {
  selectedId = id;
  const a = apts.find((x) => x.id === id);
  if (!a) return;
  renderApts();
  const panel = $("#panel");
  if (panel.classList.contains("collapsed")) panel.classList.remove("collapsed");
  if (!map.getBounds().pad(-0.1).contains([a.lat, a.lon])) map.setView([a.lat, a.lon], Math.max(map.getZoom(), 14));
  if (a.analysis?.key !== analysisKey()) {
    renderDetail(a, true);
    try {
      a.analysis = await analyze(a);
      saveApts();
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
  if (outer) map.fitBounds(L.geoJSON(outer.geometry).getBounds().pad(0.15), { maxZoom: 16 });
  if (matchMedia("(max-width: 760px)").matches) $("#detail").scrollIntoView({ block: "start", behavior: "smooth" });
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
      try { a.analysis = await analyze(a); saveApts(); renderApts(); } catch (e) { console.warn("background analysis", e); }
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
    facts0.push(fact("💶", "Rent", a.rent ? eur(a.rent) : "–", "", [a.size ? `${a.size} m²` : "", a.rooms ? `${a.rooms} rooms` : "", a.rent && a.size ? `${(a.rent / a.size).toFixed(2)} €/m²` : "", a.available ? `from ${esc(a.available)}` : ""].filter(Boolean).join(" · ")));
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
    f.push(fact("🚆", `Station: ${esc(st.name)}`, fmtMin(st.sec) + est(st), grade(st.sec / 60, 8, 30), `Direct: ${parts.join(" · ")}`));
  }
  const sd = n.stationDdf;
  if (sd && (!st || sd.name !== st.name)) {
    const d = sd.direct.duesseldorf;
    f.push(fact("🚆", `To Düsseldorf: ${esc(sd.name)}`, fmtMin(sd.sec) + est(sd), grade(sd.sec / 60, 8, 30), `Direct ${d.trips_per_day}×/day, fastest ${d.fastest_min} min`));
  }
  if (n.tram) f.push(fact("🚊", `Stadtbahn: ${esc(n.tram.name)}`, fmtMin(n.tram.sec) + est(n.tram), grade(n.tram.sec / 60, 5, 15), "Lines 16/18 also run direct to Köln city centre (≈60 min)"));
  if (n.supermarket) f.push(fact("🛍️", `Supermarket: ${esc(n.supermarket.name)}`, fmtMin(n.supermarket.sec) + est(n.supermarket), grade(n.supermarket.sec / 60, 5, 20), within("supermarket")));
  if (n.pharmacy) f.push(fact("💊", `Pharmacy: ${esc(n.pharmacy.name)}`, fmtMin(n.pharmacy.sec) + est(n.pharmacy), grade(n.pharmacy.sec / 60, 5, 20), ""));

  const c = an.commute || {};
  const t = c.transit;
  if (t) {
    const legs = t.legs.filter((l) => l.mode !== "WALK").map((l) => `<span class="pill">${esc(l.line || l.mode)}</span> ${esc(l.from)} → ${esc(l.to)}`).join("<br>");
    f.push(fact("💼", `To ${esc(settings.workName)} (public transport)`, fmtMin(t.sec), grade(t.sec / 60, 15, 50),
      `Leave ${t.dep}, arrive ${t.arr} · ${t.transfers} transfer${t.transfers === 1 ? "" : "s"}${legs ? "<br>" + legs : " · walking only"}`));
  }
  if (c.bike) f.push(fact("🚲", "By bike", fmtMin(c.bike.sec), grade(c.bike.sec / 60, 10, 30), `${c.bike.km.toFixed(1)} km`));
  if (c.walk) f.push(fact("🚶", "On foot", fmtMin(c.walk.sec), grade(c.walk.sec / 60, 15, 45), `${c.walk.km.toFixed(1)} km`));

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
      i: i + 1, a, score: scoreOf(an), rent: a.rent, size: a.size, sqm: a.rent && a.size ? a.rent / a.size : null,
      disc: n.discounter?.sec, gym: n.gym?.sec, gymPrice: n.gym?.price?.monthly_eur, station: n.stationKoeln?.sec, stationName: n.stationKoeln?.name,
      transit: an?.commute?.transit?.sec, bike: an?.commute?.bike?.sec,
      discCount: an?.within?.discounter?.[10], gymCount: an?.within?.gym?.[10],
    };
  });
  const cols = [
    ["#", (r) => r.i], ["Apartment", (r) => esc(r.a.label || r.a.addr)], ["Score", (r) => r.score ?? "–", "score", "max"],
    ["Rent", (r) => eur(r.rent), "rent", "min"], ["m²", (r) => r.size ?? "", "size", "max"], ["€/m²", (r) => (r.sqm ? r.sqm.toFixed(1) : ""), "sqm", "min"],
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
      apts.push({ ...a, id: a.id || Math.random().toString(36).slice(2, 10) });
      added++;
    }
    if (d.settings && confirm("Also import settings (work place, priorities)?")) { settings = { ...settings, ...d.settings }; store.set("settings", settings); drawWork(); }
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
  settings = next;
  store.set("settings", settings);
  drawWork(); renderApts();
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
  if (apts.length) {
    const b = L.latLngBounds(apts.map((a) => [a.lat, a.lon])).extend([settings.workLat, settings.workLon]);
    map.fitBounds(b.pad(0.3), { maxZoom: 15 });
    analyzeRest();
  }
})();
