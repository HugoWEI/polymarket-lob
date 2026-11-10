#!/usr/bin/env python3
"""Polymarket level-2 order book recorder.

Subscribes to the public CLOB market websocket and appends every event to
hourly CSV files:

    <out>/<market-slug>/<YYYY-MM-DD>/<HH>.csv      (UTC)
    <out>/index.json                               (manifest read by the dashboard)

Every hourly file starts with a full book snapshot, so any hour can be replayed
on its own. With --bucket the files are also mirrored to Google Cloud Storage
(gzip-encoded, so browsers decode them transparently).

Row format (one event per row):
    recv_ns   local receive time, ns since epoch
    ts_ms     exchange timestamp, ms since epoch
    event     snapshot | book | change | trade | tick
    side      BUY (bid side / buyer-initiated trade) or SELL
    price, size
    best_bid, best_ask   (change rows only, as sent by the exchange)
    hash      book hash / transaction hash

    snapshot  marks a book reset; the `book` rows that follow are its levels
    book      one resting level of the snapshot
    change    the level at `price` now has total size `size` (0 = level removed)
    trade     an execution; `side` is the aggressor side
    tick      tick size changed: price = new tick, size = old tick
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import gzip
import json
import logging
import os
import re
import signal
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import websockets

WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market"
GAMMA = "https://gamma-api.polymarket.com"
COLUMNS = ["recv_ns", "ts_ms", "event", "side", "price", "size", "best_bid", "best_ask", "hash"]
log = logging.getLogger("recorder")


# ----------------------------------------------------------------- markets ---
@dataclass
class Market:
    slug: str
    asset_id: str
    question: str = ""
    outcome: str = ""
    condition_id: str = ""
    bids: dict = field(default_factory=dict)  # price str -> size str
    asks: dict = field(default_factory=dict)
    have_book: bool = False


def _gamma(path: str, **params) -> list:
    url = f"{GAMMA}{path}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": "polymarket-lob-recorder"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def _from_gamma(m: dict) -> Market:
    tokens = json.loads(m["clobTokenIds"])
    outcomes = json.loads(m.get("outcomes") or "[]")
    # Both outcome tokens mirror each other, so only the first one is recorded.
    return Market(
        slug=m["slug"],
        asset_id=tokens[0],
        question=m.get("question", ""),
        outcome=outcomes[0] if outcomes else "",
        condition_id=m.get("conditionId", ""),
    )


def resolve_markets(specs: list[str]) -> list[Market]:
    """Each spec is `top`, `top:N`, a market slug, or a raw CLOB token id."""
    out: list[Market] = []
    for spec in specs:
        if spec == "top" or spec.startswith("top:"):
            n = int(spec.split(":")[1]) if ":" in spec else 1
            rows = _gamma("/markets", active="true", closed="false", order="volume24hr",
                          ascending="false", limit=n)
            out += [_from_gamma(m) for m in rows]
        elif re.fullmatch(r"\d{20,}", spec):
            out.append(Market(slug=f"token-{spec[:12]}", asset_id=spec))
        else:
            rows = _gamma("/markets", slug=spec)
            if not rows:
                raise SystemExit(f"No market found for slug '{spec}'")
            out.append(_from_gamma(rows[0]))
    seen, uniq = set(), []
    for m in out:
        if m.asset_id not in seen:
            seen.add(m.asset_id)
            uniq.append(m)
    return uniq


# ------------------------------------------------------------------ writer ---
class HourlyWriter:
    """Appends rows to <out>/<slug>/<date>/<HH>.csv and keeps the manifest."""

    def __init__(self, out: Path, markets: list[Market]):
        self.out = out
        self.markets = {m.asset_id: m for m in markets}
        self.files: dict[str, tuple[str, object, object]] = {}  # asset -> (key, fh, csv)
        self.dirty: set[Path] = set()
        self.index_path = out / "index.json"
        self.index = self._load_index()

    def _load_index(self) -> dict:
        idx = {"markets": {}}
        if self.index_path.exists():
            try:
                idx = json.loads(self.index_path.read_text())
            except json.JSONDecodeError:
                log.warning("index.json unreadable, rebuilding")
        for m in self.markets.values():
            e = idx["markets"].setdefault(m.slug, {"hours": {}})
            e.update(asset_id=m.asset_id, question=m.question, outcome=m.outcome,
                     condition_id=m.condition_id)
        return idx

    def _open(self, m: Market, now: datetime, recv_ns: int):
        key = now.strftime("%Y-%m-%d/%H")
        cur = self.files.get(m.asset_id)
        if cur and cur[0] == key:
            return cur[2]
        if cur:
            cur[1].close()
        path = self.out / m.slug / f"{key}.csv"
        path.parent.mkdir(parents=True, exist_ok=True)
        new = not path.exists() or path.stat().st_size == 0
        fh = open(path, "a", newline="")
        w = csv.writer(fh)
        if new:
            w.writerow(COLUMNS)
        self.files[m.asset_id] = (key, fh, w)
        day, hour = key.split("/")
        hours = self.index["markets"][m.slug]["hours"].setdefault(day, [])
        if int(hour) not in hours:
            hours.append(int(hour))
            hours.sort()
        # Start every file (and every restart) with the book we currently hold.
        if m.have_book:
            self._snapshot(w, m, recv_ns, recv_ns // 1_000_000, "rollover")
        self.dirty.add(path)
        return w

    @staticmethod
    def _snapshot(w, m: Market, recv_ns: int, ts_ms, h: str):
        w.writerow([recv_ns, ts_ms, "snapshot", "", "", "", "", "", h])
        for side, book in (("BUY", m.bids), ("SELL", m.asks)):
            for price, size in book.items():
                w.writerow([recv_ns, ts_ms, "book", side, price, size, "", "", ""])

    def handle(self, ev: dict, recv_ns: int):
        et = ev.get("event_type")
        now = datetime.fromtimestamp(recv_ns / 1e9, tz=timezone.utc)
        ts = ev.get("timestamp", "")
        if et == "book":
            m = self.markets.get(ev.get("asset_id"))
            if not m:
                return
            m.bids = {l["price"]: l["size"] for l in ev.get("bids", [])}
            m.asks = {l["price"]: l["size"] for l in ev.get("asks", [])}
            m.have_book = False  # stop _open from writing a rollover copy of this same book
            w = self._open(m, now, recv_ns)
            m.have_book = True
            self._snapshot(w, m, recv_ns, ts, ev.get("hash", ""))
        elif et == "price_change":
            for c in ev.get("price_changes", []):
                m = self.markets.get(c.get("asset_id"))
                if not m:
                    continue
                book = m.bids if c["side"] == "BUY" else m.asks
                if float(c["size"]) == 0:
                    book.pop(c["price"], None)
                else:
                    book[c["price"]] = c["size"]
                self._open(m, now, recv_ns).writerow(
                    [recv_ns, ts, "change", c["side"], c["price"], c["size"],
                     c.get("best_bid", ""), c.get("best_ask", ""), c.get("hash", "")])
        elif et == "last_trade_price":
            m = self.markets.get(ev.get("asset_id"))
            if m:
                self._open(m, now, recv_ns).writerow(
                    [recv_ns, ts, "trade", ev.get("side", ""), ev.get("price", ""),
                     ev.get("size", ""), "", "", ev.get("transaction_hash", "")])
        elif et == "tick_size_change":
            m = self.markets.get(ev.get("asset_id"))
            if m:
                self._open(m, now, recv_ns).writerow(
                    [recv_ns, ts, "tick", "", ev.get("new_tick_size", ""),
                     ev.get("old_tick_size", ""), "", "", ""])

    def flush(self) -> list[Path]:
        """Flush open files, rewrite the manifest, return paths changed since last call."""
        for key, fh, _ in self.files.values():
            fh.flush()
        for m in self.markets.values():
            cur = self.files.get(m.asset_id)
            if cur:
                self.dirty.add(self.out / m.slug / f"{cur[0]}.csv")
        self.index["updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
        tmp = self.index_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.index))
        os.replace(tmp, self.index_path)
        changed = sorted(self.dirty) + [self.index_path]
        self.dirty = set()
        return changed

    def close(self):
        for _, fh, _ in self.files.values():
            fh.close()


# --------------------------------------------------------------------- GCS ---
class Uploader:
    def __init__(self, bucket: str, out: Path):
        from google.cloud import storage  # imported lazily: optional dependency
        self.bucket = storage.Client().bucket(bucket)
        self.out = out

    def upload(self, paths: list[Path]):
        for p in paths:
            try:
                blob = self.bucket.blob(p.relative_to(self.out).as_posix())
                blob.content_encoding = "gzip"
                blob.cache_control = "no-cache, max-age=0"
                ctype = "application/json" if p.suffix == ".json" else "text/csv"
                blob.upload_from_string(gzip.compress(p.read_bytes(), 6), content_type=ctype)
            except Exception as e:  # keep recording even if an upload fails
                log.warning("upload failed for %s: %s", p, e)


# ---------------------------------------------------------------- main loop ---
async def stream(markets: list[Market], writer: HourlyWriter, stop: asyncio.Event):
    backoff = 1
    ids = [m.asset_id for m in markets]
    while not stop.is_set():
        try:
            async with websockets.connect(WS_URL, ping_interval=None, max_size=None) as ws:
                await ws.send(json.dumps({"assets_ids": ids, "type": "market"}))
                log.info("subscribed to %d market(s)", len(ids))
                backoff = 1

                async def heartbeat():
                    while True:
                        await asyncio.sleep(10)
                        await ws.send("PING")

                hb = asyncio.create_task(heartbeat())
                try:
                    while not stop.is_set():
                        raw = await asyncio.wait_for(ws.recv(), timeout=45)
                        recv_ns = time.time_ns()
                        if raw in ("PONG", b"PONG"):
                            continue
                        try:
                            msg = json.loads(raw)
                        except json.JSONDecodeError:
                            continue
                        for ev in msg if isinstance(msg, list) else [msg]:
                            if isinstance(ev, dict):
                                writer.handle(ev, recv_ns)
                finally:
                    hb.cancel()
        except (asyncio.TimeoutError, OSError, websockets.WebSocketException) as e:
            log.warning("connection lost (%s); reconnecting in %ds", type(e).__name__, backoff)
            for m in markets:  # the next snapshot must reset the book
                m.have_book = False
            try:
                await asyncio.wait_for(stop.wait(), timeout=backoff)
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, 30)


async def sync_loop(writer: HourlyWriter, uploader, every: int, stop: asyncio.Event):
    while True:
        try:
            await asyncio.wait_for(stop.wait(), timeout=every)
        except asyncio.TimeoutError:
            pass
        changed = writer.flush()
        if uploader:
            await asyncio.to_thread(uploader.upload, changed)
        if stop.is_set():
            return


async def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--market", action="append", default=[],
                    help="`top`, `top:N`, a market slug, or a CLOB token id (repeatable)")
    ap.add_argument("--out", default="data", help="local output directory")
    ap.add_argument("--bucket", help="GCS bucket to mirror to (optional)")
    ap.add_argument("--sync-seconds", type=int, default=60)
    ap.add_argument("--check", action="store_true",
                    help="connect, print the first book snapshot summary and exit")
    args = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

    markets = resolve_markets(args.market or ["top"])
    for m in markets:
        log.info("recording %s [%s] %s", m.slug, m.outcome, m.question)

    if args.check:
        async with websockets.connect(WS_URL, ping_interval=None, max_size=None) as ws:
            await ws.send(json.dumps({"assets_ids": [m.asset_id for m in markets], "type": "market"}))
            raw = await asyncio.wait_for(ws.recv(), timeout=20)
            msg = json.loads(raw)
            ev = msg[0] if isinstance(msg, list) else msg
            print(f"OK: first message is '{ev.get('event_type')}' with "
                  f"{len(ev.get('bids', []))} bid and {len(ev.get('asks', []))} ask levels")
        return

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    writer = HourlyWriter(out, markets)
    uploader = Uploader(args.bucket, out) if args.bucket else None
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    try:
        await asyncio.gather(stream(markets, writer, stop),
                             sync_loop(writer, uploader, args.sync_seconds, stop))
    finally:
        writer.close()


if __name__ == "__main__":
    asyncio.run(main())
