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
const VIEW_KEY = 'maison.view';
// Alpha of a passive action (waiting, out of occupancy) on the decision track.
const PASSIVE_OP = .45;

let payload = null;
// 'day' | 'week'. The day is the default because that is the question actually
// being asked ("what is the house doing today"); the week is the one you open
// on purpose, so it is a click away and remembered across visits.
let view = localStorage.getItem(VIEW_KEY) === 'week' ? 'week' : 'day';
// The slice the current view renders: filled by render(), read by the tooltip.
let viewT = [];
const frames = new Map();

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

// Occupancy phases, straight from the engine's own vocabulary. 'off' draws
// nothing on purpose: an empty room is an empty bar, which reads faster than
// any colour would.
const OCC_META = {
  window:  { fill: 'var(--occ)',  op: .95, label: 'occupée' },
  precool: { fill: 'var(--cool)', op: .70, label: 'pré-refroidissement' },
  always:  { fill: 'var(--occ)',  op: .40, label: 'permanente' },
  off:     { fill: null,                   label: 'vide' },
};
const occMeta = (v) => OCC_META[v] || { fill: null, label: v || '—' };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── chart ───────────────────────────────────────────────────────────────── */

function chartSvg(f, t, marks) {
  const n = t.length;
  const T = f.T, bmin = f.bmin, bmax = f.bmax, out = f.out;

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

  // Same marks as the axis under the strips: midnights over a week, every
  // third hour over a day. Drawing them from one shared list is what keeps the
  // gridlines and the labels on the same pixels.
  let seps = '';
  for (const [i] of marks) {
    seps += `<line x1="${x(i).toFixed(1)}" y1="0" x2="${x(i).toFixed(1)}" y2="${PLOT_H}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }

  return `<svg class="chart" viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" aria-hidden="true">
    ${seps}
    ${bandPath ? `<path d="${bandPath}" fill="var(--band-fill)"/>` : ''}
    <path d="${line(out)}" fill="none" stroke="var(--ink-dim)" stroke-width="1" stroke-dasharray="3 3" opacity=".55" vector-effect="non-scaling-stroke"/>
    <path d="${line(T)}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
  </svg>`;
}

// One row per actuator, all on the chart's x axis. A single mixed strip could
// only ever show the engine's winning action, so a fan running under a running
// AC was invisible; one track per type is the whole point of this block.
//
// Consecutive equal values are merged into one rect: a flat day is a handful of
// nodes rather than a thousand, which is what keeps twelve tracks cheap.
function trackSvg(name, values, style) {
  const n = values.length;
  if (!n) return '';
  let rects = '', i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && values[j] === values[i]) j++;
    const st = style(values[i]);
    if (st && st.fill) {
      const h = st.h == null ? STRIP_H : st.h;
      rects += `<rect x="${((i / n) * PLOT_W).toFixed(2)}" y="${(STRIP_H - h).toFixed(2)}"`
        + ` width="${Math.max(((j - i) / n) * PLOT_W, 0.4).toFixed(2)}" height="${h.toFixed(2)}"`
        + ` fill="${st.fill}" opacity="${st.op == null ? 0.95 : st.op}"/>`;
    }
    i = j;
  }
  return `<svg class="strip" data-track="${name}" viewBox="0 0 ${PLOT_W} ${STRIP_H}" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}

function trackRow(label, hint, svg) {
  return `<div class="track"><span class="tlab" title="${esc(hint || label)}">${esc(label)}</span>`
    + `<div class="tbar">${svg}</div></div>`;
}

// Time labels under the tracks, from the same mark list the gridlines use.
function axisHtml(t, marks) {
  const n = t.length;
  if (n < 2 || !marks.length) return '';
  return `<div class="axis">${marks.map(([i, l]) =>
    `<span style="left:${((i / (n - 1)) * 100).toFixed(2)}%">${esc(l)}</span>`).join('')}</div>`;
}

/* ── zone card ───────────────────────────────────────────────────────────── */

function deviceChip(name, dev) {
  if (!dev) return '';
  const failed = dev.fail_streak > 0 || dev.off_fail_streak > 0;
  const cls = failed ? 'fail' : dev.on ? 'on' : '';
  const since = dev.since ? ` · ${ago(dev.since)}` : '';
  return `<span class="dev ${cls}">${name} ${dev.on ? 'on' : 'off'}${since}${failed ? ' ⚠️' : ''}</span>`;
}

function zoneCard(zone, f, t, marks) {
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
    </div>
    ${c.reason ? `<div class="why">${esc(c.reason)}</div>` : ''}
    <div class="devs">${devs}</div>
    ${chartSvg(f, t, marks)}
    <div class="tracks">
      ${trackRow('décision', "L'action retenue par le moteur à ce tick — une seule par tick", trackSvg('act', f.act, (a) => a ? { fill: colorFor(a), op: meta(a).active || isAlert(a) ? .95 : PASSIVE_OP } : null))}
      ${trackRow('occupation', "Phase d'occupation de la zone", trackSvg('occ', f.occ, (v) => occMeta(v)))}
      ${zone.has_ac ? trackRow('clim', 'Clim en marche sous pilotage du moteur', trackSvg('ac', f.ac, (v) => v ? { fill: 'var(--cool)' } : null)) : ''}
      ${zone.has_fan ? trackRow('ventilo', 'Ventilo en marche sous pilotage du moteur', trackSvg('fan', f.fan, (v) => v ? { fill: 'var(--fan)' } : null)) : ''}
      ${zone.has_velux ? trackRow('volet', "Ouverture du volet — hauteur de la barre = % ouvert", trackSvg('velux', f.velux, (v) => v == null ? null : { fill: 'var(--velux)', op: .8, h: Math.max(1.5, (v / 100) * STRIP_H) })) : ''}
      ${axisHtml(t, marks)}
    </div>
  </section>`;
}

/* ── render ──────────────────────────────────────────────────────────────── */

// Index range of the current view. "Day" is the calendar day (house time) of
// the most recent tick, not a rolling 24 h: a rolling window would put two
// different mornings side by side, which is not how anyone reads a day.
function viewRange(t) {
  if (view === 'week' || !t.length) return [0, t.length];
  const k = dayKey(t[t.length - 1]);
  let i = t.length;
  while (i > 0 && dayKey(t[i - 1]) === k) i--;
  return [i, t.length];
}

// Where the gridlines and the time labels go, computed once for every zone.
function viewMarks(t) {
  const marks = [];
  if (view === 'week') {
    for (let i = 1; i < t.length; i++) {
      if (dayKey(t[i]) !== dayKey(t[i - 1])) marks.push([i, dayLabel(t[i])]);
    }
  } else {
    let last = -1;
    for (let i = 0; i < t.length; i++) {
      const h = Number(parts(t[i]).hour);
      if (h % 3 === 0 && h !== last) { marks.push([i, `${String(h).padStart(2, '0')}h`]); last = h; }
    }
  }
  return marks;
}

// The payload ships every track run-length encoded over the full window; the
// view slices them. Held in `frames` so the tooltip reads exactly what is drawn
// -- computing it twice is how an off-by-one between chart and readout starts.
function frameFor(zone, n, i0, i1) {
  const ser = zone.series || {};
  const cut = (rleArr) => expand(rleArr || [], n).slice(i0, i1);
  return {
    T: (ser.T || []).slice(i0, i1),
    out: (payload.outdoor?.T || []).slice(i0, i1),
    bmin: cut(ser.bmin), bmax: cut(ser.bmax),
    act: expand(zone.runs || [], n).slice(i0, i1),
    // Optional: a container still serving a payload from before the tracks
    // were exported must degrade to empty rows, not to a broken page.
    occ: cut(ser.occ), ac: cut(ser.ac), fan: cut(ser.fan), velux: cut(ser.velux),
  };
}

function render() {
  const all = payload.t || [];
  const [i0, i1] = viewRange(all);
  const t = all.slice(i0, i1);
  const marks = viewMarks(t);
  viewT = t;
  frames.clear();
  const eng = payload.engine || {};

  for (const b of document.querySelectorAll('.seg button')) {
    b.classList.toggle('on', b.dataset.view === view);
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  }

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
    ? payload.zones.map((z) => {
      const f = frameFor(z, all.length, i0, i1);
      frames.set(z.name, f);
      return zoneCard(z, f, t, marks);
    }).join('')
    : '<p class="empty">Aucune zone dans les données.</p>';

  $('legend').innerHTML = [['var(--cool)', 'froid / clim'], ['var(--warm)', 'chaud'],
    ['var(--fan)', 'ventilo'], ['var(--occ)', 'occupation'],
    ['var(--velux)', 'volet'], ['var(--alert)', 'échec'],
    ['var(--band)', 'bande de confort']]
    .map(([c, l]) => `<span><i style="background:${c}"></i>${l}</span>`).join('');

  $('help-body').innerHTML = helpHtml();

  $('foot-meta').textContent =
    `${view === 'day' ? 'jour' : payload.window_days + ' j'} · ${t.length} ticks`
    + ` · export ${hhmm(Math.floor(new Date(payload.generated_at).getTime() / 1000))}`;
}

// The legend is built from the payload, not written here: it lists the action
// codes that actually occur in the current window, with the engine's own emoji
// and wording. A hand-written list would drift the day an action is added --
// and would name actions this house never takes.
function helpHtml() {
  // Keyed by what the reader sees, not by the action code: several codes share
  // one wording (IDLE and VELUX_HOLD are both "ok"), and they draw the same
  // rect -- listing them twice would ask the reader to tell apart two identical
  // entries.
  const seen = new Map();
  for (const z of payload.zones || []) {
    for (const [a, c] of z.runs || []) {
      if (!a) continue;
      const m = meta(a);
      const key = `${m.emoji}|${m.label}|${colorFor(a)}`;
      const cur = seen.get(key) || { m, color: colorFor(a), n: 0 };
      cur.n += c;
      seen.set(key, cur);
    }
  }
  const actions = [...seen.values()].sort((a, b) => b.n - a.n)
    .map((e) => `<span class="chip"><i style="background:${e.color}"></i>${e.m.emoji} ${esc(e.m.label)}</span>`)
    .join('');

  const occ = ['window', 'always', 'precool', 'off'].map((k) => {
    const m = occMeta(k);
    return `<span class="chip"><i style="background:${m.fill || 'var(--card-2)'};opacity:${m.op == null ? 1 : m.op}"></i>${esc(m.label)}</span>`;
  }).join('');

  return `
    <h3>La courbe</h3>
    <p>Trait plein : la température de la pièce. Pointillés : la température
    extérieure. Le fond vert est la bande de confort visée — elle n'est pas
    plate, elle suit le programme jour / nuit de la zone. La jauge sous le titre
    montre où la pièce se situe dans sa bande à l'instant présent.</p>

    <h3>Les pistes</h3>
    <p>Chaque ligne est une lecture verticale du même axe de temps que la courbe.
    Survoler une ligne (ou y poser le doigt) affiche une bulle propre à
    <em>cette</em> ligne : sa valeur à cet instant, et depuis quand elle dure.</p>
    <ul>
      <li><b>décision</b> — ce que le moteur a retenu à ce tick, <em>une seule
      action à la fois</em>. C'est la ligne qui porte le pourquoi (le texte au
      dessus de la courbe) et les échecs de driver. Bleu : action de
      refroidissement. Orange : de chauffage. Gris : neutre. Rouge : échec.
      Translucide : action passive (en attente, hors occupation).</li>
      <li><b>occupation</b> — la phase d'occupation de la zone. Une case vide
      est une pièce inoccupée.</li>
      <li><b>clim</b> / <b>ventilo</b> — barre pleine = appareil en marche
      <em>sous pilotage du moteur</em>. C'est le seul état que le moteur
      enregistre : un appareil allumé à la main n'apparaît pas ici.</li>
      <li><b>volet</b> — la hauteur de la barre est le pourcentage d'ouverture.
      Barre pleine = grand ouvert, ligne fine = fermé.</li>
    </ul>

    <h3>Occupation</h3>
    <div class="chips">${occ}</div>

    <h3>Actions vues sur cette fenêtre</h3>
    <div class="chips">${actions || '<span class="chip">aucune</span>'}</div>

    <h3>Le reste</h3>
    <ul>
      <li><b>Jour / 7 j</b> — « Jour » est le jour calendaire en cours de la
      maison, pas les 24 dernières heures. Le choix est retenu d'une visite à
      l'autre.</li>
      <li><b>tick 12:05</b> en haut à droite : l'heure du dernier passage du
      moteur. La pastille passe au rouge s'il se tait.</li>
      <li><b>clim off · 7 h</b> sous la ligne d'action : depuis combien de temps
      l'appareil est dans cet état. Un ⚠️ signale un driver qui refuse.</li>
      <li>La page se rafraîchit toute seule chaque minute ; la maison, elle,
      exporte toutes les 10 minutes.</li>
    </ul>`;
}

function bindView() {
  $('view').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (!b || b.dataset.view === view) return;
    view = b.dataset.view;
    localStorage.setItem(VIEW_KEY, view);
    if (payload) render();
  });
}

/* ── hover readout ───────────────────────────────────────────────────────── */

// Extent of the run the pointer is standing in. A strip's whole point is that
// a value lasts: "clim en marche" answers less than "en marche depuis 06:20".
function runAt(values, i) {
  let a = i, b = i;
  while (a > 0 && values[a - 1] === values[i]) a--;
  while (b < values.length - 1 && values[b + 1] === values[i]) b++;
  return [a, b];
}

// Over a week a run starts on another day, and a bare "06:20" would then be a
// lie by omission -- the day is spelled out unless it is the hovered one.
function stamp(e, ref) {
  return dayKey(e) === dayKey(ref) ? hhmm(e) : `${dayLabel(e)} ${hhmm(e)}`;
}

function runSpan(values, i, t) {
  const [a, b] = runAt(values, i);
  const open = b >= t.length - 1;   // still running: a start, no end
  // A run touching index 0 began before the window -- "depuis 00:05" would then
  // be the edge of the *view*, not of the run, and the day view would shorten
  // every overnight run by construction.
  if (a === 0) return open ? 'toute la période affichée' : `au moins jusqu'à ${stamp(t[b + 1], t[i])}`;
  const from = stamp(t[a], t[i]);
  return open ? `depuis ${from}` : `${from} → ${stamp(t[b + 1], t[i])}`;
}

// One bubble per row, saying what THAT row shows. A single readout repeating
// every track under every row made the pointer position meaningless: whichever
// line you were on, you got the same block and had to find your line in it.
function tipFor(track, f, i, t) {
  const dim = (x) => `<span class="dim">${x}</span>`;
  switch (track) {
    case 'act': {
      const m = meta(f.act[i]);
      if (!f.act[i]) return 'pas de décision enregistrée';
      return `${m.emoji} ${esc(m.label)}<br>${dim(runSpan(f.act, i, t))}`;
    }
    case 'occ': {
      if (f.occ[i] == null) return 'occupation inconnue';
      return `occupation : ${esc(occMeta(f.occ[i]).label)}<br>${dim(runSpan(f.occ, i, t))}`;
    }
    case 'ac':
    case 'fan': {
      const v = f[track][i];
      if (v == null) return 'pas de mesure';
      const noun = track === 'ac' ? 'clim' : 'ventilo';
      const state = v ? 'en marche' : (track === 'ac' ? 'arrêtée' : 'arrêté');
      return `${noun} ${state}<br>${dim(runSpan(f[track], i, t))}`
        + (v ? `<br>${dim('sous pilotage du moteur')}` : '');
    }
    case 'velux': {
      if (f.velux[i] == null) return 'pas de position connue';
      return `volet ${f.velux[i]}% ouvert<br>${dim(runSpan(f.velux, i, t))}`;
    }
    default: {
      const temp = f.T[i], lo = f.bmin[i], hi = f.bmax[i];
      return `${temp != null ? `<b>${temp.toFixed(1)}°</b>` : 'pas de mesure'}`
        + `${f.out[i] != null ? ` · ext ${f.out[i].toFixed(1)}°` : ''}`
        + `${lo != null && hi != null ? `<br>${dim(`bande ${lo}–${hi}°`)}` : ''}`;
    }
  }
}

function bindTip() {
  const tip = $('tip');
  $('zones').addEventListener('pointermove', (ev) => {
    const card = ev.target.closest('.zone');
    const svg = ev.target.closest('.chart, .strip');
    if (!card || !svg || !payload) { tip.hidden = true; return; }
    const f = frames.get(card.dataset.zone);
    const t = viewT;
    if (!f || !t.length) return;

    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(t.length - 1,
      Math.round(((ev.clientX - r.left) / r.width) * (t.length - 1))));

    tip.innerHTML = `<b>${dayLabel(t[i])} ${hhmm(t[i])}</b><br>`
      + tipFor(svg.dataset.track || 'chart', f, i, t);
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

bindView();
bindTip();
load();
setInterval(load, REFRESH_MS);
// Coming back to a backgrounded tab must show now, not the last poll.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
