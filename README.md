# Basel Live · trams & buses (POC)

A screensaver-style live map of Basel's BVB/BLT network. Every tram and bus moves along the real tracks in its official line colour, real-life delays show up live, and every station is clickable for its next departures.

## Run

1. Put your opentransportdata.swiss token in `.env` as `OTD_TOKEN=...` (get one at https://api-manager.opentransportdata.swiss/, product "GTFS-RT").
2. Build the timetable subset once (downloads ~290 MB, takes about a minute, writes `gtfs/basel.json`):

```bash
mkdir -p gtfs && curl -L -o gtfs/gtfs.zip 'https://data.opentransportdata.swiss/dataset/3d2c18f9-9ef1-463f-a249-5c67604efd74/resource/112426e8-d1d1-4244-92ff-a6a14329c256/download/gtfs_fp2026_20261010.zip' && python3 prepare_gtfs.py gtfs/gtfs.zip
```

3. Start the server and open http://localhost:8765:

```bash
python3 server.py
```

No dependencies beyond Python 3.9+ and Leaflet from a CDN. The HUD fades out after 20 s without input.

Without the server (`python3 -m http.server 8765`) the page falls back to polling transport.opendata.ch stationboards for 24 hub stops, which covers fewer vehicles.

## How it works

- **Timetable**: `prepare_gtfs.py` streams the Swiss GTFS zip and keeps only BVB and BLT (59 routes, ~188k trips for the year, 1451 platforms).
- **Real time**: `server.py` polls the national GTFS-RT trip-update feed every 30 s (one request returns ~10k trips for all of Switzerland), keeps the BVB/BLT ones and applies the per-stop delays to today's schedule. Cancelled trips disappear, skipped stops are dropped, delays propagate to later stops as the GTFS-RT spec requires.
- **Positions**: Switzerland publishes no vehicle GPS feed, so the server serves each running trip's delay-adjusted stop times (`/vehicles.json`, refreshed every 10 s by the page) and the browser interpolates between stops. Dashed markers are trips with no real-time update yet, drawn on schedule.
- **Tracks and colours**: OpenStreetMap route relations via the Swiss Overpass mirror, converted by `build_routes.py` into `routes.json`. Line colours are the relations' `colour` tags (official BVB/BLT colours for trams; OSM maps buses grey). Each line's ways form a graph and the vehicle follows the shortest path between its two stops.
- **Stations**: `/stops.json` lists every BVB/BLT stop; clicking one fetches the next 8 departures live from transport.opendata.ch.

## Refresh the track geometry

```bash
curl -s 'https://overpass.osm.ch/api/interpreter' --data-urlencode 'data=[out:json][timeout:180];relation[route=tram](47.48,7.50,47.62,7.72);out geom;' -o osm_tram.json
```

```bash
curl -s 'https://overpass.osm.ch/api/interpreter' --data-urlencode 'data=[out:json][timeout:180];relation[route=bus][operator~"BVB|BLT"](47.50,7.53,47.61,7.67);out geom;' -o osm_bus.json
```

```bash
python3 build_routes.py osm_tram.json osm_bus.json > routes.json
```

## Notes

- The GTFS zip is republished twice a week; re-run step 2 now and then (the RT feed's `feedVersion` tells you which timetable it expects).
- To cover another region, change `AGENCY_RE` in `prepare_gtfs.py` and fetch that region's OSM routes.
- The game layer (board, hop off, checkpoints, multiplayer) was prototyped earlier and removed; it can sit on top of this data model.
