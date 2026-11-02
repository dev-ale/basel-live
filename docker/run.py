#!/usr/bin/env python3
"""Container entrypoint: keeps the timetable current and runs server.py.

On start the newest timetable is fetched when needed (first start: download + filter, about 2 minutes).
Every day at GTFS_REFRESH_AT (Europe/Zurich, default 04:30) it is checked again; a new one is built next to the
running server, which is then restarted on it (a few seconds without /vehicles.json).
If server.py exits on its own, so does this script, and the container's restart policy takes over.
"""
import os, signal, subprocess, sys, time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import gtfs_update

TZ = ZoneInfo('Europe/Zurich')
REFRESH_AT = os.environ.get('GTFS_REFRESH_AT', '04:30')
log = lambda *a: print(time.strftime('%H:%M:%S'), 'run:', *a, file=sys.stderr, flush=True)
server = None


def next_refresh() -> datetime:
    h, m = map(int, REFRESH_AT.split(':'))
    now = datetime.now(TZ)
    t = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return t if t > now else t + timedelta(days=1)


def refresh() -> bool:
    try:
        return gtfs_update.update()
    except Exception as ex:   # network or upstream trouble: keep serving the timetable we have
        log('timetable update failed:', ex)
        return False


def start_server():
    return subprocess.Popen([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.py')])


def stop_server():
    if server and server.poll() is None:
        server.terminate()
        try: server.wait(20)
        except subprocess.TimeoutExpired: server.kill()


def shutdown(*_):
    stop_server(); sys.exit(0)


signal.signal(signal.SIGTERM, shutdown)
signal.signal(signal.SIGINT, shutdown)

refresh()
if not os.path.exists(gtfs_update.OUT):
    sys.exit('no timetable: the first download failed, see above')

server = start_server()
while True:
    due = next_refresh()
    log(f'next timetable check {due:%Y-%m-%d %H:%M}')
    while datetime.now(TZ) < due:
        if server.poll() is not None: sys.exit(f'server.py exited with {server.returncode}')
        time.sleep(15)
    if refresh():
        log('restarting server on the new timetable')
        stop_server(); server = start_server()
