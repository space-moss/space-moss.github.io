#!/usr/bin/env node
'use strict';
/* Rule survey: runs every Life-like rule on the same random soups and logs how each one behaves.

   A Life-like rule says which neighbour counts bring a dead cell to life (B) and which keep a live cell alive (S).
   On the square grid every cell has 8 neighbours, so there are 2^9 x 2^9 = 262,144 rules. On the hexagonal grid
   every cell has 6, so there are 2^7 x 2^7 = 16,384.

   For each rule and each soup it records how much of the world is alive and how much changes each generation
   (averaged over the last quarter of the run), the peak population, whether it died out, and whether it settled
   into a repeating cycle (and the cycle's period). Each rule gets one class:
     dies        every soup ended empty
     freezes     every soup settled into a still world (period 1)
     oscillates  every soup settled into a repeating cycle (some with period 2 or more), usually blinking "ash"
     boils       at least one soup never settled, and more than 15% of cells change every generation
     dense       at least one soup never settled, more than 60% alive, quieter than boiling
     lives       at least one soup never settled, sparse and not boiling: the Conway-like ones
   A rule only counts as settling if every soup settles: Conway's rule can leave one small soup still going after
   400 generations and another already blinking, and it belongs with the rules that keep going.
   Rules with B0 (empty space comes alive) are flagged: their background flashes on and off.

   Usage:
     node tools/rule-survey.js run [options]            survey rules, appending to the log (resumes if interrupted)
       --grid square|hex      which grid (default square)
       --size N               the soup is N x N, wrapping at the edges (default 60: even, for hex, and not a power of two, which would wipe out parity rules like B1357/S1357)
       --gens N               generations per soup (default 400)
       --seeds N              soups per rule (default 2); every rule sees the same soups
       --fill F               share of cells alive at the start (default 0.35)
       --rules B3/S23,...     only these rules (default: all of them)
       --sample N             only N rules spread evenly across the whole space, for a quick preview
       --workers N            parallel threads (default: one per CPU, minus one)
       --out FILE             the log (default logs/rules-<grid>.jsonl)
     node tools/rule-survey.js ships [options]          look for spaceships (gliders) in chosen rules
       --rules B3/S23,...     rules to search, or --class lives to search every rule of that class in the log (--class any: all without B0)
       --trials N             random 5 x 5 starts per rule (default 60)
     node tools/rule-survey.js summary [--in FILE] [--md FILE]   turn a log into tables for the article
     node tools/rule-survey.js reclassify [--in FILE]            re-label an existing log with the current classes (no re-running)
     node tools/rule-survey.js export [--in FILE] [--json FILE] [--b0]
                            a compact JSON of every rule (without B0 unless --b0) for charts on the site:
                            { settings, classes, rules: [[rule, class index, alive per mille, changing per mille], ...] } */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const ROOT = path.resolve(__dirname, '..');

/* ---------- rules ---------- */
function gridInfo(grid) { return grid === 'hex' ? { grid: 'hex', k: 6 } : { grid: 'square', k: 8 }; }
function ruleIndexToMasks(i, k) { const bits = k + 1; return { born: i & ((1 << bits) - 1), surv: i >> bits }; }
function masksToName(m, k) { let b = '', s = ''; for (let n = 0; n <= k; n++) { if (m.born >> n & 1) b += n; if (m.surv >> n & 1) s += n; } return 'B' + b + '/S' + s; }
function nameToMasks(name, k) {
  const m = /^B([0-9]*)\/S([0-9]*)$/i.exec(String(name).trim());
  if (!m) throw new Error('Not a rule: ' + name);
  let born = 0, surv = 0;
  for (const d of m[1]) { if (+d > k) throw new Error(name + ': ' + d + ' is more than ' + k + ' neighbours'); born |= 1 << +d; }
  for (const d of m[2]) { if (+d > k) throw new Error(name + ': ' + d + ' is more than ' + k + ' neighbours'); surv |= 1 << +d; }
  return { born, surv };
}
function masksToIndex(m, k) { return m.born | (m.surv << (k + 1)); }

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* ---------- the world ---------- */
/* Neighbour lists for a wrapping N x N grid. Hex uses "odd-r" offset rows: odd rows sit half a cell to the right. */
function neighbourTable(N, grid) {
  const k = grid === 'hex' ? 6 : 8, T = new Int32Array(N * N * k), w = (v) => (v + N) % N;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const base = (y * N + x) * k;
    const offs = grid === 'hex'
      ? (y & 1 ? [[1, 0], [-1, 0], [0, -1], [1, -1], [0, 1], [1, 1]] : [[1, 0], [-1, 0], [-1, -1], [0, -1], [-1, 1], [0, 1]])
      : [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
    offs.forEach(([dx, dy], j) => { T[base + j] = w(y + dy) * N + w(x + dx); });
  }
  return T;
}

/* Run one soup under one rule. Returns averages over the last quarter, the peak, and how it ended. */
function runSoup(rule, opts, nb, seed) {
  const { size: N, gens, fill, k } = opts, M = N * N;
  // next state for (alive, neighbours): one lookup per cell
  const next = new Uint8Array(2 * (k + 1));
  for (let n = 0; n <= k; n++) { next[n] = rule.born >> n & 1; next[k + 1 + n] = rule.surv >> n & 1; }
  let a = new Uint8Array(M), b = new Uint8Array(M);
  const rnd = mulberry32(seed * 7919 + 17);
  let alive = 0;
  for (let i = 0; i < M; i++) { a[i] = rnd() < fill ? 1 : 0; alive += a[i]; }
  const tail = Math.max(1, gens >> 2), seen = new Map();
  let sumAlive = 0, sumChange = 0, samples = 0, peak = alive, period = 0, settleGen = -1, extinctGen = -1;
  const startAlive = alive;
  for (let g = 1; g <= gens; g++) {
    let al = 0, ch = 0, h1 = 0, h2 = 0;
    for (let i = 0; i < M; i++) {
      let n = 0; const base = i * k;
      for (let j = 0; j < k; j++) n += a[nb[base + j]];
      const v = next[a[i] * (k + 1) + n];
      b[i] = v;
      if (v) { al++; h1 = (h1 + Math.imul(i + 1, 2654435761)) | 0; h2 = (h2 ^ Math.imul(i + 7, 40503)) + 0x9e3779b9 | 0; }
      if (v !== a[i]) ch++;
    }
    const t = a; a = b; b = t;
    if (al > peak) peak = al;
    if (g > gens - tail) { sumAlive += al; sumChange += ch; samples++; }
    if (al === 0) { extinctGen = g; period = 1; settleGen = g; sumAlive = 0; sumChange = 0; samples = 1; break; }
    // the same state seen before means it repeats forever from here: stop and use the cycle's averages
    const key = al + ':' + h1 + ':' + h2;
    if (seen.has(key)) {
      const first = seen.get(key); period = g - first.g; settleGen = first.g;
      let cA = 0, cC = 0, cnt = 0; for (const s of seen.values()) if (s.g >= first.g) { cA += s.al; cC += s.ch; cnt++; }
      sumAlive = cA; sumChange = cC; samples = Math.max(1, cnt);
      break;
    }
    seen.set(key, { g, al, ch });
    if (seen.size > 64) seen.delete(seen.keys().next().value);   // only look for cycles up to 64 generations long
  }
  return { alive: sumAlive / samples / M, change: sumChange / samples / M, peak: peak / M, start: startAlive / M, period, settleGen, extinctGen };
}

function classify(r, b0) {
  if (r.seeds.every((s) => s.extinctGen >= 0)) return 'dies';
  const settled = r.seeds.every((s) => s.period > 0);
  if (settled) return r.seeds.every((s) => s.period <= 1) ? 'freezes' : 'oscillates';
  if (r.change > 0.15) return 'boils';
  if (r.alive > 0.6) return 'dense';
  return 'lives';
}

function surveyRule(rule, opts, nb) {
  const seeds = [];
  for (let s = 1; s <= opts.seeds; s++) seeds.push(runSoup(rule, opts, nb, s));
  const avg = (key) => seeds.reduce((t, x) => t + x[key], 0) / seeds.length;
  const out = { alive: avg('alive'), change: avg('change'), peak: Math.max(...seeds.map((x) => x.peak)), seeds };
  const b0 = !!(rule.born & 1);
  out.class = classify(out, b0);
  return out;
}

/* ---------- spaceship search ---------- */
/* Start from small random patterns in an empty world and watch for a shape that comes back moved: a spaceship.
   Hex cells are compared in axial coordinates, where moving a pattern doesn't change its neighbourhoods. */
function findShips(rule, k, grid, trials) {
  const N = 72, M = N * N, nb = neighbourTable(N, grid), next = new Uint8Array(2 * (k + 1)), found = new Map();
  for (let n = 0; n <= k; n++) { next[n] = rule.born >> n & 1; next[k + 1 + n] = rule.surv >> n & 1; }
  if (rule.born & 1) return [];                         // empty space comes alive: no ships on an empty background
  const rnd = mulberry32(12345);
  for (let tr = 0; tr < trials; tr++) {
    let a = new Uint8Array(M), b = new Uint8Array(M);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (rnd() < 0.5) a[(N / 2 - 2 + y) * N + (N / 2 - 2 + x)] = 1;
    const shapes = [];
    for (let g = 1; g <= 160; g++) {
      let al = 0;
      for (let i = 0; i < M; i++) { let n = 0; const base = i * k; for (let j = 0; j < k; j++) n += a[nb[base + j]]; const v = next[a[i] * (k + 1) + n]; b[i] = v; al += v; }
      const t = a; a = b; b = t;
      if (al === 0 || al > 60) break;                   // died, or grew too big to be a small ship
      const cells = [];
      for (let i = 0; i < M; i++) if (a[i]) { const y = (i / N) | 0, x = i % N; cells.push(grid === 'hex' ? [x - ((y - (y & 1)) >> 1), y] : [x, y]); }
      let mx = Infinity, my = Infinity, Mx = -Infinity, My = -Infinity;
      for (const [x, y] of cells) { mx = Math.min(mx, x); my = Math.min(my, y); Mx = Math.max(Mx, x); My = Math.max(My, y); }
      if (Mx - mx > N / 2 || My - my > N / 2) break;      // wrapped round the edge; stop rather than misread it
      const key = cells.map(([x, y]) => (x - mx) + ',' + (y - my)).sort().join(';');
      for (let p = shapes.length - 1; p >= Math.max(0, shapes.length - 30); p--) {
        const s = shapes[p];
        if (s.key === key) { const dx = mx - s.mx, dy = my - s.my, per = g - s.g;
          if (dx || dy) { const id = key; if (!found.has(id)) found.set(id, { cells: cells.length, period: per, dx, dy, speed: Math.max(Math.abs(dx), Math.abs(dy)) + '/' + per }); }
          g = 1e9; break; }
      }
      shapes.push({ key, mx, my, g });
    }
  }
  return [...found.values()].sort((p, q) => p.cells - q.cells);
}

/* ---------- worker ---------- */
if (!isMainThread) {
  const { opts } = workerData, nb = neighbourTable(opts.size, opts.grid);
  parentPort.on('message', (msg) => {
    if (msg === 'stop') process.exit(0);
    const res = msg.map((idx) => {
      const rule = ruleIndexToMasks(idx, opts.k), r = surveyRule(rule, opts, nb);
      return { rule: masksToName(rule, opts.k), grid: opts.grid, b0: !!(rule.born & 1), class: r.class,
               alive: +r.alive.toFixed(4), change: +r.change.toFixed(4), peak: +r.peak.toFixed(4),
               seeds: r.seeds.map((s) => ({ alive: +s.alive.toFixed(4), change: +s.change.toFixed(4), period: s.period, settle: s.settleGen, extinct: s.extinctGen })) };
    });
    parentPort.postMessage(res);
  });
  return;
}

/* ---------- main ---------- */
function args(argv) {
  const o = { cmd: argv[0] || 'run', grid: 'square', size: 60, gens: 400, seeds: 2, fill: 0.35, rules: null, workers: Math.max(1, os.cpus().length - 1), out: null, in: null, md: null, cls: null, trials: 60, sample: 0, json: null, b0: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--grid') o.grid = v(); else if (a === '--size') o.size = +v(); else if (a === '--gens') o.gens = +v();
    else if (a === '--seeds') o.seeds = +v(); else if (a === '--fill') o.fill = +v(); else if (a === '--rules') o.rules = v().split(',');
    else if (a === '--workers') o.workers = +v(); else if (a === '--out') o.out = v(); else if (a === '--in') o.in = v(); else if (a === '--md') o.md = v();
    else if (a === '--class') o.cls = v(); else if (a === '--trials') o.trials = +v(); else if (a === '--sample') o.sample = +v();
    else if (a === '--json') o.json = v(); else if (a === '--b0') o.b0 = true;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error('Unknown option ' + a);
  }
  if (!['square', 'hex'].includes(o.grid)) throw new Error('--grid must be square or hex');
  if (o.grid === 'hex' && o.size % 2) throw new Error('--size must be even on the hex grid');
  Object.assign(o, gridInfo(o.grid));
  o.out = o.out || path.join(ROOT, 'logs', 'rules-' + o.grid + '.jsonl');
  return o;
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.rule);
}

async function run(o) {
  const total = 1 << (2 * (o.k + 1));
  let todo = o.rules ? o.rules.map((r) => masksToIndex(nameToMasks(r, o.k), o.k))
    : o.sample ? Array.from({ length: Math.min(o.sample, total) }, (_, i) => Math.floor(i * total / Math.min(o.sample, total)))
    : Array.from({ length: total }, (_, i) => i);
  // resume: skip rules already in the log with the same settings
  const settings = { grid: o.grid, size: o.size, gens: o.gens, seeds: o.seeds, fill: o.fill };
  fs.mkdirSync(path.dirname(o.out), { recursive: true });
  const prior = readLog(o.out), header = fs.existsSync(o.out) ? JSON.parse(fs.readFileSync(o.out, 'utf8').split('\n')[0]) : null;
  if (header && header.settings && JSON.stringify(header.settings) !== JSON.stringify(settings)) throw new Error(o.out + ' was made with different settings (' + JSON.stringify(header.settings) + '). Use --out for a new log.');
  if (!header) fs.writeFileSync(o.out, JSON.stringify({ survey: 'Life-like rules', settings, started: new Date().toISOString() }) + '\n');
  const done = new Set(prior.map((r) => r.rule));
  todo = todo.filter((i) => !done.has(masksToName(ruleIndexToMasks(i, o.k), o.k)));
  console.log(`${o.grid} grid: ${total.toLocaleString('en-GB')} rules, ${done.size.toLocaleString('en-GB')} already logged, ${todo.length.toLocaleString('en-GB')} to go. ` +
    `${o.seeds} soups each, ${o.size} x ${o.size}, ${o.gens} generations, ${o.workers} threads. Log: ${path.relative(process.cwd(), o.out)}`);
  if (!todo.length) return;
  const CHUNK = 64, chunks = []; for (let i = 0; i < todo.length; i += CHUNK) chunks.push(todo.slice(i, i + CHUNK));
  const out = fs.openSync(o.out, 'a'), t0 = Date.now(); let finished = 0, nextChunk = 0, lastPrint = 0;
  await new Promise((resolve, reject) => {
    let live = 0;
    const workers = Array.from({ length: Math.min(o.workers, chunks.length) }, () => new Worker(__filename, { workerData: { opts: o } }));
    const feed = (w) => { if (nextChunk < chunks.length) w.postMessage(chunks[nextChunk++]); else { w.postMessage('stop'); if (--live === 0) resolve(); } };
    workers.forEach((w) => {
      live++;
      w.on('message', (res) => {
        fs.writeSync(out, res.map((r) => JSON.stringify(r)).join('\n') + '\n');
        finished += res.length;
        const now = Date.now();
        if (now - lastPrint > 2000 || finished === todo.length) { lastPrint = now;
          const rate = finished / ((now - t0) / 1000), left = (todo.length - finished) / rate;
          process.stdout.write(`\r  ${finished.toLocaleString('en-GB')} / ${todo.length.toLocaleString('en-GB')} rules, ${rate.toFixed(0)} a second, about ${left < 90 ? Math.round(left) + ' s' : Math.round(left / 60) + ' min'} left   `); }
        feed(w);
      });
      w.on('error', reject);
      feed(w);
    });
  });
  fs.closeSync(out);
  console.log(`\n  done in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
}

async function ships(o) {
  let rules = o.rules;
  if (!rules && o.cls) rules = readLog(o.out).filter((r) => (o.cls === 'any' || r.class === o.cls) && !r.b0).map((r) => r.rule);   // --class any: every rule without B0
  if (!rules || !rules.length) throw new Error('Give --rules, or --class with a log that has rules of that class.');
  const file = o.out.replace(/\.jsonl$/, '') + '-ships.jsonl', done = new Set(readLog(file).map((r) => r.rule));
  const todo = rules.filter((r) => !done.has(r));
  console.log(`Looking for spaceships in ${todo.length} ${o.grid} rules (${o.trials} random starts each). Log: ${path.relative(process.cwd(), file)}`);
  const t0 = Date.now();
  todo.forEach((name, i) => {
    const found = findShips(nameToMasks(name, o.k), o.k, o.grid, o.trials);
    fs.appendFileSync(file, JSON.stringify({ rule: name, grid: o.grid, trials: o.trials, ships: found }) + '\n');
    if (found.length) console.log(`  ${name}: ${found.length} ship${found.length > 1 ? 's' : ''}, smallest ${found[0].cells} cells moving ${found[0].speed}`);
    if (i % 50 === 49) console.log(`  ${i + 1} / ${todo.length} rules searched, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  });
}

function summary(o) {
  const file = o.in || o.out, rows = readLog(file), lines = [];
  if (!rows.length) throw new Error('No results in ' + file);
  const grid = rows[0].grid, k = gridInfo(grid).k, total = 1 << (2 * (k + 1)), byRule = new Map(rows.map((r) => [r.rule, r]));
  const head = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  const pct = (v) => (100 * v).toFixed(1) + '%', count = {};
  rows.forEach((r) => { count[r.class] = (count[r.class] || 0) + 1; });
  lines.push(`# ${grid === 'hex' ? 'Hexagonal' : 'Square'} grid: ${rows.length.toLocaleString('en-GB')} of ${total.toLocaleString('en-GB')} rules surveyed`, '');
  if (head.settings) lines.push(`Settings: ${head.settings.seeds} soups per rule, ${head.settings.size} x ${head.settings.size} wrapping grid, ${pct(head.settings.fill)} alive at the start, ${head.settings.gens} generations.`, '');
  lines.push('## How the rules behave', '', '| Class | Rules | Share |', '|---|---|---|');
  ['lives', 'boils', 'dense', 'oscillates', 'freezes', 'dies'].forEach((c) => lines.push(`| ${c} | ${(count[c] || 0).toLocaleString('en-GB')} | ${pct((count[c] || 0) / rows.length)} |`));
  const b0 = rows.filter((r) => r.b0).length; lines.push('', `${b0.toLocaleString('en-GB')} of these rules have B0 (empty space comes alive) and flash on and off.`, '');
  // Conway's neighbourhood (or its hex equivalent)
  const centre = grid === 'hex' ? 'B2/S34' : 'B3/S23';
  if (byRule.has(centre)) {
    const c = nameToMasks(centre, k);
    lines.push(`## One number away from ${centre}`, '', '| Change | Rule | Alive | Changing | Class |', '|---|---|---|---|---|');
    const r0 = byRule.get(centre); lines.push(`| (none) | ${centre} | ${pct(r0.alive)} | ${pct(r0.change)} | ${r0.class} |`);
    for (const part of ['born', 'surv']) for (let n = 0; n <= k; n++) {
      const m = { born: c.born, surv: c.surv }; m[part] ^= 1 << n;
      const name = masksToName(m, k), r = byRule.get(name); if (!r) continue;
      lines.push(`| ${(c[part] >> n & 1 ? 'remove ' : 'add ') + (part === 'born' ? 'B' : 'S') + n} | ${name} | ${pct(r.alive)} | ${pct(r.change)} | ${r.class} |`);
    }
    lines.push('');
  }
  // the Conway-like rules: sparse, never settling, not boiling
  const lives = rows.filter((r) => r.class === 'lives' && !r.b0).sort((p, q) => p.alive - q.alive);
  lines.push(`## The ${lives.length.toLocaleString('en-GB')} rules that "live" (no B0), sparsest first`, '', '| Rule | Alive | Changing |', '|---|---|---|');
  lives.slice(0, 40).forEach((r) => lines.push(`| ${r.rule} | ${pct(r.alive)} | ${pct(r.change)} |`));
  if (lives.length > 40) lines.push(`| … ${lives.length - 40} more in the log | | |`);
  lines.push('');
  // spaceships, if searched
  const shipFile = file.replace(/\.jsonl$/, '') + '-ships.jsonl';
  if (fs.existsSync(shipFile)) {
    const sh = readLog(shipFile), withShips = sh.filter((r) => r.ships.length);
    lines.push(`## Spaceships`, '', `${withShips.length} of ${sh.length} searched rules produced a spaceship from small random starts.`, '', '| Rule | Ships found | Smallest | Speed (cells/generations) |', '|---|---|---|---|');
    withShips.sort((p, q) => p.ships[0].cells - q.ships[0].cells).slice(0, 40).forEach((r) => lines.push(`| ${r.rule} | ${r.ships.length} | ${r.ships[0].cells} cells | ${r.ships[0].speed} |`));
    lines.push('');
  }
  const text = lines.join('\n');
  if (o.md) fs.writeFileSync(o.md, text + '\n');
  console.log(text);
}

function reclassify(o) {
  const file = o.in || o.out, lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean), changed = {};
  const out = lines.map((l, i) => { if (i === 0) return l; const r = JSON.parse(l), before = r.class;
    r.class = classify({ alive: r.alive, change: r.change, seeds: r.seeds.map((s) => ({ period: s.period, extinctGen: s.extinct })) });
    if (r.class !== before) { const k = before + ' -> ' + r.class; changed[k] = (changed[k] || 0) + 1; }
    return JSON.stringify(r); });
  fs.writeFileSync(file + '.tmp', out.join('\n') + '\n'); fs.renameSync(file + '.tmp', file);
  console.log('Re-labelled ' + path.relative(process.cwd(), file) + ': ' + (Object.keys(changed).map((k) => changed[k].toLocaleString('en-GB') + ' ' + k).join(', ') || 'nothing changed'));
}

function exportJson(o) {
  const file = o.in || o.out, rows = readLog(file), head = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
  const classes = ['lives', 'boils', 'dense', 'oscillates', 'freezes', 'dies'];
  const keep = rows.filter((r) => o.b0 || !r.b0);
  const outFile = o.json || path.join(ROOT, 'data', 'rules-' + o.grid + '.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ grid: o.grid, settings: head.settings, b0: o.b0, classes,
    rules: keep.map((r) => [r.rule, classes.indexOf(r.class), Math.round(r.alive * 1000), Math.round(r.change * 1000)]) }));
  console.log(`Wrote ${keep.length.toLocaleString('en-GB')} rules to ${path.relative(process.cwd(), outFile)} (${(fs.statSync(outFile).size / 1024).toFixed(0)} KB).`);
}

(async () => {
  const o = args(process.argv.slice(2));
  if (o.cmd === 'run') await run(o);
  else if (o.cmd === 'ships') await ships(o);
  else if (o.cmd === 'summary') summary(o);
  else if (o.cmd === 'export') exportJson(o);
  else if (o.cmd === 'reclassify') reclassify(o);
  else throw new Error('Unknown command ' + o.cmd + ' (run, ships, summary or export)');
})().catch((e) => { console.error(e.message); process.exit(1); });
