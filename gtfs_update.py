#!/usr/bin/env python3
"""Fetch the newest Swiss GTFS timetable and rebuild gtfs/basel.json when it has changed.

opentransportdata.swiss publishes one dataset per timetable year (timetable-2026-gtfs2020, …) and refreshes it
twice a week; its /permalink redirects to the newest zip. A timetable year starts with the December timetable
change (second Sunday of December), so from that day on the next year's dataset is used.

Usage: python3 gtfs_update.py        (writes gtfs/basel.json, or $GTFS_DIR/basel.json)
Exit code 0 also when the timetable was already current.
"""
import os, shutil, subprocess, sys, tempfile, time, urllib.error, urllib.request
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get('GTFS_DIR') or os.path.join(HERE, 'gtfs')
OUT = os.path.join(DATA, 'basel.json')
SOURCE = os.path.join(DATA, 'source.txt')   # file name of the zip basel.json was built from
PERMALINK = 'https://data.opentransportdata.swiss/dataset/timetable-{}-gtfs2020/permalink'
HEADERS = {'User-Agent': 'basel-live-gtfs-update'}   # the portal rejects urllib's default agent
log = lambda *a: print(time.strftime('%H:%M:%S'), 'gtfs:', *a, file=sys.stderr, flush=True)


def timetable_year(d: date) -> int:
    dec1 = date(d.year, 12, 1)
    second_sunday = dec1 + timedelta(days=(6 - dec1.weekday()) % 7 + 7)
    return d.year + 1 if d >= second_sunday else d.year


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None


def newest_zip_url(year: int) -> str:
    try:
        urllib.request.build_opener(_NoRedirect).open(urllib.request.Request(PERMALINK.format(year), headers=HEADERS), timeout=30)
    except urllib.error.HTTPError as e:
        if e.code in (301, 302, 303, 307, 308): return e.headers['Location']
        raise
    raise RuntimeError(f'permalink for {year} did not redirect to a zip')


def update() -> bool:
    """Returns True when basel.json was (re)built, False when it was already current."""
    url = newest_zip_url(timetable_year(datetime.now(ZoneInfo('Europe/Zurich')).date()))
    name = url.rsplit('/', 1)[1]
    try: current = open(SOURCE).read().strip()
    except FileNotFoundError: current = None
    if current == name and os.path.exists(OUT):
        log(f'{name} is current'); return False

    os.makedirs(DATA, exist_ok=True)
    # work next to the output so the final rename is atomic; the zip (~290 MB) is deleted with the temp dir
    with tempfile.TemporaryDirectory(dir=DATA, prefix='.update-') as tmp:
        os.makedirs(os.path.join(tmp, 'gtfs'))
        zip_path = os.path.join(tmp, 'gtfs.zip')
        log(f'downloading {name} …')
        with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=60) as r, open(zip_path, 'wb') as f:
            shutil.copyfileobj(r, f, 1 << 20)
        log(f'downloaded {os.path.getsize(zip_path) / 1e6:.0f} MB, filtering to BVB + BLT …')
        subprocess.run([sys.executable, os.path.join(HERE, 'prepare_gtfs.py'), zip_path], cwd=tmp, check=True)
        os.replace(os.path.join(tmp, 'gtfs', 'basel.json'), OUT)
    with open(SOURCE, 'w') as f: f.write(name + '\n')
    log(f'basel.json rebuilt from {name}')
    return True


if __name__ == '__main__':
    update()
