#!/usr/bin/env node
'use strict';
/* Logger: runs the notebook's FarmSim headless (the exact code in index.html) and writes one JSON-lines log
   per run to logs/. Then it runs the parser, which updates farms.json, the data behind farms.html.

   Log lines:
     {"t":"run", id, sim, world, strategy, seed, W, H, gens, params, snapRadius, at}
     {"t":"g", g, r, x, y}              a grazed meal: rover r stepped onto a live cell at (x, y)
     {"t":"h", g, r, x, y}              a harvested meal: a cell was born under rover r while it stayed
     {"t":"snap", g, r, x, y, n, cells} live cells around the rover (offsets) at its 1st and 10th harvest on a square
     {"t":"split", g, p, c, x, y}       rover p split; child c appeared at (x, y)
     {"t":"end", g, rovers, stats}

   Usage:
     node tools/farm-log.js                         8 new seeds in each world, 1,500 generations each
     node tools/farm-log.js --world soup --seeds 1-20 --gens 3000
     node tools/farm-log.js --watch --serve 8080    keep running new seeds; farms.html at http://127.0.0.1:8080/farms.html updates live
     node tools/farm-log.js --watch --push          also commit and push farms.json whenever a new farm is spotted */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const L = require('./farm-lib');
const { parse, MIN_HARVESTS } = require('./farm-parse');

const SNAP_RADIUS = 6, COLS = 120, ROWS = 80;

function args(argv) {
  const o = { world: 'both', seeds: null, count: 8, gens: 1500, strategy: 'farmer', out: path.join(L.ROOT, 'logs'), watch: false, push: false, serve: 0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => argv[++i];
    if (a === '--world') o.world = v();
    else if (a === '--seeds') o.seeds = v();
    else if (a === '--count') o.count = +v();
    else if (a === '--gens') o.gens = +v();
    else if (a === '--strategy') o.strategy = v();
    else if (a === '--out') o.out = path.resolve(v());
    else if (a === '--watch') o.watch = true;
    else if (a === '--push') o.push = true;
    else if (a === '--serve') o.serve = /^\d+$/.test(argv[i + 1] || '') ? +v() : 8080;
    else if (a === '--help' || a === '-h') { console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]); process.exit(0); }
    else throw new Error('Unknown option ' + a);
  }
  if (!['soup', 'glider-rain', 'both'].includes(o.world)) throw new Error('--world must be soup, glider-rain or both');
  return o;
}

function seedList(spec) {
  const out = [];
  for (const part of String(spec).split(',')) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) for (let s = +m[1]; s <= +m[2]; s++) out.push(s); else out.push(+part);
  }
  return out;
}

/* Run one simulation and write its log. Returns the log path. Yields now and then so the local server stays responsive. */
async function runOne(S, { world, seed, gens, strategy, out }) {
  const runId = `${S.version}-${world}-${strategy}-s${seed}-g${gens}`;
  const file = path.join(out, runId + '.jsonl');
  if (fs.existsSync(file)) return file;
  const lines = [], parks = new Map();
  let sim = null;
  const push = (o) => lines.push(JSON.stringify(o));
  function snapshot(x, y) {
    const a = sim.cells(), cells = [];
    for (let dy = -SNAP_RADIUS; dy <= SNAP_RADIUS; dy++) for (let dx = -SNAP_RADIUS; dx <= SNAP_RADIUS; dx++) {
      const X = ((x + dx) % COLS + COLS) % COLS, Y = ((y + dy) % ROWS + ROWS) % ROWS;
      if (a[Y * COLS + X]) cells.push([dx, dy]);
    }
    return cells;
  }
  function log(type, d) {
    if (type === 'eat') {
      const r = d.r;
      push({ t: d.moved ? 'g' : 'h', g: d.g, r: r.id, x: r.x, y: r.y });
      let park = parks.get(r.id);
      if (d.moved || !park || park.x !== r.x || park.y !== r.y) parks.set(r.id, (park = { x: r.x, y: r.y, n: 0 }));
      if (!d.moved && (++park.n === 1 || park.n === MIN_HARVESTS)) push({ t: 'snap', g: d.g, r: r.id, x: r.x, y: r.y, n: park.n, cells: snapshot(r.x, r.y) });
    } else if (type === 'split') push({ t: 'split', g: d.g, p: d.parent.id, c: d.child.id, x: d.child.x, y: d.child.y });
  }
  sim = new S.FarmSim(COLS, ROWS, { world, strategy, seed, visual: false, log });
  push({ t: 'run', id: runId, sim: S.version, world, strategy, seed, W: COLS, H: ROWS, gens, params: sim.P, snapRadius: SNAP_RADIUS, at: new Date().toISOString() });
  for (let g = 0; g < gens; g++) { sim.step(); if (g % 25 === 24) await new Promise((r) => setImmediate(r)); }
  push({ t: 'end', g: sim.gen, rovers: sim.rovers.length, stats: sim.stats });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(file + '.tmp', lines.join('\n') + '\n');
  fs.renameSync(file + '.tmp', file);            // the parser skips files until they're complete
  return file;
}

function usedSeeds(out, S, world, strategy, gens) {
  const prefix = `${S.version}-${world}-${strategy}-s`;
  if (!fs.existsSync(out)) return new Set();
  return new Set(fs.readdirSync(out).filter((f) => f.startsWith(prefix) && f.endsWith(`-g${gens}.jsonl`)).map((f) => +f.slice(prefix.length).split('-')[0]));
}
function nextSeeds(o, S, world, n) {
  const used = usedSeeds(o.out, S, world, o.strategy, o.gens), seeds = [];
  for (let s = 1; seeds.length < n; s++) if (!used.has(s)) seeds.push(s);
  return seeds;
}

function report(created) {
  for (const f of created) {
    const lab = f.lab;
    console.log(`  NEW FARM: ${f.name} (${f.size} cells) feeds ${lab.mealsPerCycle} meal${lab.mealsPerCycle === 1 ? '' : 's'} every ${lab.period === 1 ? 'generation' : lab.period + ' generations'}. First seen in ${f.firstSpotted.world}, seed ${f.firstSpotted.seed}, gen ${f.firstSpotted.gen}.`);
  }
}

function pushFarms(created) {
  const rel = path.relative(L.ROOT, path.join(L.ROOT, 'farms.json'));
  try {
    execFileSync('git', ['add', rel], { cwd: L.ROOT });
    execFileSync('git', ['commit', '-m', 'Spot new farm' + (created.length > 1 ? 's' : '') + ': ' + [...new Set(created.map((f) => f.name))].join(', '), '--', rel], { cwd: L.ROOT, stdio: 'ignore' });
    execFileSync('git', ['push', '-q'], { cwd: L.ROOT });
    console.log('  pushed farms.json');
  } catch (e) { console.error('  push failed: ' + (e.stderr ? e.stderr.toString().trim() : e.message)); }
}

/* Tiny static server with caching off, so farms.html sees every update to farms.json */
function serve(port) {
  const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };
  http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const file = path.resolve(L.ROOT, rel);
    if (!file.startsWith(L.ROOT + path.sep) || rel.startsWith('logs') || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(port, '127.0.0.1', () => console.log(`Serving the site at http://127.0.0.1:${port}/farms.html`));
}

async function main() {
  const o = args(process.argv.slice(2));
  if (L.KNOWN_ERRORS.length) console.warn('Known-object list problems (skipped):\n  ' + L.KNOWN_ERRORS.join('\n  '));
  const S = L.loadFarmSim();
  const worlds = o.world === 'both' ? ['soup', 'glider-rain'] : [o.world];
  if (o.serve) serve(o.serve);
  console.log(`FarmSim ${S.version}, strategy ${o.strategy}, ${o.gens.toLocaleString()} generations per run. Logs in ${path.relative(process.cwd(), o.out) || '.'}`);
  const batch = async (seedsFor) => {
    const created = [];
    for (const world of worlds) for (const seed of seedsFor(world)) {
      const t0 = Date.now();
      await runOne(S, { world, seed, gens: o.gens, strategy: o.strategy, out: o.out });
      const r = parse({ inputs: [o.out] });
      console.log(`${world} seed ${seed}: ${((Date.now() - t0) / 1000).toFixed(1)}s, ${r.db.farms.length} farm structures so far`);
      report(r.created); created.push(...r.created);
    }
    return created;
  };
  if (!o.watch) {
    await batch((w) => (o.seeds ? seedList(o.seeds) : nextSeeds(o, S, w, o.count)));
    if (!o.serve) return;
    console.log('Still serving. Ctrl+C to stop.');
    return;
  }
  console.log('Watching: running new seeds until you stop it (Ctrl+C).' + (o.push ? ' New farms are pushed to GitHub.' : ''));
  for (;;) {
    const created = await batch((w) => nextSeeds(o, S, w, 1));
    if (created.length && o.push) pushFarms(created);
    await new Promise((r) => setTimeout(r, 50));
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
