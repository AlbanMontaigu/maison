# Single-container deploy: nginx serves the frontend from the image, the live
# data from a mounted volume, and proxies /api/ to the comfort API on the mac.
# Nothing is built, nothing is compiled -- the page is vanilla HTML/CSS/JS, and
# the proxy is nginx itself rather than a second process to supervise.
FROM nginx:1.27-alpine

# Rendered at start-up by the image's envsubst hook, because the config now
# carries the comfort API's URL and bearer -- neither of which may be baked
# into a public image.
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.d/ /docker-entrypoint.d/
COPY frontend/ /usr/share/nginx/html/

# Human-readable build timestamp, shown in the footer so a deployed instance
# can be told apart from another at a glance (same trick as flip7).
RUN date -u "+%d/%m/%Y %H:%M UTC" > /usr/share/nginx/html/build.txt

# The dashboard payload is NOT baked into the image: it changes every 10 min and
# is pushed here over ssh by comfort-dashboard-export.py on the mac. Mount the
# host directory that receives it on /data (see Coolify > Storages).
RUN mkdir -p /data && echo '{"error":"no data pushed yet"}' > /data/data.json

EXPOSE 80
