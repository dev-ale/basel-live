# Two images from one file, wired together by compose.yaml:
#   app  server.py (GTFS-RT merge) plus the daily timetable refresh; reachable only inside the compose network
#   web  Caddy: HTTPS, compression, the public files, and a proxy for the three API paths

FROM python:3.13-slim AS app
RUN pip install --no-cache-dir tzdata==2025.2 \
 && useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin app \
 && mkdir -p /data && chown app /data
WORKDIR /app
COPY server.py prepare_gtfs.py gtfs_update.py docker/run.py ./
# server.py reads gtfs/basel.json next to itself; the timetable lives on the /data volume
RUN ln -s /data gtfs
USER app
ENV PYTHONUNBUFFERED=1 PORT=8765
EXPOSE 8765
CMD ["python", "run.py"]

FROM node:22-alpine AS cesium
WORKDIR /tmp
# busybox tar cannot select a directory from npm tarballs (they have no directory entries): unpack all, keep the build
RUN npm pack cesium@1.144.0 >/dev/null \
 && tar -xzf cesium-1.144.0.tgz \
 && mkdir /vendor && mv package/Build/Cesium /vendor/cesium

FROM caddy:2.10-alpine AS web
COPY docker/Caddyfile /etc/caddy/Caddyfile
# only these files are public
COPY index.html app.js vehicles3d.js world3d.js routes.json /srv/
COPY models/ /srv/models/
COPY --from=cesium /vendor/ /srv/vendor/
