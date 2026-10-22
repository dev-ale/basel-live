#!/usr/bin/env python3
"""Filter the Swiss GTFS zip down to BVB + BLT and write gtfs/basel.json.

Usage: python3 prepare_gtfs.py gtfs/gtfs.zip
Streams the big files (trips 390 MB, stop_times 3.6 GB) straight out of the zip; takes about a minute.

Output layout (compact on purpose, the server parses stop times lazily):
  routes:   {route_id: {line, type, agency}}
  trips:    {trip_id: [route_id, service_id, headsign]}
  stops:    [[didok, name, lat, lon, stop_id], ...]  (index = stop idx)
  st:       {trip_id: "stopidx,arr,dep;stopidx,arr,dep;..."}   seconds since service-day midnight, in sequence order
  calendar: {service_id: {days:[7 bools], start, end, add:[dates], remove:[dates]}}
"""
import csv, io, json, re, sys, time, zipfile

ZIP = sys.argv[1] if len(sys.argv) > 1 else 'gtfs/gtfs.zip'
AGENCY_RE = re.compile(r'Basler Verkehrs|Baselland Transport|\bBVB\b|\bBLT\b', re.I)
t0 = time.time()
log = lambda *a: print(f'[{time.time()-t0:6.1f}s]', *a, file=sys.stderr)

z = zipfile.ZipFile(ZIP)
def rows(name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding='utf-8-sig', newline=''))

agencies = {r['agency_id']: r['agency_name'] for r in rows('agency.txt') if AGENCY_RE.search(r['agency_name'])}
log('agencies', agencies)

routes = {r['route_id']: {'line': r.get('route_short_name') or r.get('route_long_name'), 'type': int(r['route_type']),
                          'agency': agencies[r['agency_id']]} for r in rows('routes.txt') if r['agency_id'] in agencies}
log('routes', len(routes))

trips, services = {}, set()
for r in rows('trips.txt'):
    if r['route_id'] in routes:
        trips[r['trip_id']] = [r['route_id'], r['service_id'], r.get('trip_headsign', '')]
        services.add(r['service_id'])
log('trips', len(trips))

def hms(s):
    h, m, sec = s.split(':'); return int(h) * 3600 + int(m) * 60 + int(sec)

raw, stop_ids, n = {}, set(), 0
for r in rows('stop_times.txt'):
    tid = r['trip_id']
    if tid in trips:
        raw.setdefault(tid, []).append((int(r['stop_sequence']), r['stop_id'], hms(r['arrival_time']), hms(r['departure_time'])))
        stop_ids.add(r['stop_id'])
    n += 1
    if n % 10_000_000 == 0: log('stop_times scanned', n)
log('stop_times kept', sum(len(v) for v in raw.values()))

stops, stop_idx = [], {}
for r in rows('stops.txt'):
    if r['stop_id'] in stop_ids:
        stop_idx[r['stop_id']] = len(stops)
        stops.append([r.get('didok') or r['stop_id'].split(':')[0], r['stop_name'], round(float(r['stop_lat']), 6), round(float(r['stop_lon']), 6), r['stop_id']])
log('stops', len(stops))

st = {}
for tid, v in raw.items():
    v.sort()
    st[tid] = ';'.join(f'{stop_idx[s]},{a},{d}' for _, s, a, d in v if s in stop_idx)

calendar = {}
for r in rows('calendar.txt'):
    if r['service_id'] in services:
        calendar[r['service_id']] = {'days': [r[d] == '1' for d in ('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')],
                                     'start': r['start_date'], 'end': r['end_date'], 'add': [], 'remove': []}
for r in rows('calendar_dates.txt'):
    c = calendar.get(r['service_id'])
    if c is None and r['service_id'] in services:
        c = calendar[r['service_id']] = {'days': [False] * 7, 'start': '00000000', 'end': '99999999', 'add': [], 'remove': []}
    if c: (c['add'] if r['exception_type'] == '1' else c['remove']).append(r['date'])
log('services', len(calendar))

with open('gtfs/basel.json', 'w') as f:
    json.dump({'routes': routes, 'trips': trips, 'stops': stops, 'st': st, 'calendar': calendar,
               'generated': time.strftime('%Y-%m-%d %H:%M')}, f, separators=(',', ':'), ensure_ascii=False)
log('written gtfs/basel.json')
