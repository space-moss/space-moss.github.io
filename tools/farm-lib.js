'use strict';
/* Shared pieces for the farm tools: load the notebook's FarmSim, run Life on small patterns,
   put patterns in a canonical form, name them, and test whether a structure feeds a parked rover. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');

/* The simulation lives in index.html. Pull it out so the tools always run exactly what the site runs. */
function loadFarmSim(indexPath = path.join(ROOT, 'index.html')) {
  const src = fs.readFileSync(indexPath, 'utf8');
  const rng = src.match(/^function mulberry32[^\n]*$/m);
  const a = src.indexOf('var FARM_STRATEGIES'), b = src.indexOf('function farmBenchmark');
  if (!rng || a < 0 || b < a) throw new Error('Could not find FarmSim in ' + indexPath);
  const code = rng[0] + '\n' + src.slice(a, b);
  const version = crypto.createHash('sha1').update(code).digest('hex').slice(0, 8);
  const mod = new Function('performance', code + '\nreturn { FarmSim: FarmSim, FARM_STRATEGIES: FARM_STRATEGIES, FARM_DEFAULTS: FARM_DEFAULTS };')(
    globalThis.performance || { now: () => 0 });
  mod.version = version;
  return mod;
}

/* ---------- Life on an unbounded grid (a set of encoded cells) ---------- */
const OFF = 2048, SPAN = 4096;
const enc = (x, y) => (x + OFF) * SPAN + (y + OFF);
const dec = (k) => [Math.floor(k / SPAN) - OFF, (k % SPAN) - OFF];

function lifeStep(live) {
  const counts = new Map();
  for (const k of live) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const n = k + dx * SPAN + dy;
      counts.set(n, (counts.get(n) || 0) + 1);
    }
  }
  const next = new Set();
  for (const [k, n] of counts) if (n === 3 || (n === 2 && live.has(k))) next.add(k);
  return next;
}
const toSet = (cells) => new Set(cells.map(([x, y]) => enc(x, y)));
const toCells = (set) => [...set].map(dec);

/* ---------- Canonical form under the 8 rotations and reflections ---------- */
const SYMS = [
  (x, y) => [x, y], (x, y) => [-x, y], (x, y) => [x, -y], (x, y) => [-x, -y],
  (x, y) => [y, x], (x, y) => [-y, x], (x, y) => [y, -x], (x, y) => [-y, -x]
];
/* Returns { key, cells, bite } with the smallest key over all symmetries. The bite (where the rover sits) is optional. */
function canon(cells, bite) {
  let best = null;
  for (const f of SYMS) {
    const pts = cells.map(([x, y]) => f(x, y)), b = bite ? f(bite[0], bite[1]) : null;
    let mx = Infinity, my = Infinity;
    for (const [x, y] of pts) { if (x < mx) mx = x; if (y < my) my = y; }
    if (b) { mx = Math.min(mx, b[0]); my = Math.min(my, b[1]); }
    const P = pts.map(([x, y]) => [x - mx, y - my]).sort((p, q) => p[1] - q[1] || p[0] - q[0]);
    const B = b ? [b[0] - mx, b[1] - my] : null;
    const key = (B ? 'b' + B.join(',') + '|' : '') + P.map((p) => p.join(',')).join(';');
    if (!best || key < best.key) best = { key, cells: P, bite: B };
  }
  return best;
}

/* 8-connected components */
function components(cells) {
  const left = new Map(cells.map((c) => [enc(c[0], c[1]), c])), out = [];
  while (left.size) {
    const [k0, c0] = left.entries().next().value; left.delete(k0);
    const comp = [c0], stack = [c0];
    while (stack.length) {
      const [x, y] = stack.pop();
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const k = enc(x + dx, y + dy);
        if (left.has(k)) { const c = left.get(k); left.delete(k); comp.push(c); stack.push(c); }
      }
    }
    out.push(comp);
  }
  return out;
}
const cheb = ([x, y], [u, v]) => Math.max(Math.abs(x - u), Math.abs(y - v));

/* ---------- Known objects. Each is checked by simulation when this file loads. ---------- */
const KNOWN_SRC = [
  ['Block', 1, ['##', '##']],
  ['Beehive', 1, ['.##.', '#..#', '.##.']],
  ['Loaf', 1, ['.##.', '#..#', '.#.#', '..#.']],
  ['Boat', 1, ['##.', '#.#', '.#.']],
  ['Ship', 1, ['##.', '#.#', '.##']],
  ['Tub', 1, ['.#.', '#.#', '.#.']],
  ['Pond', 1, ['.##.', '#..#', '#..#', '.##.']],
  ['Barge', 1, ['.#..', '#.#.', '.#.#', '..#.']],
  ['Long boat', 1, ['##..', '#.#.', '.#.#', '..#.']],
  ['Long ship', 1, ['##..', '#.#.', '.#.#', '..##']],
  ['Long barge', 1, ['.#...', '#.#..', '.#.#.', '..#.#', '...#.']],
  ['Snake', 1, ['##.#', '#.##']],
  ['Aircraft carrier', 1, ['##..', '#..#', '..##']],
  ['Eater 1', 1, ['##..', '#.#.', '..#.', '..##']],
  ['Mango', 1, ['.##..', '#..#.', '.#..#', '..##.']],
  ['Blinker', 2, ['###']],
  ['Toad', 2, ['.###', '###.']],
  ['Beacon', 2, ['##..', '##..', '..##', '..##']]
];
function parseRows(rows) {
  const cells = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') cells.push([x, y]); }));
  return cells;
}
/* Period of a pattern that returns to itself in place, or 0 */
function periodOf(cells, max = 30) {
  const start = canon(cells).key; let s = toSet(cells);
  for (let p = 1; p <= max; p++) {
    s = lifeStep(s);
    const c = toCells(s);
    if (c.length === cells.length && canon(c).key === start) {
      // must be back in the same place, not a translated copy (that would be a spaceship)
      const k0 = new Set(cells.map(([x, y]) => enc(x, y)));
      if ([...s].every((k) => k0.has(k))) return p;
    }
  }
  return 0;
}
const KNOWN = [], NAMES = new Map(), KNOWN_ERRORS = [];
for (const [name, period, rows] of KNOWN_SRC) {
  const cells = parseRows(rows), p = periodOf(cells);
  if (p !== period) { KNOWN_ERRORS.push(`${name}: expected period ${period}, got ${p || 'none'}`); continue; }
  const phases = []; let s = toSet(cells);
  for (let i = 0; i < period; i++) { const c = toCells(s); phases.push(c); NAMES.set(canon(c).key, name); s = lifeStep(s); }
  KNOWN.push({ name, period, cells, phases });
}

/* Name a structure: a known object, a sum of known objects, or null */
function nameOf(cells) {
  if (!cells.length) return null;
  const whole = NAMES.get(canon(cells).key);
  if (whole) return whole;
  const comps = components(cells);
  if (comps.length < 2) return null;
  const names = comps.map((c) => NAMES.get(canon(c).key));
  if (!names.every(Boolean)) return null;
  const count = {}; names.forEach((n) => { count[n] = (count[n] || 0) + 1; });
  return Object.keys(count).sort().map((n) => (count[n] > 1 ? count[n] + ' × ' : '') + n).join(' + ');
}

/* ---------- The lab: park a rover on `bite` and let it eat every generation ----------
   Same order as the notebook: the rover eats the cell under it (if alive), then Life steps; Life never
   sees the rover. The structure "feeds forever" if the world settles into a cycle that includes a meal. */
function lab(cells, bite, maxGen = 600) {
  let live = toSet(cells);
  const b = enc(bite[0], bite[1]), seen = new Map(), meals = [];
  for (let g = 0; g <= maxGen; g++) {
    const ate = live.has(b);
    const before = ate ? toCells(live) : null;
    if (ate) { live.delete(b); meals.push(g); }
    const key = [...live].sort((p, q) => p - q).join(',');
    if (seen.has(key)) {
      // the state after eating at g matches the state after eating at g0, so the meals in (g0, g] repeat forever
      const g0 = seen.get(key), period = g - g0, inCycle = meals.filter((t) => t > g0 && t <= g).length;
      const phase = before || toCells(live);
      return { sustains: inCycle > 0, period, mealsPerCycle: inCycle, yield: inCycle / period, settledAt: g0,
               mealsBefore: meals.filter((t) => t <= g0).length, becomes: inCycle > 0 ? phase : null };
    }
    seen.set(key, g);
    if (live.size === 0) return { sustains: false, dies: true, meals: meals.length, endedAt: g };
    live = lifeStep(live);
  }
  return { sustains: false, unsettled: true, meals: meals.length };
}

/* Test every square on or next to a known object (every phase), deduplicated by symmetry */
function labKnown(obj) {
  const tried = new Map();
  for (const phase of obj.phases) {
    const occupied = new Set(phase.map(([x, y]) => enc(x, y))), cand = new Set();
    for (const [x, y] of phase) for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) cand.add(enc(x + dx, y + dy));
    for (const k of cand) {
      const bite = dec(k), c = canon(phase, bite);
      if (tried.has(c.key)) continue;
      const r = lab(phase, bite);
      tried.set(c.key, { bite: c.bite, cells: c.cells, onCell: occupied.has(k), ...slimLab(r) });
    }
  }
  const all = [...tried.values()], ok = all.filter((t) => t.sustains).sort((p, q) => q.yield - p.yield);
  return { name: obj.name, period: obj.period, cells: canon(obj.cells).cells, bitesTried: all.length,
           sustaining: ok, best: ok[0] || null };
}

function slimLab(r) {
  const out = { sustains: r.sustains };
  if (r.sustains) {
    const b = canon(r.becomes);
    Object.assign(out, { yield: +r.yield.toFixed(4), period: r.period, mealsPerCycle: r.mealsPerCycle, settledAt: r.settledAt,
                         becomes: nameOf(r.becomes) || `${r.becomes.length}-cell structure`, becomesCells: b.cells });
  } else out.fate = r.dies ? `eaten out after ${r.meals} meals` : r.unsettled ? `no cycle within 600 generations (${r.meals} meals)` : 'settles into something that never feeds it';
  return out;
}

module.exports = { ROOT, loadFarmSim, lifeStep, toSet, toCells, canon, components, cheb, nameOf, lab, labKnown, slimLab,
                   KNOWN, KNOWN_ERRORS, parseRows };
