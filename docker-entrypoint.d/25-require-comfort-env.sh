#!/bin/sh
# Refuse to start without the comfort API settings.
#
# Without this, a missing COMFORT_API_TOKEN renders as an empty bearer, nginx
# starts happily, and every button answers 401 -- a container that looks healthy
# while every action silently fails. Crashing here turns a config mistake into
# something Coolify shows on the first deploy.
#
# (An empty COMFORT_API_URL is caught for free: `proxy_pass ;` is a syntax
# error and nginx refuses to load. The token is the case that needs a check.)
set -e

missing=""
[ -n "$COMFORT_API_URL" ]   || missing="$missing COMFORT_API_URL"
[ -n "$COMFORT_API_TOKEN" ] || missing="$missing COMFORT_API_TOKEN"

if [ -n "$missing" ]; then
    echo "FATAL: variable(s) d'environnement manquante(s) :$missing" >&2
    echo "       (a definir dans Coolify > Environment Variables)" >&2
    exit 1
fi
