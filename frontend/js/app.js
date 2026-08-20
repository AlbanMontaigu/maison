/* Maison — comfort dashboard.
 *
 * Reads one payload (/data.json) pushed every 10 min by the house engine and
 * renders it. Deliberately dependency-free and build-free: no framework, no
 * CDN, no bundler. The page must keep working years from now with nothing to
 * upgrade, and it must stay readable to whoever opens it next.
 *
 * The page knows nothing about the house: zone names, comfort bands, action
 * labels and emojis all come from the payload. That is what lets this repo be
 * public while the house stays private.
 */

const REFRESH_MS = 60_000;
const PLOT_W = 1000, PLOT_H = 110, STRIP_H = 14;

let payload = null;

const $ = (id) => document.getElementById(id);

/* ── helpers ─────────────────────────────────────────────────────────────── */

// [[v,3],[w,1]] -> [v,v,v,w]. Bands and actions are near-constant for hours,
// so the payload ships them run-length encoded.
function expand(rle, n) {
  const out = [];
  for (const [v, c] of rle) for (let i = 0; i < c; i++) out.push(v);
  while (out.length < n) out.push(null);
  return out;
}

// Render in the house's timezone, not the reader's: "22:05" must mean 22:05 at
// home even when the phone is abroad. Intl with the IANA zone rather than a
// fixed offset -- a 7-day window can straddle a DST change, and a single offset
// would shift half the curve by an hour against local-time occupancy bands.
let _fmt = null, _fmtTz = null;
function parts(epochS) {
  const tz = payload?.tz || 'Europe/Paris';
  // One formatter, reused: dayKey alone runs once per tick per zone (~6000
  // calls a render), and building an Intl.DateTimeFormat is not cheap.
  if (!_fmt || _fmtTz !== tz) {
    _fmtTz = tz;
    _fmt = new Intl.DateTimeFormat('fr-FR', {
      timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    });
  }
  const o = {};
  for (const p of _fmt.formatToParts(new Date(epochS * 1000))) o[p.type] = p.value;
  return o;
}
const hhmm = (e) => { const p = parts(e); return `${p.hour}:${p.minute}`; };
const dayKey = (e) => { const p = parts(e); return `${p.year}-${p.month}-${p.day}`; };
const dayLabel = (e) => { const p = parts(e); return `${p.weekday} ${Number(p.day)}`; };

function ago(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}

function meta(action) {
  return (payload?.actions || {})[action] || { emoji: '·', dir: 'neutral', active: false, label: action || '—' };
}

// An action whose label announces a driver failure is not a state, it is a
// problem: it gets the alert colour everywhere it is drawn.
const isAlert = (a) => /FAIL|RETRY/.test(a || '');

function colorFor(action) {
  if (!action) return 'transparent';
  if (isAlert(action)) return 'var(--alert)';
  const m = meta(action);
  const base = m.dir === 'cool' ? 'var(--cool)' : m.dir === 'warm' ? 'var(--warm)' : 'var(--neutral)';
  return base;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── chart ───────────────────────────────────────────────────────────────── */

function chartSvg(zone, t) {
  const n = t.length;
  const T = zone.series.T;
  const bmin = expand(zone.series.bmin, n);
  const bmax = expand(zone.series.bmax, n);
  const out = payload.outdoor.T;

  const vals = [];
  for (let i = 0; i < n; i++) {
    for (const v of [T[i], bmin[i], bmax[i], out[i]]) if (v != null) vals.push(v);
  }
  if (!vals.length) return '';
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 2) { hi += 1; lo -= 1; }
  const pad = (hi - lo) * 0.08;
  lo -= pad; hi += pad;

  const x = (i) => (i / Math.max(1, n - 1)) * PLOT_W;
  const y = (v) => PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;

  // Comfort band as an envelope: it moves with the day/night schedule, so it
  // has to be drawn per point, not as one flat rectangle.
  let top = '', bot = '';
  for (let i = 0; i < n; i++) {
    if (bmax[i] == null) continue;
    top += `${top ? 'L' : 'M'}${x(i).toFixed(1)},${y(bmax[i]).toFixed(1)}`;
  }
  for (let i = n - 1; i >= 0; i--) {
    if (bmin[i] == null) continue;
    bot += `L${x(i).toFixed(1)},${y(bmin[i]).toFixed(1)}`;
  }
  const bandPath = top && bot ? `${top}${bot}Z` : '';

  const line = (arr) => {
    let d = '', pen = false;
    for (let i = 0; i < n; i++) {
      if (arr[i] == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(arr[i]).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  // One separator per midnight, so seven days read as seven days.
  let seps = '';
  for (let i = 1; i < n; i++) {
    if (dayKey(t[i]) !== dayKey(t[i - 1])) {
      seps += `<line x1="${x(i).toFixed(1)}" y1="0" x2="${x(i).toFixed(1)}" y2="${PLOT_H}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
    }
  }

  return `<svg class="chart" viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" aria-hidden="true">
    ${seps}
    ${bandPath ? `<path d="${bandPath}" fill="rgba(70,209,139,.13)"/>` : ''}
    <path d="${line(out)}" fill="none" stroke="var(--ink-dim)" stroke-width="1" stroke-dasharray="3 3" opacity=".55" vector-effect="non-scaling-stroke"/>
    <path d="${line(T)}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// The action strip below each chart: what the engine was doing, minute by
// minute, on the same x axis as the curve.
function stripSvg(zone, n) {
  let i = 0, rects = '';
  for (const [action, count] of zone.runs) {
    if (action) {
      const w = (count / n) * PLOT_W;
      rects += `<rect x="${((i / n) * PLOT_W).toFixed(2)}" y="0" width="${Math.max(w, 0.4).toFixed(2)}" height="${STRIP_H}" fill="${colorFor(action)}" opacity="${meta(action).active || isAlert(action) ? 0.95 : 0.3}"/>`;
    }
    i += count;
  }
  return `<svg class="strip" viewBox="0 0 ${PLOT_W} ${STRIP_H}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}

/* ── zone card ───────────────────────────────────────────────────────────── */

function deviceChip(name, dev) {
  if (!dev) return '';
  const failed = dev.fail_streak > 0 || dev.off_fail_streak > 0;
  const cls = failed ? 'fail' : dev.on ? 'on' : '';
  const since = dev.since ? ` · ${ago(dev.since)}` : '';
  return `<span class="dev ${cls}">${name} ${dev.on ? 'on' : 'off'}${since}${failed ? ' ⚠️' : ''}</span>`;
}

function zoneCard(zone, t) {
  const c = zone.current;
  const m = meta(c.action);
  const band = c.band || {};
  const hasBand = band.min != null && band.max != null;

  // Gauge: position inside the band, clamped. Outside the band the marker
  // pins to the edge and the temperature colours itself instead.
  let gauge = '';
  if (hasBand && c.T != null) {
    const span = Math.max(1, band.max - band.min);
    const lo = band.min - span * 0.35, hi = band.max + span * 0.35;
    const pct = (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
    gauge = `<div class="gauge">
        <span class="in" style="left:${pct(band.min).toFixed(1)}%;right:${(100 - pct(band.max)).toFixed(1)}%"></span>
        <span class="cur" style="left:${pct(c.T).toFixed(1)}%"></span>
      </div>
      <div class="gauge-lab"><span>${band.min}°</span><span>${esc(c.band_name || '')}</span><span>${band.max}°</span></div>`;
  }

  const tempCls = hasBand && c.T != null ? (c.T > band.max ? 'hot' : c.T < band.min ? 'cold' : '') : '';
  const devs = [deviceChip('clim', c.ac), deviceChip('ventilo', c.fan),
    c.velux != null ? `<span class="dev ${c.velux > 0 ? 'on' : ''}">volet ${c.velux}%${c.velux_since ? ' · ' + ago(c.velux_since) : ''}</span>` : ''].join('');

  const sub = [];
  if (!zone.has_ac && !zone.has_fan && !zone.has_velux) sub.push('observation seule');
  if (c.occupancy_phase === 'off' && c.occ_next_start) sub.push(`occupée à ${esc(c.occ_next_start)}`);
  if (c.directive) sub.push(`directive : ${esc(c.directive)}`);
  if (c.day_peak != null) sub.push(`pic du jour ${c.day_peak}°`);

  return `<section class="zone" data-zone="${esc(zone.name)}">
    <div class="zone-head">
      <div>
        <div class="zone-name">${esc(zone.name)}</div>
        <div class="zone-sub">${sub.join(' · ')}</div>
      </div>
      <div class="zone-temp ${tempCls}">${c.T != null ? c.T.toFixed(1) : '—'}<small>°C</small></div>
    </div>
    ${gauge}
    <div class="action ${m.active ? 'is-active' : ''} ${isAlert(c.action) ? 'is-alert' : ''}">
      <span class="emo">${m.emoji}</span><span class="lab">${esc(m.label)}</span>
      <span class="why">— ${esc(c.reason || '')}</span>
    </div>
    <div class="devs">${devs}</div>
    ${chartSvg(zone, t)}
    ${stripSvg(zone, t.length)}
  </section>`;
}

/* ── render ──────────────────────────────────────────────────────────────── */

function render() {
  const t = payload.t || [];
  const eng = payload.engine || {};

  const engEl = $('engine');
  engEl.textContent = eng.stale
    ? `moteur muet depuis ${ago(eng.last_run) || '?'}`
    : `tick ${eng.last_run ? hhmm(Math.floor(new Date(eng.last_run).getTime() / 1000)) : '—'}`;
  engEl.className = 'pill ' + (eng.stale ? 'stale' : 'fresh');

  const oT = payload.outdoor?.T || [], oS = payload.outdoor?.solar || [];
  const lastIdx = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i; return -1; };
  const iO = lastIdx(oT), iS = lastIdx(oS);
  $('outdoor').textContent = `extérieur ${iO >= 0 ? oT[iO].toFixed(1) + '°' : '—'}` + (iS >= 0 ? ` · soleil ${Math.round(oS[iS])}` : '');

  $('zones').innerHTML = payload.zones.length
    ? payload.zones.map((z) => zoneCard(z, t)).join('')
    : '<p class="empty">Aucune zone dans les données.</p>';

  $('legend').innerHTML = [['var(--cool)', 'froid'], ['var(--warm)', 'chaud'],
    ['var(--neutral)', 'neutre'], ['var(--alert)', 'échec'],
    ['rgba(70,209,139,.4)', 'bande de confort']]
    .map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');

  $('foot-meta').textContent =
    `${payload.window_days} j · ${t.length} ticks · export ${hhmm(Math.floor(new Date(payload.generated_at).getTime() / 1000))}`;
}

/* ── hover readout ───────────────────────────────────────────────────────── */

function bindTip() {
  const tip = $('tip');
  $('zones').addEventListener('pointermove', (ev) => {
    const card = ev.target.closest('.zone');
    const svg = ev.target.closest('.chart, .strip');
    if (!card || !svg || !payload) { tip.hidden = true; return; }
    const zone = payload.zones.find((z) => z.name === card.dataset.zone);
    const t = payload.t;
    if (!zone || !t.length) return;

    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(t.length - 1,
      Math.round(((ev.clientX - r.left) / r.width) * (t.length - 1))));

    const acts = expand(zone.runs, t.length);
    const m = meta(acts[i]);
    const temp = zone.series.T[i];
    tip.innerHTML = `<b>${dayLabel(t[i])} ${hhmm(t[i])}</b><br>`
      + `${temp != null ? temp.toFixed(1) + '°' : 'pas de mesure'}`
      + `${payload.outdoor.T[i] != null ? ` · ext ${payload.outdoor.T[i].toFixed(1)}°` : ''}<br>`
      + `${m.emoji} ${esc(m.label)}`;
    tip.hidden = false;
    // Keep the readout on screen near the right edge of a phone.
    const w = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, ev.clientX - w / 2)) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + 'px';
  });
  $('zones').addEventListener('pointerleave', () => { tip.hidden = true; });
}

/* ── load loop ───────────────────────────────────────────────────────────── */

async function load() {
  try {
    const res = await fetch('data.json', { cache: 'no-store' });
    // 204 = the container is up but nothing has been pushed yet. That is a
    // waiting state, not an error, and it must not blank an existing view.
    if (res.status === 204) {
      if (!payload) $('zones').innerHTML = '<p class="empty">En attente du premier export de la maison…</p>';
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = await res.json();
    if (payload.error) { $('zones').innerHTML = `<p class="empty">${esc(payload.error)}</p>`; payload = null; return; }
    render();
  } catch (e) {
    // A failed refresh keeps the last good view: a network blip must not erase
    // the house. Only the status pill says something is wrong.
    $('engine').textContent = 'données injoignables';
    $('engine').className = 'pill stale';
    if (!payload) $('zones').innerHTML = `<p class="empty">Données injoignables (${esc(e.message)}).</p>`;
  }
}

fetch('build.txt').then((r) => r.ok ? r.text() : '').then((v) => {
  if (v) document.title = 'Maison · Confort';
}).catch(() => {});

bindTip();
load();
setInterval(load, REFRESH_MS);
// Coming back to a backgrounded tab must show now, not the last poll.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
