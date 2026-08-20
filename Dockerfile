# Static single-container deploy: nginx serves the frontend from the image and
# the live data from a mounted volume. Nothing is built, nothing is compiled --
# the page is vanilla HTML/CSS/JS, like the other apps on this Coolify.
FROM nginx:1.27-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY frontend/ /usr/share/nginx/html/

# Human-readable build timestamp, shown in the footer so a deployed instance
# can be told apart from another at a glance (same trick as flip7).
RUN date -u "+%d/%m/%Y %H:%M UTC" > /usr/share/nginx/html/build.txt

# The dashboard payload is NOT baked into the image: it changes every 10 min and
# is pushed here over ssh by comfort-dashboard-export.py on the mac. Mount the
# host directory that receives it on /data (see Coolify > Storages).
RUN mkdir -p /data && echo '{"error":"no data pushed yet"}' > /data/data.json

EXPOSE 80
