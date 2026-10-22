#!/usr/bin/env python3
"""Basel Live server: static files + /vehicles.json + /stops.json

- Loads gtfs/basel.json (BVB + BLT subset of the Swiss GTFS, see prepare_gtfs.py).
- Polls the opentransportdata.swiss GTFS-RT trip updates every 30 s with the token from .env (OTD_TOKEN).
- Merges the real-time delays into today's scheduled trips and serves the currently running vehicles.

Run:  python3 server.py   (port 8765)
"""
import json, os, sys, threading, time, urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

PORT = int(os.environ.get('PORT', 8765))
TZ = ZoneInfo('Europe/Zurich')
RT_URL = 'https://api.opentransportdata.swiss/la/gtfs-rt?format=JSON'
RT_EVERY = 30
HERE = os.path.dirname(os.path.abspath(__file__))

def load_env():
    try:
        for line in open(os.path.join(HERE, '.env')):
            line = line.strip()
            if line and not line.startswith('#') and '=' in line:
                k, v = line.split('=', 1); os.environ.setdefault(k.strip(), v.strip().strip('"\''))
    except FileNotFoundError:
        pass
load_env()
TOKEN = os.environ.get('OTD_TOKEN', '')
log = lambda *a: print(time.strftime('%H:%M:%S'), *a, file=sys.stderr, flush=True)

# ---------------------------------------------------------------- static GTFS
log('loading gtfs/basel.json …')
G = json.load(open(os.path.join(HERE, 'gtfs', 'basel.json')))
STOPS = G['stops']
log(f"gtfs ready: {len(G['trips'])} trips, {len(STOPS)} stops, generated {G['generated']}")

def service_runs(sid, day):
    c = G['calendar'].get(sid)
    if not c: return False
    d = day.strftime('%Y%m%d')
    if d in c['remove']: return False
    if d in c['add']: return True
    return c['start'] <= d <= c['end'] and c['days'][day.weekday()]

class Index:
    """Scheduled trips around now, as absolute epoch seconds. Rebuilt every 10 min."""
    def __init__(self):
        self.trips = {}; self.by_start = {}; self.built = 0; self.lock = threading.Lock()
    def build(self):
        now = datetime.now(TZ)
        out, by_start = {}, {}
        for day in (now.date() - timedelta(days=1), now.date()):
            midnight = datetime(day.year, day.month, day.day, tzinfo=TZ).timestamp()
            date = day.strftime('%Y%m%d')
            for tid, (rid, sid, headsign) in G['trips'].items():
                if not service_runs(sid, day): continue
                s = G['st'].get(tid)
                if not s: continue
                stops = []
                for part in s.split(';'):
                    i, a, d = part.split(','); stops.append([int(i), midnight + int(a), midnight + int(d)])
                if stops[-1][1] < now.timestamp() - 3 * 3600 or stops[0][2] > now.timestamp() + 3 * 3600: continue
                key = f'{tid}|{date}'  # same trip_id can run yesterday after midnight and today
                out[key] = {'route': rid, 'headsign': headsign, 'stops': stops}
                by_start.setdefault((rid, date, int(stops[0][2] - midnight)), []).append(key)
        with self.lock:
            self.trips = out; self.by_start = by_start; self.built = time.time()
        log(f'schedule index: {len(out)} trips within ±3 h')

IDX = Index(); IDX.build()

# ---------------------------------------------------------------- GTFS-RT
RT = {'updates': {}, 'cancelled': set(), 'fetched': 0, 'error': None, 'entities': 0}

def hms(s):
    h, m, sec = s.split(':'); return int(h) * 3600 + int(m) * 60 + int(sec)

def stop_fits(stops, stu):
    seq, sid = stu.get('stopSequence'), stu.get('stopId')
    if seq is None or sid is None: return True
    if not 0 < seq <= len(stops): return False
    st = STOPS[stops[seq - 1][0]]
    return len(st) < 5 or st[4] == sid  # basel.json from before stop ids were stored: trust the start time

def match_trip(trip, stus, active, by_start):
    """GTFS-RT trip_ids are renumbered with every timetable publication (twice a week), so with an older
    basel.json the same id points at a different trip. Match on route + service day + start time instead,
    and use the stop ids to pick between trips leaving at the same time (e.g. opposite directions)."""
    try: k = (trip['routeId'], trip['startDate'], hms(trip['startTime']))
    except (KeyError, ValueError): return None
    for key in by_start.get(k, ()):
        if all(stop_fits(active[key]['stops'], stu) for stu in stus): return key
    return None

def fetch_rt():
    req = urllib.request.Request(RT_URL, headers={'Authorization': TOKEN, 'User-Agent': 'basel-live-poc'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.load(r)
    updates, cancelled, n, missed = {}, set(), 0, 0
    with IDX.lock: active, by_start = IDX.trips, IDX.by_start
    for e in data.get('entity', []):
        tu = e.get('tripUpdate');
        if not tu: continue
        tid = match_trip(tu.get('trip', {}), tu.get('stopTimeUpdate', []), active, by_start)
        if tid is None:
            if tu.get('trip', {}).get('routeId') in G['routes']: missed += 1
            continue
        n += 1
        if tu['trip'].get('scheduleRelationship') == 'CANCELED': cancelled.add(tid); continue
        upd = {}
        for stu in tu.get('stopTimeUpdate', []):
            seq = stu.get('stopSequence')
            if seq is None: continue
            upd[int(seq)] = (stu.get('arrival', {}).get('delay'), stu.get('departure', {}).get('delay'), stu.get('scheduleRelationship', 'SCHEDULED'))
        updates[tid] = upd
    RT.update(updates=updates, cancelled=cancelled, fetched=time.time(), error=None, entities=n)
    log(f'gtfs-rt: {len(data.get("entity", []))} entities, {n} for BVB/BLT, {len(cancelled)} cancelled, {missed} BVB/BLT unmatched')

def rt_loop():
    while True:
        if time.time() - IDX.built > 600:
            try: IDX.build()
            except Exception as ex: log('index rebuild failed', ex)
        if TOKEN:
            try: fetch_rt()
            except Exception as ex:
                RT['error'] = str(ex); log('gtfs-rt fetch failed:', ex)
        else:
            RT['error'] = 'OTD_TOKEN missing in .env'
        time.sleep(RT_EVERY)
threading.Thread(target=rt_loop, daemon=True).start()

# ---------------------------------------------------------------- vehicles
def vehicles():
    now = time.time()
    with IDX.lock: active = dict(IDX.trips)
    out = []
    for tid, t in active.items():
        if tid in RT['cancelled']: continue
        upd = RT['updates'].get(tid)
        stops, arr_d, dep_d = [], 0, 0
        for seq, (i, a, d) in enumerate(t['stops'], start=1):
            if upd is not None and seq in upd:
                ua, ud, rel = upd[seq]
                if ua is not None: arr_d = ua
                if ud is not None: dep_d = ud
                elif ua is not None: dep_d = ua
                if rel == 'SKIPPED': continue
            else:
                arr_d = dep_d  # delay propagates from the previous departure
            st = STOPS[i]
            stops.append({'id': st[0], 'name': st[1], 'lat': st[2], 'lon': st[3],
                          'arr': int((a + arr_d) * 1000), 'dep': int((max(d + dep_d, a + arr_d)) * 1000), 'delay': round(dep_d / 60)})
        if not stops or now * 1000 < stops[0]['dep'] - 30_000 or now * 1000 > stops[-1]['arr'] + 45_000: continue
        # trim to the segment around now (previous stop onwards)
        k = 0
        while k + 1 < len(stops) and stops[k + 1]['arr'] <= now * 1000: k += 1
        route = G['routes'][t['route']]
        out.append({'key': tid, 'line': route['line'], 'cat': 'tram' if route['type'] in (0, 900) else 'bus',
                    'to': t['headsign'], 'op': 'BVB' if 'Basler' in route['agency'] else 'BLT', 'rt': upd is not None,
                    'stops': stops[max(0, k - 1):]})
    return out

STOPS_JSON = None
def stops_json():
    global STOPS_JSON
    if STOPS_JSON is None:
        seen = {}
        for didok, name, lat, lon, *_ in STOPS:
            if didok not in seen: seen[didok] = {'id': didok, 'name': name, 'lat': lat, 'lon': lon}
        STOPS_JSON = json.dumps(list(seen.values()), ensure_ascii=False).encode()
    return STOPS_JSON

# ---------------------------------------------------------------- http
class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k): super().__init__(*a, directory=HERE, **k)
    def log_message(self, *a): pass
    def send_json(self, body: bytes):
        self.send_response(200); self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store'); self.send_header('Content-Length', str(len(body))); self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith('/vehicles.json'):
            body = {'now': int(time.time() * 1000), 'rt_age': int(time.time() - RT['fetched']) if RT['fetched'] else None,
                    'rt_error': RT['error'], 'vehicles': vehicles()}
            return self.send_json(json.dumps(body, ensure_ascii=False).encode())
        if self.path.startswith('/stops.json'): return self.send_json(stops_json())
        if self.path in ('/.env', '/gtfs/basel.json'): self.send_error(403); return
        return super().do_GET()

if __name__ == '__main__':
    log(f'serving on http://localhost:{PORT}  (token {"set" if TOKEN else "MISSING"})')
    ThreadingHTTPServer(('', PORT), H).serve_forever()
