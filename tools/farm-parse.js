#!/usr/bin/env node
'use strict';
/* Parser: reads the JSON-lines logs written by farm-log.js, finds where rovers parked and harvested, works out
   which structure fed them, and merges the results into farms.json (the data behind farms.html).

   A parking session is a run of meals one rover ate on one square, where every meal after the first was
   harvested (a cell born under it while it stayed). A session with at least MIN_HARVESTS harvests is a
   candidate. Its structure is cut out of the logged snapshot: the live cells within 2 squares of the rover,
   plus everything connected to them, plus the cell it just ate. Objects that aren't needed for the feeding
   are pruned. The structure counts as a FARM if, on its own in the lab, it feeds a parked rover forever.
   Candidates that don't are counted as "fed by their surroundings".

   A farm's instances are the distinct places it turned up: the same structure at the same spot in one run counts
   once, however many rovers took turns on it (field.sessions counts those turns).

   Usage: node tools/farm-parse.js [log files or folders...] [--out farms.json] [--rebuild]
          (defaults: every .jsonl file in logs/, and farms.json at the site root)
          --rebuild starts the counts again from the logs given, keeping each farm's id and first-spotted date. */
const fs = require('fs');
const path = require('path');
const L = require('./farm-lib');

const MIN_HARVESTS = 10;   // harvests on one square before a session counts as a farm candidate
const MAX_GAP = 16;        // generations allowed between harvests in one session (slow oscillators)
const REACH = 2;           // objects with a cell this close to the rover are part of its structure
const CATALOGUE_VERSION = 1;

function readLog(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const run = lines.find((e) => e.t === 'run');
  if (!run) throw new Error(file + ': no run header');
  return { run, events: lines, complete: lines.some((e) => e.t === 'end') };
}

/* Rebuild parking sessions from the meal events */
function sessionsOf(events) {
  const cur = new Map(), done = [];
  const close = (id) => { const s = cur.get(id); if (s) { if (s.harvests >= MIN_HARVESTS) done.push(s); cur.delete(id); } };
  for (const e of events) {
    if (e.t !== 'h' && e.t !== 'g') continue;
    const s = cur.get(e.r);
    if (e.t === 'h' && s && s.x === e.x && s.y === e.y && e.g - s.last <= MAX_GAP) { s.harvests++; s.last = e.g; continue; }
    close(e.r);
    cur.set(e.r, { rover: e.r, x: e.x, y: e.y, start: e.g, last: e.g, harvests: e.t === 'h' ? 1 : 0 });
  }
  for (const id of [...cur.keys()]) close(id);
  return done;
}

/* The snapshot logged for a session: prefer the one taken at its 10th harvest (settled), else its first */
function snapFor(snaps, s) {
  const mine = snaps.filter((n) => n.r === s.rover && n.x === s.x && n.y === s.y && n.g >= s.start && n.g <= s.last);
  return mine.find((n) => n.n === MIN_HARVESTS) || mine[0] || null;
}

const labCache = new Map();
function labCached(cells, bite) {
  const c = L.canon(cells, bite);
  if (!labCache.has(c.key)) labCache.set(c.key, L.slimLab(L.lab(c.cells, c.bite)));
  return { c, r: labCache.get(c.key) };
}

/* Cut the structure out of a snapshot and prune it to what the feeding needs */
function structureOf(snap, radius) {
  const cells = snap.cells.concat([[0, 0]]);          // the rover just ate the cell under it: put it back
  const comps = L.components(cells).filter((comp) => comp.some((c) => L.cheb(c, [0, 0]) <= REACH));
  const partial = comps.some((comp) => comp.some((c) => L.cheb(c, [0, 0]) >= radius));
  let keep = comps, { c, r } = labCached(keep.flat(), [0, 0]);
  if (r.sustains) {
    for (let i = keep.length - 1; i >= 0 && keep.length > 1; i--) {
      if (keep[i].some((p) => p[0] === 0 && p[1] === 0)) continue;       // never drop the part the rover sits in
      const trial = keep.filter((_, j) => j !== i), t = labCached(trial.flat(), [0, 0]);
      if (t.r.sustains && t.r.yield === r.yield) { keep = trial; c = t.c; r = t.r; }
    }
  }
  // where the structure sits relative to the rover (its top-left corner), to tell one instance from another
  const flat = keep.flat(), ax = Math.min(...flat.map((p) => p[0])), ay = Math.min(...flat.map((p) => p[1]));
  return { key: c.key, cells: c.cells, bite: c.bite, lab: r, partial, anchor: [ax, ay] };
}

/* Name a farm: the whole structure if it's a known object (a block, with the rover on a corner), or else the
   objects around the rover once the cell it's about to eat is taken away (a block and a blinker feeding the gap) */
function nameStructure(cells, bite) {
  const whole = L.nameOf(cells);
  if (whole) return whole;
  const rest = cells.filter((c) => c[0] !== bite[0] || c[1] !== bite[1]);
  return (rest.length < cells.length && L.nameOf(rest)) || `Unnamed ${cells.length}-cell structure`;
}

function emptyDb() {
  return { updated: null, definition: { minHarvests: MIN_HARVESTS, maxGap: MAX_GAP, reach: REACH },
           totals: { runs: 0, generations: 0, candidates: 0, farmSessions: 0, instances: 0, surroundingsSessions: 0, surroundingsHarvests: 0 },
           farms: [], catalogue: null };
}

/* The ids of every run already merged live in farm-runs.json next to farms.json, not in farms.json itself:
   the list only grows, and farms.html downloads farms.json every 15 seconds. */
const runsFile = (out) => path.join(path.dirname(out), 'farm-runs.json');
function loadRuns(out) {
  const f = runsFile(out);
  return new Set(fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).runs : []);
}
function saveRuns(out, ids) {
  fs.writeFileSync(runsFile(out), JSON.stringify({ note: 'Runs already merged into farms.json, so no run is counted twice.', runs: [...ids].sort() }, null, 1) + '\n');
}

function catalogue() {
  return { version: CATALOGUE_VERSION, objects: L.KNOWN.map((k) => L.labKnown(k)) };
}

/* Merge one parsed log into the database. Returns the farms it created. */
function mergeRun(db, runs, log, now) {
  const { run, events } = log;
  if (runs.has(run.id)) return [];
  const end = events.find((e) => e.t === 'end');
  const snaps = events.filter((e) => e.t === 'snap');
  const created = [], placed = new Set();          // farm key + world position, for counting instances in this run
  runs.add(run.id);
  db.totals.runs++; db.totals.generations += end ? end.g : 0;
  for (const s of sessionsOf(events)) {
    db.totals.candidates++;
    const snap = snapFor(snaps, s);
    if (!snap) continue;
    const st = structureOf(snap, run.snapRadius);
    if (!st.lab.sustains) { db.totals.surroundingsSessions++; db.totals.surroundingsHarvests += s.harvests; continue; }
    db.totals.farmSessions++;
    let f = db.farms.find((x) => x.key === st.key);
    if (!f) {
      f = { key: st.key, id: 'f' + db.farms.length.toString().padStart(3, '0'), name: nameStructure(st.cells, st.bite),
            size: st.cells.length, cells: st.cells, bite: st.bite, lab: st.lab, partial: st.partial,
            firstSpotted: { at: now, world: run.world, strategy: run.strategy, seed: run.seed, gen: s.start, run: run.id },
            field: { instances: 0, sessions: 0, harvests: 0, longest: 0, worlds: {}, strategies: {} } };
      db.farms.push(f); created.push(f);
    }
    const F = f.field, W = run.W, H = run.H;
    const where = f.key + '@' + (((s.x + st.anchor[0]) % W + W) % W) + ',' + (((s.y + st.anchor[1]) % H + H) % H);
    if (!placed.has(where)) { placed.add(where); F.instances = (F.instances || 0) + 1; db.totals.instances = (db.totals.instances || 0) + 1; }
    F.sessions++; F.harvests += s.harvests; F.longest = Math.max(F.longest, s.last - s.start);
    F.worlds[run.world] = (F.worlds[run.world] || 0) + 1;
    F.strategies[run.strategy] = (F.strategies[run.strategy] || 0) + 1;
  }
  return created;
}

function listLogs(inputs) {
  const out = [];
  for (const p of inputs) {
    if (!fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) fs.readdirSync(p).filter((f) => f.endsWith('.jsonl')).sort().forEach((f) => out.push(path.join(p, f)));
    else out.push(p);
  }
  return out;
}

function loadDb(file) {
  if (!fs.existsSync(file)) return emptyDb();
  const db = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.assign(emptyDb(), db);
}

/* Parse logs into farms.json. Returns { db, created } where created lists farms seen for the first time. */
function parse({ inputs = [path.join(L.ROOT, 'logs')], out = path.join(L.ROOT, 'farms.json'), rebuild = false } = {}) {
  const old = loadDb(out), now = new Date().toISOString(), created = [];
  const db = rebuild ? emptyDb() : old, runs = rebuild ? new Set() : loadRuns(out);
  if (rebuild) db.catalogue = old.catalogue;
  if (db.runs) { db.runs.forEach((r) => runs.add(r.id)); delete db.runs; }   // older farms.json kept the list inside
  if (!db.catalogue || db.catalogue.version !== CATALOGUE_VERSION) db.catalogue = catalogue();
  for (const file of listLogs(inputs)) {
    const log = readLog(file);
    if (!log.complete) continue;                       // a run still being written
    created.push(...mergeRun(db, runs, log, now));
  }
  if (rebuild) {   // keep ids and first-spotted dates from before, so links and history survive a rebuild
    let next = Math.max(-1, ...old.farms.map((f) => +f.id.slice(1))) + 1;
    db.farms.forEach((f) => { const o = old.farms.find((x) => x.key === f.key);
      if (o) { f.id = o.id; f.firstSpotted = o.firstSpotted; } else f.id = 'f' + String(next++).padStart(3, '0'); });
    created.length = 0; created.push(...db.farms.filter((f) => !old.farms.some((x) => x.key === f.key)));
  }
  db.farms.sort((a, b) => b.field.harvests - a.field.harvests);
  // which farms each known object turned up in: on its own ("Block") or as part of one ("Blinker + Block")
  db.catalogue.objects.forEach((o) => {
    o.spottedIn = [...new Set(db.farms.map((f) => f.name))].filter((n) => n.split(' + ').some((part) => part.replace(/^\d+ × /, '') === o.name));
    delete o.spotted;
  });
  db.updated = now;
  fs.writeFileSync(out, JSON.stringify(db, null, 1) + '\n');
  saveRuns(out, runs);
  return { db, created };
}

module.exports = { parse, sessionsOf, structureOf, loadRuns, MIN_HARVESTS };

if (require.main === module) {
  const argv = process.argv.slice(2), inputs = [];
  let out, rebuild = false;
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--out') out = argv[++i]; else if (argv[i] === '--rebuild') rebuild = true; else inputs.push(argv[i]); }
  const { db, created } = parse({ inputs: inputs.length ? inputs : undefined, out, rebuild });
  console.log(`${db.farms.length} farm structures from ${db.totals.runs} runs (${db.totals.generations.toLocaleString()} generations).`);
  for (const f of created) console.log(`  new farm: ${f.name} (${f.size} cells), ${f.lab.mealsPerCycle} meal${f.lab.mealsPerCycle === 1 ? '' : 's'} every ${f.lab.period === 1 ? 'generation' : f.lab.period + ' generations'}`);
  if (!created.length) console.log('  no new farms.');
}
