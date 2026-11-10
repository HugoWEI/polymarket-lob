#!/usr/bin/env python3
"""Generate SYNTHETIC order book data in the recorder's format, for trying the
dashboard before any real data exists. Trades follow a Hawkes process with known
parameters (branching ratio 0.6, decay 0.5/s), so the dashboard's fit can be checked.

    python tools/make_sample.py docs/sample
"""
import math, random, sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "recorder"))
from recorder import HourlyWriter, Market  # noqa: E402

N_BRANCH, BETA = 0.6, 0.5
ASSET = "0" * 24 + "1"


def hawkes_times(rng, mu_of, T):
    """Cluster simulation: immigrants at rate mu(t), each event spawns Poisson(n) children."""
    t, imm, mu_max = 0.0, [], max(mu_of(x) for x in range(0, int(T), 60))
    while True:
        t += rng.expovariate(mu_max)
        if t >= T:
            break
        if rng.random() < mu_of(t) / mu_max:
            imm.append(t)
    out, stack = [], imm[:]
    while stack:
        s = stack.pop()
        out.append(s)
        k = sum(1 for _ in range(50) if rng.random() < N_BRANCH / 50)  # ~Poisson(n)
        for _ in range(k):
            c = s + rng.expovariate(BETA)
            if c < T:
                stack.append(c)
    return sorted(out)


def run(out: Path, days=("2026-11-07", "2026-11-08", "2026-11-09"), h0=10, h1=15):
    rng = random.Random(7)
    m = Market(slug="synthetic-demo-market", asset_id=ASSET, outcome="Yes",
               question="SYNTHETIC DATA: simulated market for testing the dashboard")
    w = HourlyWriter(out, [m])
    for day in days:
        start = datetime.fromisoformat(f"{day}T{h0:02d}:00:00").replace(tzinfo=timezone.utc).timestamp()
        T = (h1 - h0) * 3600
        mu = lambda x: 0.05 + 0.10 * math.exp(-((x / 3600 - 2.5) ** 2) / 0.8)  # busier mid-window
        trades = [(t, "T") for t in hawkes_times(rng, mu, T)]
        quotes, t = [], 0.0
        while t < T:
            t += rng.expovariate(1.2)
            quotes.append((t, "Q"))
        mid = 50 + rng.randint(-5, 5)  # in ticks of 0.01
        bids = {mid - i: round(rng.uniform(200, 3000), 2) for i in range(1, 15)}
        asks = {mid + i: round(rng.uniform(200, 3000), 2) for i in range(1, 15)}
        px = lambda k: f"{k / 100:.2f}"

        def send(ev, ts):
            ev["timestamp"] = str(int((start + ts) * 1000))
            w.handle(ev, int((start + ts) * 1e9) + rng.randint(2_000_000, 40_000_000))

        send({"event_type": "book", "asset_id": ASSET, "hash": "synthetic",
              "bids": [{"price": px(k), "size": str(v)} for k, v in bids.items()],
              "asks": [{"price": px(k), "size": str(v)} for k, v in asks.items()]}, 0)

        def change(side, k, size, ts):
            book = bids if side == "BUY" else asks
            if size <= 0:
                book.pop(k, None)
            else:
                book[k] = size
            send({"event_type": "price_change", "price_changes": [
                {"asset_id": ASSET, "price": px(k), "size": f"{max(size, 0):.2f}", "side": side,
                 "best_bid": px(max(bids)), "best_ask": px(min(asks)), "hash": ""}]}, ts)

        sign = 1
        for ts, kind in sorted(trades + quotes):
            if ts >= T - 0.1:
                break
            bb, ba = max(bids), min(asks)
            if kind == "T":
                imb = (bids[bb] - asks[ba]) / (bids[bb] + asks[ba])
                p_buy = min(0.95, max(0.05, 0.5 + 0.25 * imb + 0.2 * sign))
                sign = 1 if rng.random() < p_buy else -1
                k, book, rest = (ba, asks, "SELL") if sign > 0 else (bb, bids, "BUY")
                size = min(round(rng.paretovariate(1.6) * 40, 2), book[k])
                send({"event_type": "last_trade_price", "asset_id": ASSET, "price": px(k),
                      "size": f"{size:.2f}", "side": "BUY" if sign > 0 else "SELL",
                      "transaction_hash": f"0xsynthetic{int(ts * 1000)}"}, ts)
                change(rest, k, round(book[k] - size, 2), ts)
            else:
                side = "BUY" if rng.random() < 0.5 else "SELL"
                book = bids if side == "BUY" else asks
                best = bb if side == "BUY" else ba
                step = -1 if side == "BUY" else 1
                r = rng.random()
                if ba - bb > 1 and r < 0.5:  # improve the quote
                    change(side, best - step, round(rng.uniform(100, 1500), 2), ts)
                elif r < 0.55:  # add
                    k = best + step * int(rng.expovariate(0.5))
                    if 1 <= k <= 99:
                        change(side, k, round(book.get(k, 0) + rng.uniform(50, 1500), 2), ts)
                elif len(book) > 4:  # cancel
                    k = rng.choice(sorted(book, reverse=side == "BUY")[:6])
                    change(side, k, round(book[k] * rng.choice([0, 0, 0.3, 0.6]), 2), ts)
            # keep both sides populated
            for side, book, step in (("BUY", bids, -1), ("SELL", asks, 1)):
                if len(book) < 6:
                    edge = min(bids) if side == "BUY" else max(asks)
                    if 1 < edge + step < 99:
                        change(side, edge + step, round(rng.uniform(200, 3000), 2), ts)
        m.have_book = False
        for _, fh, _ in w.files.values():
            fh.close()
        w.files.clear()
    w.flush()
    w.close()


if __name__ == "__main__":
    run(Path(sys.argv[1] if len(sys.argv) > 1 else "docs/sample"))
