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
const PLOT_W = 1000, PLOT_H = 110, STRIP_H = 14, SUN_H = 40;
// Seuil « plein soleil » du moteur (solar_high_threshold), en W/m². Trace en
// repere sur la courbe du soleil : au-dessus, il agit sur les volets.
const SOLAR_HIGH = 150;
const VIEW_KEY = 'maison.view';
// Alpha of a passive action (waiting, out of occupancy) on the decision track.
const PASSIVE_OP = .45;

let payload = null;
// 'day' | 'week'. The day is the default because that is the question actually
// being asked ("what is the house doing today"); the week is the one you open
// on purpose, so it is a click away and remembered across visits.
// localStorage leve en navigation privee sur Safari. Un choix d'affichage non
// memorise est un desagrement ; une page blanche est une panne.
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* rien a faire */ } },
};
const VIEWS = ['yesterday', 'day', 'week'];
let view = VIEWS.includes(store.get(VIEW_KEY)) ? store.get(VIEW_KEY) : 'day';
// « Hier » et « 7 j » sont RETROSPECTIVES : la fenetre est close. Ce qui decrit
// l'instant present -- action en cours, temperature actuelle, anciennete des
// appareils -- n'y a pas sa place : ce serait dire « maintenant » sur une page
// qui parle d'avant. Elles montrent donc des agregats de fenetre.
const isRetro = () => view !== 'day';
// Zone ouverte, portee par le HASH et pas par une variable : l'URL est
// partageable, le bouton Retour du navigateur marche sans code, et un
// rafraichissement garde la piece ouverte. Le nom est celui du payload, donc
// une zone renommee ramene simplement a la vue d'ensemble.
const zoneFromHash = () => {
  const m = /^#zone=(.*)$/.exec(location.hash || '');
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
};
// The slice the current view renders: filled by render(), read by the tooltip.
let viewT = [];
// Frontiere « maintenant » du rendu courant, relue par la bulle. Posee par
// render(), donc toujours coherente avec ce qui est dessine.
let viewNowIdx = -1;
const frames = new Map();
// Pieces ayant recu une consigne depuis le chargement : nom -> instant du clic.
// Sert au SEUL retour visuel que la page puisse donner honnetement. Les courbes
// et l'etat des appareils viennent du payload pousse toutes les 10 min : ils ne
// peuvent PAS bouger tout de suite, et les faire bouger serait afficher une
// mesure inventee. Ce qu'on montre est donc autre chose -- « la consigne est
// posee » -- et ca s'efface tout seul quand le payload, devenu plus recent que
// le clic, porte enfin la nouvelle.
//
// Le libelle est volontairement court : le POURQUOI la courbe ne bouge pas
// encore est dans la reponse du moteur, affichee juste dessous dans le panneau,
// et en `title` sur la pastille pour qui survole.
const acted = new Map();
const FLASH_MS = 1600;

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

// Reference de temps du payload : « clim allumee depuis 3 h » se compte depuis
// l'export, pas depuis l'horloge du telephone qui le lit. Un mobile deregle
// affichait des durees fausses sans que rien ne le signale.
function houseNow() {
  const g = payload?.generated_at ? new Date(payload.generated_at).getTime() : NaN;
  return Number.isFinite(g) ? g : Date.now();
}

function ago(iso, ref = houseNow()) {
  if (!iso) return '';
  const s = Math.max(0, (ref - new Date(iso).getTime()) / 1000);
  // Sous la minute, l'age exact n'apprend rien -- et « 0 s » se lit comme un
  // bug. C'est aussi le filet si un horodatage depasse la reference (derive
  // d'horloge sur le mac, ou payload fige plus vieux que l'etat qu'il decrit).
  if (s < 60) return "à l'instant";
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} j`;
}

// Le moteur nomme ses actions pour un operateur : « plus de levier »,
// « actionneur bloque », « anti-cyclage » sont son vocabulaire, et il est
// partage avec les notifications Telegram -- le changer la-bas serait le
// changer partout. Le dashboard le reecrit donc chez lui, et **par code
// d'action**, jamais par ressemblance de texte : un code est un identifiant
// stable, une phrase se reformule. Un code inconnu retombe sur le libelle du
// moteur, emoji et couleur inclus.
const PLAIN_LABELS = {
  IDLE: 'rien à faire',
  VELUX_HOLD: 'rien à faire',
  OCC_OFF: 'personne dans la pièce',
  NO_ACTION_HOT: 'trop chaud, rien de plus à faire',
  NO_ACTION_COLD: 'trop froid, rien de plus à faire',
  // Volontairement GENERIQUE. Ce code est emis des qu'une directive d'agenda
  // bloque un actionneur -- une absence, mais aussi un simple « clim 2 off ».
  // L'ancien libelle disait « absence prevue » et faisait donc passer une
  // consigne ponctuelle pour un depart : le moteur, lui, nomme les deux
  // distinctement (« directive absent (motif) » contre « directive clim2_off »).
  DIRECTIVE_OFF: "appareil coupé (consigne de l'agenda)",
  AC_WAIT: 'clim en pause (protection du compresseur)',
  HEAT_WAIT: 'chauffage en pause (protection de la chaudière)',
  AC_RETRY: "clim relancée (elle n'avait pas répondu)",
  HEAT_RETRY: "chauffage relancé (il n'avait pas répondu)",
  VELUX_NIGHT_PURGE: 'volet ouvert (on fait entrer la fraîcheur)',
  VELUX_NIGHT_INSULATION: 'volet fermé (on garde la chaleur)',
  VELUX_CLOSE: 'volet fermé (on bloque le soleil)',
  VELUX_CLOSE_PREDICTIVE: 'volet fermé (avant que le soleil tape)',
  VELUX_DAY_LIGHT: 'volet ouvert (lumière du jour)',
  VELUX_OPEN: 'volet ouvert (on capte le soleil)',
  RELEASE_FAIL: "échec : l'appareil est encore allumé",
};

function meta(action) {
  const m = (payload?.actions || {})[action]
    || { emoji: '·', dir: 'neutral', active: false, label: action || '—' };
  return PLAIN_LABELS[action] ? { ...m, label: PLAIN_LABELS[action] } : m;
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

// Graduations « rondes » dans l'intervalle trace. Un pas choisi dans une liste
// fixe plutot que span/3 : 24.7, 26.4, 28.1 se lit moins vite que 25, 26, 27,
// et l'echelle doit se lire sans effort ou elle ne sert a rien.
function niceTicks(lo, hi) {
  const raw = (hi - lo) / 3;
  // Les trois plus petits pas servent a la courbe electrique, ou l'ordonnee se
  // compte en dixiemes d'euro : avec 0,5 pour plancher, une pointe a 0,65 €/h
  // n'avait qu'UNE graduation. Ils ne changent rien aux courbes de temperature,
  // qui ne les atteignent que sur une amplitude inferieure a 1,5 °C -- et la,
  // deux graduations valent mieux qu'une.
  const step = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10].find((v) => v >= raw) || 10;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
    out.push(Number(v.toFixed(2)));
  }
  return out;
}

// L'ecart entre ce qui etait prevu et ce qui a ete mesure, rempli. Deux traces
// qui se croisent demandent de suivre chacun du regard ; une surface se lit
// d'un coup, et c'est elle qui repond a « la prevision etait-elle bonne ».
// Uniquement sur les heures passees : a droite du marqueur il n'y a pas de
// mesure a opposer.
function gapArea(measured, forecast, x, y) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < measured.length; i++) {
    const a = measured[i], b = forecast[i];
    if (a == null || b == null) { cur = null; continue; }
    if (!cur) { cur = []; runs.push(cur); }
    cur.push([i, a, b]);
  }
  return runs.filter((r) => r.length > 1).map((r) => {
    let d = '';
    r.forEach(([i, a], k) => { d += (k ? 'L' : 'M') + `${x(i).toFixed(1)},${y(a).toFixed(1)}`; });
    for (let k = r.length - 1; k >= 0; k--) {
      const [i, , b] = r[k];
      d += `L${x(i).toFixed(1)},${y(b).toFixed(1)}`;
    }
    return `<path d="${d}Z" fill="var(--fc-fill)"/>`;
  }).join('');
}

function chartSvg(f, t, marks, nowIdx) {
  const n = t.length;
  const T = f.T, bmin = f.bmin, bmax = f.bmax, out = f.out;

  const outFc = (f.fc && f.fc.out) || [];
  const outPast = (f.fc && f.fc.past) || [];
  const vals = [];
  for (let i = 0; i < n; i++) {
    for (const v of [T[i], bmin[i], bmax[i], out[i], outFc[i], outPast[i]]) if (v != null) vals.push(v);
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
  for (const i of marks.lines) {
    seps += `<line x1="${x(i).toFixed(1)}" y1="0" x2="${x(i).toFixed(1)}" y2="${PLOT_H}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }

  // Ordonnee : traits dans le SVG, chiffres en HTML par-dessus. Le SVG est
  // etire horizontalement (viewBox 1000 pour ~240 px, preserveAspectRatio
  // none) -- un <text> dedans serait comprime d'un facteur 4 et illisible.
  const ticks = niceTicks(lo, hi);
  let grid = '', yLabels = '';
  ticks.forEach((v, k) => {
    grid += `<line x1="0" y1="${y(v).toFixed(1)}" x2="${PLOT_W}" y2="${y(v).toFixed(1)}"`
      + ` stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4" opacity=".8"`
      + ` vector-effect="non-scaling-stroke"/>`;
    // L'unite une seule fois, sur la graduation du haut : la repeter trois fois
    // n'apprend rien et encombre un graphe de 240 px de large.
    // Une graduation peut tomber sur le bord meme du trace ; centree, la moitie
    // de l'etiquette deborderait sur la ligne d'au-dessus (les chips) ou sur la
    // premiere piste. Aux bords, elle bascule a l'interieur au lieu d'etre
    // recentree -- elle reste collee a SON trait, ce qu'un recadrage perdrait.
    const pct = (y(v) / PLOT_H) * 100;
    const edge = pct < 8 ? ' edge-top' : pct > 92 ? ' edge-bot' : '';
    yLabels += `<span class="${edge.trim()}" style="top:${pct.toFixed(2)}%">`
      + `${v}${k === ticks.length - 1 ? '°' : ''}</span>`;
  });

  return `<svg class="chart" viewBox="0 0 ${PLOT_W} ${PLOT_H}" preserveAspectRatio="none" aria-hidden="true">
    ${grid}
    ${seps}
    ${bandPath ? `<path d="${bandPath}" fill="var(--band-fill)"/>` : ''}
    ${gapArea(out, outPast, x, y)}
    <path d="${line(out)}" fill="none" stroke="var(--ink-dim)" stroke-width="1.1" stroke-dasharray="4 3" opacity=".75" vector-effect="non-scaling-stroke"/>
    <path d="${line(outPast)}" fill="none" stroke="var(--fc)" stroke-width="1.3" stroke-dasharray="1 3" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <path d="${line(outFc)}" fill="none" stroke="var(--fc)" stroke-width="1.3" stroke-dasharray="1 3" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
    <path d="${line(T)}" fill="none" stroke="var(--ink)" stroke-width="1.6" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    ${nowMark(nowIdx, n, PLOT_H)}
    <line x1="0" y1="${PLOT_H}" x2="${PLOT_W}" y2="${PLOT_H}" stroke="var(--ink-dim)" stroke-width="1" vector-effect="non-scaling-stroke"/>
  </svg><div class="yaxis">${yLabels}</div>`;
}

// One row per actuator, all on the chart's x axis. A single mixed strip could
// only ever show the engine's winning action, so a fan running under a running
// AC was invisible; one track per type is the whole point of this block.
//
// Consecutive equal values are merged into one rect: a flat day is a handful of
// nodes rather than a thousand, which is what keeps twelve tracks cheap.
function trackSvg(name, nowIdx, values, style) {
  const n = values.length;
  if (!n) return '';
  // MEME mapping que la courbe (i / (n-1)) : les pistes divisaient par n, soit
  // un creneau de decalage accumule sur la largeur. Invisible au milieu, ~2 px
  // au bord droit -- assez pour que le marqueur « maintenant » ne tombe pas sur
  // le meme pixel dans la courbe et dans les barres.
  const x = (i) => (Math.min(i, n - 1) / Math.max(1, n - 1)) * PLOT_W;
  let rects = '', i = 0;
  while (i < n) {
    let j = i + 1;
    while (j < n && values[j] === values[i]) j++;
    const st = style(values[i]);
    if (st && st.fill) {
      const h = st.h == null ? STRIP_H : st.h;
      rects += `<rect x="${x(i).toFixed(2)}" y="${(STRIP_H - h).toFixed(2)}"`
        + ` width="${Math.max(x(j) - x(i), 0.4).toFixed(2)}" height="${h.toFixed(2)}"`
        + ` fill="${st.fill}" opacity="${st.op == null ? 0.95 : st.op}"/>`;
    }
    i = j;
  }
  return `<svg class="strip" data-track="${name}" viewBox="0 0 ${PLOT_W} ${STRIP_H}" preserveAspectRatio="none" aria-hidden="true">`
    + `${rects}${nowMark(nowIdx, n, STRIP_H)}</svg>`;
}

// La frontiere entre ce qui a eu lieu et ce qui reste de la journee. Dessinee
// dans CHAQUE trace plutot qu'en surcouche CSS : les traces sont deja alignes
// au pixel, donc les segments se lisent comme une seule ligne verticale, et le
// marqueur ne peut pas deriver de la donnee qu'il designe.
function nowMark(nowIdx, n, h) {
  if (nowIdx == null || nowIdx < 0 || nowIdx >= n - 1) return '';
  const x = ((nowIdx / Math.max(1, n - 1)) * PLOT_W).toFixed(2);
  return `<line x1="${x}" y1="0" x2="${x}" y2="${h}" stroke="var(--now)" stroke-width="1.5"`
    + ` vector-effect="non-scaling-stroke"/>`;
}

// Le rayonnement se trace a part, pas en 4e courbe sur le graphe de
// temperature : une seconde ordonnee dans le meme cadre (W/m² contre °C) est
// exactement le genre de graphique qu'il faut expliquer pour etre lu.
//
// C'est le soleil recu par CETTE piece (rayonnement du ciel x facteur de sa
// fenetre), pas la meteo : au meme instant une chambre peu exposee prend 34
// W/m² quand la mezzanine en prend 274. C'est cette courbe-la qui explique
// pourquoi une piece chauffe et pas sa voisine.
function sunSvg(values, nowIdx, marks, fc) {
  const n = values.length;
  const fcv = fc || [];
  const known = [...values, ...fcv].filter((v) => v != null);
  if (!known.length) return '';
  // Echelle bornee par le seuil du moteur : sans plancher, une journee sans
  // soleil se dessinerait comme une belle journee, faute de reference.
  const hi = Math.max(SOLAR_HIGH * 1.2, ...known);
  const x = (i) => (i / Math.max(1, n - 1)) * PLOT_W;
  const y = (v) => SUN_H - (v / hi) * SUN_H;

  let d = '', area = '', open = false;
  for (let i = 0; i < n; i++) {
    if (values[i] == null) { open = false; continue; }
    if (!open) { area += `M${x(i).toFixed(1)},${SUN_H}L`; d += `M`; open = true; }
    else { area += 'L'; d += 'L'; }
    const pt = `${x(i).toFixed(1)},${y(values[i]).toFixed(1)}`;
    area += pt; d += pt;
  }
  if (open) area += `L${x(n - 1).toFixed(1)},${SUN_H}Z`;

  let seps = '';
  for (const i of marks.lines) {
    seps += `<line x1="${x(i).toFixed(1)}" y1="0" x2="${x(i).toFixed(1)}" y2="${SUN_H}" stroke="var(--line)" stroke-width="1" vector-effect="non-scaling-stroke"/>`;
  }
  const hiLine = `<line x1="0" y1="${y(SOLAR_HIGH).toFixed(1)}" x2="${PLOT_W}" y2="${y(SOLAR_HIGH).toFixed(1)}"`
    + ` stroke="var(--warm)" stroke-width="1" stroke-dasharray="3 4" opacity=".7" vector-effect="non-scaling-stroke"/>`;

  // Meme geometrie, style different : aire plus pale et trait pointille. La
  // prevision doit se voir comme une prevision sans avoir a lire la legende.
  let fd = '', fa = '', fopen = false;
  for (let i = 0; i < n; i++) {
    if (fcv[i] == null) { fopen = false; continue; }
    if (!fopen) { fa += `M${x(i).toFixed(1)},${SUN_H}L`; fd += 'M'; fopen = true; }
    else { fa += 'L'; fd += 'L'; }
    const pt = `${x(i).toFixed(1)},${y(fcv[i]).toFixed(1)}`;
    fa += pt; fd += pt;
  }
  if (fopen) fa += `L${x(n - 1).toFixed(1)},${SUN_H}Z`;

  return `<svg class="sun" data-track="solar" viewBox="0 0 ${PLOT_W} ${SUN_H}" preserveAspectRatio="none" aria-hidden="true">`
    + `${seps}${fa ? `<path d="${fa}" fill="var(--sun-fill)" opacity=".45"/>` : ''}`
    + `${fd ? `<path d="${fd}" fill="none" stroke="var(--sun)" stroke-width="1.2" stroke-dasharray="2 3" opacity=".75" vector-effect="non-scaling-stroke"/>` : ''}`
    + `<path d="${area}" fill="var(--sun-fill)"/>`
    + `<path d="${d}" fill="none" stroke="var(--sun)" stroke-width="1.4" vector-effect="non-scaling-stroke"/>`
    + `${hiLine}${nowMark(nowIdx, n, SUN_H)}</svg>`
    // Quand le maximum du jour frole le seuil, les deux etiquettes se
    // superposent : c'est le maximum qui cede, le repere porte plus de sens.
    + `<div class="yaxis">`
    + (hi > SOLAR_HIGH * 1.35 ? `<span class="edge-top">${Math.round(hi)} W/m²</span>` : '')
    + `<span class="sunhi" style="top:${((y(SOLAR_HIGH) / SUN_H) * 100).toFixed(1)}%">plein soleil</span></div>`;
}

function trackRow(label, hint, svg) {
  // La courbe n'a pas le fond des pistes : c'est un trace, pas une barre.
  const cls = /class="(chart|sun)"/.test(svg) ? 'tplot' : 'tbar';
  return `<div class="track"><span class="tlab" title="${esc(hint || label)}">${esc(label)}</span>`
    + `<div class="${cls}">${svg}</div></div>`;
}

// Piste dont la serie manque au payload. Hachuree et libellee, jamais vide :
// une barre vide se lit « rien ne s'est passe », ce qui est faux.
function missingRow(label) {
  return `<div class="track"><span class="tlab">${esc(label)}</span>`
    + `<div class="tbar tbar-missing"><span>donnée absente</span></div></div>`;
}

// Time labels under the tracks, from the same mark list the gridlines use.
// Rendered as one more row of the track grid, with an empty label cell: the
// axis then sits in the SAME flex column as the plots, by construction. It used
// to reproduce the gutter with `margin-left: calc(4.6rem + .45rem)`, which put
// it 0.02px off and, worse, would drift the day the label column changes width.
function axisHtml(t, marks, nowIdx) {
  const n = t.length;
  if (n < 2 || !marks.labels.length) return '';
  const nowPos = nowIdx > 0 && nowIdx < n - 1 ? nowIdx / (n - 1) : null;
  // Une graduation fixe trop proche de l'heure courante disparait : l'etiquette
  // « maintenant » a un fond opaque et la recouvrait a moitie, ce qui donnait
  // un « 21h » tronque en « 2 » -- pire qu'absent, parce que ca se lit comme un
  // chiffre. C'est la graduation fixe qui cede : l'heure reelle prime.
  //
  // Le seuil vient de la largeur des etiquettes, pas d'un tatonnement : sur un
  // axe de ~240 px, « 22:35 » fait ~40 px et « 21h » ~26 px, donc les centres
  // doivent etre distants de (40+26)/2 = 33 px, soit 0.14 de la largeur. Avec
  // des graduations toutes les 3 h (0.125), cela retire exactement la plus
  // proche, jamais la suivante (0.25).
  let labels = marks.labels
    .filter(([pos]) => nowPos === null || Math.abs(pos - nowPos) > 0.14)
    .map(([pos, l]) => `<span style="left:${(pos * 100).toFixed(2)}%">${esc(l).replace('\n', '<br>')}</span>`)
    .join('');
  // L'etiquette du marqueur porte l'heure : « maintenant » seul obligerait a
  // aller la chercher ailleurs sur la page.
  if (nowPos !== null) {
    labels += `<span class="now" style="left:${(nowPos * 100).toFixed(2)}%">`
      + `${esc(hhmm(t[nowIdx]))}</span>`;
  }
  return `<div class="track"><span class="tlab"></span>`
    + `<div class="axis${view === 'week' ? ' axis-2l' : ''}">${labels}</div></div>`;
}

/* ── zone card ───────────────────────────────────────────────────────────── */

function deviceChip(name, dev) {
  if (!dev) return '';
  const failed = dev.fail_streak > 0 || dev.off_fail_streak > 0;
  const cls = failed ? 'fail' : dev.on ? 'on' : '';
  const since = dev.since ? ` · ${ago(dev.since)}` : '';
  return `<span class="dev ${cls}">${name} ${dev.on ? 'on' : 'off'}${since}${failed ? ' ⚠️' : ''}</span>`;
}

// Ce que la fenetre dit, pas ce que l'instant dit. Sur sept jours, « trop
// chaud, plus de levier » decrit un tick parmi mille : c'est du bruit devant la
// question que la vue semaine pose, qui est une question de tendance.
//
// Tout est calcule sur les series deja tracees -- meme source que les courbes,
// donc pas de chiffre qui contredise le dessin juste au-dessus.
function weekStats(zone, f, t) {
  const stepH = tickStep(t) / 3600;
  let n = 0, sum = 0, lo = Infinity, hi = -Infinity, out = 0, ac = 0, fan = 0;
  for (let i = 0; i < f.T.length; i++) {
    const v = f.T[i];
    if (v != null) {
      n++; sum += v;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
      // Hors bande = au-dessus du max OU en dessous du min A CE TICK : la bande
      // bouge avec le programme jour/nuit, un seuil fixe mentirait la nuit.
      if ((f.bmax[i] != null && v > f.bmax[i]) || (f.bmin[i] != null && v < f.bmin[i])) out++;
    }
    if (f.ac[i]) ac++;
    if (f.fan[i]) fan++;
  }
  if (!n) return '';
  const dur = (ticks) => {
    const h = ticks * stepH;
    return h < 1 ? `${Math.round(h * 60)} min` : `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  };
  const chips = [
    `<span class="stat">moyenne <b>${(sum / n).toFixed(1)}°</b></span>`,
    `<span class="stat">${lo.toFixed(1)} → ${hi.toFixed(1)}°</span>`,
    `<span class="stat${out / n > .25 ? ' warn' : ''}">hors de l'objectif <b>${Math.round((out / n) * 100)} %</b></span>`,
  ];
  // Serie absente => surtout PAS « clim — », qui affirme qu'elle n'a pas tourne.
  if (zone.has_ac && f.has.ac) chips.push(`<span class="stat">clim ${ac ? dur(ac) : '—'}</span>`);
  if (zone.has_fan && f.has.fan) chips.push(`<span class="stat">ventilo ${fan ? dur(fan) : '—'}</span>`);
  return `<div class="devs">${chips.join('')}</div>`;
}

// L'etat de la piece en francais, construit ICI depuis les memes champs
// structures que le moteur a utilises (T, bornes de bande, occupation,
// directive).
//
// La `reason` du moteur n'est PAS traduite : c'est une trace de debug en texte
// libre -- « T=23.7 dans la bande mais > seuil hysteresis -> on maintient
// (anti-cyclage) », « ext=14.4 <= 15.0, T=23.8 <= bmax=24 -> volet deja en
// position (current=0.0 ~= 0) ». La faire passer par un traducteur de motifs
// reviendrait a s'ancrer sur une ressemblance : le jour ou le moteur reformule
// une phrase, le dashboard afficherait une traduction fausse sans que rien ne
// casse. Elle reste disponible en `title` sur la ligne d'action, pour
// l'operateur qui la cherche.
//
// Effet de bord voulu : les bornes de la bande redeviennent lisibles sans
// survol, ce que le retrait de la jauge avait fait perdre sur telephone.
// Le moteur nomme ses directives « directive absent (motif) » ou
// « directive clim2_off ». Ce sont deux choses differentes : la premiere dit
// que la maison est vide, la seconde est une consigne ponctuelle sur UN
// appareil. Les confondre -- ce que faisait un « absence declaree » pose sur
// tout ce qui portait une directive -- annonce un depart qui n'a pas lieu.
//
// L'aiguillage se fait sur le prefixe exact du moteur, pas sur une
// ressemblance : un libelle inconnu retombe sur « consigne de l'agenda »
// plutot que d'etre range de force dans l'une des deux cases.
// Motif -> phrase. Les trois premieres cles viennent du cron d'agenda et
// nomment leur piece ; les trois suivantes sont les consignes posees a la main,
// qui parlent de l'appareil de LA piece affichee. Le volet est a part : il est
// FIGE, pas coupe -- dire « coupe » ferait croire a une fermeture, soit
// l'inverse d'un volet reste ouvert.
const DIRECTIVE_TARGETS = {
  clim1_off: 'clim 1 coupée', clim2_off: 'clim 2 coupée',
  clim_salon_off: 'clim du salon coupée',
  clim: 'clim coupée', ventilo: 'ventilateur coupé',
  volet: 'volet figé — le moteur n\'y touche plus',
};

function directiveLabel(txt) {
  const raw = String(txt || '');
  const abs = /^directive absent(?:\s*\((.*)\))?\s*$/.exec(raw);
  if (abs) return `absence déclarée${abs[1] ? ` (${esc(abs[1])})` : ''}`;
  // Les motifs du moteur ont deux formes : un CODE prefixe (« directive
  // clim2_off »), et une PHRASE deja lisible (« consigne manuelle : ventilo
  // coupé »). Ranger la seconde dans le repli « consigne de l'agenda : … »
  // donnait « consigne de l'agenda : consigne manuelle : ventilo coupé » —
  // illisible, et faux : elle ne vient pas de l'agenda.
  if (!/^directive\s/.test(raw)) return esc(raw);
  const key = raw.replace(/^directive\s+/, '');
  return DIRECTIVE_TARGETS[key]
    ? `consigne : ${DIRECTIVE_TARGETS[key]}`
    : `consigne de l'agenda : ${esc(key)}`;
}

function plainState(c) {
  const b = c.band || {};
  const hasBand = b.min != null && b.max != null;
  const bits = [];
  if (hasBand && c.T != null) {
    const goal = `objectif ${b.min}–${b.max} °C`;
    if (c.T > b.max) bits.push(`<b>trop chaud</b> — ${goal}`);
    else if (c.T < b.min) bits.push(`<b>trop froid</b> — ${goal}`);
    else bits.push(`<b>température OK</b> — ${goal}`);
  } else if (hasBand) {
    bits.push(`pas de mesure — objectif ${b.min}–${b.max} °C`);
  } else {
    bits.push('pas de mesure');
  }
  if (c.directive) bits.push(directiveLabel(c.directive));
  else if (c.occupancy_phase === 'off') {
    bits.push(c.occ_next_start ? `personne ici avant ${esc(c.occ_next_start)}` : 'personne ici');
  }
  return bits.join(' · ');
}

// Ce que la page ne montre pas ailleurs, et qui reste une vue d'ensemble : des
// agregats de la fenetre, pas un journal d'evenements. On ne descend pas au
// tick -- la pile de pistes le fait deja, et mieux.
//
// Tout est calcule sur les series DEJA TRACEES au-dessus : aucun chiffre ne
// peut contredire le dessin, et rien n'est relu depuis le payload brut.
function zoneDetail(zone, f, t) {
  const stepH = tickStep(t) / 3600;
  const dur = (n) => {
    const h = n * stepH;
    return h < 1 ? `${Math.round(h * 60)} min` : `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;
  };
  const rows = [];

  const T = f.T.filter((v) => v != null);
  if (T.length) {
    const avg = T.reduce((a, b) => a + b, 0) / T.length;
    let out = 0;
    for (let i = 0; i < f.T.length; i++) {
      const v = f.T[i];
      if (v == null) continue;
      if ((f.bmax[i] != null && v > f.bmax[i]) || (f.bmin[i] != null && v < f.bmin[i])) out++;
    }
    rows.push(['Température', `moyenne ${avg.toFixed(1)} °C`,
      `de ${Math.min(...T).toFixed(1)} à ${Math.max(...T).toFixed(1)} °C`]);
    rows.push(["Hors de l'objectif", `${Math.round((out / T.length) * 100)} %`,
      `soit ${dur(out)} sur la fenêtre`]);
  }

  const occ = f.occ.filter((v) => v != null && v !== 'off').length;
  if (f.has.occ) rows.push(['Occupation', dur(occ), 'quelqu\'un dans la pièce']);

  if (zone.has_ac && f.has.ac) {
    const on = f.ac.filter(Boolean).length;
    rows.push(['Clim', on ? dur(on) : 'jamais',
      on ? `${Math.round((on / f.ac.length) * 100)} % de la fenêtre` : 'sur cette fenêtre']);
  }
  if (zone.has_fan && f.has.fan) {
    const on = f.fan.filter(Boolean).length;
    rows.push(['Ventilo', on ? dur(on) : 'jamais',
      on ? `${Math.round((on / f.fan.length) * 100)} % de la fenêtre` : 'sur cette fenêtre']);
  }
  if (zone.has_velux && f.has.velux) {
    const v = f.velux.filter((x) => x != null);
    if (v.length) rows.push(['Volet', `ouvert ${Math.round(v.reduce((a, b) => a + b, 0) / v.length)} % en moyenne`,
      `de ${Math.min(...v)} à ${Math.max(...v)} %`]);
  }
  if (f.has.solar) {
    const sun = f.solar.filter((v) => v != null);
    if (sun.length) {
      const strong = sun.filter((v) => v >= SOLAR_HIGH).length;
      rows.push(['Soleil', `pointe à ${Math.max(...sun)} W/m²`,
        strong ? `${dur(strong)} au-dessus du seuil d'action` : "jamais assez fort pour agir"]);
    }
  }

  // Le temps passe dans chaque action, du plus long au plus court : c'est le
  // resume que la frise ne donne pas d'un coup d'oeil.
  const byAction = new Map();
  for (const a of f.act) {
    if (!a) continue;
    const m = meta(a);
    const k = `${m.emoji}|${m.label}`;
    byAction.set(k, (byAction.get(k) || 0) + 1);
  }
  const top = [...byAction.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    .map(([k, n]) => { const [emo, lab] = k.split('|');
      return `<span class="chip">${emo} ${esc(lab)} <b>${dur(n)}</b></span>`; }).join('');

  return `<div class="detail">
    <dl>${rows.map(([k, v, sub]) =>
      `<div><dt>${esc(k)}</dt><dd>${v}<em>${esc(sub)}</em></dd></div>`).join('')}</dl>
    ${top ? `<h4>Temps passé par action</h4><div class="chips">${top}</div>` : ''}
  </div>`;
}

// Le chiffre en gros. Sur « aujourd'hui » c'est la mesure du moment ; sur une
// fenetre CLOSE c'est la moyenne de la fenetre, annoncee comme telle. Afficher
// la temperature actuelle sur une page « hier » reviendrait a dater de
// maintenant une information sur avant -- le defaut existait deja sur la vue
// 7 j, la vue « hier » l'a rendu evident.
function headline(c, f, tempCls) {
  if (isRetro()) {
    const T = f.T.filter((v) => v != null);
    if (!T.length) return `<div class="zone-temp none">aucune mesure</div>`;
    const avg = T.reduce((a, b) => a + b, 0) / T.length;
    return `<div class="zone-temp"><small class="pre">moy.</small>${avg.toFixed(1)}<small>°C</small></div>`;
  }
  return c.T != null
    ? `<div class="zone-temp ${tempCls}">${c.T.toFixed(1)}<small>°C</small></div>`
    : `<div class="zone-temp none">capteur muet</div>`;
}

function zoneCard(zone, f, t, marks, nowIdx) {
  const c = zone.current;
  const m = meta(c.action);
  // La bande de confort n'est plus dessinee ici : la courbe en dessous la
  // trace deja, et en mieux -- l'enveloppe suit le programme jour/nuit au lieu
  // de figer l'instant present. Elle reste lue pour colorer la temperature et
  // reste chiffree dans la bulle du graphe.
  const band = c.band || {};
  const hasBand = band.min != null && band.max != null;

  const tempCls = hasBand && c.T != null ? (c.T > band.max ? 'hot' : c.T < band.min ? 'cold' : '') : '';
  const devs = [deviceChip('clim', c.ac), deviceChip('ventilo', c.fan),
    c.velux != null ? `<span class="dev ${c.velux > 0 ? 'on' : ''}">volet ${c.velux}%${c.velux_since ? ' · ' + ago(c.velux_since) : ''}</span>` : ''].join('');

  // Occupation et directive sont passees dans plainState ; les repeter ici les
  // dirait deux fois. Reste ce qui n'y est pas.
  const sub = [];
  if (!zone.has_ac && !zone.has_fan && !zone.has_velux) sub.push('aucun appareil ici');
  if (c.day_peak != null) sub.push(`plus chaud aujourd'hui : ${c.day_peak}°`);

  // Sur la semaine, l'instant cede la place a la fenetre : l'action du moment,
  // son motif et l'anciennete des appareils decrivent un tick parmi mille.
  const head = isRetro()
    ? weekStats(zone, f, t)
    : `<div class="action ${m.active ? 'is-active' : ''} ${isAlert(c.action) ? 'is-alert' : ''}"
        ${c.reason ? `title="${esc(c.reason)}"` : ''}>
      <span class="emo">${m.emoji}</span><span class="lab">${esc(m.label)}</span>
    </div>
    <div class="why">${plainState(c)}</div>
    <div class="devs">${devs}</div>`;

  const open = zoneFromHash() === zone.name;
  const at = acted.get(zone.name);
  // `generated_at` est l'heure de l'EXPORT, pas celle du navigateur : la
  // pastille disparait quand la maison a reellement reparle, pas apres un delai
  // devine ici.
  const pending = at && new Date(payload.generated_at).getTime() < at;
  const flash = at && Date.now() - at < FLASH_MS;
  return `<section class="zone${open ? ' solo' : ''}${flash ? ' acted' : ''}" data-zone="${esc(zone.name)}">
    ${pending ? `<div class="pending" title="La courbe et l'état des appareils viennent de l'envoi de la maison, toutes les 10 min : ils ne bougeront qu'au suivant.">✓ Consigne posée</div>` : ''}
    <div class="zone-head">
      <div>
        <div class="zone-name">${open ? esc(zone.name)
          : `<a class="zlink" href="#zone=${encodeURIComponent(zone.name)}">${esc(zone.name)}</a>`}</div>
        <div class="zone-sub">${isRetro() ? '' : sub.join(' · ')}</div>
      </div>
      ${headline(c, f, tempCls)}
    </div>
    ${head}
    <div class="tracks">
      ${trackRow('température', 'Trait plein : la pièce. Pointillés : dehors. Fond vert : l\'objectif de température.', chartSvg(f, t, marks, nowIdx))}
      ${(() => { const sun = f.has.solar ? sunSvg(f.solar, nowIdx, marks, f.fc && f.fc.solar) : '';
          return sun ? trackRow('soleil', 'Rayonnement reçu par la fenêtre de cette pièce, en W/m²', sun) : ''; })()}
      ${trackRow('décision', "Ce que la maison a décidé de faire à cet instant — une seule chose à la fois", trackSvg('act', nowIdx, f.act, (a) => a ? { fill: colorFor(a), op: meta(a).active || isAlert(a) ? .95 : PASSIVE_OP } : null))}
      ${f.has.occ
        // Le vecu et le prevu se dessinent PAREIL. L'occupation est une regle,
        // pas une prevision : les fenetres sont dans les reglages et l'agenda du
        // jour est deja interprete, donc la barre de 22h est aussi certaine que
        // celle de 8h. Le trait rouge suffit a dire ou on en est. Une barre a
        // mi-hauteur laissait entendre un doute qui n'existe pas.
        ? trackRow('occupation', "Phase d'occupation de la zone — règles horaires et agenda du jour",
            trackSvg('occ', nowIdx, f.occ.map((v, i) => (v != null ? v : f.occPlan[i])),
              (v) => occMeta(v)))
        : missingRow('occupation')}
      ${!zone.has_ac ? '' : f.has.ac
        ? trackRow('clim', 'Clim en marche, allumée par la maison', trackSvg('ac', nowIdx, f.ac, (v) => v ? { fill: 'var(--cool)' } : null))
        : missingRow('clim')}
      ${!zone.has_fan ? '' : f.has.fan
        ? trackRow('ventilo', 'Ventilo en marche, allumé par la maison', trackSvg('fan', nowIdx, f.fan, (v) => v ? { fill: 'var(--fan)' } : null))
        : missingRow('ventilo')}
      ${!zone.has_velux ? '' : f.has.velux
        ? trackRow('volet', "Ouverture du volet — hauteur de la barre = % ouvert", trackSvg('velux', nowIdx, f.velux, (v) => v == null ? null : { fill: 'var(--velux)', op: .8, h: Math.max(1.5, (v / 100) * STRIP_H) }))
        : missingRow('volet')}
      ${axisHtml(t, marks, nowIdx)}
      <div class="cursor" hidden></div>
    </div>
    ${open ? zoneDetail(zone, f, t) : ''}
  </section>`;
}

// House-level banner. An absence directive cuts every AC in the house and puts
// the heating in Netatmo away -- it was readable only in a card subtitle, which
// is how the 21/08 « Noune » false positive (a first name read as a week-long
// absence) held a whole morning unnoticed. Three states, none of them decorative:
// the absence itself, a multi-day window waiting on confirmation, and an absence
// the guard refused -- that last one is the guard saying out loud what it did.
// The payload dates directives in ISO; the banner is read by a human standing
// in the kitchen. No timezone maths here -- this is a calendar day, not an
// instant, so parsing it as a Date would only risk shifting it by one.
const frDate = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}` : String(iso || '');
};

// Combien coute l'electricite, en euros. Bloc MAISON : le Linky compte tout le
// compteur, pas une piece -- l'afficher sur une carte de zone laisserait croire
// que c'est la conso de cette piece.
//
// Le tarif vient du fichier de secrets et transite dans le payload : la page ne
// multiplie rien, elle affiche des euros deja calcules. Un tarif illisible cote
// collecteur donne des euros a null, et on retombe sur les kWh -- pas sur un
// cout invente.
const eur = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const kwh = (v) => v.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' kWh';

// Courbe de charge : la puissance appelee, une valeur par demi-heure.
//
// L'ancienne courbe tracait `conso_jour_kwh`, presente comme « un cumul qui
// repart de zero a minuit ». C'etait faux : ce compteur ne prend que DEUX
// valeurs par jour (mesure le 23/08/2026 sur 122 releves), et il est publie
// avec un jour ou deux de retard. La courbe etait donc plate et ne montrait
// rien. La vraie courbe vient de l'historique Jeedom de « Consommation
// Horaire » -- 48 points par jour, sur des semaines.
//
// Consequence a ne pas cacher : Enedis publie en differe. La journee EN COURS
// n'a donc pas de courbe, et c'est un fait a annoncer, pas un vide a masquer.
// Ce que la bulle relit au survol. Pose par energyCurve, comme `frames` pour
// les cartes de zone : le curseur ne recalcule rien, il lit ce qui est DESSINE.
let ecurve = null;

// Graduations de temps de la courbe electrique. Elles ne peuvent pas venir de
// `viewMarks` : celui-ci travaille sur l'axe des ticks du moteur (10 min), alors
// que la courbe de charge a son propre pas (30 min) et sa propre etendue.
function energyMarks(t0, t1) {
  const span = t1 - t0;
  const out = [];
  if (span <= 36 * 3600) {
    const step = 3 * 3600;
    for (let ts = Math.ceil(t0 / step) * step; ts <= t1; ts += step) {
      out.push([(ts - t0) / span, hhmm(ts)]);
    }
  } else {
    let last = null;
    for (let ts = t0; ts <= t1; ts += 3600) {
      const k = dayKey(ts);
      if (k === last) continue;
      last = k;
      out.push([(ts - t0) / span, dayLabel(ts)]);
    }
  }
  return out;
}

// Plages de fonctionnement de chaque appareil, sous la courbe. D'abord les
// CONSOMMATEURS (clim, ventilo) en blocs pleins, puis les volets en barres dont
// la hauteur est l'ouverture : ceux-la ne consomment rien, et leur donner la
// meme forme les ferait lire comme une depense sur le trait du dessus.
//
// Les series du moteur sont a un autre pas (10 min) et sur une autre etendue
// que la courbe de charge (30 min) : chaque segment est donc place par son
// HORODATAGE, jamais par son rang. Un appareil qui n'a pas tourne du tout sur
// la fenetre n'a pas de piste -- une ligne vide se lit comme une panne.
const DEVICE_KINDS = [['ac', 'clim', 'var(--cool)'], ['fan', 'ventilo', 'var(--fan)']];

function energyDevices(t0, t1) {
  const ts = payload.t || [];
  const span = t1 - t0 || 1;
  // Duree d'un tick, pour donner sa largeur au dernier segment : sans elle, une
  // marche encore en cours au dernier releve serait dessinee comme un trait.
  const step = ts.length > 1 ? (ts[1] - ts[0]) : 600;
  const rows = [];
  const devs = [];
  const vlx = [];
  let velux = false;

  for (const z of payload.zones || []) {
    for (const [kind, label, color] of DEVICE_KINDS) {
      // `ac` et `fan` sont RUN-LENGTH ENCODES dans le payload (44 paires pour
      // 1015 ticks) : les indexer directement ne trouve jamais rien, et une
      // piste absente se lit « cet appareil n'a pas tourne ». Il faut expand().
      const raw = (z.series || {})[kind];
      if (!raw || !raw.length) continue;
      const ser = expand(raw, ts.length);
      let rects = '', any = false;
      let runFrom = null;
      for (let i = 0; i < ts.length; i++) {
        const inWin = ts[i] >= t0 && ts[i] <= t1;
        const on = inWin && !!ser[i];
        if (on && runFrom === null) runFrom = ts[i];
        if (!on && runFrom !== null) {
          const x0 = ((runFrom - t0) / span) * 1000;
          const x1 = ((Math.min(ts[i], t1) - t0) / span) * 1000;
          rects += `<rect x="${x0.toFixed(1)}" y="0" width="${Math.max(1, x1 - x0).toFixed(1)}" height="10" fill="${color}"/>`;
          any = true;
          runFrom = null;
        }
      }
      if (runFrom !== null) {
        const x0 = ((runFrom - t0) / span) * 1000;
        const x1 = ((Math.min(ts[ts.length - 1] + step, t1) - t0) / span) * 1000;
        rects += `<rect x="${x0.toFixed(1)}" y="0" width="${Math.max(1, x1 - x0).toFixed(1)}" height="10" fill="${color}"/>`;
        any = true;
      }
      if (!any) continue;
      rows.push(deviceRow(`${label} ${z.name}`, rects));
      devs.push({ name: `${label} ${z.name}`, ser });
    }
  }

  // Les volets ferment la marche, et se dessinent AUTREMENT : une barre dont la
  // HAUTEUR est le pourcentage d'ouverture, pas un bloc plein. Ils ne consomment
  // rien -- leur donner la meme forme que la clim les ferait lire comme une
  // depense sur le trait du dessus. Position 0 (ferme) garde un filet visible :
  // « ferme » et « pas de mesure » ne doivent pas se ressembler.
  for (const z of payload.zones || []) {
    const raw = (z.series || {}).velux;
    if (!raw || !raw.length) continue;
    const ser = expand(raw, ts.length);
    let rects = '', any = false, runFrom = null, runVal = null;
    const flush = (endTs) => {
      if (runFrom === null) return;
      const x0 = ((runFrom - t0) / span) * 1000;
      const x1 = ((Math.min(endTs, t1) - t0) / span) * 1000;
      const h = Math.max(1.5, (runVal / 100) * 10);
      rects += `<rect x="${x0.toFixed(1)}" y="${(10 - h).toFixed(1)}"`
        + ` width="${Math.max(1, x1 - x0).toFixed(1)}" height="${h.toFixed(1)}"`
        + ` fill="var(--velux)" opacity=".8"/>`;
      any = true;
      runFrom = null;
    };
    for (let i = 0; i < ts.length; i++) {
      const inWin = ts[i] >= t0 && ts[i] <= t1;
      const v = inWin ? ser[i] : null;
      if (v == null) { flush(ts[i]); runVal = null; continue; }
      if (runFrom === null) { runFrom = ts[i]; runVal = v; }
      else if (v !== runVal) { flush(ts[i]); runFrom = ts[i]; runVal = v; }
    }
    flush(ts[ts.length - 1] + step);
    if (any) {
      rows.push(deviceRow(`volet ${z.name}`, rects));
      // Le nom de la piece SEUL : la bulle les regroupe sous « volets : », et
      // repeter le mot a chaque entree la remplirait de bruit.
      vlx.push({ name: z.name, ser });
      velux = true;
    }
  }
  return { html: rows.join(''), velux, devs, vlx };
}

function deviceRow(name, rects) {
  return `<div class="erow2">
      <span class="elab" title="${esc(name)}">${esc(name)}</span>
      <div class="estrip"><svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true">${rects}</svg></div>
    </div>`;
}

function energyCurve(e) {
  ecurve = null;
  const pts = (e.series || []).filter((p) => Array.isArray(p) && p.length === 2);
  const from = view !== 'week' && viewT.length ? dayKey(viewT[viewT.length - 1]) : null;
  // Sur 7 j, la courbe est BORNEE a la fenetre de la page. La courbe de charge
  // en garde 8 : les tracer tels quels donnait un premier cinquieme sans aucune
  // piste d'appareil en face -- ce qui se lit « rien n'a tourne ce jour-la »,
  // alors que c'est la page qui ne connait pas ce jour. Et un bloc annonce
  // « 7 j » qui en montre 8 est faux, meme si personne ne compte les jours.
  const floor = view === 'week' && (payload.t || []).length ? payload.t[0] : null;
  const use = from ? pts.filter((p) => dayKey(p[0]) === from)
    : floor ? pts.filter((p) => p[0] >= floor) : pts;

  // Le COUT peut manquer sans que le reste manque. Aujourd'hui, Enedis n'a
  // encore rien publie -- mais la temperature et l'activite des appareils sont
  // la, relevees toutes les 10 min. Se taire entierement pour un seul des trois
  // signaux revenait a cacher deux mesures disponibles.
  const hasCost = use.length >= 2;
  let t0, t1;
  if (hasCost) {
    t0 = use[0][0];
    t1 = use[use.length - 1][0];
  } else if (viewT.length >= 2) {
    // Fenetre de la PAGE, bornee a maintenant : au-dela rien n'a encore eu
    // lieu, et une piste vide s'y lirait « cet appareil n'a pas tourne ».
    t0 = viewT[0];
    t1 = viewT[viewNowIdx > 0 ? viewNowIdx : viewT.length - 1];
  } else {
    t0 = t1 = 0;
  }
  if (t1 <= t0) {
    return `<div class="ecurve empty">pas encore assez de relevés</div>`;
  }

  // En euros par heure. C'est la MEME courbe que les kW a un facteur pres (le
  // tarif) : la forme ne change pas, seule l'unite parle. Sans tarif lisible on
  // retombe sur les kW plutot que d'inventer un cout.
  const tarif = e.tarif_kwh_eur;
  const unit = tarif ? (v) => v * tarif : (v) => v;
  const U = tarif ? ' €/h' : ' kW';
  const fmt = (v) => v.toLocaleString('fr-FR',
    tarif ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }) + U;

  const W = 1000, H = 60;
  const x = (ts) => (t1 === t0 ? W : ((ts - t0) / (t1 - t0)) * W);

  const hi = hasCost ? (Math.max(...use.map((p) => unit(p[1]))) || 1) : 0;
  const y = (v) => H - (v / (hi || 1)) * H;
  let d = '', area = '';
  if (hasCost) {
    area = `M0,${H}L`;
    use.forEach((p, k) => {
      const pt = `${x(p[0]).toFixed(1)},${y(unit(p[1])).toFixed(1)}`;
      d += (k ? 'L' : 'M') + pt;
      area += (k ? 'L' : '') + pt;
    });
    area += `L${W},${H}Z`;
  }

  // Ordonnee : traits dans le SVG, chiffres en HTML par-dessus. Meme raison que
  // sur les courbes de piece -- le SVG est etire (preserveAspectRatio none) et
  // un <text> y serait comprime.
  // Etiquette d'ordonnee : chiffres en HTML par-dessus le SVG (celui-ci est
  // etire, un <text> y serait comprime). L'unite une seule fois, sur la
  // graduation du haut : la repeter n'apprend rien sur une bande de 62 px.
  const yLab = (tk, pos, cls, unit) => tk.map((v, k) => {
    const pct = (pos(v) / H) * 100;
    return `<span class="${cls}${pct < 10 ? ' edge-top' : ''}" style="top:${pct.toFixed(2)}%">`
      + `${v.toLocaleString('fr-FR')}${k === tk.length - 1 ? unit : ''}</span>`;
  }).join('');
  const gridFor = (tk, pos) => tk.map((v) =>
    `<line x1="0" y1="${pos(v).toFixed(1)}" x2="${W}" y2="${pos(v).toFixed(1)}"`
    + ` stroke="var(--line)" stroke-width="1" stroke-dasharray="2 4" opacity=".8"`
    + ` vector-effect="non-scaling-stroke"/>`).join('');

  const ticks = hasCost ? niceTicks(0, hi).filter((v) => v > 0 && v <= hi) : [];
  let grid = hasCost ? gridFor(ticks, y) : '';
  const yLabels = hasCost ? yLab(ticks, y, 'y-cost', U) : '';

  // Temperature exterieure REELLE, sur la meme abscisse. Prise par HORODATAGE
  // et pas par index : les deux series n'ont ni le meme pas (10 min contre 30)
  // ni la meme etendue, et les aligner par rang ferait glisser la temperature
  // de plusieurs heures.
  const oT = [];
  const ts = payload.t || [], oa = (payload.outdoor || {}).T || [];
  for (let i = 0; i < ts.length; i++) {
    if (oa[i] == null || ts[i] < t0 || ts[i] > t1) continue;
    oT.push([ts[i], oa[i]]);
  }
  let temp = '', tempLbl = '', yT = null, yLabelsR = '';
  if (oT.length >= 2) {
    const lo = Math.min(...oT.map((q) => q[1])), hiT = Math.max(...oT.map((q) => q[1]));
    // Bande de 6 °C au minimum : sur une nuit calme l'ecart reel peut etre de
    // 0,3 °C, et une echelle collee au min/max transformerait ce souffle en
    // montagnes russes.
    const span = Math.max(6, hiT - lo);
    const mid = (lo + hiT) / 2;
    yT = (v) => H - ((v - (mid - span / 2)) / span) * H;
    // Une echelle a DROITE, dans la couleur du trait. Sans elle la temperature
    // flottait sans repere -- et sur la journee en cours, ou le cout n'est pas
    // encore publie, elle etait la SEULE courbe du dessin sans aucune ordonnee.
    const tTicks = niceTicks(mid - span / 2, mid + span / 2)
      .filter((v) => v >= mid - span / 2 && v <= mid + span / 2);
    yLabelsR = yLab(tTicks, yT, 'y-temp', '°');
    // La grille appartient a UNE echelle : deux jeux de traits horizontaux se
    // lisent comme un quadrillage sans signification. Le cout la prend quand il
    // existe ; sinon elle revient a la temperature, seule courbe restante.
    if (!hasCost) grid = gridFor(tTicks, yT);
    temp = '<path d="' + oT.map((q, k) =>
      (k ? 'L' : 'M') + `${x(q[0]).toFixed(1)},${yT(q[1]).toFixed(1)}`).join('')
      + '" fill="none" stroke="var(--neutral)" stroke-width="1.4" stroke-dasharray="4 3"'
      + ' vector-effect="non-scaling-stroke"/>';
    // La temperature partage le dessin mais PAS l'echelle : son etendue est
    // ecrite a part, sinon deux unites superposees se lisent comme une seule.
    const deg = (v) => v.toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    tempLbl = `dehors ${deg(lo)}–${deg(hiT)}°`;
  }

  const devices = energyDevices(t0, t1);
  ecurve = { use: hasCost ? use : null, oT, t0, t1, unit, fmt,
             devs: devices.devs, vlx: devices.vlx, ts };
  // Abscisse : les etiquettes flottaient sans rien pour les rattacher au
  // dessin. Une ligne de base et un repere sous chacune disent OU tombe l'heure.
  const marks = energyMarks(t0, t1);
  const axis = marks
    .map(([pos, l]) => `<span style="left:${(pos * 100).toFixed(2)}%">${esc(l)}</span>`).join('');
  const xTicks = `<line x1="0" y1="${H}" x2="${W}" y2="${H}" stroke="var(--line)"`
    + ` stroke-width="1" vector-effect="non-scaling-stroke"/>`
    + marks.map(([pos]) => {
      const px = (pos * W).toFixed(1);
      return `<line x1="${px}" y1="${H - 3}" x2="${px}" y2="${H}" stroke="var(--ink-dim)"`
        + ` stroke-width="1" opacity=".55" vector-effect="non-scaling-stroke"/>`;
    }).join('');

  return `<div class="ecurve">
      <div class="estack">
      <div class="erow2">
        <span class="elab"></span>
        <div class="eplot">
          <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
            ${grid}
            ${area ? `<path d="${area}" fill="var(--sun-fill)"/>` : ''}
            ${d ? `<path d="${d}" fill="none" stroke="var(--sun)" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` : ''}
            ${temp}
            ${xTicks}
          </svg>
          <div class="ylab">${yLabels}</div>
          <div class="ylab ylab-r">${yLabelsR}</div>
        </div>
      </div>
      ${devices.html}
      <div class="ecurwrap"><div class="ecur" hidden></div></div>
      </div>
      <div class="erow2"><span class="elab"></span><div class="eaxis">${axis}</div></div>
      <div class="eleg">${hasCost ? `pointe ${esc(fmt(hi))}` : 'coût du jour publié demain — Enedis diffère'}${tempLbl ? ` · ${esc(tempLbl)}` : ''}${devices.velux ? ' · volets : hauteur = ouverture' : ''}</div>
    </div>`;
}

function energyHtml(e) {
  if (!e) {
    return `<div class="energy off"><b>Électricité</b>`
      + `<span class="esub">consommation indisponible — le compteur n'a pas répondu</span></div>`;
  }
  const old = e.age_s != null && e.age_s > 3600;
  const cell = (label, b) => b && b.kwh != null
    ? `<span class="e"><i>${label}</i>${b.eur != null ? `<b>${eur(b.eur)}</b>` : ''}`
      + `<em>${kwh(b.kwh)}</em></span>`
    : '';

  // Le dernier jour COMPLET, avec sa date, calcule sur la courbe. On n'affiche
  // plus « aujourd'hui » a partir du compteur « Consommation Jour » : recoupe le
  // 23/08, sa valeur etait celle d'un jour passe (43,646 = le total du 20/08),
  // donc la page datait de maintenant un chiffre d'avant-hier.
  const days = e.days || [];
  const last = days.length ? days[days.length - 1] : null;
  const dayCell = last
    ? `<span class="e"><i>${esc(frDate(last[0]))}</i>`
      + `${e.tarif_kwh_eur ? `<b>${eur(last[1] * e.tarif_kwh_eur)}</b>` : ''}`
      + `<em>${kwh(last[1])}</em></span>`
    : '';

  return `<div class="energy${old ? ' stale' : ''}">
      <div class="erow">
        <b class="etitle">Électricité</b>
        ${dayCell}${cell('ce mois', e.mois)}${cell('cette année', e.annee)}
      </div>
      ${energyCurve(e)}
      ${old ? `<span class="esub">relevé vieux de ${ago(e.generated_at, Date.now())}</span>` : ''}
    </div>`;
}

function bannerHtml(h) {
  if (!h) return '';
  const out = [];
  if (h.absent) {
    out.push(`<div class="banner warn"><b>Maison déclarée vide</b>`
      + `${h.reason ? ` — ${esc(h.reason)}` : ''}`
      + `<span class="bsub">Toutes les clims sont coupées et le chauffage est en mode Absent.`
      + `${h.until ? ` Jusqu'au ${esc(frDate(h.until))}.` : " Expire ce soir."}`
      + ` ${h.manual ? 'Posée à la main.' : "Lue dans l'agenda."}</span></div>`);
  }
  if (h.until_pending) {
    out.push(`<div class="banner warn"><b>Absence limitée à aujourd'hui</b>`
      + `<span class="bsub">L'agenda propose de la prolonger jusqu'au ${esc(frDate(h.until_pending))}.`
      + ` Non appliqué sans confirmation.</span></div>`);
  }
  if (h.refused) {
    out.push(`<div class="banner info"><b>Absence refusée</b> — ${esc(h.refused)}`
      + `<span class="bsub">L'agenda a été lu comme « maison vide », sans marqueur de départ`
      + ` dans le titre. Le pilotage normal est maintenu.</span></div>`);
  }
  return out.join('');
}

/* ── render ──────────────────────────────────────────────────────────────── */

// Index range of the current view. "Day" is the calendar day (house time) of
// the most recent tick, not a rolling 24 h: a rolling window would put two
// different mornings side by side, which is not how anyone reads a day.
const secsIntoDay = (e) => { const p = parts(e); return Number(p.hour) * 3600 + Number(p.minute) * 60; };

// Cadence reelle des ticks, mediane pour ignorer un trou de service.
function tickStep(ts) {
  if (ts.length < 2) return 600;
  const d = [];
  for (let i = 1; i < ts.length; i++) d.push(ts[i] - ts[i - 1]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] || 600;
}

// La vue jour couvre la JOURNEE ENTIERE, 00:00 -> 24:00, pas seulement le temps
// deja ecoule. Sinon l'axe s'etire au fil des heures : la meme piece, relue
// deux fois dans la journee, n'a pas la meme abscisse, et rien ne dit combien
// de journee il reste. Les creneaux a venir sont ajoutes vides (donc en fin de
// journee la moitie droite est vide -- c'est l'information), et `nowIdx` marque
// la frontiere.
//
// Le remplissage se fait a la cadence des ticks, pas sur une grille reechan-
// tillonnee : rien des mesures reelles n'est deplace ni fusionne.
function buildView(all) {
  if (view === 'week' || !all.length) {
    return { t: all, i0: 0, i1: all.length, padStart: 0, padEnd: 0, nowIdx: -1 };
  }
  // Bornes de la journee visee : la derniere pour « aujourd'hui », celle d'avant
  // pour « hier ». On remonte par CLE DE JOUR et non par soustraction de 24 h --
  // un jour de changement d'heure ne fait pas 24 h, et un trou de service ne
  // doit pas decaler la journee choisie.
  let end = all.length;
  if (view === 'yesterday') {
    const kToday = dayKey(all[all.length - 1]);
    while (end > 0 && dayKey(all[end - 1]) === kToday) end--;
    if (end === 0) {
      // Le payload ne contient qu'aujourd'hui : rien a montrer pour hier.
      return { t: [], i0: 0, i1: 0, padStart: 0, padEnd: 0, nowIdx: -1, empty: true };
    }
  }
  const k = dayKey(all[end - 1]);
  let i0 = end;
  while (i0 > 0 && dayKey(all[i0 - 1]) === k) i0--;
  const real = all.slice(i0, end);
  const step = tickStep(real);
  const CAP = 300;   // garde-fou : un payload aberrant ne doit pas fabriquer 100k creneaux
  const padStart = Math.min(CAP, Math.floor(secsIntoDay(real[0]) / step));
  const padEnd = Math.min(CAP, Math.max(0, Math.floor((86400 - secsIntoDay(real[real.length - 1])) / step) - 1));
  const t = [];
  for (let i = padStart; i > 0; i--) t.push(real[0] - i * step);
  t.push(...real);
  const last = real[real.length - 1];
  for (let i = 1; i <= padEnd; i++) t.push(last + i * step);
  // Une journee close n'a pas de « maintenant » a marquer.
  return { t, i0, i1: end, padStart, padEnd,
           nowIdx: view === 'day' ? padStart + real.length - 1 : -1 };
}

// Traits et etiquettes, calcules une fois pour toutes les zones -- et
// SEPAREMENT, parce qu'ils ne designent pas la meme chose.
//
// Sur la semaine, le trait marque une frontiere (minuit) mais l'etiquette
// nomme un JOUR : la centrer sur le trait la faisait chevaucher ses deux
// voisines, sept libellés de ~44 px pour 34 px disponibles a 390 px de large.
// Centree dans sa journee, chacune dispose de toute la largeur du jour ; et sur
// deux lignes (« sam. » au-dessus de « 15 ») elle tient sans rien perdre.
//
// Sur la journee, l'etiquette designe bien un instant : elle reste sur le trait.
function viewMarks(t) {
  const n = t.length;
  const lines = [], labels = [];
  const at = (i) => i / Math.max(1, n - 1);
  if (view === 'week') {
    const bounds = [0];
    for (let i = 1; i < n; i++) {
      if (dayKey(t[i]) !== dayKey(t[i - 1])) { lines.push(i); bounds.push(i); }
    }
    bounds.push(n);
    for (let b = 0; b < bounds.length - 1; b++) {
      const a = bounds[b], z = bounds[b + 1];
      // Un jour partiel trop etroit n'a pas la place : pas d'etiquette plutot
      // qu'une etiquette debordant sur la journee d'a cote.
      if (z - a < n * 0.06) continue;
      labels.push([at((a + z) / 2), dayLabel(t[a]).replace(' ', '\n')]);
    }
  } else {
    let last = -1;
    for (let i = 0; i < n; i++) {
      const h = Number(parts(t[i]).hour);
      if (h % 3 === 0 && h !== last) { lines.push(i); labels.push([at(i), `${String(h).padStart(2, '0')}h`]); last = h; }
    }
  }
  return { lines, labels };
}

// The payload ships every track run-length encoded over the full window; the
// view slices them. Held in `frames` so the tooltip reads exactly what is drawn
// -- computing it twice is how an off-by-one between chart and readout starts.
// Valeur prevue a un instant, interpolee entre les deux heures qui l'encadrent.
// La prevision est horaire, la grille du dashboard est a 10 min : sans
// interpolation la courbe serait un escalier, qu'on lirait comme des paliers
// reels alors que ce n'est qu'un pas d'echantillonnage.
function forecastAt(ts, times, values) {
  if (!times || !times.length) return null;
  if (ts < times[0] || ts > times[times.length - 1]) return null;
  for (let i = 1; i < times.length; i++) {
    if (ts > times[i]) continue;
    const a = values[i - 1], b = values[i];
    if (a == null || b == null) return null;
    const span = times[i] - times[i - 1];
    return span ? a + (b - a) * ((ts - times[i - 1]) / span) : a;
  }
  return null;
}

// Series PREVUES, tenues a part des mesurees et jamais fusionnees avec elles :
// c'est ce qui permet de les dessiner autrement, et d'etre sur qu'on ne fera
// jamais une moyenne ou un « hors objectif » sur de la prevision.
function forecastArrays(zoneName, tl, nowIdx) {
  const fc = payload.forecast;
  const empty = { out: [], solar: [], past: [] };
  // La comparaison prevu/mesure vaut pour toute journee dont on a l'archive --
  // y compris une journee FINIE, ou elle vaut meme le plus : elle est alors
  // complete. Elle ne suit donc plus `nowIdx`, seulement la disponibilite de
  // l'archive du jour affiche. La vue 7 j en est exclue : l'archive ne garde
  // que deux jours, superposer une prevision sur un sixieme de la fenetre
  // donnerait un trait qui commence nulle part.
  if (!fc || view === 'week' || !tl.length) return empty;
  const issued = (fc.archive || {})[dayKey(tl[tl.length - 1])];
  const out = new Array(tl.length).fill(null);
  const solar = new Array(tl.length).fill(null);
  const past = new Array(tl.length).fill(null);
  if (issued) {
    // Toute la fenetre, pas seulement jusqu'au marqueur : sur une journee
    // close il n'y a pas de marqueur, et sur la journee en cours le trace du
    // futur prend le relais avec la prevision la plus recente.
    const upTo = nowIdx >= 0 ? Math.min(nowIdx, tl.length - 1) : tl.length - 1;
    for (let i = 0; i <= upTo; i++) {
      const v = forecastAt(tl[i], issued.t, issued.outdoor);
      if (v != null) past[i] = Math.round(v * 10) / 10;
    }
  }
  if (nowIdx < 0 || view !== 'day') return { out, solar, past, issuedAt: issued && issued.issued_at };
  const solarSrc = (fc.solar || {})[zoneName];
  for (let i = nowIdx; i < tl.length; i++) {
    const v = forecastAt(tl[i], fc.t, fc.outdoor);
    if (v != null) out[i] = Math.round(v * 10) / 10;
    if (solarSrc) {
      const sv = forecastAt(tl[i], fc.t, solarSrc);
      if (sv != null) solar[i] = Math.round(sv);
    }
  }
  return { out, solar, past, issuedAt: issued && issued.issued_at };
}

// Occupation planifiee, depuis les transitions calculees par l'export avec la
// fonction meme du moteur. Une regle, pas une prevision : les fenetres sont
// dans la config et l'agenda du jour est deja interprete.
function plannedOcc(zoneName, tl, nowIdx) {
  const plan = (payload.occ_plan || {})[zoneName];
  const out = new Array(tl.length).fill(null);
  if (!plan || !plan.length || nowIdx < 0 || view !== 'day') return out;
  let k = 0;
  for (let i = nowIdx + 1; i < tl.length; i++) {
    while (k + 1 < plan.length && plan[k + 1][0] <= tl[i]) k++;
    if (plan[k][0] <= tl[i]) out[i] = plan[k][1];
  }
  return out;
}

function frameFor(zone, n, v) {
  const ser = zone.series || {};
  const pad = (arr) => [...Array(v.padStart).fill(null), ...arr, ...Array(v.padEnd).fill(null)];
  const cut = (rleArr) => pad(expand(rleArr || [], n).slice(v.i0, v.i1));
  return {
    T: pad((ser.T || []).slice(v.i0, v.i1)),
    out: pad((payload.outdoor?.T || []).slice(v.i0, v.i1)),
    solar: cut(ser.solar),
    bmin: cut(ser.bmin), bmax: cut(ser.bmax),
    act: pad(expand(zone.runs || [], n).slice(v.i0, v.i1)),
    occ: cut(ser.occ), ac: cut(ser.ac), fan: cut(ser.fan), velux: cut(ser.velux),
    // Quelles series le payload portait REELLEMENT. Un conteneur qui sert
    // encore un fichier d'avant les pistes dessinait des barres vides --
    // indistinguables d'une journee ou la clim n'a jamais tourne. L'absence de
    // donnee ne doit jamais se lire comme une absence d'activite : la piste dit
    // « donnee absente » au lieu de se dessiner vide.
    has: { occ: 'occ' in ser, ac: 'ac' in ser, fan: 'fan' in ser, velux: 'velux' in ser,
           solar: 'solar' in ser },
    fc: forecastArrays(zone.name, v.t, v.nowIdx),
    // Tenu a part de `occ` : les agregats (temps d'occupation, page par piece)
    // se calculent sur le VECU. Les fusionner ferait compter des heures qui
    // n'ont pas encore eu lieu.
    occPlan: plannedOcc(zone.name, v.t, v.nowIdx),
  };
}

function render() {
  const all = payload.t || [];
  const v = buildView(all);
  const t = v.t;
  const marks = viewMarks(t);
  viewT = t;
  viewNowIdx = v.nowIdx;
  shownCursor = null;   // les cartes vont etre remplacees
  frames.clear();
  const eng = payload.engine || {};

  for (const b of document.querySelectorAll('.seg button')) {
    b.classList.toggle('on', b.dataset.view === view);
    b.setAttribute('aria-pressed', String(b.dataset.view === view));
  }

  // Trois etats, dans cet ordre de gravite. Le second est nouveau : si le PUSH
  // s'arrete alors que le moteur tourne, le fichier servi se fige et tout a
  // l'air normal -- `engine.stale` est calcule a l'export, donc il gele avec
  // lui. C'est le seul endroit ou l'horloge du lecteur sert, et seulement comme
  // seuil grossier.
  const frozenMin = (Date.now() - new Date(payload.generated_at).getTime()) / 60000;
  const engEl = $('engine');
  if (Number.isFinite(frozenMin) && frozenMin > 25) {
    engEl.textContent = `données figées depuis ${ago(payload.generated_at, Date.now())}`;
    engEl.className = 'pill stale';
  } else if (eng.stale) {
    engEl.textContent = `maison silencieuse depuis ${ago(eng.last_run) || '?'}`;
    engEl.className = 'pill stale';
  } else {
    engEl.textContent = `mesure de ${eng.last_run ? hhmm(Math.floor(new Date(eng.last_run).getTime() / 1000)) : '—'}`;
    engEl.className = 'pill fresh';
  }

  const oT = payload.outdoor?.T || [];
  // Le CIEL (`radiation`), pas `solar_now` : celui-ci est module par la fenetre
  // de chaque zone et variait d'un facteur 8 entre pieces au meme instant. La
  // serie globale gardait la derniere zone ecrite, donc une piece au hasard.
  const oS = expand(payload.outdoor?.radiation || [], all.length);
  const lastIdx = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null) return i; return -1; };
  const iO = lastIdx(oT), iS = lastIdx(oS);
  // « soleil 0 » ne disait rien : ni unite, ni echelle. Le nombre est un
  // ensoleillement en W/m² sur la vitre, et le seuil qui le rend « fort » est
  // celui du moteur lui-meme (`solar_high_threshold` = 150), pas une echelle
  // inventee ici. Le chiffre reste en title pour qui le veut.
  const solarWord = (v) => (v <= 0 ? 'nuit' : v >= 150 ? 'plein soleil' : 'soleil voilé');
  const outEl = $('outdoor');
  outEl.textContent = `dehors ${iO >= 0 ? oT[iO].toFixed(1) + '°' : '—'}`
    + (iS >= 0 ? ` · ${solarWord(oS[iS])}` : '');
  outEl.title = iS >= 0 ? `rayonnement du ciel ${Math.round(oS[iS])} W/m² (fort au-delà de ${SOLAR_HIGH})` : '';

  // L'electricite est un compteur de MAISON : sur la page d'une piece elle
  // repond a une autre question que celle qu'on est venu poser, et sa presence
  // laisse croire qu'elle parle de cette piece-la.
  $('banners').innerHTML = (zoneFromHash() ? '' : energyHtml(payload.energy))
    + bannerHtml(payload.house);

  // Une piece ouverte : on ne rend qu'elle. Un nom inconnu (zone renommee,
  // lien vieilli) retombe sur la vue d'ensemble plutot que sur une page vide.
  const solo = zoneFromHash();
  const shown = solo ? payload.zones.filter((z) => z.name === solo) : payload.zones;
  const zones = shown.length ? shown : payload.zones;
  $('back').innerHTML = solo && shown.length
    ? '<a class="back" href="#">← toutes les pièces</a>' : '';
  // Une seule piece : la grille repasse a une colonne. Sans ca, la carte reste
  // dans la premiere des trois colonnes et laisse les deux autres vides -- une
  // tuile perdue au bord d'un ecran large, alors que c'est LA page de cette
  // piece. La classe est posee ici plutot qu'avec `:has()` en CSS : le solo est
  // deja calcule, et ca ne depend pas du support du selecteur.
  $('zones').classList.toggle('solo', !!(solo && shown.length));

  if (v.empty) {
    $('zones').innerHTML = '<p class="empty">Pas encore de journée complète avant aujourd\'hui.</p>';
    renderActions();
    $('help-body').innerHTML = helpHtml();
    $('foot-meta').textContent = '';
    return;
  }

  $('zones').innerHTML = zones.length
    ? zones.map((z) => {
      const f = frameFor(z, all.length, v);
      frames.set(z.name, f);
      return zoneCard(z, f, t, marks, v.nowIdx);
    }).join('')
    : '<p class="empty">Aucune zone dans les données.</p>';

  renderActions();

  $('help-body').innerHTML = helpHtml();

  $('foot-meta').textContent =
    `${view === 'day' ? "aujourd'hui" : view === 'yesterday' ? 'hier'
        : payload.window_days + ' derniers jours'}`
    + ` · relevé toutes les 10 min · dernier envoi ${hhmm(Math.floor(new Date(payload.generated_at).getTime() / 1000))}`;
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
    extérieure. Le fond vert est l'objectif de température — elle n'est pas
    plate, elle suit le programme jour / nuit de la zone.</p>
    <p><b>Les axes.</b> En ordonnée, des graduations en °C (l'unité n'est
    écrite qu'une fois, en haut) avec leurs pointillés horizontaux ; l'échelle
    est propre à chaque pièce et s'ajuste à ce qu'elle a vécu sur la fenêtre —
    deux cartes voisines ne sont donc pas à la même échelle. En abscisse, le
    temps, partagé au pixel près avec les pistes du dessous.</p>

    <h3>Ce qui n'a pas encore eu lieu</h3>
    <p>Sur « Aujourd'hui », la fin de journée est tracée en <em>pointillés
    fins</em> : c'est la météo, pas une mesure. Deux courbes seulement — la
    température dehors, et le soleil attendu sur la fenêtre de chaque pièce
    (même calcul que pour le présent, donc une pièce peu exposée reste peu
    exposée dans la prévision).</p>
    <p><b>Prévu contre mesuré.</b> Trois traits à ne pas confondre : la pièce est
    en <em>noir plein</em>, le dehors <em>mesuré</em> en tirets gris, le dehors
    <em>prévu</em> en pointillé violet. La bande violette pâle entre les deux
    derniers <em>est</em> l'écart : large, la météo s'est trompée ; absente, elle
    avait vu juste. Le prévu court aussi sur les heures déjà passées — c'est ce
    qui avait été annoncé, figé au premier relevé de la journée. Survoler donne
    le chiffre (« dehors 13,9°, prévu 16,1°, −2,2° »). L'archive est
    indispensable — la météo réécrit ses heures passées à chaque appel, et
    comparer sans elle opposerait la mesure à une prévision corrigée après coup,
    ce qui flatte la prévision.</p>
    <p>La comparaison reste sur une journée <em>finie</em> — c'est même là
    qu'elle vaut le plus, puisqu'elle est alors complète. Elle vaut donc aussi
    sur « Hier », dès lors que la prévision de ce jour-là a été archivée. Pas
    sur « 7 j » : l'archive ne garde que deux jours, et un trait couvrant un
    sixième de la fenêtre commencerait nulle part.</p>
    <p>L'écart n'est donné que pour le <em>dehors</em> : c'est la seule des deux
    courbes prévues qu'on mesure aussi. Le soleil d'une pièce est lui-même
    calculé à partir de la prévision — un « prévu contre mesuré » y opposerait
    la prévision à elle-même.</p>
    <p>L'occupation, elle, fait exception : c'est une <em>règle</em>, pas une
    prévision. Elle est donc remplie d'avance pour toute la journée et dessinée
    à l'identique — la barre de 22 h est aussi certaine que celle de 8 h. Elle
    ne compte en revanche jamais dans les moyennes ni dans les durées : celles-ci
    ne portent que sur ce qui a eu lieu.</p>
    <p>La température <em>intérieure</em> n'est pas prévue, et les décisions à
    venir non plus. Il faudrait un modèle pour la première, et la seconde
    dépend de ce que la maison verra vraiment. Une courbe modélisée posée à
    côté de courbes mesurées se lirait comme une mesure — les pistes restent
    donc vides à droite du trait rouge.</p>

    <h3>Les pistes</h3>
    <p>Chaque ligne est une lecture verticale du même axe de temps que la courbe.
    Survoler une ligne (ou y poser le doigt) affiche une bulle propre à
    <em>cette</em> ligne : sa valeur à cet instant, et depuis quand elle dure.
    Un trait vertical gris suit le pointeur et traverse toute la pile — il se
    pose sur le relevé décrit par la bulle, pas exactement sous le doigt, pour
    que les deux ne se contredisent pas.</p>
    <ul>
      <li><b>décision</b> — ce que la maison a décidé à cet instant, <em>une seule
      action à la fois</em>. C'est la ligne qui porte le pourquoi (le texte au
      dessus de la courbe) et les pannes d'appareil. Bleu : action de
      refroidissement. Orange : de chauffage. Gris : neutre. Rouge : échec.
      Translucide : action passive (en attente, hors occupation).</li>
      <li><b>soleil</b> — le rayonnement qui frappe la fenêtre de <em>cette</em>
      pièce, en W/m². Ce n'est pas la météo : au même instant, une chambre peu
      exposée en reçoit 34 quand la mezzanine en reçoit 274, pour un ciel
      identique. C'est cette courbe qui explique pourquoi une pièce chauffe et
      pas sa voisine. Le trait orange est le seuil au-delà duquel la maison
      ferme les volets.</li>
      <li>Une <b>consigne d'agenda</b> peut couper un appareil sans que la
      maison soit vide : « clim 2 coupée » est une consigne ponctuelle, pas un
      départ. La carte les nomme distinctement — « consigne : … » d'un côté,
      « absence déclarée » de l'autre, et seule la seconde allume le bandeau en
      haut de page.</li>
      <li><b>occupation</b> — la phase d'occupation de la zone. Une case vide
      est une pièce inoccupée. La barre couvre <em>toute</em> la journée, à
      venir comprise, et de la même façon : ce n'est pas une prévision mais une
      règle — les fenêtres sont dans les réglages, l'agenda du jour est déjà
      interprété. Seul le pré-refroidissement n'y figure pas : il dépend de la
      température qu'aura la pièce, et on ne prédit pas l'intérieur.</li>
      <li><b>clim</b> / <b>ventilo</b> — barre pleine = appareil en marche
      <em>allumé par la maison</em>. C'est le seul état que la maison
      enregistre : un appareil allumé à la main n'apparaît pas ici.</li>
      <li><b>volet</b> — la hauteur de la barre est le pourcentage d'ouverture.
      Barre pleine = grand ouvert, ligne fine = fermé.</li>
    </ul>

    <h3>Les couleurs</h3>
    <div class="chips">${[['var(--cool)', 'refroidir / clim'], ['var(--warm)', 'réchauffer'],
      ['var(--fan)', 'ventilo'], ['var(--occ)', "quelqu'un dans la pièce"],
      ['var(--velux)', 'volet'], ['var(--sun)', 'soleil'], ['var(--alert)', 'panne'],
      ['var(--band)', 'objectif de température'], ['var(--now)', "l'heure qu'il est"],
      ['var(--ink-dim)', 'dehors, mesuré'], ['var(--fc)', 'dehors, prévu']]
      .map(([c, l]) => `<span class="chip"><i style="background:${c}"></i>${l}</span>`).join('')}</div>

    <h3>Occupation</h3>
    <div class="chips">${occ}</div>

    <h3>Actions vues sur cette fenêtre</h3>
    <div class="chips">${actions || '<span class="chip">aucune</span>'}</div>

    <h3>Électricité</h3>
    <p>Ce que consomme <em>toute</em> la maison, relevé sur le compteur Linky :
    le total du jour, du mois et de l'année, en euros au tarif du contrat, plus
    la puissance appelée à l'instant et ce qu'elle coûterait sur une heure. Ce
    n'est pas la consommation d'une pièce, et ce n'est pas que le chauffage —
    c'est le compteur entier, machines et lumières comprises.</p>

    <h3>Le reste</h3>
    <ul>
      <li><b>Cliquer le nom d'une pièce</b> ouvre sa page : la même carte, seule,
      suivie d'un résumé de la fenêtre — moyenne, temps hors de l'objectif,
      durées d'occupation et de marche, pointe de soleil, et le temps passé
      dans chaque action. L'adresse porte la pièce, donc le lien se partage et
      le bouton Retour du navigateur ramène à l'ensemble.</li>
      <li><b>La courbe du coût</b> est celle de <em>toute</em> la maison, en
      haut de page. Sur « Jour » elle monte depuis minuit ; sur « 7 j » chaque
      pic est le total d'une journée, puisque le compteur repart de zéro à
      minuit. Elle se construit à partir des relevés pris toutes les 10 min :
      un compteur ne donne qu'un cumul instantané, l'historique se fabrique.</li>
      <li><b>Hier / Aujourd'hui / 7 j</b> — des jours calendaires de la maison,
      tracés de 00 h à 24 h. Sur « Aujourd'hui », la partie à venir reste vide
      et un trait rouge marque l'heure qu'il est ; « Hier » est une journée
      close, donc sans trait. Le choix est retenu d'une visite à l'autre.</li>
      <li>Sur <b>Hier</b> et <b>7 j</b>, la fenêtre est close : la carte ne
      montre plus l'action du moment ni son motif — ce serait dater de
      maintenant une information sur avant. Elle affiche à la place ce que la
      fenêtre dit : température moyenne (le grand chiffre porte alors
      « moy. »), amplitude min → max, temps hors de l'objectif, et durées de
      marche clim / ventilo.</li>
      <li><b>hors de l'objectif</b> = part de la fenêtre entière — heures inoccupées
      comprises — où la pièce était au-dessus ou en dessous de son objectif,
      comparée à l'objectif <em>de ce moment-là</em> et non à un seuil fixe.
      La restreindre aux seules heures d'occupation a été mesurée : au plus
      7 points d'écart, donc le chiffre simple suffit. Il vire à l'orange
      au-delà de 25 %.</li>
      <li><b>mesure de 12:05</b> en haut à droite : l'heure du dernier relevé. La
      pastille passe au rouge si la maison se tait, et aussi si la page ne
      reçoit plus rien de neuf (« données figées »).</li>
      <li><b>clim off · 7 h</b> sous la ligne d'action : depuis combien de temps
      l'appareil est dans cet état. Un ⚠️ signale un driver qui refuse.</li>
      <li>La page se rafraîchit toute seule chaque minute ; la maison, elle,
      exporte toutes les 10 minutes.</li>
    </ul>`;
}

// Le hash pilote le rendu : un clic sur une piece, un Retour navigateur ou un
// lien colle dans la barre d'adresse passent tous par le meme chemin.
function bindRoute() {
  window.addEventListener('hashchange', () => {
    if (payload) render();
    window.scrollTo(0, 0);
  });
}

function bindView() {
  $('view').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (!b || b.dataset.view === view) return;
    view = b.dataset.view;
    store.set(VIEW_KEY, view);
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
        + (v ? `<br>${dim('allumé par la maison')}` : '');
    }
    case 'solar': {
      if (f.solar[i] == null) return 'pas de mesure';
      const v = f.solar[i];
      return `soleil sur cette pièce : <b>${v} W/m²</b><br>`
        + dim(v >= SOLAR_HIGH ? 'assez fort pour agir sur les volets' : 'sous le seuil d\'action');
    }
    case 'velux': {
      if (f.velux[i] == null) return 'pas de position connue';
      return `volet ${f.velux[i]}% ouvert<br>${dim(runSpan(f.velux, i, t))}`;
    }
    default: {
      const temp = f.T[i], lo = f.bmin[i], hi = f.bmax[i];
      const prev = f.fc && f.fc.past ? f.fc.past[i] : null;
      // L'ecart n'a de sens que pour le DEHORS : c'est la seule des deux
      // series prevues qu'on mesure aussi.
      const gap = prev != null && f.out[i] != null
        ? ` <span class="dim">(prévu ${prev.toFixed(1)}°, ${
            Math.abs(f.out[i] - prev) < 0.05 ? 'pile'
            : `${f.out[i] > prev ? '+' : '−'}${Math.abs(f.out[i] - prev).toFixed(1)}°`})</span>`
        : '';
      return `${temp != null ? `<b>${temp.toFixed(1)}°</b>` : 'pas de mesure'}`
        + `${f.out[i] != null ? ` · dehors ${f.out[i].toFixed(1)}°${gap}` : ''}`
        + `${lo != null && hi != null ? `<br>${dim(`objectif ${lo}–${hi}°`)}` : ''}`;
    }
  }
}

// Curseur vertical : materialise le point de mesure lu par la bulle. Il se
// place sur l'index RETENU, pas sous le doigt -- entre deux creneaux, la bulle
// annonce une valeur et le trait doit designer celle-la, sinon les deux se
// contredisent a l'oeil.
//
// En surcouche CSS et non dans les SVG : le trait traverse toute la pile, or
// chaque trace est un SVG separe. Une div positionnee dans `.tracks` donne une
// ligne continue, et surtout un seul element a bouger a chaque mouvement de
// souris plutot qu'un re-rendu de six graphiques.
let shownCursor = null;

function hideCursor() {
  if (shownCursor) { shownCursor.hidden = true; shownCursor = null; }
}

function placeCursor(card, svg, i, n) {
  const cur = card.querySelector('.cursor');
  const tracks = card.querySelector('.tracks');
  if (!cur || !tracks) return;
  const tr = tracks.getBoundingClientRect(), sr = svg.getBoundingClientRect();
  const axis = card.querySelector('.axis');
  // S'arrete au-dessus de l'axe : le trait barrerait les heures.
  const bottom = axis ? axis.getBoundingClientRect().top : tr.bottom;
  cur.style.left = `${(sr.left - tr.left) + (i / Math.max(1, n - 1)) * sr.width}px`;
  cur.style.height = `${Math.max(0, bottom - tr.top)}px`;
  if (shownCursor && shownCursor !== cur) shownCursor.hidden = true;
  cur.hidden = false;
  shownCursor = cur;
}

// Curseur de lecture sur la courbe electrique. Handler a part de celui des
// cartes : le bloc vit dans #banners, hors de #zones, et surtout ses deux series
// ont chacune leur pas -- on cherche donc le point le plus proche EN TEMPS, pas
// a l'index. Chercher a l'index aurait fait afficher une temperature d'une autre
// heure sous le curseur.
function nearest(list, ts) {
  if (!list || !list.length) return null;
  let best = null, bd = Infinity;
  for (const q of list) {
    const dd = Math.abs(q[0] - ts);
    if (dd < bd) { bd = dd; best = q; }
  }
  return best;
}

function bindEnergyTip() {
  const tip = $('tip');
  const host = $('banners');
  host.addEventListener('pointermove', (ev) => {
    // On ecoute sur tout le bloc, pas seulement sur le trace : les pistes
    // d'appareils sont precisement l'endroit ou l'on veut lire « a cet instant,
    // qu'est-ce qui tournait ». La geometrie reste celle du trace, qui a la
    // meme largeur que les pistes (meme gouttiere).
    const block = ev.target.closest('.ecurve');
    const plot = block && block.querySelector('.eplot');
    if (!plot || !ecurve) { tip.hidden = true; return; }
    const r = plot.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    const ts = ecurve.t0 + f * (ecurve.t1 - ecurve.t0);

    // `use` est NULL quand le cout n'est pas encore publie : la bulle doit
    // continuer a donner l'heure, le dehors et les appareils. Lire un point
    // inexistant plantait le handler, et un handler mort emporte le curseur
    // avec lui -- on perdait trois informations pour l'absence d'une seule.
    const c = ecurve.use ? nearest(ecurve.use, ts) : null;
    const o = nearest(ecurve.oT, ts);
    // La temperature n'est montree que si elle est PROCHE dans le temps : au
    // bord d'une fenetre, le point le plus proche peut etre a des heures, et
    // l'afficher sous le curseur en ferait une mesure de cet instant.
    const oOk = o && Math.abs(o[0] - ts) <= 1800;
    // Quels appareils tournaient a cet instant. Le rang est cherche dans l'axe
    // des ticks du moteur, JAMAIS dans celui de la courbe de charge : ils n'ont
    // pas le meme pas. Seuls les consommateurs sont listes -- l'ouverture d'un
    // volet se lit deja a la hauteur de sa barre, et neuf lignes de bulle a
    // chaque survol la rendraient illisible.
    let onNow = '';
    if (ecurve.devs && ecurve.devs.length && ecurve.ts && ecurve.ts.length) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < ecurve.ts.length; i++) {
        const dd = Math.abs(ecurve.ts[i] - ts);
        if (dd < bd) { bd = dd; bi = i; }
      }
      if (bd <= 900) {
        const names = ecurve.devs.filter((dv) => dv.ser[bi]).map((dv) => dv.name);
        onNow = names.length
          ? `<br><span class="dim">en marche :</span> ${esc(names.join(', '))}`
          : '<br><span class="dim">aucun appareil en marche</span>';
        // Les volets sur UNE ligne, pas une par volet : ils ne consomment rien,
        // et deux lignes de plus a chaque survol pousseraient hors de l'ecran la
        // seule chose qu'on est venu lire. Une position absente est passee sous
        // silence -- « pas de mesure » n'est pas « ferme ».
        const vs = (ecurve.vlx || [])
          .filter((v) => v.ser[bi] != null)
          // Parentheses et pas un espace : « Salle de Bains 1 » finit par un
          // chiffre, et « Salle de Bains 1 0 % » se lit 10 %. Un nom de piece
          // peut toujours finir par un nombre -- la separation doit tenir sans
          // dependre de la piece.
          .map((v) => `${v.name} (${v.ser[bi]} %)`);
        if (vs.length) onNow += `<br><span class="dim">volets :</span> ${esc(vs.join(', '))}`;
      }
    }
    const at = c ? c[0] : Math.round(ts);
    tip.innerHTML = `<b>${dayLabel(at)} ${hhmm(at)}</b><br>`
      + (c ? `électricité : <b>${esc(ecurve.fmt(ecurve.unit(c[1])))}</b>`
           : '<span class="dim">coût pas encore publié</span>')
      + (oOk ? `<br>dehors : <b>${o[1].toLocaleString('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}°</b>` : '')
      + (o && !oOk ? '<br><span class="dim">pas de mesure du dehors ici</span>' : '')
      + onNow;
    tip.hidden = false;

    const cur = block.querySelector('.ecur');
    if (cur) {
      cur.style.left = `${((at - ecurve.t0) / (ecurve.t1 - ecurve.t0) * 100).toFixed(2)}%`;
      cur.hidden = false;
    }
    const w = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, ev.clientX - w / 2)) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + 'px';
  });
  host.addEventListener('pointerleave', () => {
    tip.hidden = true;
    const cur = host.querySelector('.ecur');
    if (cur) cur.hidden = true;
  });
}

function bindTip() {
  const tip = $('tip');
  $('zones').addEventListener('pointermove', (ev) => {
    const card = ev.target.closest('.zone');
    const svg = ev.target.closest('.chart, .strip, .sun');
    if (!card || !svg || !payload) { tip.hidden = true; hideCursor(); return; }
    const f = frames.get(card.dataset.zone);
    const t = viewT;
    if (!f || !t.length) return;

    const r = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(t.length - 1,
      Math.round(((ev.clientX - r.left) / r.width) * (t.length - 1))));

    // Au-dela du marqueur on n'est pas devant une donnee manquante mais devant
    // une heure qui n'a pas encore eu lieu -- le dire evite de lire un trou de
    // service la ou il n'y a que le futur.
    const ahead = viewNowIdx >= 0 && i > viewNowIdx;
    const track = svg.dataset.track || 'chart';
    // Au-dela du marqueur on n'a que de la prevision -- et seulement pour le
    // dehors et le soleil. Le reste n'a pas eu lieu, et on le dit.
    let body;
    if (ahead && track === 'occ' && f.occPlan && f.occPlan[i] != null) {
      body = `occupation prévue : <b>${esc(occMeta(f.occPlan[i]).label)}</b><br>`
        + `<span class="dim">règle horaire + agenda du jour</span>`;
    } else if (!ahead) body = tipFor(track, f, i, t);
    else if (track === 'solar' && f.fc && f.fc.solar && f.fc.solar[i] != null) {
      body = `soleil prévu : <b>${f.fc.solar[i]} W/m²</b><br><span class="dim">prévision météo</span>`;
    } else if (track === 'chart' && f.fc && f.fc.out && f.fc.out[i] != null) {
      body = `dehors, prévu : <b>${f.fc.out[i].toFixed(1)}°</b><br><span class="dim">prévision météo</span>`;
    } else body = '<span class="dim">à venir</span>';
    tip.innerHTML = `<b>${dayLabel(t[i])} ${hhmm(t[i])}</b><br>` + body;
    tip.hidden = false;
    placeCursor(card, svg, i, t.length);
    // Keep the readout on screen near the right edge of a phone.
    const w = tip.offsetWidth;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, ev.clientX - w / 2)) + 'px';
    tip.style.top = (r.top - tip.offsetHeight - 8 < 8 ? r.bottom + 8 : r.top - tip.offsetHeight - 8) + 'px';
  });
  $('zones').addEventListener('pointerleave', () => { tip.hidden = true; hideCursor(); });
  // Un re-rendu remplace les cartes : la reference gardee pointerait sur un
  // element detache, et le curseur resterait invisible pour toujours.
  window.addEventListener('scroll', hideCursor, { passive: true });
}

/* ── actions ─────────────────────────────────────────────────────────────── */

/* The only part of this page that writes. It calls its own origin -- `api/...`
 * -- and knows nothing of where the house is: nginx holds the address and the
 * bearer. See the README.
 *
 * Three rules earned the hard way and worth keeping:
 *
 * 1. A 200 proves nothing. Point the proxy at the wrong upstream and the tailnet
 *    answers 200 with somebody else's HTML. So every answer is checked for the
 *    shape we expect, and anything else is a failure.
 * 2. Unreachable means visibly disarmed, never a button that looks normal and
 *    does nothing. The panel says so and draws no buttons at all.
 * 3. Which rooms can be acted on comes from the API, not from a table written
 *    here. This repository is public and holds no knowledge of the house; a
 *    hard-coded "Chambre 1 -> clim1" would leak it AND freeze a mapping that
 *    lives with the engine.
 */

// null = not probed yet. Otherwise {ok, directives, zones, text} or {error}.
let ctl = null;
let ctlBusy = false;
// Last answer from the engine, shown verbatim: it is the only thing that knows
// whether the directive was applied now or waits for the next tick.
let ctlSaid = null;

async function apiCall(path, opts) {
  const res = await fetch(path, { cache: 'no-store', ...opts });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch { /* handled just below */ }
  // Rule 1: shape, not status. `ok` is a boolean in every answer the comfort
  // API gives, including its refusals.
  if (!json || typeof json.ok !== 'boolean') {
    throw new Error(res.ok ? 'réponse inattendue' : `HTTP ${res.status}`);
  }
  return json;
}

async function loadCtl() {
  try {
    ctl = await apiCall('api/state');
  } catch (e) {
    ctl = { error: e.message };
  }
}

// « ce soir » expire a minuit, et le moteur peut alors relancer une clim entre
// minuit et le passage du cron d'agenda a 05h07 -- c'est un trou constate, pas
// une hypothese. On ne le cache pas derriere un libelle vague : la ligne le dit,
// et « cette nuit » (jusqu'a demain) est propose juste a cote.
const tomorrowKey = () => dayKey(Math.floor(Date.now() / 1000) + 86400);

// Ce que chaque type d'appareil se laisse faire. Le vocabulaire est porte ici
// parce qu'il differe VRAIMENT d'un appareil a l'autre : couper une clim et
// figer un volet ne sont pas la meme action. Un volet n'a pas d'etat
// allume/eteint mais une position -- dire « couper le volet » ferait croire a
// une fermeture, soit l'inverse d'un volet reste ouvert.
// Vocabulaire par appareil. Le volet a trois actions et non deux : il n'a pas
// d'etat marche/arret mais une POSITION, et « le laisser tranquille » (figer)
// est une troisieme intention, pas l'absence des deux autres.
const KIND_UI = {
  ac:    { label: 'Clim',        libre: 'Clim pilotée normalement par le moteur.',
           on: 'Allumer', off: 'Couper', coupe: 'Clim coupée' },
  fan:   { label: 'Ventilateur', libre: 'Ventilateur piloté normalement par le moteur.',
           on: 'Allumer', off: 'Couper', coupe: 'Ventilateur coupé' },
  velux: { label: 'Volet',       libre: 'Volet piloté normalement par le moteur.',
           on: 'Ouvrir', off: 'Fermer', fige: 'Figer', coupe: 'Volet figé — il reste où il est' },
};
// Ordre d'affichage stable, du levier le plus utilise au moins utilise. Sans
// lui, l'ordre viendrait des cles du JSON et pourrait changer d'un deploiement
// a l'autre -- des boutons qui se deplacent sous le pouce.
const KIND_ORDER = ['ac', 'fan', 'velux'];

// ── Durees ───────────────────────────────────────────────────────────────────
// UNE seule notion de duree, choisie AVANT l'action. Le panneau en offrait
// quatre expressions concurrentes (« ce soir », « cette nuit », des heures, une
// date) pour la meme dimension, et le champ date COMMANDAIT la maison des qu'on
// touchait au selecteur -- seul controle de la page a agir sans qu'on appuie sur
// rien. Ici la date ne fait que renseigner la duree ; c'est l'action qui agit.
// Deux facons de borner une consigne, et le francais dit ou passe la coupure :
// on coupe « PENDANT 3 h », ou « JUSQU'A ce soir ». « Ce soir » n'est donc pas
// une duree, c'est un terme -- le ranger avec les heures obligeait a lire
// « pendant ce soir ». Un premier decoupage (« durée » / « jusqu'au ») donnait
// « jusqu'à durée », qui ne compose aucune phrase.
const DURATIONS = [
  { id: '1h', label: '1 h', hours: 1 },
  { id: '2h', label: '2 h', hours: 2 },
  { id: '3h', label: '3 h', hours: 3 },
  { id: '6h', label: '6 h', hours: 6 },
];
// Termes : des points d'arret, pas des durees. `until` null = ce soir minuit.
const ENDPOINTS = [
  { id: 'soir', label: 'ce soir', until: null },
  { id: 'demain', label: 'demain', tomorrow: true },
];
const DEFAULT_END = 'soir';
const DEFAULT_DUR = '3h';
const endPick = new Map();   // "zone|kind" -> id du terme choisi
// Selection par appareil, gardee hors du DOM : le panneau est re-rendu apres
// chaque commande, et un choix stocke dans le HTML disparaitrait a ce moment-la.
const durPick = new Map();
const durDate = new Map();
// « durée » OU « jusqu'au » : le choix est EXCLUSIF, il doit donc se voir comme
// un choix. Les deux rangées affichées cote a cote, l'une s'eteignant quand
// l'autre se remplit, laissaient croire a deux reglages qui coexistent.
const durMode = new Map();   // "zone|kind" -> 'dur' | 'date' 
let absentDate = null;
const durKey = (zone, kind) => `${zone}|${kind}`;

const hhmmLocal = (ts) => new Date(ts * 1000).toLocaleTimeString('fr-FR',
  { hour: '2-digit', minute: '2-digit' });

// Heures restantes jusqu'a la fin d'un jour donne (null = aujourd'hui). Sert a
// exprimer « ce soir » comme une duree : un forcage EN MARCHE n'existe qu'en
// heures cote moteur, il n'a pas d'equivalent a l'echelle du jour.
function hoursUntilEndOf(dayIso) {
  const now = new Date();
  const end = dayIso ? new Date(`${dayIso}T23:59:59`) : new Date(now);
  if (!dayIso) end.setHours(23, 59, 59, 0);
  const h = (end.getTime() - now.getTime()) / 3600000;
  return h > 0 ? Math.round(h * 10) / 10 : null;
}

// Ce que la duree choisie sait exprimer, pour chaque sens d'action.
//   forceHours : duree en heures pour un forcage (marche OU arret minute)
//   dayUntil   : date d'echeance pour une consigne a l'echelle du jour
//                (undefined = « ce soir », pas de date a poser)
function durationSpec(zoneName, kind) {
  const key = durKey(zoneName, kind);
  if ((durMode.get(key) || 'dur') === 'dur') {
    const id = durPick.get(key) || DEFAULT_DUR;
    const d = DURATIONS.find((x) => x.id === id) || DURATIONS[2];
    return { id, label: d.label, forceHours: d.hours, dayScale: false };
  }
  // Terme : « ce soir », « demain », ou une date. Tous de meme nature -- un
  // point d'arret -- donc un seul choix parmi eux, dont la date fait partie.
  const id = endPick.get(key) || DEFAULT_END;
  if (id === 'date') {
    const day = durDate.get(key) || null;
    return { id, label: day ? frDate(day) : 'une date', dayScale: true, until: day,
             forceHours: day ? hoursUntilEndOf(day) : null, missing: !day };
  }
  const e = ENDPOINTS.find((x) => x.id === id) || ENDPOINTS[0];
  const until = e.tomorrow ? tomorrowKey() : null;
  return { id, label: e.label, dayScale: true, until,
           forceHours: hoursUntilEndOf(until) };
}

function durationRow(zoneName, kind) {
  const key = durKey(zoneName, kind);
  const mode = durMode.get(key) || 'dur';
  const z = `data-zone="${esc(zoneName)}" data-kind="${esc(kind)}"`;
  // Le choix du MODE d'abord. Un seul controle est ensuite montre : c'est le
  // seul moyen qu'« ou bien, ou bien » se lise sans avoir a l'expliquer.
  const tabs = [['dur', 'pendant'], ['date', "jusqu'à"]].map(([id, lbl]) =>
    `<button type="button" class="dur dur-mode${id === mode ? ' on' : ''}"
      data-mode="${id}" ${z} aria-pressed="${id === mode}">${lbl}</button>`).join('');

  let body;
  if (mode === 'dur') {
    const cur = durPick.get(key) || DEFAULT_DUR;
    body = DURATIONS.map((d) =>
      `<button type="button" class="dur${d.id === cur ? ' on' : ''}" data-dur="${d.id}" ${z}
        aria-pressed="${d.id === cur}">${esc(d.label)}</button>`).join('');
  } else {
    const cur = endPick.get(key) || DEFAULT_END;
    body = ENDPOINTS.map((e) =>
      `<button type="button" class="dur${e.id === cur ? ' on' : ''}" data-end="${e.id}" ${z}
        aria-pressed="${e.id === cur}">${esc(e.label)}</button>`).join('')
      + `<input type="date" class="dur-date${cur === 'date' ? ' on' : ''}" ${z}
          value="${esc(durDate.get(key) || '')}"
          min="${dayKey(Math.floor(Date.now() / 1000))}">`;
  }
  // Deux rangees : les onglets, puis les valeurs. Tout sur une seule debordait
  // au telephone -- et melanger « a quelle question on repond » avec « quelle
  // reponse » sur la meme ligne les met au meme rang, ce qu'ils ne sont pas.
  return `<div class="act-row act-dur">${tabs}</div>
    <div class="act-row act-dur act-vals">${body}</div>`;
}

// Un bouton d'action, arme ou visiblement desarme AVEC sa raison. Un bouton qui
// part et se fait refuser par l'API apprend la regle apres coup ; desarme, il
// l'apprend avant.
//
// `active` = c'est l'etat COURANT de l'appareil. Les trois boutons sont des
// MODES entre lesquels on bascule, pas des actions de rangs differents : ils
// partagent donc la meme apparence, et seule l'appartenance a l'etat courant
// les distingue. « Piloté par le moteur » n'etait qu'une pastille : en faire un
// bouton rend le retour a l'automatique aussi direct que l'en sortir.
function actBtn(label, body, zoneName, why, active) {
  const cls = `act${active ? '' : ' act-quiet'}`;
  if (why) {
    return `<button type="button" class="${cls}" disabled title="${esc(why)}">${esc(label)}</button>`;
  }
  if (active) {
    // L'etat courant ne se represse pas : il se lit. Le desarmer evite un aller
    // -retour inutile jusqu'au moteur pour ne rien changer.
    return `<button type="button" class="${cls}" disabled aria-current="true">${esc(label)}</button>`;
  }
  return `<button type="button" class="${cls}" data-body="${esc(JSON.stringify(body))}">${esc(label)}</button>`;
}

const MAX_FORCE_H = 24;   // borne de l'API : un forcage se compte en heures

function kindBlock(kind, info, zoneName, absent) {
  const ui = KIND_UI[kind];
  if (!ui) return '';
  // PAS `info.verb` : pour la clim c'est `clim1`/`clim2`/`salon`, qui nomment
  // leur piece en dur et refusent une piece en parametre.
  const verb = info.manual_verb || info.verb;
  const d = durationSpec(zoneName, kind);
  const m = info.manual;

  // L'ETAT COURANT n'est plus une pastille a cote des boutons : c'est celui des
  // boutons qui est marque. Trois modes entre lesquels on bascule -- coupé, en
  // marche, piloté -- et le mode actif porte SON echeance dans son libelle, la
  // ou les autres portent leur verbe.
  const mode = m ? (m.mode === 'on' ? 'on' : 'off')
    : (absent && kind !== 'velux') ? 'absent'
    : info.off ? 'off' : 'auto';
  const fin = m ? ` jusqu'à ${hhmmLocal(m.until_ts)}`
    : info.until ? ` jusqu'au ${frDate(info.until)}`
    : info.off ? ' ce soir' : '';

  const tooLong = "un forçage en marche se compte en heures : au-delà d'une "
    + 'journée, coupez plutôt, ou rendez la main au moteur';
  const needDate = 'choisir une date d’abord';
  const dayOnly = 'figer un volet se déclare à la journée, pas à l’heure';
  const whyForce = d.missing ? needDate
    : !d.forceHours ? tooLong
    : d.forceHours > MAX_FORCE_H ? tooLong : null;

  const acts = [];
  if (kind === 'velux') {
    acts.push(actBtn(mode === 'on' ? `Ouvert${fin}` : ui.on,
                     { cmd: verb, value: 'on', zone: zoneName, hours: d.forceHours },
                     zoneName, mode === 'on' ? null : whyForce, mode === 'on'));
    acts.push(actBtn(mode === 'off' && m ? `Fermé${fin}` : ui.off,
                     { cmd: verb, value: 'off', zone: zoneName, hours: d.forceHours },
                     zoneName, (mode === 'off' && m) ? null : whyForce, mode === 'off' && m));
    // Figer = « n'y touche plus », une intention a l'echelle du jour.
    const figeActive = mode === 'off' && !m;
    const bodyF = { cmd: verb, value: 'off', zone: zoneName };
    if (d.until) bodyF.until = d.until;
    acts.push(actBtn(figeActive ? `Figé${fin}` : ui.fige, bodyF, zoneName,
                     figeActive ? null : (!d.dayScale ? dayOnly : d.missing ? needDate : null),
                     figeActive));
  } else {
    const offBody = d.dayScale
      ? { cmd: verb, value: 'off', zone: zoneName, ...(d.until ? { until: d.until } : {}) }
      : { cmd: verb, value: 'off', zone: zoneName, hours: d.forceHours };
    acts.push(actBtn(mode === 'off' ? `Coupé${fin}` : ui.off, offBody, zoneName,
                     mode === 'off' ? null : (d.missing ? needDate : null), mode === 'off'));
    acts.push(actBtn(mode === 'on' ? `En marche${fin}` : ui.on,
                     { cmd: verb, value: 'on', zone: zoneName, hours: d.forceHours },
                     zoneName, mode === 'on' ? null : whyForce, mode === 'on'));
  }
  // Le troisieme mode : rendre la main. Toujours propose, y compris quand il est
  // deja actif -- c'est lui qui dit « rien ne bloque ».
  acts.push(actBtn('Piloté par le moteur', { cmd: verb, value: 'on', zone: zoneName },
                   zoneName, null, mode === 'auto'));

  // `absent` bloque clim et ventilo partout : le dire, plutot que de laisser
  // croire qu'un bouton de cette piece y changera quelque chose.
  const note = mode === 'absent'
    ? `<p class="act-none">Maison déclarée vide : déjà coupé partout, dans toutes
       les pièces. Ces boutons reprendront la main au retour.</p>`
    : '';

  return `<div class="act-kind"><h4>${ui.label}</h4>
    ${note}
    <div class="act-row">${acts.join('')}</div>
    ${durationRow(zoneName, kind)}
  </div>`;
}

function zonePanel(zoneName) {
  const kinds = (ctl.zones || {})[zoneName];
  if (!kinds || !Object.keys(kinds).length) {
    return `<p class="act-none">Aucune commande pour cette pièce : le moteur n'y
      pilote aucun appareil qui accepte une consigne manuelle.</p>`;
  }
  const absent = !!(ctl.directives || {}).absent;
  const blocks = KIND_ORDER.filter((k) => kinds[k])
    .map((k) => kindBlock(k, kinds[k], zoneName, absent)).join('');
  // Plus de phrase d'echeance ici : chaque appareil porte la sienne, juste
  // au-dessus de ses boutons. Reprendre une date au pied du panneau obligerait
  // a choisir LAQUELLE quand deux appareils sont coupes a des dates
  // differentes -- et la fenetre globale du fichier, qui servait a ca, ne
  // gouverne plus les coupures par zone.
  // La note ne vaut que pour UN choix de durée : ne la montrer que s'il est
  // retenu quelque part. Répétée sous chaque pièce, elle se lisait comme une
  // mise en garde générale sur les boutons.
  const soir = Object.keys(kinds).some((k) => durationSpec(zoneName, k).id === 'soir');
  return blocks + (soir
    ? `<p class="act-fine">« Ce soir » s'arrête à minuit — le moteur peut
       reprendre entre minuit et 5 h du matin. Pour couvrir la nuit, choisir une
       date.</p>`
    : '');
}

function housePanel() {
  const d = ctl.directives || {};
  // `d.until` est une CARTE {clé: date} depuis le 24/08 : chaque consigne porte
  // sa fenêtre. La ligne d'absence prend donc celle de l'absence -- la lire en
  // bloc afficherait « [object Object] », et une date unique parlerait au nom
  // de consignes qui ne l'ont pas demandée.
  // Trois sujets sans rapport entre eux -- l'absence, Thea, l'annulation --
  // etaient empiles sans rien qui les separe : les boutons se touchaient et on
  // ne voyait plus lequel repondait a quoi. Meme decoupage en blocs titres que
  // sur la page d'une piece, ou il marche deja.
  const block = (title, body) => `<div class="act-kind"><h4>${title}</h4>${body}</div>`;
  const out = [];

  out.push(block('Absence', d.absent
    ? `<p class="act-state">🚪 Maison déclarée vide${d.absent_reason ? ` (${esc(d.absent_reason)})` : ''}${(d.until || {}).absent ? `, jusqu'au ${esc(frDate(d.until.absent))} inclus` : ''}.</p>
       <div class="act-row"><button type="button" class="act" data-cmd="absent" data-value="off">Nous sommes rentrés</button></div>`
    // Même règle que pour les appareils : la date RENSEIGNE, le bouton agit.
    // Elle déclenchait la commande sur simple choix, et sur téléphone le
    // sélecteur natif émet son événement pendant qu'on fait défiler les jours.
    // Même découpage que sur un appareil : la durée d'un côté, la date de
    // l'autre. Ici la durée n'a qu'une valeur possible (« ce soir »), donc seule
    // la date a besoin d'une rangée — vide, l'absence vaut pour aujourd'hui.
    // Même choix exclusif que sur un appareil : « aujourd'hui » OU « jusqu'au ».
    // Un seul contrôle montré à la fois.
    // Meme vocabulaire que sur un appareil : des TERMES, pas des durees. Ici il
    // n'y a pas de « pendant » -- une absence se declare jusqu'a une date, pas
    // pour trois heures -- donc les termes sont proposes directement.
    : `<div class="act-row">
         ${actBtn('Maison vide', absentDate
             ? { cmd: 'absent', value: 'on', until: absentDate }
             : { cmd: 'absent', value: 'on' }, null,
             absentDate === '' ? 'choisir une date d’abord' : null, true)}
       </div>
       <div class="act-row act-dur act-vals"><span class="act-tag">jusqu'à</span>
         <button type="button" class="dur${absentDate === null ? ' on' : ''}"
           data-abs-mode="jour" aria-pressed="${absentDate === null}">ce soir</button>
         <input type="date" class="abs-date${absentDate ? ' on' : ''}" data-for="absent"
           value="${esc(absentDate || '')}" min="${tomorrowKey()}">
       </div>`));

  out.push(block('Théa', d.at_creche === true
    ? `<p class="act-state">🏫 À la crèche.</p>
       <div class="act-row"><button type="button" class="act" data-cmd="sieste">Elle est à la maison</button></div>`
    : d.at_creche === false
      ? `<p class="act-state">🏠 À la maison (fenêtre sieste ouverte).</p>
         <div class="act-row"><button type="button" class="act" data-cmd="creche" data-value="on">Elle est à la crèche</button></div>`
      : `<div class="act-row">
           <button type="button" class="act" data-cmd="sieste">À la maison</button>
           <button type="button" class="act" data-cmd="creche" data-value="on">À la crèche</button>
         </div>`));

  // N'apparait que s'il y a quelque chose a annuler : un bouton qui n'efface
  // rien inviterait a le presser pour verifier.
  if ((d.manual || []).length) {
    out.push(block('Mes consignes du jour',
      `<div class="act-row"><button type="button" class="act act-quiet" data-cmd="reset">Tout annuler</button></div>`));
  }
  return out.join('');
}

function actionsHtml() {
  // Agir depuis une page qui parle d'hier n'a pas de sens : la fenetre est
  // close, et le bouton porterait sur maintenant tout en etant lu dans le
  // contexte d'avant.
  if (isRetro()) return '';
  if (!ctl) return `<section class="acts"><h3>Agir</h3><p class="act-none">Vérification des commandes…</p></section>`;

  const solo = zoneFromHash();
  let body;
  if (ctl.error) {
    body = `<p class="act-none act-ko">Commandes indisponibles (${esc(ctl.error)}).
      La maison continue d'être pilotée normalement — c'est la main qui manque,
      pas le moteur.</p>`;
  } else if (ctl.zones == null) {
    body = `<p class="act-none act-ko">Impossible de savoir quelles pièces
      acceptent une consigne : aucun bouton n'est proposé plutôt que d'en
      proposer au hasard.</p>`;
  } else {
    body = solo ? zonePanel(solo) : housePanel();
  }

  return `<section class="acts" ${ctlBusy ? 'data-busy="1"' : ''}>
    <h3>Agir${solo ? ` · ${esc(solo)}` : ' sur la maison'}</h3>
    ${body}
    ${ctlSaid ? `<p class="act-said ${ctlSaid.ok ? '' : 'act-ko'}">${esc(ctlSaid.text)}</p>` : ''}
    ${ctlBusy ? '<p class="act-fine">envoi en cours…</p>' : ''}
  </section>`;
}

async function sendDirective(body) {
  if (ctlBusy) return;
  ctlBusy = true; ctlSaid = null;
  renderActions();
  try {
    const j = await apiCall('api/directive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // The engine's own sentence, verbatim. It is the only thing that knows
    // whether this took effect now or waits for the next tick -- rewording it
    // here would be inventing a certainty.
    ctlSaid = { ok: j.ok, text: j.text || j.error || (j.ok ? 'appliqué' : 'refusé') };
    if (j.ok) markActed(body);
  } catch (e) {
    ctlSaid = { ok: false, text: `Commande non transmise (${e.message}). Rien n'a changé dans la maison.` };
  }
  ctlBusy = false;
  await loadCtl();
  renderActions();
  // The curves come from the pushed payload, not from this call: they will
  // catch up at the next export. Refreshing now costs nothing and shows the
  // new directive as soon as it lands.
  load();
}

// Quelles cartes une commande vient-elle de toucher ? Une commande de piece n'en
// touche qu'une ; `absent` et les consignes Thea valent pour toute la maison, et
// n'en marquer aucune laisserait un clic sans le moindre accuse de reception.
function markActed(body) {
  const now = Date.now();
  const solo = body.zone || (ctl.zones && Object.entries(ctl.zones)
    .find(([, kinds]) => Object.values(kinds).some((k) => k.verb === body.cmd))?.[0]);
  const names = solo ? [solo] : Object.keys(ctl.zones || {});
  for (const n of names) acted.set(n, now);
  // Le lisere doit s'eteindre meme si rien d'autre ne provoque de rendu.
  setTimeout(() => { if (payload) render(); }, FLASH_MS + 50);
}

function renderActions() {
  // Deliberately NOT gated on the payload. The panel needs none of it (parts()
  // already falls back to Europe/Paris), and hiding the buttons when the push
  // is broken would remove the hand exactly when the automatic path is the one
  // in doubt.
  const el = $('actions');
  if (el) el.innerHTML = actionsHtml();
}

function bindActions() {
  $('actions').addEventListener('click', (ev) => {
    // Une puce de durée ne commande RIEN : elle choisit, et le panneau se
    // redessine pour montrer ce que ce choix rend possible.
    const dur = ev.target.closest('button.dur');
    if (dur) {
      if (dur.dataset.mode) {
        durMode.set(durKey(dur.dataset.zone, dur.dataset.kind), dur.dataset.mode);
        renderActions();
        return;
      }
      if (dur.dataset.absMode) {
        absentDate = dur.dataset.absMode === 'jour' ? null : (absentDate || '');
      }
      else if (dur.dataset.end) {
        endPick.set(durKey(dur.dataset.zone, dur.dataset.kind), dur.dataset.end);
      } else durPick.set(durKey(dur.dataset.zone, dur.dataset.kind), dur.dataset.dur);
      renderActions();
      return;
    }
    const b = ev.target.closest('button.act');
    if (!b || b.disabled) return;
    // Le corps est calculé au RENDU, pas au clic : c'est le seul moyen que le
    // bouton désarmé et le bouton armé parlent de la même chose.
    if (b.dataset.body) { sendDirective(JSON.parse(b.dataset.body)); return; }
    const body = { cmd: b.dataset.cmd };
    if (b.dataset.value) body.value = b.dataset.value;
    if (b.dataset.until) body.until = b.dataset.until;
    if (b.dataset.zone) body.zone = b.dataset.zone;
    if (b.dataset.hours) body.hours = Number(b.dataset.hours);
    sendDirective(body);
  });
  // Choisir une date ne commande plus rien : elle renseigne la durée, et c'est
  // l'action qui agit. Le sélecteur natif émet `change` pendant qu'on fait
  // défiler les jours — on pouvait couper une clim en explorant.
  $('actions').addEventListener('change', (ev) => {
    const i = ev.target.closest('input[type=date]');
    if (!i || !i.value) return;
    if (i.classList.contains('dur-date')) {
      const k = durKey(i.dataset.zone, i.dataset.kind);
      durDate.set(k, i.value);
      endPick.set(k, 'date');   // choisir une date, c'est choisir ce terme-la
    } else if (i.dataset.for === 'absent') {
      absentDate = i.value;
    }
    renderActions();
  });
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
bindRoute();
bindTip();
bindEnergyTip();
bindActions();
// Probed once at boot and re-read after every command. Not on the refresh
// timer: the directives change when someone changes them, and polling the
// house's control plane every minute to redraw two buttons would be noise.
loadCtl().then(renderActions);
load();
setInterval(load, REFRESH_MS);
// Coming back to a backgrounded tab must show now, not the last poll.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
