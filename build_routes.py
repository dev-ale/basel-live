#!/usr/bin/env python3
"""Convert an Overpass `out geom` dump of route relations into routes.json.

Usage:  python3 build_routes.py osm_tram.json [osm_bus.json ...] > routes.json

Output: { "lines": { "<ref>": { "colour": "#rrggbb", "segments": [[[lat,lon],...], ...] } } }
Each segment is one OSM way's geometry. The browser merges them into a graph per line.
"""
import json, sys

lines = {}
for path in sys.argv[1:]:
    with open(path) as f:
        data = json.load(f)
    for rel in data.get("elements", []):
        if rel.get("type") != "relation":
            continue
        tags = rel.get("tags", {})
        ref = tags.get("ref")
        if not ref:
            continue
        entry = lines.setdefault(ref, {"colour": None, "segments": [], "names": set()})
        if tags.get("colour") and not entry["colour"]:
            entry["colour"] = tags["colour"]
        if tags.get("name"):
            entry["names"].add(tags["name"])
        for m in rel.get("members", []):
            if m.get("type") != "way" or not m.get("geometry"):
                continue
            if m.get("role", "") not in ("", "forward", "backward"):
                continue  # skip platforms / stops
            seg = [[round(p["lat"], 6), round(p["lon"], 6)] for p in m["geometry"]]
            if len(seg) >= 2:
                entry["segments"].append(seg)

out = {"lines": {}}
for ref, e in sorted(lines.items()):
    # dedupe identical segments (same way used by both directions)
    seen, segs = set(), []
    for s in e["segments"]:
        k = json.dumps(s)
        if k not in seen:
            seen.add(k); segs.append(s)
    out["lines"][ref] = {"colour": e["colour"], "segments": segs, "names": sorted(e["names"])}
    print(f"{ref:>5} {e['colour'] or '-':8} {len(segs):4} ways", file=sys.stderr)

json.dump(out, sys.stdout, separators=(",", ":"))
