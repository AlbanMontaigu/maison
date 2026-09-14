# CLAUDE.md

Guidance for Claude Code (or any coding agent) working in this repository.

## What this is

The frontend of a home comfort dashboard: a single static page (no build
step) showing the state of each room and 7 days of history, served by nginx,
which also proxies a handful of control buttons to a private API on the
house's own machine. Read `README.md` first — it documents the two data
flows (pushed telemetry, proxied directives) and the reasoning behind most
of the non-obvious choices in this repo. Do not re-derive that reasoning;
extend it.

## Structure

```
Dockerfile                              nginx:alpine image, no build stage
nginx.conf.template                     rendered by envsubst at container start
docker-entrypoint.d/
  25-require-comfort-env.sh             refuses to boot without required env vars
frontend/
  index.html
  css/app.css
  js/app.js                             all client logic, vanilla JS
```

There is no backend code in this repo. `comfort-engine.py`,
`comfort-dashboard-export.py`, `comfort-api.py` and `comfort-directive.py`
live on the house machine and are out of scope here — this repo only knows
the JSON shape they produce/accept.

## Conventions

- **Interface text is French; code, identifiers, comments and commit
  messages are otherwise in English** — except commit messages, which are
  in French (see `git log`; e.g. `Théa : école et non plus crèche`). Match
  whichever file/context you're in.
- **Commit messages explain why, not just what**, often at some length —
  this codebase treats commit messages as the place non-obvious design
  decisions get recorded. Follow that when the change isn't self-evident.
- **No build step.** The frontend is vanilla HTML/CSS/JS on purpose — don't
  introduce a bundler, framework, or package.json without a real reason.
- **This repo is public.** Never hardcode zone names, real hostnames/IPs,
  tokens, or anything else specific to the house — that all comes from the
  pushed payload (`data.json`) or from environment variables at deploy time.
- **The page holds no domain knowledge.** Zone names, comfort bands, and the
  action vocabulary (labels, emojis) all come from the JSON payload, not
  from the code. If you find yourself hardcoding a zone name or action label
  in `app.js`, that's very likely a payload change instead.
- **Two independent authorities, don't merge them.** nginx does not validate
  directives — the API on the mac owns the allowlist of verbs. Don't add a
  second validation layer here; it can only drift from the first.
- Required env vars: `COMFORT_API_URL`, `COMFORT_API_TOKEN`. The entrypoint
  script crashes the container on boot if either is missing — keep that
  behavior, since a container that boots with an empty bearer looks healthy
  while every button silently 401s.

## Working locally

```sh
docker build -t maison . && docker run --rm -p 8080:80 -v "$PWD/sample:/data" maison
```

or, frontend-only, no Docker:

```sh
cd frontend && python3 -m http.server 8899   # needs a data.json alongside
```

There is no test suite. Verify changes by building the image (the Dockerfile
has build-time checks — e.g. the cache-busting `sed` asserts its own
substitution happened) and/or loading the page against a sample
`data.json`.

## Before editing

1. Read `README.md` — most "why" questions about this repo are answered
   there (push-only data, proxy-only backend, why `index.html` must never
   be cached, why zone/action data live in the payload).
2. Check whether a change to `frontend/js/app.js` implies a matching change
   on the API/engine side (outside this repo) — e.g. new `cmd` verbs or
   renamed fields need the house-side API to already understand them, since
   this repo deploys independently.
3. `git status` should be clean before you start; this repo has no staging
   branch, commits go straight to `main` and to production via Coolify.
