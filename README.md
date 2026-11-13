# Polymarket order book lab

Records the level-2 order book of Polymarket markets and analyses it in a browser dashboard.

```
recorder/   recorder.py: websocket -> hourly CSV event log (+ optional Google Cloud Storage mirror)
docs/       the dashboard (static; serve it with GitHub Pages from /docs)
docs/sample SYNTHETIC data so the dashboard works before you have real recordings
deploy/     gcp_setup.sh: bucket + always-on e2-micro VM running the recorder
tools/      make_sample.py: regenerates the synthetic sample
```

## Record

```bash
pip install -r recorder/requirements.txt
python recorder/recorder.py --check                 # can this machine reach the feed?
python recorder/recorder.py --market top --out data # most traded market by 24h volume
python recorder/recorder.py --market long:3 --market some-market-slug --bucket my-bucket
# top[:N] = most traded now; long[:N] = most traded among markets with 30+ days left
```

Files land in `<out>/<slug>/<YYYY-MM-DD>/<HH>.csv` (UTC). Each row is one event
(`snapshot`, `book`, `change`, `trade`, `tick`); the column meanings are at the top of
`recorder.py`. Every hourly file starts with a full book snapshot, so any hour replays alone.

On Google Cloud: `PROJECT=... BUCKET=... ./deploy/gcp_setup.sh`

## Analyse

Locally: `python -m http.server -d docs` then open http://localhost:8000.
Press **Data source** and enter `https://storage.googleapis.com/<bucket>` (or append
`?data=<url>` to the address). To read a local recording, copy or symlink the data folder
into `docs/` and enter its name.

**Live** mode connects to Polymarket straight from the browser and keeps the data in the tab
only; **Export CSV** saves whatever is loaded, in the recorder's format.

## Notes

- The feed is level 2: sizes per price level, not individual orders. "Added" and "cancelled"
  size are inferred from level changes; a size drop within 250 ms of a trade at that price is
  treated as a fill.
- Fills that share a transaction hash and side are merged into one trade by default
  ("Grouped by order"); switch Trades to "Every fill" to see them separately.
- The Event tab compares a window before and after a chosen time (by default the start of
  the largest five-minute move) and shows the average price a buyer would have paid by taking
  the resting asks at each moment after it.
- Open the dashboard on a given market with `?market=<slug>`.
- Only the first outcome token of each market is recorded; the other one mirrors it.
- The Hawkes model is `mu + n*beta*sum(exp(-beta*(t - t_j)))`, fitted by maximum likelihood
  over all loaded windows. `n` is the branching ratio.
