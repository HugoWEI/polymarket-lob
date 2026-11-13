/* Dashboard: loads recorded hours (or a live websocket), replays the book, draws the statistics. */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
  const GAMMA = "https://gamma-api.polymarket.com";
  const DEFAULT_BASE = "https://storage.googleapis.com/hugowei-polymarket-lob"; // "sample" = synthetic data
  const HEADER = "recv_ns,ts_ms,event,side,price,size,best_bid,best_ask,hash";

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  const S = {
    base: (new URLSearchParams(location.search).get("data") || store.get("lob-base") || DEFAULT_BASE).replace(/\/$/, ""),
    index: null, mode: "rec", segs: [], groups: [], raw: [], tz: "local",
    live: { ws: null, rows: [], raw: [], timer: null, hb: null },
  };

  // ------------------------------------------------------------- helpers ----
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const status = (t) => { $("status").textContent = t; };
  const pad = (n) => String(n).padStart(2, "0");
  function shifted(ms) { return S.tz === "utc" ? new Date(ms) : new Date(ms - new Date(ms).getTimezoneOffset() * 60000); }
  const tstr = (ms) => shifted(ms).toISOString().replace("T", " ").slice(0, 23);
  const hourOf = (ms) => shifted(ms).getUTCHours();
  const dayOf = (ms) => shifted(ms).toISOString().slice(0, 10);
  function fmt(x, d) {
    if (x == null || !Number.isFinite(x)) return "–";
    const a = Math.abs(x);
    if (a >= 1e6) return (x / 1e6).toFixed(2) + "M";
    if (a >= 1e4) return (x / 1e3).toFixed(1) + "k";
    return x.toLocaleString("en-US", { maximumFractionDigits: d == null ? (a < 1 ? 4 : 2) : d });
  }
  function thin(n, max) { const st = Math.max(1, Math.ceil(n / max)), ix = []; for (let i = 0; i < n; i += st) ix.push(i); return ix; }

  function plot(id, traces, layout) {
    const C = { text: css("--text"), text2: css("--text2"), grid: css("--grid"), line: css("--line") };
    const ax = { gridcolor: C.grid, linecolor: C.line, zerolinecolor: C.line, tickfont: { size: 11, color: C.text2 },
                 title: { font: { size: 11.5, color: C.text2 }, standoff: 6 }, automargin: true };
    const L = Object.assign({
      margin: { l: 48, r: 14, t: 8, b: 36 }, paper_bgcolor: "rgba(0,0,0,0)", plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "ui-sans-serif, system-ui, sans-serif", color: C.text, size: 12 },
      showlegend: traces.filter((t) => t.showlegend !== false).length > 1,
      legend: { orientation: "h", y: 1.02, yanchor: "bottom", x: 0, font: { size: 11.5, color: C.text2 } },
      hoverlabel: { font: { size: 12 } }, hovermode: "closest",
    }, layout || {});
    L.xaxis = Object.assign({}, ax, (layout && layout.xaxis) || {});
    L.yaxis = Object.assign({}, ax, (layout && layout.yaxis) || {});
    if (L.xaxis.title && typeof L.xaxis.title === "string") L.xaxis.title = Object.assign({ text: L.xaxis.title }, ax.title);
    if (L.yaxis.title && typeof L.yaxis.title === "string") L.yaxis.title = Object.assign({ text: L.yaxis.title }, ax.title);
    if (L.showlegend) L.margin = Object.assign({}, L.margin, { t: 30 });
    Plotly.react(id, traces, L, { displayModeBar: false, responsive: true });
  }
  const empty = (id, msg) => plot(id, [], { annotations: [{ text: msg || "Not enough data", showarrow: false, font: { color: css("--muted") } }],
                                            xaxis: { visible: false }, yaxis: { visible: false } });

  // -------------------------------------------------------- recorded data ---
  async function loadIndex() {
    $("banner").style.display = S.base === "sample" ? "block" : "none";
    $("banner").textContent = "Showing synthetic sample data, simulated to test the dashboard. Use Data source to point at your recorder's bucket.";
    try {
      const r = await fetch(`${S.base}/index.json`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      S.index = await r.json();
    } catch (e) {
      S.index = null;
      status(`Could not read ${S.base}/index.json (${e.message}). Check the data source.`);
      return;
    }
    // markets still being recorded first, then by amount of data
    const stat = (n) => { const h = S.index.markets[n].hours, d = Object.keys(h).sort(), l = d[d.length - 1] || "";
                          return [l + "/" + pad(l ? Math.max(...h[l]) : 0), d.reduce((a, k) => a + h[k].length, 0)]; };
    const names = Object.keys(S.index.markets).sort((a, b) => { const x = stat(a), y = stat(b);
      return x[0] === y[0] ? y[1] - x[1] : x[0] < y[0] ? 1 : -1; });
    $("market").innerHTML = names.map((n) => `<option value="${n}">${n}</option>`).join("");
    const want = new URLSearchParams(location.search).get("market");
    if (want && names.includes(want)) $("market").value = want;
    fillDates();
    status(`Data source: ${S.base} · last recorder update ${S.index.updated || "unknown"}`);
    if (names.length) loadSelection();
  }

  // every recorded UTC hour of the selected market, with its local-day/hour
  function availableHours() {
    const m = S.index.markets[$("market").value], out = [];
    for (const day of Object.keys(m.hours).sort()) for (const h of m.hours[day]) {
      const ms = Date.parse(`${day}T${pad(h)}:00:00Z`);
      out.push({ ms, path: `${day}/${pad(h)}.csv`, day: dayOf(ms), hour: hourOf(ms) });
    }
    return out;
  }
  function fillDates() {
    if (!S.index) return;
    const m = S.index.markets[$("market").value];
    $("question").textContent = m.question ? `${m.question}${m.outcome ? " · " + m.outcome : ""}` : $("market").value;
    $("token").value = $("token").value || m.asset_id || "";
    const days = [...new Set(availableHours().map((h) => h.day))];
    const opts = days.map((d) => `<option>${d}</option>`).join("");
    $("d0").innerHTML = opts; $("d1").innerHTML = opts;
    $("d0").value = days[Math.max(0, days.length - 3)]; $("d1").value = days[days.length - 1];
  }

  async function loadSelection() {
    if (!S.index) return;
    const d0 = $("d0").value, d1 = $("d1").value, h0 = +$("h0").value, h1 = +$("h1").value;
    const inHours = (h) => (h0 < h1 ? h >= h0 && h < h1 : h >= h0 || h < h1); // allows ranges across midnight
    const files = availableHours().filter((f) => f.day >= d0 && f.day <= d1 && inHours(f.hour));
    if (!files.length) { status("No recorded hours in that selection."); return; }
    if (files.length > 96 && !confirmLarge(files.length)) return;
    $("load").disabled = true;
    status(`Loading ${files.length} hourly file(s)…`);
    const slug = $("market").value;
    try {
      const texts = await Promise.all(files.map((f) =>
        fetch(`${S.base}/${slug}/${f.path}`, { cache: "no-store" }).then((r) => { if (!r.ok) throw new Error(`${f.path}: HTTP ${r.status}`); return r.text(); })));
      // consecutive hours form one contiguous segment
      const groups = [];
      files.forEach((f, i) => {
        const g = groups[groups.length - 1];
        if (g && f.ms - g.last === 3600000) { g.rows = g.rows.concat(LOB.parseCSV(texts[i])); g.last = f.ms; }
        else groups.push({ start: f.ms, last: f.ms, rows: LOB.parseCSV(texts[i]) });
      });
      S.raw = [];
      S.groups = groups.filter((g) => g.rows.length);
      for (const g of S.groups) { for (const r of g.rows) S.raw.push(r.raw);
        g.label = `${tstr(g.start).slice(0, 16)} → ${tstr(g.last + 3600000).slice(11, 16)}`; }
      replayAll();
      const n = S.raw.length;
      status(`Loaded ${fmt(n, 0)} rows from ${files.length} hour(s) in ${S.segs.length} window(s) · ${S.base}`);
      fillSegs(); renderAll();
    } catch (e) { status(`Load failed: ${e.message}`); }
    $("load").disabled = false;
  }
  function replayAll() {
    const groupFills = $("grp").value === "1";
    S.segs = S.groups.map((g) => { const s = LOB.replaySegment(g.rows, { groupFills }); s.label = g.label; return s; });
  }
  function confirmLarge(n) { status(`That selection is ${n} hourly files. Narrow the dates or hours (limit 96).`); return false; }

  function fillSegs() {
    $("segsel").innerHTML = S.segs.map((s, i) => `<option value="${i}">${s.label}</option>`).join("");
    $("segsel").value = String(S.segs.length - 1);
    $("export").disabled = !S.raw.length;
  }

  // --------------------------------------------------------------- render ---
  function renderAll() {
    if (!S.segs.length) return;
    renderKpis(); renderBook(); renderFlow(); renderEvent();
    S.btDirty = true;
    if (!$("tab-bt").classList.contains("hide")) setTimeout(renderBacktest, 30);
    // the Hawkes fit is the slow part: let the page paint first
    setTimeout(renderArrivals, 20);
  }

  function renderKpis(h) {
    let trades = 0, vol = 0, upd = 0, secs = 0, sp = 0, gn = 0, fills = 0;
    for (const s of S.segs) {
      fills += s.fills;
      trades += s.trades.t.length; upd += s.updates.t.length; secs += (s.t1 - s.t0) / 1000;
      for (const v of s.trades.s) vol += v;
      for (const v of s.grid.spread) { sp += v; gn++; }
    }
    const items = [
      ["Book updates", fmt(upd, 0)], [fills > trades * 1.01 ? `Trades (${fmt(fills, 0)} fills)` : "Trades", fmt(trades, 0)], ["Traded size", fmt(vol)],
      ["Trades per minute", fmt(secs ? (trades / secs) * 60 : NaN, 2)], ["Mean spread", fmt(gn ? sp / gn : NaN, 4)],
      ["Hours loaded", fmt(secs / 3600, 1)],
    ];
    $("kpis").innerHTML = items.map(([l, v]) => `<div class="kpi"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
  }

  function renderBook() {
    const s = S.segs[+$("segsel").value || 0];
    if (!s) return;
    const g = s.grid, ix = thin(g.t.length, 3000), T = ix.map((i) => tstr(g.t[i]));
    const bid = css("--bid"), ask = css("--ask"), ink = css("--ink");
    if (!g.t.length) { ["p-price", "p-spread", "p-imb", "p-heat", "p-depth"].forEach((p) => empty(p)); return; }
    const ti = thin(s.trades.t.length, 2500);
    plot("p-price", [
      { x: T, y: ix.map((i) => g.ask[i]), name: "Best ask", mode: "lines", line: { color: ask, width: 2, shape: "hv" } },
      { x: T, y: ix.map((i) => g.bid[i]), name: "Best bid", mode: "lines", line: { color: bid, width: 2, shape: "hv" } },
      { x: ti.map((i) => tstr(s.trades.t[i])), y: ti.map((i) => s.trades.p[i]), name: "Trades", mode: "markers",
        marker: { color: ink, size: 4, opacity: 0.55 }, text: ti.map((i) => `size ${fmt(s.trades.s[i])} · ${s.trades.sign[i] > 0 ? "buy" : "sell"}`),
        hovertemplate: "%{x}<br>%{y}<br>%{text}<extra>Trade</extra>" },
    ], { yaxis: { title: "Price" }, hovermode: "x unified" });

    plot("p-spread", [{ x: T, y: ix.map((i) => g.spread[i]), mode: "lines", line: { color: ink, width: 1.5, shape: "hv" }, name: "Spread" }],
         { yaxis: { title: "Spread", rangemode: "tozero" } });
    $("s-spread").textContent = `Mean ${fmt(LOB.mean(g.spread), 4)} in this window`;
    plot("p-imb", [{ x: T, y: ix.map((i) => g.imb5[i]), mode: "lines", line: { color: ink, width: 1 }, name: "Imbalance" }],
         { yaxis: { range: [-1.05, 1.05], title: "Imbalance" } });

    // depth
    const cum = (lv) => { let c = 0; return lv.map(([p, q]) => [p, (c += q)]); };
    const mid = g.mid[g.mid.length - 1], near = (lv) => lv.filter(([p]) => Math.abs(p - mid) <= 0.15);
    const cb = cum(near(s.book.bids)), ca = cum(near(s.book.asks));
    if (!cb.length && !ca.length) empty("p-depth", "The book is empty at the end of this window");
    else plot("p-depth", [
      { x: cb.map((v) => v[0]), y: cb.map((v) => v[1]), name: "Bids", mode: "lines", fill: "tozeroy", line: { color: bid, width: 2, shape: "vh" }, fillcolor: bid + "33" },
      { x: ca.map((v) => v[0]), y: ca.map((v) => v[1]), name: "Asks", mode: "lines", fill: "tozeroy", line: { color: ask, width: 2, shape: "vh" }, fillcolor: ask + "33" },
    ], { xaxis: { title: "Price" }, yaxis: { title: "Cumulative size" } });

    $("s-heat").textContent = `${matchMedia("(prefers-color-scheme: dark)").matches ? "Brighter" : "Darker"} means more size at that level`;
    // heatmap of resting size
    const H = s.heat;
    if (H.t.length > 1) {
      let lo = Infinity, hi = -Infinity;
      for (const b of H.books) { if (b.mid < lo) lo = b.mid; if (b.mid > hi) hi = b.mid; }
      const keys = new Set();
      const span = Math.max(600, (hi - lo) * 0.5);
      for (const b of H.books) for (const side of [b.bids, b.asks]) for (const [k] of side) if (k >= lo - span && k <= hi + span) keys.add(k);
      const ks = [...keys].sort((a, b) => a - b), pos = new Map(ks.map((k, i) => [k, i]));
      const z = ks.map(() => new Array(H.t.length).fill(null)), all = [];
      H.books.forEach((b, j) => { for (const side of [b.bids, b.asks]) for (const [k, q] of side) { const i = pos.get(k); if (i != null) { z[i][j] = q; all.push(q); } } });
      all.sort((a, b) => a - b);
      plot("p-heat", [{ type: "heatmap", x: H.t.map(tstr), y: ks.map((k) => k / 1e4), z, zmin: 0, zmax: all[Math.floor(all.length * 0.97)] || 1,
                        colorscale: [[0, css("--seq-lo")], [1, css("--seq-hi")]], hoverongaps: false,
                        colorbar: { thickness: 10, len: 0.9, tickfont: { size: 10, color: css("--text2") }, outlinewidth: 0 },
                        hovertemplate: "%{x}<br>price %{y}<br>size %{z:,.0f}<extra></extra>" }],
           { yaxis: { title: "Price" }, margin: { l: 48, r: 4, t: 8, b: 36 } });
    } else empty("p-heat");
  }

  function renderArrivals() {
    const key = $("proc").value, bid = css("--bid"), ask = css("--ask"), ink = css("--ink");
    const prep = LOB.prepareTimes(S.segs.map((s) => ({ t0: s.t0, t1: s.t1, t: s[key].t })));
    const n = prep.reduce((a, s) => a + s.t.length, 0);
    if (n < 50) { $("fit-table").innerHTML = `<p class="note">Only ${n} events in this selection; at least 50 are needed to fit.</p>`;
                  ["p-surv", "p-qqp", "p-qqh", "p-hrate", "p-hspread"].forEach((p) => empty(p)); return; }
    const po = LOB.poissonFit(prep);
    const hk = n <= 400000 ? LOB.hawkesFit(prep) : null;
    const pv = (p) => (p < 1e-4 ? "< 0.0001" : p.toFixed(4));
    $("fit-table").innerHTML = `<table>
      <tr><th>Model</th><th>Events</th><th>Baseline rate /s</th><th>Branching ratio</th><th>Decay /s</th><th>Half-life s</th><th>KS distance</th><th>KS p-value</th><th>AIC</th></tr>
      <tr><td>Poisson</td><td>${fmt(po.n, 0)}</td><td>${fmt(po.rate, 4)}</td><td>–</td><td>–</td><td>–</td><td>${po.ks.d.toFixed(4)}</td><td>${pv(po.ks.p)}</td><td>${fmt(hk ? hk.aicPoisson : 2 - 2 * po.loglik, 0)}</td></tr>
      ${hk ? `<tr><td>Hawkes, exponential kernel</td><td>${fmt(po.n, 0)}</td><td>${fmt(hk.mu, 4)}</td><td>${hk.n.toFixed(3)}</td><td>${fmt(hk.beta, 3)}</td><td>${fmt(hk.halfLife, 2)}</td><td>${hk.ks.d.toFixed(4)}</td><td>${pv(hk.ks.p)}</td><td>${fmt(hk.aic, 0)}</td></tr>`
           : `<tr><td>Hawkes</td><td colspan="8" style="text-align:left">Skipped: more than 400,000 events. Narrow the selection.</td></tr>`}
    </table>`;

    // survival function of the gaps
    const dt = Float64Array.from(po.dt).sort(), ix = thin(dt.length, 500);
    const sx = ix.map((i) => dt[i]), sy = ix.map((i) => 1 - i / dt.length);
    plot("p-surv", [
      { x: sx, y: sy, name: "Observed", mode: "lines", line: { color: bid, width: 2 } },
      { x: sx, y: sx.map((x) => Math.exp(-po.rate * x)), name: "Poisson fit", mode: "lines", line: { color: ask, width: 2, dash: "dash" } },
    ], { xaxis: { title: "Gap between events, seconds" }, yaxis: { type: "log", title: "Share of gaps longer", range: [Math.log10(1 / dt.length), 0] } });

    const qq = (id, q, lab) => {
      const m = Math.max(q.th[q.th.length - 1], q.em[q.em.length - 1]);
      plot(id, [
        { x: q.th, y: q.em, name: "Quantiles", mode: "markers", marker: { color: bid, size: 5, opacity: 0.8 } },
        { x: [0, m], y: [0, m], name: "Perfect fit", mode: "lines", line: { color: ink, width: 1, dash: "dot" }, hoverinfo: "skip" },
      ], { xaxis: { title: "Model quantile" }, yaxis: { title: lab } });
    };
    qq("p-qqp", po.qq, "Observed gap, seconds");
    if (hk) qq("p-qqh", hk.qq, "Observed residual"); else empty("p-qqh", "Hawkes fit skipped");

    const hp = LOB.hourlyProfile(S.segs, key, hourOf), hrs = [...Array(24).keys()];
    const bar = (id, y, lab) => plot(id, [{ type: "bar", x: hrs, y, marker: { color: bid, line: { width: 0 } }, name: lab,
                                            hovertemplate: "%{x}:00<br>%{y:.4g}<extra></extra>" }],
                                      { bargap: 0.25, xaxis: { title: `Hour of day (${S.tz === "utc" ? "UTC" : "local"})`, dtick: 2, range: [-0.6, 23.6] }, yaxis: { title: lab, rangemode: "tozero" } });
    bar("p-hrate", hp.rate, "Events per minute"); bar("p-hspread", hp.spread, "Mean spread");
  }

  function renderFlow() {
    const bid = css("--bid"), ask = css("--ask"), ink = css("--ink"), grids = S.segs.map((s) => s.grid);
    const ns = LOB.nextStep(grids, $("imbkey").value);
    if (ns.total >= 1) {
      plot("p-step", [
        { type: "bar", x: ns.x, y: ns.pUp, marker: { color: bid }, name: "Share up", customdata: ns.steps,
          error_y: { type: "data", array: ns.se.map((v) => 1.96 * v), color: ink, thickness: 1, width: 3 },
          hovertemplate: "imbalance %{x:.2f}<br>next step up %{y:.0%}<br>%{customdata} price steps<extra></extra>" },
        { x: [-1.05, 1.05], y: [0.5, 0.5], mode: "lines", line: { color: ink, width: 1, dash: "dash" }, showlegend: false, hoverinfo: "skip" },
      ], { bargap: 0.2, xaxis: { title: "Imbalance now", range: [-1.05, 1.05] }, yaxis: { title: "Share of next steps that go up", range: [0, 1.05], tickformat: ".0%" } });
      plot("p-wait", [{ type: "bar", x: ns.x, y: ns.wait, marker: { color: bid }, name: "Median wait",
                        hovertemplate: "imbalance %{x:.2f}<br>median wait %{y:,.0f}s<extra></extra>" }],
           { bargap: 0.2, xaxis: { title: "Imbalance now", range: [-1.05, 1.05] }, yaxis: { title: "Seconds", rangemode: "tozero" } });
    } else { empty("p-step", "No price step in this selection"); empty("p-wait", "No price step in this selection"); }
    $("s-step").textContent = `${ns.total} price step${ns.total === 1 ? "" : "s"} in the selection (${ns.ups} up)` +
      (ns.oneTickShare != null ? ` · spread one tick wide ${(ns.oneTickShare * 100).toFixed(0)}% of the time` : "") +
      (ns.total < 30 ? " · too few steps to conclude" : "");
    const h = +$("hor").value, ir = LOB.imbalanceResponse(grids, h, $("imbkey").value);
    plot("p-imbresp", [{ type: "bar", x: ir.x, y: ir.y, marker: { color: bid }, name: "Mean move",
                         error_y: { type: "data", array: ir.se.map((v) => 1.96 * v), color: ink, thickness: 1, width: 3 },
                         customdata: ir.n, hovertemplate: "imbalance %{x:.1f}<br>mean move %{y:.5f}<br>%{customdata} samples<extra></extra>" }],
         { bargap: 0.2, xaxis: { title: "Imbalance now", range: [-1.05, 1.05] }, yaxis: { title: `Mid change after ${h}s` } });
    $("s-imb").textContent = `Average mid change ${h} seconds later, by imbalance bucket; bars show 95% intervals`;

    const fr = LOB.flowVsReturn(S.segs, 30), fi = thin(fr.x.length, 3000);
    if (fr.x.length > 5) {
      const x0 = Math.min(...fr.x), x1 = Math.max(...fr.x);
      plot("p-flowret", [
        { x: fi.map((i) => fr.x[i]), y: fi.map((i) => fr.y[i]), mode: "markers", name: "30s windows", marker: { color: bid, size: 5, opacity: 0.45 } },
        { x: [x0, x1], y: [fr.intercept + fr.slope * x0, fr.intercept + fr.slope * x1], mode: "lines", name: "Linear fit", line: { color: ask, width: 2 } },
      ], { xaxis: { title: "Buy size − sell size in window" }, yaxis: { title: "Mid change in window" } });
      $("s-flow").textContent = `30-second windows · R² ${fr.r2.toFixed(3)} · slope ${fr.slope.toExponential(2)} per unit size`;
    } else empty("p-flowret");

    const sizes = [], signs = [];
    for (const s of S.segs) { for (const v of s.trades.s) sizes.push(v); for (const v of s.trades.sign) signs.push(v); }
    if (sizes.length > 20) {
      const c = LOB.ccdf(sizes);
      plot("p-size", [{ x: c.x, y: c.y, mode: "lines", line: { color: bid, width: 2 }, name: "Observed" }],
           { xaxis: { type: "log", title: "Trade size" }, yaxis: { type: "log", title: "Share of trades larger" } });
      $("s-size").textContent = `Tail exponent ${fmt(c.hill, 2)} (Hill estimate, largest 10% of trades)`;
      const a = LOB.acf(signs, 40), lags = a.acf.map((_, i) => i + 1);
      plot("p-acf", [
        { type: "bar", x: lags, y: a.acf, marker: { color: bid }, name: "Autocorrelation" },
        { x: [0, 41], y: [a.band, a.band], mode: "lines", line: { color: ink, width: 1, dash: "dash" }, showlegend: false, hoverinfo: "skip" },
        { x: [0, 41], y: [-a.band, -a.band], mode: "lines", line: { color: ink, width: 1, dash: "dash" }, showlegend: false, hoverinfo: "skip" },
      ], { bargap: 0.3, xaxis: { title: "Lag, trades" }, yaxis: { title: "Autocorrelation" } });
    } else { empty("p-size"); empty("p-acf"); $("s-size").textContent = ""; }

    const lags = [1, 2, 5, 10, 30, 60, 120, 300], sig = LOB.signature(grids, lags);
    plot("p-sig", [{ x: lags, y: sig, mode: "lines+markers", line: { color: bid, width: 2 }, marker: { size: 8 }, name: "Volatility" }],
         { xaxis: { type: "log", title: "Sampling interval, seconds" }, yaxis: { title: "Volatility per √s", rangemode: "tozero" } });
  }

  // ---------------------------------------------------------------- event ---
  function parseEv() {
    const v = $("evtime").value;
    if (!v) return null;
    return S.tz === "utc" ? Date.parse(v + "Z") : new Date(v).getTime();
  }
  function setEv(ms) { $("evtime").value = tstr(ms).slice(0, 19).replace(" ", "T"); }
  function findEvent() {
    const ev = LOB.detectEvent(S.segs);
    if (ev) setEv(ev.t);
    return ev;
  }
  function renderEvent(keep) {
    const ids = ["p-evprice", "p-evcost", "p-evact", "p-evflow", "p-evimb"];
    if (!S.segs.length) return;
    if (keep !== true || parseEv() == null) findEvent();
    const e = parseEv(), W = +$("evwin").value * 60000;
    const si = S.segs.findIndex((s) => e >= s.t0 && e <= s.t1);
    if (e == null || si < 0) { $("ev-table").innerHTML = `<p class="note">That time is outside the loaded data.</p>`; ids.forEach((p) => empty(p)); return; }
    const s = S.segs[si], a = Math.max(s.t0, e - W), b = Math.min(s.t1, e + W);
    const bid = css("--bid"), ask = css("--ask"), third = css("--third"), ink = css("--ink");
    const line = { shapes: [{ type: "line", xref: "x", yref: "paper", x0: tstr(e), x1: tstr(e), y0: 0, y1: 1, line: { color: ink, width: 1.5, dash: "dot" } }] };

    const B = LOB.windowStats(s, a, e), A = LOB.windowStats(s, e, b);
    const row = (l, f) => `<tr><td>${l}</td><td>${f(B)}</td><td>${f(A)}</td></tr>`;
    $("ev-table").innerHTML = `<table>
      <tr><th>Measure</th><th>Before (${fmt((e - a) / 60000, 0)} min)</th><th>After (${fmt((b - e) / 60000, 0)} min)</th></tr>
      ${row("Mid price, start → end", (x) => `${fmt(x.midStart, 3)} → ${fmt(x.midEnd, 3)}`)}
      ${row("Trades per minute", (x) => fmt(x.tradesPerMin, 2))}
      ${row("Traded size", (x) => fmt(x.size))}
      ${row("Net buying (buy − sell size)", (x) => fmt(x.net))}
      ${row("Buy trades / sell trades", (x) => `${fmt(x.buys, 0)} / ${fmt(x.sells, 0)}`)}
      ${row("Largest buy trade", (x) => fmt(x.largestBuy))}
      ${row("Share of buying from the 5 largest buys", (x) => (x.top5BuyShare == null ? "–" : (x.top5BuyShare * 100).toFixed(0) + "%"))}
      ${row("Ask size bought / cancelled / added", (x) => `${fmt(x.bought)} / ${fmt(x.askCxl)} / ${fmt(x.askAdd)}`)}
      ${row("Bid size sold into / cancelled / added", (x) => `${fmt(x.sold)} / ${fmt(x.bidCxl)} / ${fmt(x.bidAdd)}`)}
      ${row("Book updates per minute", (x) => fmt(x.updatesPerMin, 1))}
      ${row("Mean spread", (x) => fmt(x.spread, 4))}
      ${row("Mean imbalance, top 5 levels", (x) => fmt(x.imb, 2))}
      ${row("Mid volatility per √second", (x) => fmt(x.vol, 5))}
    </table>`;

    const g = s.grid, gi = [];
    for (let i = 0; i < g.t.length; i++) if (g.t[i] >= a && g.t[i] <= b) gi.push(i);
    if (!gi.length) { ids.forEach((p) => empty(p)); return; }
    const ix = thin(gi.length, 3000).map((k) => gi[k]), T = ix.map((i) => tstr(g.t[i]));
    const tr = [];
    for (let i = 0; i < s.trades.t.length; i++) if (s.trades.t[i] >= a && s.trades.t[i] <= b) tr.push(i);
    const ti = thin(tr.length, 2500).map((k) => tr[k]);
    plot("p-evprice", [
      { x: T, y: ix.map((i) => g.ask[i]), name: "Best ask", mode: "lines", line: { color: ask, width: 2, shape: "hv" } },
      { x: T, y: ix.map((i) => g.bid[i]), name: "Best bid", mode: "lines", line: { color: bid, width: 2, shape: "hv" } },
      { x: ti.map((i) => tstr(s.trades.t[i])), y: ti.map((i) => s.trades.p[i]), name: "Trades", mode: "markers", marker: { color: ink, size: 4, opacity: 0.55 } },
    ], Object.assign({ yaxis: { title: "Price" }, hovermode: "x unified" }, line));

    // cost to buy, from the event onwards
    const sizes = [100, 1000, 10000], step = Math.max(1000, Math.round((b - e) / 600 / 1000) * 1000);
    const sw = LOB.sweepSeries(S.groups[si].rows, e - Math.min(W, 10 * 60000), b, step, sizes);
    const settle = A.midEnd, cols = [bid, ask, third];
    if (sw.t.length) {
      plot("p-evcost", sizes.map((q, k) => ({ x: sw.t.map(tstr), y: sw.cost[k], name: `${fmt(q, 0)} shares`, mode: "lines", connectgaps: false,
                                              line: { color: cols[k], width: 2, shape: "hv" } })),
           Object.assign({ yaxis: { title: "Average price paid" }, hovermode: "x unified" }, line));
      const at = (mins, k) => { const i = sw.t.findIndex((t) => t >= e + mins * 60000); return i < 0 ? null : sw.cost[k][i]; };
      const parts = [1, 5, 15].filter((m) => e + m * 60000 < b).map((m) => `${m} min after: ${fmt(at(m, 1), 3)}`);
      $("s-evcost").textContent = `Average price to buy by taking the asks. For 1,000 shares, ${parts.join(" · ") || "no data"}; mid at end of window ${fmt(settle, 3)}`;
    } else { empty("p-evcost"); $("s-evcost").textContent = ""; }

    // activity score: how unusual each minute is against the six hours before it
    const ac = LOB.activityScore(s), THR = 5, CAP = 60, names = ["Trades", "Book updates", "Traded size"];
    const ai = []; for (let i = 0; i < ac.t.length; i++) if (ac.t[i] >= a && ac.t[i] <= b) ai.push(i);
    if (ai.some((i) => ac.score[i] != null)) {
      plot("p-evact", names.map((nm, k) => ({ x: ai.map((i) => tstr(ac.t[i])), y: ai.map((i) => (ac.z[k][i] == null ? null : Math.min(CAP, ac.z[k][i]))),
                                              name: nm, mode: "lines", line: { color: cols[k], width: 2, shape: "hv" } }))
        .concat([{ x: [tstr(a), tstr(b)], y: [THR, THR], mode: "lines", line: { color: ink, width: 1, dash: "dash" }, showlegend: false, hoverinfo: "skip" }]),
        Object.assign({ yaxis: { title: "Deviations above normal", range: [-3, CAP + 3] }, hovermode: "x unified" }, line));
      const first = ai.find((i) => ac.t[i] < e && ac.score[i] != null && ac.score[i] > THR);
      let prior = 0, hrs = 0;
      for (let i = 0; i < ac.t.length && ac.t[i] < a; i++) if (ac.score[i] != null) { hrs += 1 / 60; if (ac.score[i] > THR) prior++; }
      $("s-evact").textContent = `Per minute, in standard deviations above the previous six hours (capped at ${CAP}); dashed line is the alert level of ${THR}. ` +
        (first != null ? `First alert before the event: ${tstr(ac.t[first]).slice(11, 16)}, ${fmt((e - ac.t[first]) / 60000, 0)} minutes ahead. ` : "No alert before the event in this window. ") +
        `The same alert fired in ${prior} of the ${fmt(hrs * 60, 0)} earlier minutes loaded.`;
    } else { empty("p-evact", "Needs at least 30 minutes of data before the window"); $("s-evact").textContent = ""; }

    let c = 0;
    plot("p-evflow", [{ x: tr.map((i) => tstr(s.trades.t[i])), y: tr.map((i) => (c += s.trades.sign[i] * s.trades.s[i])), mode: "lines", name: "Net buying",
                        line: { color: bid, width: 2, shape: "hv" } }],
         Object.assign({ yaxis: { title: "Cumulative buy − sell size" } }, line));
    plot("p-evimb", [{ x: T, y: ix.map((i) => g.imb5[i]), mode: "lines", line: { color: ink, width: 1 }, name: "Imbalance" }],
         Object.assign({ yaxis: { range: [-1.05, 1.05], title: "Imbalance" } }, line));
  }

  // ------------------------------------------------------------- backtest ---
  function renderBacktest() {
    if (!S.groups.length && !(S.mode === "live" && S.live.rows.length)) return;
    S.btDirty = false;
    const groups = S.mode === "live" ? [{ rows: S.live.rows }] : S.groups;
    const base = { size: +$("btsize").value, maxInv: +$("btinv").value, latency: +$("btlat").value,
                   feeBps: Math.max(0, +$("btfee").value || 0), sampleMs: 60000 };
    const th = +$("btth").value;
    if (base.size > base.maxInv) base.size = base.maxInv; // a quote cannot exceed the inventory limit
    const strat = [{ name: "Always quote", o: Object.assign({}, base, { theta: 2 }), color: css("--ask") },
                   { name: `Imbalance rule (±${th})`, o: Object.assign({}, base, { theta: th }), color: css("--bid") }];
    const hs = [1, 2, 5, 10, 30, 60, 300];
    let hours = 0;
    for (const s of S.segs) hours += (s.t1 - s.t0) / 3.6e6;
    for (const st of strat) {
      st.runs = groups.map((g) => LOB.backtestMM(g.rows, st.o));
      st.pnl = 0; st.fills = 0; st.shares = 0; st.maxInv = 0; st.dd = 0; st.fees = 0;
      st.t = []; st.cum = []; st.inv = [];
      let off = 0, mkN = hs.map(() => 0), mkD = hs.map(() => 0);
      for (const r of st.runs) {
        for (let i = 0; i < r.series.t.length; i++) { st.t.push(r.series.t[i]); st.cum.push(off + r.series.pnl[i]); st.inv.push(r.series.inv[i]); }
        if (r.series.t.length) { st.t.push(null); st.cum.push(null); st.inv.push(null); } // gap between windows
        st.dd = Math.max(st.dd, r.dd); off += r.pnl;
        st.fills += r.fills.t.length; st.shares += r.shares; st.maxInv = Math.max(st.maxInv, r.maxInv); st.fees += r.fees;
        LOB.markouts(r, hs).forEach((v, i) => { if (v != null) { mkN[i] += v * r.shares; mkD[i] += r.shares; } });
      }
      st.pnl = off;
      st.mark = mkN.map((v, i) => (mkD[i] ? v / mkD[i] : null));
    }
    const [A, B] = strat, c = (v) => (v == null ? "–" : (v * 100).toFixed(2) + "¢");
    const usd = (v) => (v == null || !Number.isFinite(v) ? "–" : (v < 0 ? "−$" : "$") + fmt(Math.abs(v), 2));
    const row = (l, f) => `<tr><td>${l}</td><td>${f(A)}</td><td>${f(B)}</td></tr>`;
    $("bt-table").innerHTML = `<table>
      <tr><th>Measure</th><th>${A.name}</th><th>${B.name}</th></tr>
      ${row("P&L", (x) => usd(x.pnl))}
      ${row("P&L per day", (x) => usd(hours ? (x.pnl / hours) * 24 : NaN))}
      ${row("Fills", (x) => fmt(x.fills, 0))}
      ${row("Shares traded", (x) => fmt(x.shares, 0))}
      ${row("P&L per share traded", (x) => c(x.shares ? x.pnl / x.shares : null))}
      ${row("Gain per share at fill vs 10 s later", (x) => `${c(x.mark[0])} → ${c(x.mark[3])}`)}
      ${row("Largest inventory, shares", (x) => fmt(x.maxInv, 0))}
      ${row("Largest drawdown", (x) => usd(x.dd))}
      ${row("Fees paid", (x) => usd(x.fees))}
    </table>`;
    const better = B.pnl > A.pnl, d = B.pnl - A.pnl;
    $("s-bt").textContent = `${fmt(hours, 1)} hours replayed. ` +
      (A.fills + B.fills === 0 ? "Neither strategy was filled. The quote may be too large to get past the size queued ahead; try a smaller quote size or a busier market."
        : `The imbalance rule ${better ? "added" : "cost"} ${usd(Math.abs(d))} against always quoting, ` +
          `trading ${fmt(B.shares, 0)} shares instead of ${fmt(A.shares, 0)}. ` +
          (A.mark[3] != null ? `Ten seconds after a fill, always-quote fills were worth ${c(A.mark[3])} a share and imbalance-rule fills ${c(B.mark[3])}.` : ""));

    const T = (st) => st.t.map((t) => (t == null ? null : tstr(t)));
    plot("p-btpnl", strat.map((st) => ({ x: T(st), y: st.cum, name: st.name, mode: "lines", line: { color: st.color, width: 2 }, connectgaps: false })),
         { yaxis: { title: "Dollars" }, hovermode: "x unified" });
    plot("p-btinv", strat.map((st) => ({ x: T(st), y: st.inv, name: st.name, mode: "lines", line: { color: st.color, width: 1.5, shape: "hv" }, connectgaps: false })),
         { yaxis: { title: "Shares" }, hovermode: "x unified" });
    plot("p-btmark", strat.map((st) => ({ x: hs, y: st.mark.map((v) => (v == null ? null : v * 100)), name: st.name, mode: "lines+markers",
                                          line: { color: st.color, width: 2 }, marker: { size: 8 } }))
         .concat([{ x: [hs[0], hs[hs.length - 1]], y: [0, 0], mode: "lines", line: { color: css("--ink"), width: 1, dash: "dash" }, showlegend: false, hoverinfo: "skip" }]),
         { xaxis: { type: "log", title: "Seconds after the fill" }, yaxis: { title: "Cents per share" } });
    // daily P&L from the sampled series
    const days = [...new Set(strat.flatMap((st) => st.t.filter((t) => t != null).map(dayOf)))].sort();
    const daily = (st) => { const end = {}, start = {};
      st.runs.forEach((r) => { let prevDay = null, carry = 0;
        for (let i = 0; i < r.series.t.length; i++) { const dy = dayOf(r.series.t[i]);
          if (dy !== prevDay) { start[dy] = (start[dy] || 0) + (i ? r.series.pnl[i - 1] : 0); if (prevDay) end[prevDay] = (end[prevDay] || 0) + r.series.pnl[i - 1]; prevDay = dy; } }
        if (prevDay) end[prevDay] = (end[prevDay] || 0) + r.series.pnl[r.series.pnl.length - 1]; });
      return days.map((dy) => (end[dy] || 0) - (start[dy] || 0)); };
    plot("p-btday", strat.map((st) => ({ type: "bar", x: days, y: daily(st), name: st.name, marker: { color: st.color } })),
         { barmode: "group", bargap: 0.3, yaxis: { title: "Dollars" }, xaxis: { type: "category" } });
  }

  // ----------------------------------------------------------------- live ---
  function liveRow(recvMs, ts, ev, side, p, s, bb, ba, h) {
    const raw = [String(Math.round(recvMs * 1e6)), String(ts || ""), ev, side || "", p == null ? "" : String(p), s == null ? "" : String(s), bb || "", ba || "", h || ""];
    S.live.raw.push(raw);
    S.live.rows.push({ recv: recvMs, t: ts ? +ts : recvMs, ev, side: side || "", p: p == null ? NaN : +p, s: s == null ? NaN : +s, raw });
  }
  function onLive(ev, token) {
    const now = Date.now(), ts = ev.timestamp;
    if (ev.event_type === "book" && ev.asset_id === token) {
      liveRow(now, ts, "snapshot", "", null, null, "", "", ev.hash);
      for (const l of ev.bids || []) liveRow(now, ts, "book", "BUY", l.price, l.size);
      for (const l of ev.asks || []) liveRow(now, ts, "book", "SELL", l.price, l.size);
    } else if (ev.event_type === "price_change") {
      for (const c of ev.price_changes || []) if (c.asset_id === token) liveRow(now, ts, "change", c.side, c.price, c.size, c.best_bid, c.best_ask, c.hash);
    } else if (ev.event_type === "last_trade_price" && ev.asset_id === token) liveRow(now, ts, "trade", ev.side, ev.price, ev.size, "", "", ev.transaction_hash);
    else if (ev.event_type === "tick_size_change" && ev.asset_id === token) liveRow(now, ts, "tick", "", ev.new_tick_size, ev.old_tick_size);
  }
  function liveRefresh() {
    const L = S.live;
    if (!L.rows.length) return;
    const s = LOB.replaySegment(L.rows, { groupFills: $("grp").value === "1" });
    s.label = `Live since ${tstr(L.rows[0].t).slice(11, 19)}`;
    S.segs = [s]; S.raw = L.raw;
    const first = !$("segsel").options.length || $("segsel").options[0].textContent !== s.label;
    if (first) fillSegs();
    $("export").disabled = false;
    status(`Live: ${fmt(L.rows.length, 0)} rows captured in this tab. Export CSV saves them; they are lost when the tab closes.`);
    renderAll();
  }
  function disconnect() {
    const L = S.live;
    if (L.ws) { L.ws.onclose = null; L.ws.close(); L.ws = null; }
    clearInterval(L.timer); clearInterval(L.hb);
    $("connect").textContent = "Connect";
  }
  function connect() {
    const L = S.live, token = $("token").value.trim();
    if (L.ws) { disconnect(); status("Disconnected."); return; }
    if (!/^\d{10,}$/.test(token)) { status("Enter a CLOB token id (a long number), or use Find most traded."); return; }
    L.rows = []; L.raw = []; $("segsel").innerHTML = "";
    status("Connecting to Polymarket…");
    const ws = (L.ws = new WebSocket(WS_URL));
    ws.onopen = () => {
      ws.send(JSON.stringify({ assets_ids: [token], type: "market" }));
      L.hb = setInterval(() => ws.readyState === 1 && ws.send("PING"), 10000);
      L.timer = setInterval(liveRefresh, 3000);
      $("connect").textContent = "Disconnect";
      status("Connected. Waiting for the first book snapshot…");
    };
    ws.onmessage = (m) => {
      if (m.data === "PONG") return;
      let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      for (const ev of Array.isArray(msg) ? msg : [msg]) if (ev && typeof ev === "object") onLive(ev, token);
    };
    ws.onerror = () => status("Websocket error: the connection to Polymarket was refused or blocked on this network.");
    ws.onclose = () => { disconnect(); status("Connection closed. Data captured so far is still shown."); };
  }
  async function findTop() {
    status("Looking up the most traded market…");
    try {
      const r = await fetch(`${GAMMA}/markets?active=true&closed=false&order=volume24hr&ascending=false&limit=1`);
      const m = (await r.json())[0];
      $("token").value = JSON.parse(m.clobTokenIds)[0];
      $("question").textContent = `${m.question} · ${JSON.parse(m.outcomes)[0]}`;
      status(`Most traded over 24h: ${m.question}. Press Connect.`);
    } catch (e) { status("The market lookup was blocked from this browser. Paste a token id instead (recorder.py prints them)."); }
  }

  // --------------------------------------------------------------- wiring ---
  function exportCSV() {
    const blob = new Blob([HEADER + "\n" + S.raw.map((r) => r.join(",")).join("\n") + "\n"], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `polymarket-${S.mode === "live" ? "live" : $("market").value}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }
  function setMode(m) {
    S.mode = m;
    document.querySelectorAll("#mode button").forEach((b) => b.classList.toggle("on", b.dataset.m === m));
    document.querySelectorAll(".rec").forEach((e) => e.classList.toggle("hide", m !== "rec"));
    document.querySelectorAll(".live").forEach((e) => e.classList.toggle("hide", m !== "live"));
    if (m === "rec") { disconnect(); if (S.index) loadSelection(); } else status("Live mode records in this tab only. Enter a token id and press Connect.");
  }
  function init() {
    const hs = [...Array(25).keys()];
    $("h0").innerHTML = hs.slice(0, 24).map((h) => `<option value="${h}">${pad(h)}:00</option>`).join("");
    $("h1").innerHTML = hs.slice(1).map((h) => `<option value="${h % 24}">${pad(h)}:00</option>`).join("");
    $("h0").value = "0"; $("h1").value = "0";
    $("tz").value = S.tz = store.get("lob-tz") || "local";
    document.querySelectorAll("#mode button").forEach((b) => (b.onclick = () => setMode(b.dataset.m)));
    document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => {
      document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
      ["book", "arr", "flow", "event", "bt"].forEach((t) => $("tab-" + t).classList.toggle("hide", t !== b.dataset.t));
      if (b.dataset.t === "bt" && S.btDirty) setTimeout(renderBacktest, 30);
      window.dispatchEvent(new Event("resize")); // plots drawn while hidden need a resize
    }));
    $("load").onclick = loadSelection;
    $("market").onchange = () => { fillDates(); loadSelection(); };
    $("tz").onchange = () => { S.tz = $("tz").value; store.set("lob-tz", S.tz); if (S.mode === "rec") { fillDates(); loadSelection(); } else renderAll(); };
    $("segsel").onchange = renderBook;
    $("grp").onchange = () => { if (S.mode === "rec" && S.groups.length) { replayAll(); renderAll(); } else if (S.mode === "live") liveRefresh(); };
    $("proc").onchange = renderArrivals;
    $("evtime").onchange = () => renderEvent(true); $("evwin").onchange = () => renderEvent(true);
    $("evfind").onclick = () => renderEvent(false);
    $("btrun").onclick = renderBacktest;
    $("hor").onchange = renderFlow; $("imbkey").onchange = renderFlow;
    $("export").onclick = exportCSV;
    $("connect").onclick = connect; $("findtop").onclick = findTop;
    $("source").onclick = () => {
      const v = window.prompt("Base URL of the recorded data (the folder holding index.json).\nFor a GCS bucket: https://storage.googleapis.com/YOUR_BUCKET\nUse 'sample' for the synthetic sample.", S.base);
      if (v) { S.base = v.trim().replace(/\/$/, ""); store.set("lob-base", S.base); loadIndex(); }
    };
    loadIndex();
  }
  init();
})();
