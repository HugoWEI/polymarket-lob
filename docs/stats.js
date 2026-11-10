/* Order book replay and statistics. Pure functions, no DOM: usable from Node for tests. */
(function (root) {
  "use strict";
  const K = 1e4; // prices are keyed as integer ten-thousandths

  // ---------------------------------------------------------------- parsing --
  // CSV columns: recv_ns, ts_ms, event, side, price, size, best_bid, best_ask, hash
  function parseCSV(text) {
    const rows = [];
    let i = text.indexOf("\n") + 1; // skip header
    const n = text.length;
    while (i < n) {
      let j = text.indexOf("\n", i);
      if (j < 0) j = n;
      if (j > i) {
        const f = text.slice(i, j).replace("\r", "").split(",");
        if (f.length >= 6) {
          const recvMs = Number(f[0].slice(0, -6) + "." + f[0].slice(-6));
          rows.push({ recv: recvMs, t: f[1] ? +f[1] : recvMs, ev: f[2], side: f[3],
                      p: f[4] === "" ? NaN : +f[4], s: f[5] === "" ? NaN : +f[5], raw: f });
        }
      }
      i = j + 1;
    }
    return rows;
  }

  // ----------------------------------------------------------------- replay --
  function bestOf(map, isBid) {
    let b = isBid ? -Infinity : Infinity;
    for (const k of map.keys()) if (isBid ? k > b : k < b) b = k;
    return b;
  }
  function topN(map, isBid, n) {
    const ks = Array.from(map.keys()).sort((a, b) => (isBid ? b - a : a - b)).slice(0, n);
    let s = 0;
    for (const k of ks) s += map.get(k);
    return s;
  }

  /* Replays one contiguous run of rows (must begin with a snapshot).
     Returns the event streams and the book state sampled on a 1-second grid. */
  function replaySegment(rows, opts) {
    opts = opts || {};
    const heatCols = opts.heatCols || 240;
    const bids = new Map(), asks = new Map();
    let bb = -Infinity, ba = Infinity, ready = false, loading = false;

    // trade times per price, for telling fills from cancels
    const tradeAt = new Map();
    for (const r of rows) if (r.ev === "trade") {
      const k = Math.round(r.p * K);
      if (!tradeAt.has(k)) tradeAt.set(k, []);
      tradeAt.get(k).push(r.t);
    }
    const nearTrade = (k, t) => {
      const a = tradeAt.get(k);
      if (!a) return false;
      let lo = 0, hi = a.length;
      while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < t - 250) lo = m + 1; else hi = m; }
      return lo < a.length && a[lo] <= t + 250;
    };

    const first = rows.find((r) => r.ev !== "snapshot" && r.ev !== "book");
    const t0 = rows.length ? rows[0].t : 0, t1 = rows.length ? rows[rows.length - 1].t : 0;
    const out = {
      t0, t1,
      trades: { t: [], p: [], s: [], sign: [] },
      adds: { t: [], s: [], side: [] },
      cancels: { t: [], s: [], side: [] },
      updates: { t: [] },
      grid: { t: [], bid: [], ask: [], mid: [], spread: [], imb1: [], imb5: [], micro: [] },
      heat: { t: [], books: [] },
      ticks: [],
    };
    let nextGrid = Math.ceil((first ? first.t : t0) / 1000) * 1000;
    const heatStep = Math.max(1000, Math.ceil((t1 - t0) / heatCols / 1000) * 1000);
    let nextHeat = nextGrid;

    function sample(t) {
      while (nextGrid <= t) {
        if (ready && bb > -Infinity && ba < Infinity && bb < ba) {
          const qb = bids.get(bb), qa = asks.get(ba);
          const b5 = topN(bids, true, 5), a5 = topN(asks, false, 5);
          const g = out.grid;
          g.t.push(nextGrid); g.bid.push(bb / K); g.ask.push(ba / K);
          g.mid.push((bb + ba) / 2 / K); g.spread.push((ba - bb) / K);
          g.imb1.push((qb - qa) / (qb + qa)); g.imb5.push((b5 - a5) / (b5 + a5));
          g.micro.push((bb * qa + ba * qb) / (qa + qb) / K);
          if (nextGrid >= nextHeat) {
            out.heat.t.push(nextGrid);
            out.heat.books.push({ bids: Array.from(bids), asks: Array.from(asks), mid: (bb + ba) / 2 });
            nextHeat = nextGrid + heatStep;
          }
        }
        nextGrid += 1000;
      }
    }

    for (const r of rows) {
      if (r.ev === "snapshot") { bids.clear(); asks.clear(); loading = true; ready = false; continue; }
      if (r.ev === "book") { (r.side === "BUY" ? bids : asks).set(Math.round(r.p * K), r.s); continue; }
      if (loading) { bb = bestOf(bids, true); ba = bestOf(asks, false); loading = false; ready = true; }
      sample(r.t);
      if (r.ev === "change") {
        const isBid = r.side === "BUY", book = isBid ? bids : asks, k = Math.round(r.p * K);
        const prev = book.get(k) || 0, d = r.s - prev;
        if (r.s === 0) book.delete(k); else book.set(k, r.s);
        if (isBid) { if (r.s > 0 && k > bb) bb = k; else if (r.s === 0 && k === bb) bb = bestOf(bids, true); }
        else { if (r.s > 0 && k < ba) ba = k; else if (r.s === 0 && k === ba) ba = bestOf(asks, false); }
        out.updates.t.push(r.t);
        if (d > 0) { out.adds.t.push(r.t); out.adds.s.push(d); out.adds.side.push(isBid ? 1 : -1); }
        else if (d < 0 && !nearTrade(k, r.t)) {
          out.cancels.t.push(r.t); out.cancels.s.push(-d); out.cancels.side.push(isBid ? 1 : -1);
        }
      } else if (r.ev === "trade") {
        out.trades.t.push(r.t); out.trades.p.push(r.p); out.trades.s.push(r.s);
        out.trades.sign.push(r.side === "BUY" ? 1 : -1);
      } else if (r.ev === "tick") out.ticks.push({ t: r.t, tick: r.p });
    }
    if (loading) { bb = bestOf(bids, true); ba = bestOf(asks, false); ready = true; }
    sample(t1);
    out.book = { bids: Array.from(bids).sort((a, b) => b[0] - a[0]).map(([k, s]) => [k / K, s]),
                 asks: Array.from(asks).sort((a, b) => a[0] - b[0]).map(([k, s]) => [k / K, s]) };
    return out;
  }

  // ------------------------------------------------------------- numerics ----
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);

  function nelderMead(f, x0, maxIter) {
    const n = x0.length;
    let sim = [x0.slice()];
    for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] += 0.5; sim.push(x); }
    let fv = sim.map(f);
    for (let it = 0; it < (maxIter || 400); it++) {
      const idx = fv.map((v, i) => i).sort((a, b) => fv[a] - fv[b]);
      sim = idx.map((i) => sim[i]); fv = idx.map((i) => fv[i]);
      if (Math.abs(fv[n] - fv[0]) < 1e-9 * (Math.abs(fv[0]) + 1e-9)) break;
      const c = new Array(n).fill(0);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += sim[i][j] / n;
      const at = (k) => c.map((v, j) => v + k * (sim[n][j] - v));
      const xr = at(-1), fr = f(xr);
      if (fr < fv[0]) { const xe = at(-2), fe = f(xe); if (fe < fr) { sim[n] = xe; fv[n] = fe; } else { sim[n] = xr; fv[n] = fr; } }
      else if (fr < fv[n - 1]) { sim[n] = xr; fv[n] = fr; }
      else {
        const xc = at(0.5), fc = f(xc);
        if (fc < fv[n]) { sim[n] = xc; fv[n] = fc; }
        else for (let i = 1; i <= n; i++) { sim[i] = sim[i].map((v, j) => sim[0][j] + 0.5 * (v - sim[0][j])); fv[i] = f(sim[i]); }
      }
    }
    let b = 0;
    for (let i = 1; i <= n; i++) if (fv[i] < fv[b]) b = i;
    return { x: sim[b], f: fv[b] };
  }

  // Kolmogorov-Smirnov test of `x` against a CDF
  function ksTest(x, cdf) {
    const s = Float64Array.from(x).sort(), n = s.length;
    let d = 0;
    for (let i = 0; i < n; i++) {
      const F = cdf(s[i]);
      d = Math.max(d, Math.abs(F - i / n), Math.abs((i + 1) / n - F));
    }
    const lam = (Math.sqrt(n) + 0.12 + 0.11 / Math.sqrt(n)) * d;
    let p = 0;
    for (let k = 1; k < 101; k++) p += 2 * (k % 2 ? 1 : -1) * Math.exp(-2 * k * k * lam * lam);
    return { d, p: Math.min(1, Math.max(0, p)), n };
  }

  // QQ points of `x` against Exp(rate), thinned to at most `maxPts`
  function qqExp(x, rate, maxPts) {
    const s = Float64Array.from(x).sort(), n = s.length, step = Math.max(1, Math.floor(n / (maxPts || 400)));
    const th = [], em = [];
    for (let i = 0; i < n; i += step) { th.push(-Math.log(1 - (i + 0.5) / n) / rate); em.push(s[i]); }
    if (n) { th.push(-Math.log(0.5 / n) / rate); em.push(s[n - 1]); }
    return { th, em };
  }

  // --------------------------------------------------------- point process ---
  /* segs: [{t0, t1, t: [ms...]}]. Converts to seconds from segment start and
     breaks millisecond ties with uniform jitter (seeded, so results are stable). */
  function prepareTimes(segs) {
    const rnd = mulberry32(12345);
    return segs.map((s) => {
      const a = Float64Array.from(s.t, (t) => (t - s.t0 + rnd()) / 1000).sort();
      return { T: Math.max((s.t1 - s.t0) / 1000 + 0.001, a.length ? a[a.length - 1] : 0), t: a };
    }).filter((s) => s.T > 0);
  }
  function interArrivals(prep) {
    const out = [];
    for (const s of prep) for (let i = 1; i < s.t.length; i++) out.push(s.t[i] - s.t[i - 1]);
    return out;
  }

  function poissonFit(prep) {
    let n = 0, T = 0;
    for (const s of prep) { n += s.t.length; T += s.T; }
    const rate = n / T, dt = interArrivals(prep);
    return { rate, n, T, loglik: n * Math.log(rate) - rate * T, dt,
             ks: ksTest(dt, (x) => 1 - Math.exp(-rate * x)), qq: qqExp(dt, rate) };
  }

  /* Hawkes process with intensity  mu + n*beta * sum exp(-beta (t - t_j)).
     n is the branching ratio (share of events triggered by earlier events). */
  function hawkesNLL(prep, mu, n, beta, resid) {
    let ll = 0;
    for (const s of prep) {
      let R = 0, prev = 0, started = false;
      for (let i = 0; i < s.t.length; i++) {
        const dt = s.t[i] - prev, e = Math.exp(-beta * dt);
        const comp = mu * dt + (started ? n * (R + 1) * (1 - e) : 0);
        R = started ? e * (R + 1) : 0;
        const lam = mu + n * beta * R;
        ll += Math.log(lam) - comp;
        if (resid && started) resid.push(comp);
        prev = s.t[i]; started = true;
      }
      const dt = s.T - prev;
      ll -= mu * dt + (started ? n * (R + 1) * (1 - Math.exp(-beta * dt)) : 0);
    }
    return -ll;
  }
  function hawkesFit(prep) {
    const po = poissonFit(prep);
    if (po.n < 50) return null;
    const sig = (x) => 1 / (1 + Math.exp(-x));
    const f = (x) => {
      const v = hawkesNLL(prep, Math.exp(x[0]), sig(x[1]), Math.exp(x[2]));
      return Number.isFinite(v) ? v : 1e300;
    };
    let best = null;
    for (const b0 of [po.rate * 2, po.rate * 20, 1]) { // a few starts: the surface is not convex
      const r = nelderMead(f, [Math.log(po.rate * 0.5), 0, Math.log(Math.max(b0, 1e-3))], 500);
      if (!best || r.f < best.f) best = r;
    }
    const mu = Math.exp(best.x[0]), n = sig(best.x[1]), beta = Math.exp(best.x[2]);
    const resid = [];
    hawkesNLL(prep, mu, n, beta, resid);
    return { mu, n, beta, halfLife: Math.log(2) / beta, loglik: -best.f, resid,
             aic: 2 * 3 + 2 * best.f, aicPoisson: 2 * 1 - 2 * po.loglik,
             ks: ksTest(resid, (x) => 1 - Math.exp(-x)), qq: qqExp(resid, 1) };
  }

  // ------------------------------------------------------------ descriptive --
  function acf(x, maxLag) {
    const n = x.length, m = mean(x);
    let v = 0;
    for (const xi of x) v += (xi - m) * (xi - m);
    const out = [];
    for (let k = 1; k <= maxLag && k < n; k++) {
      let c = 0;
      for (let i = k; i < n; i++) c += (x[i] - m) * (x[i - k] - m);
      out.push(c / v);
    }
    return { acf: out, band: 1.96 / Math.sqrt(n) };
  }

  function histogram(x, bins, log) {
    const v = log ? x.filter((a) => a > 0).map(Math.log10) : x;
    if (!v.length) return { x: [], y: [], w: 0 };
    let lo = Infinity, hi = -Infinity;
    for (const a of v) { if (a < lo) lo = a; if (a > hi) hi = a; }
    if (hi === lo) hi = lo + 1;
    const w = (hi - lo) / bins, c = new Array(bins).fill(0);
    for (const a of v) c[Math.min(bins - 1, Math.floor((a - lo) / w))]++;
    return { x: c.map((_, i) => lo + (i + 0.5) * w), y: c, w, lo, n: v.length };
  }

  function ccdf(x, maxPts) {
    const s = Float64Array.from(x.filter((a) => a > 0)).sort(), n = s.length;
    const step = Math.max(1, Math.floor(n / (maxPts || 300))), xs = [], ys = [];
    for (let i = 0; i < n; i += step) { xs.push(s[i]); ys.push(1 - i / n); }
    // Hill estimator of the tail exponent on the largest 10%
    const k = Math.max(5, Math.floor(n * 0.1));
    let h = 0;
    if (n > 20) { for (let i = n - k; i < n; i++) h += Math.log(s[i] / s[n - k - 1]); h = k / h; }
    return { x: xs, y: ys, hill: n > 20 ? h : NaN };
  }

  /* Mean future mid change (over `h` seconds) conditional on current imbalance. */
  function imbalanceResponse(grids, h, key, bins) {
    bins = bins || 10;
    const sum = new Array(bins).fill(0), sq = new Array(bins).fill(0), cnt = new Array(bins).fill(0);
    for (const g of grids) {
      let j = 0;
      for (let i = 0; i < g.t.length; i++) {
        const target = g.t[i] + h * 1000;
        while (j < g.t.length && g.t[j] < target) j++;
        if (j >= g.t.length) break;
        if (g.t[j] - target > 2000) continue; // gap in the grid
        const b = Math.min(bins - 1, Math.floor(((g[key][i] + 1) / 2) * bins)), d = g.mid[j] - g.mid[i];
        sum[b] += d; sq[b] += d * d; cnt[b]++;
      }
    }
    return { x: cnt.map((_, i) => -1 + (2 * (i + 0.5)) / bins),
             y: sum.map((s, i) => (cnt[i] ? s / cnt[i] : null)),
             se: sq.map((q, i) => (cnt[i] > 1 ? Math.sqrt(Math.max(0, q / cnt[i] - (sum[i] / cnt[i]) ** 2) / cnt[i]) : 0)),
             n: cnt };
  }

  /* Signed trade volume vs mid change over windows of `w` seconds, with OLS fit. */
  function flowVsReturn(segs, w) {
    const xs = [], ys = [];
    for (const s of segs) {
      const g = s.grid, tr = s.trades;
      let ti = 0;
      for (let i = 0; i + w < g.t.length; i += w) {
        if (g.t[i + w] - g.t[i] > (w + 2) * 1000) continue;
        let v = 0;
        while (ti < tr.t.length && tr.t[ti] < g.t[i]) ti++;
        let k = ti;
        while (k < tr.t.length && tr.t[k] < g.t[i + w]) { v += tr.sign[k] * tr.s[k]; k++; }
        xs.push(v); ys.push(g.mid[i + w] - g.mid[i]);
      }
    }
    const mx = mean(xs), my = mean(ys);
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    const slope = sxx ? sxy / sxx : 0;
    return { x: xs, y: ys, slope, intercept: my - slope * mx, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
  }

  /* Realised variance per second of the mid, sampled every d seconds. */
  function signature(grids, lags) {
    return lags.map((d) => {
      let rv = 0, T = 0;
      for (const g of grids) for (let i = 0; i + d < g.t.length; i += d) {
        if (g.t[i + d] - g.t[i] > (d + 2) * 1000) continue;
        rv += (g.mid[i + d] - g.mid[i]) ** 2; T += d;
      }
      return T ? Math.sqrt(rv / T) : null;
    });
  }

  /* Events per minute and mean spread by hour of day (`hourOf` maps ms -> hour). */
  function hourlyProfile(segs, stream, hourOf) {
    const cnt = new Array(24).fill(0), secs = new Array(24).fill(0), sp = new Array(24).fill(0);
    for (const s of segs) {
      for (const t of s[stream].t) cnt[hourOf(t)]++;
      for (let i = 0; i < s.grid.t.length; i++) { const h = hourOf(s.grid.t[i]); secs[h]++; sp[h] += s.grid.spread[i]; }
    }
    return { rate: cnt.map((c, h) => (secs[h] ? (c / secs[h]) * 60 : null)),
             spread: sp.map((v, h) => (secs[h] ? v / secs[h] : null)) };
  }

  const api = { parseCSV, replaySegment, prepareTimes, interArrivals, poissonFit, hawkesFit, hawkesNLL,
                ksTest, qqExp, acf, histogram, ccdf, imbalanceResponse, flowVsReturn, signature,
                hourlyProfile, nelderMead, mulberry32, mean };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.LOB = api;
})(typeof self !== "undefined" ? self : this);
