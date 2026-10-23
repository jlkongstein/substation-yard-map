// Likely sea routes between yards and offshore sites.
// A small hand-made network of sea waypoints (shipping lanes, straits, capes); routes are the
// shortest path through it. Good enough to show the probable voyage, not for navigation.

(function () {
  // [id, lat, lon]
  const NODES = [
    // North Sea & Norway
    ["nl_maas", 51.98, 3.95], ["nl_scheldt", 51.50, 3.30], ["ns_south", 52.60, 3.10], ["ns_nl_n", 53.20, 4.30],
    ["ns_central", 54.00, 4.00], ["ns_bight", 54.20, 7.00], ["ems", 53.70, 6.55], ["ns_dk", 55.30, 6.60],
    ["ns_north", 56.50, 4.50], ["ns_norway_sw", 58.00, 5.20], ["haugesund", 59.35, 5.05], ["fair_isle", 59.40, -2.00],
    // Skagerrak, Danish straits (Great Belt) & Baltic
    ["skagerrak_w", 57.75, 7.50], ["skagerrak_e", 57.95, 10.60], ["kattegat_n", 57.30, 11.30], ["kattegat_s", 56.30, 11.45],
    ["belt_n", 55.95, 11.05], ["belt_s", 55.25, 11.00], ["fehmarn", 54.62, 11.35], ["kadet", 54.45, 12.10],
    ["rostock_off", 54.25, 12.05], ["darss_n", 54.75, 12.90], ["rugen_n", 54.85, 13.70], ["bornholm_s", 54.85, 15.20],
    ["baltic_pl_w", 55.00, 16.30], ["baltic_pl", 55.15, 17.30],
    // Channel, Biscay, Iberia
    ["dover", 51.05, 1.55], ["channel_mid", 50.20, -0.50], ["channel_w", 49.80, -3.50], ["ushant", 48.70, -5.50],
    ["biscay_n", 47.30, -3.90], ["stnazaire_off", 47.15, -2.40], ["biscay_e", 45.90, -2.40], ["biscay_w", 46.00, -6.50],
    ["finisterre", 43.50, -9.80], ["portugal", 39.50, -9.90], ["st_vincent", 36.90, -9.30], ["cadiz_off", 36.45, -6.50],
    ["gibraltar", 35.95, -5.60],
    // Mediterranean & Suez / Red Sea
    ["alboran", 36.10, -3.50], ["cabo_gata", 36.60, -1.80], ["balearic_w", 38.60, 0.80], ["lion", 42.60, 4.00],
    ["sardinia_s", 37.90, 8.50], ["sicily_ch", 37.30, 11.80], ["crete_s", 34.30, 24.00], ["port_said", 31.50, 32.30],
    ["suez", 29.90, 32.55], ["redsea_n", 27.30, 34.30], ["redsea_mid", 20.00, 38.60], ["redsea_s", 15.00, 41.80],
    ["bab_el_mandeb", 12.60, 43.35], ["aden", 12.20, 46.00],
    // Arabian Sea, Gulf, India
    ["socotra_n", 13.50, 52.50], ["oman_s", 18.50, 58.50], ["muscat", 23.00, 59.50], ["hormuz", 26.30, 56.60],
    ["gulf", 25.90, 55.40], ["dubai_off", 25.35, 55.10], ["jebel_ali_off", 25.10, 54.90],
    ["arabian_c", 15.00, 62.00], ["india_sw", 8.00, 75.50], ["comorin", 7.20, 77.60], ["srilanka_s", 5.60, 80.60],
    ["srilanka_e", 7.50, 82.50], ["bengal_w", 12.00, 81.00], ["chennai_off", 13.30, 80.50],
    // Malacca, Singapore, South China Sea, East Asia
    ["sumatra_n", 6.20, 94.80], ["malacca_n", 5.80, 97.50], ["malacca_mid", 3.50, 100.00], ["malacca_s", 2.30, 101.60],
    ["johor_s", 1.30, 103.40], ["singapore", 1.20, 103.75], ["singapore_e", 1.25, 104.20],
    ["gulf_thai", 9.00, 102.50], ["laem_off", 12.80, 100.75], ["scs_s", 4.00, 106.00], ["vungtau_off", 9.90, 107.30],
    ["scs_mid", 13.00, 110.50], ["hainan_e", 17.50, 112.00], ["hk_s", 21.50, 115.00], ["tw_strait_s", 23.00, 118.50],
    ["tw_mid", 24.50, 120.20], ["tw_strait_n", 25.60, 120.50], ["ecs", 29.00, 123.00], ["shanghai_off", 31.00, 122.60],
    ["yellow", 34.50, 123.00], ["taean_off", 36.80, 125.60], ["bohai_strait", 38.25, 120.90], ["bohai", 38.80, 119.80],
    ["jeju_s", 32.80, 126.50], ["korea_strait", 34.00, 128.50], ["ulsan_off", 35.40, 129.60],
    // Indian Ocean & the Cape route
    ["io_n", 0.00, 85.00], ["io_c", -15.00, 70.00], ["somalia_e", 2.00, 52.00], ["mada_ne", -12.00, 51.50],
    ["mada_e", -22.00, 49.50], ["mada_s", -27.50, 46.50], ["durban_off", -32.00, 32.00], ["agulhas", -36.00, 21.00],
    ["cape", -35.00, 17.50], ["namibia", -25.00, 11.50], ["angola", -12.00, 10.50], ["gulf_guinea", 0.00, 3.00],
    ["ivory", 3.50, -5.00], ["liberia", 4.50, -11.00], ["senegal_w", 14.50, -18.50], ["canaries_w", 28.50, -19.00],
    ["madeira_e", 33.50, -15.00],
    // North Atlantic
    ["atl_ne", 47.00, -20.00], ["atl_n", 57.50, -15.00], ["atl_c", 42.00, -45.00], ["us_ne", 40.30, -69.00],
  ];

  const EDGES = [
    // North Sea
    "nl_maas-nl_scheldt", "nl_scheldt-dover", "nl_maas-ns_south", "nl_maas-ns_nl_n", "ns_south-ns_nl_n", "ns_south-dover",
    "ns_nl_n-ns_central", "ns_south-ns_central", "ns_central-ns_bight", "ns_bight-ems", "ns_nl_n-ems", "ns_bight-ns_dk",
    "ns_central-ns_dk", "ns_central-ns_north", "ns_dk-ns_north", "ns_north-ns_norway_sw", "ns_norway_sw-haugesund",
    "haugesund-fair_isle", "ns_north-fair_isle", "fair_isle-atl_n",
    // Skagerrak & Baltic (big topsides go through the Great Belt)
    "ns_north-skagerrak_w", "ns_dk-skagerrak_w", "ns_norway_sw-skagerrak_w", "skagerrak_w-skagerrak_e", "skagerrak_e-kattegat_n",
    "kattegat_n-kattegat_s", "kattegat_s-belt_n", "belt_n-belt_s", "belt_s-fehmarn", "fehmarn-kadet", "kadet-rostock_off",
    "kadet-darss_n", "darss_n-rugen_n", "rugen_n-bornholm_s", "bornholm_s-baltic_pl_w", "baltic_pl_w-baltic_pl",
    // Channel, Biscay, Iberia
    "dover-channel_mid", "channel_mid-channel_w", "channel_w-ushant", "ushant-biscay_n", "biscay_n-stnazaire_off",
    "biscay_n-biscay_e", "stnazaire_off-biscay_e", "ushant-biscay_w", "biscay_w-biscay_e", "biscay_w-finisterre",
    "finisterre-portugal", "portugal-st_vincent", "st_vincent-cadiz_off", "cadiz_off-gibraltar", "st_vincent-gibraltar",
    // Mediterranean & Suez
    "gibraltar-alboran", "alboran-cabo_gata", "cabo_gata-balearic_w", "balearic_w-lion", "balearic_w-sardinia_s",
    "lion-sardinia_s", "sardinia_s-sicily_ch", "sicily_ch-crete_s", "crete_s-port_said", "port_said-suez",
    "suez-redsea_n", "redsea_n-redsea_mid", "redsea_mid-redsea_s", "redsea_s-bab_el_mandeb", "bab_el_mandeb-aden",
    "aden-socotra_n",
    // Arabian Sea, Gulf, India
    "socotra_n-oman_s", "oman_s-muscat", "muscat-hormuz", "hormuz-gulf", "gulf-dubai_off", "gulf-jebel_ali_off",
    "dubai_off-jebel_ali_off", "muscat-arabian_c", "oman_s-arabian_c", "socotra_n-arabian_c", "arabian_c-india_sw",
    "india_sw-comorin", "comorin-srilanka_s", "srilanka_s-srilanka_e", "srilanka_e-bengal_w", "bengal_w-chennai_off",
    "arabian_c-somalia_e", "socotra_n-somalia_e",
    // Malacca to East Asia
    "srilanka_s-sumatra_n", "srilanka_e-sumatra_n", "sumatra_n-malacca_n", "malacca_n-malacca_mid", "malacca_mid-malacca_s",
    "malacca_s-johor_s", "johor_s-singapore", "singapore-singapore_e", "singapore_e-scs_s", "singapore_e-gulf_thai",
    "gulf_thai-laem_off", "gulf_thai-vungtau_off", "scs_s-vungtau_off", "vungtau_off-scs_mid", "scs_mid-hainan_e",
    "hainan_e-hk_s", "hk_s-tw_strait_s", "tw_strait_s-tw_mid", "tw_mid-tw_strait_n", "tw_strait_n-ecs", "ecs-shanghai_off",
    "shanghai_off-yellow", "ecs-yellow", "yellow-taean_off", "yellow-bohai_strait", "bohai_strait-bohai",
    "ecs-jeju_s", "yellow-jeju_s", "jeju_s-korea_strait", "korea_strait-ulsan_off",
    // Indian Ocean & Cape of Good Hope
    "sumatra_n-io_n", "srilanka_s-io_n", "io_n-io_c", "io_c-mada_e", "somalia_e-mada_ne", "mada_ne-mada_e", "mada_e-mada_s",
    "mada_s-durban_off", "durban_off-agulhas", "agulhas-cape", "cape-namibia", "namibia-angola", "angola-gulf_guinea",
    "gulf_guinea-ivory", "ivory-liberia", "liberia-senegal_w", "senegal_w-canaries_w", "canaries_w-madeira_e",
    "madeira_e-st_vincent", "madeira_e-portugal",
    // North Atlantic
    "ushant-atl_ne", "biscay_w-atl_ne", "atl_ne-atl_c", "atl_n-atl_c", "atl_c-us_ne", "finisterre-atl_ne",
  ];

  // Heavy-lift voyages between Asia/the Gulf and Europe have been routed round the Cape of Good Hope
  // since the Red Sea security problems began, so the Suez route only wins when nothing else exists.
  const AVOID = { "port_said-suez": 20000 };

  const node = new Map(NODES.map(([id, lat, lon]) => [id, { id, lat, lon }]));
  const adj = new Map(NODES.map(([id]) => [id, []]));

  function km(a, b) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  for (const e of EDGES) {
    const [a, b] = e.split("-");
    if (!node.has(a) || !node.has(b)) throw new Error(`sea.js: bad edge ${e}`);
    const d = km(node.get(a), node.get(b));
    const cost = d + (AVOID[e] || AVOID[`${b}-${a}`] || 0);
    adj.get(a).push({ to: b, d, cost });
    adj.get(b).push({ to: a, d, cost });
  }

  function nearest(p) {
    let best = null, bd = Infinity;
    for (const n of node.values()) {
      const d = km(p, n);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  function shortest(fromId, toId) {
    const dist = new Map([[fromId, 0]]), prev = new Map(), done = new Set();
    while (true) {
      let u = null, ud = Infinity;
      for (const [k, v] of dist) if (!done.has(k) && v < ud) { u = k; ud = v; }
      if (u === null || u === toId) break;
      done.add(u);
      for (const { to, cost } of adj.get(u)) {
        const nd = ud + cost;
        if (nd < (dist.get(to) ?? Infinity)) { dist.set(to, nd); prev.set(to, u); }
      }
    }
    const path = [toId];
    while (path[0] !== fromId) {
      const p = prev.get(path[0]);
      if (!p) return null;
      path.unshift(p);
    }
    return path;
  }

  const VIA = [
    ["cape", "Cape of Good Hope"], ["suez", "Suez Canal"], ["malacca_mid", "Strait of Malacca"],
    ["gibraltar", "Strait of Gibraltar"], ["dover", "English Channel"], ["belt_n", "Great Belt (Denmark)"],
    ["hormuz", "Strait of Hormuz"], ["fair_isle", "north of Scotland"],
  ];

  /**
   * Route through a list of stops ({lat, lon}). Returns {legs: [[[lat,lon],...], ...], km, via: [...]}
   * Each leg runs stop -> nearest sea waypoint -> ... -> nearest sea waypoint -> next stop.
   */
  function route(stops) {
    const legs = [];
    let total = 0;
    const via = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      const na = nearest(a), nb = nearest(b);
      const ids = na.id === nb.id ? [na.id] : shortest(na.id, nb.id) || [na.id, nb.id];
      const pts = [a, ...ids.map((id) => node.get(id)), b];
      // Short hops within one sea area: go straight rather than via a waypoint behind the destination.
      const direct = km(a, b);
      const leg = direct < 150 ? [a, b] : pts;
      for (let j = 0; j < leg.length - 1; j++) total += km(leg[j], leg[j + 1]);
      for (const [id, label] of VIA) if (ids.includes(id) && !via.includes(label)) via.push(label);
      legs.push(leg.map((p) => [p.lat, p.lon]));
    }
    return { legs, km: total, via };
  }

  window.SeaRoute = { route };
})();
