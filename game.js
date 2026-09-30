/* Rover Colony: a game built on the notebook's farm simulation (LIDAR, parts 1.5 to 1.7).
   You drive the first rover. Build children, give them roles, find the Warden and overcharge it.

   Rules are the notebook's, with a few game changes (all in RULES below):
   - Turn-based: the world moves on one generation each time you move, wait or charge, and every child acts once.
   - Rovers aren't live cells: Life never sees them. Each turn a rover moves or stays, then eats the cell it's
     standing on if that cell is alive. No two rovers can ever share a square.
   - Moving costs energy, eating earns it, and every rover pays a little upkeep each turn. A rover that runs out
     shuts down for good; when yours does, you lose.
   - You build children instead of splitting automatically. Children send you part of each meal while they're
     comfortably fed. Sensors run on your power.
   - LIDAR is a cone that widens with energy. You only see what your LIDAR, your scouts and your sensors see.
   - Somewhere on the map is a ship, the Warden. It's built of sealed chambers, and each chamber runs its own Life rule
     against the Conway plane around it; some rules change as the core fills. You can only charge the core from right
     next to it, so you have to find the way in. Overcharge it and it breaks up. That's the win.

   Exposes window.RoverGame = { open(options), close(), isOpen(), world() }. */
(function () {
'use strict';

var RULES = {
  moveCost: 1, meal: 10, upkeep: 0.06, childUpkeep: 0.05, sensorPower: 0.03,
  startEnergy: 60, maxEnergy: 150, childMax: 100,
  buildCost: 40, buildMin: 50, childStart: 20, maxChildren: 24,
  tithe: 0.3, titheAbove: 40,
  fovMin: 90, fovMax: 360, fovFull: 100, range: 20,
  soup: 0.16, gliderEvery: 24, gliderFloor: 6, memory: 400,
  chargePerTurn: 20, childCharge: 10, childKeeps: 15
};
/* Ships you have to overcharge. In `rows`: '#' is wall, 'C' is the core (solid too), ' ' is outside the ship, and every
   other letter is a square of the chamber with that key in `rooms`. Each chamber is sealed by straight walls (so Life on
   either side can't touch) except at its doors: chamber squares set into a wall. A chamber runs its own Life `rule`
   (B = neighbour counts that give birth, S = counts that let a cell survive); `phases` switch it to another rule once
   the core is at least `at` full, and back if it leaks below. `fill` is how much of a chamber starts alive. The core
   holds `capacity` energy and leaks `bleed` a turn, and you can only charge it from one of the 8 squares around it. */
var SHIPS = [
  { name: 'the Warden', capacity: 800, bleed: 1.5,
    rooms: {
      m: { name: 'Maze corridor', rule: 'B3/S12345', ruleName: 'Maze', fill: 0.3, color: [176, 146, 226] },
      r: { name: 'Reactor', rule: 'B45678/S2345', ruleName: 'Walled Cities', fill: 0.5, color: [222, 138, 116],
           phases: [{ at: 0.5, rule: 'B2/S', ruleName: 'Seeds' }] }
    },
    rows: [
      '#########################',
      '#mmmmmmmmmmmmmmmmmmmmmmm#',
      '#mmmmmmmmmmmmmmmmmmmmmmm#',
      '#mmmmmmmmmmmmmmmmmmmmmmm#',
      '#mmm########r########mmm#',
      '#mmm#rrrrrrrrrrrrrrr#mmm#',
      '#mmm#rrrrrrrrrrrrrrr#mmm#',
      '#mmm#rrrrrrrrrrrrrrr#mmm#',
      'mmmm#rrrrrrrCrrrrrrr#mmmm',
      '#mmm#rrrrrrrrrrrrrrr#mmm#',
      '#mmm#rrrrrrrrrrrrrrr#mmm#',
      '#mmm#rrrrrrrrrrrrrrr#mmm#',
      '#mmm########r########mmm#',
      '#mmmmmmmmmmmmmmmmmmmmmmm#',
      '#mmmmmmmmmmmmmmmmmmmmmmm#',
      '#mmmmmmmmmmmmmmmmmmmmmmm#',
      '#########################'] }
];
/* "B3/S23" -> bit masks: bit n of born is set if a dead cell with n live neighbours comes alive, and so on */
function parseRule(str) {
  var m = /^B([0-8]*)\/S([0-8]*)$/i.exec(String(str).replace(/\s/g, '')), born = 0, survive = 0;
  if (!m) throw new Error('Not a Life-like rule: ' + str);
  [].forEach.call(m[1], function (d) { born |= 1 << +d; }); [].forEach.call(m[2], function (d) { survive |= 1 << +d; });
  return { born: born, survive: survive };
}
var ROLES = [
  { id: 'farmer', name: 'Farmer', color: '#74a3e3', key: '1', text: 'Looks five generations ahead to find squares where food keeps being born, and parks there. Walks to farm sites your scouts and sensors report.' },
  { id: 'scout', name: 'Scout', color: '#e6b85c', key: '2', text: 'Sees all the way round, whatever its energy. Explores, reports blocks as farm sites, and lets you see what it sees.' },
  { id: 'grazer', name: 'Grazer', color: '#e0685f', key: '3', text: 'Eats anything it can reach. Quick energy, but it wrecks structures, so keep it away from farms.' },
  { id: 'sentry', name: 'Sentry', color: '#c58fd6', key: '4', text: 'Guards a post and eats whatever comes next to it, like a glider heading for your farm. Send it somewhere to move its post.' },
  { id: 'sensor', name: 'Sensor', color: '#9ad0c8', key: '5', text: 'Stays exactly where it’s built and watches all the way round, lighting up the map and reporting farm sites. Never moves, never eats, runs on your power.' }
];
var ROLE = {}; ROLES.forEach(function (r) { ROLE[r.id] = r; });
var GOALS = [
  { text: 'Eat 5 cells', done: function (g) { return g.stats.playerMeals >= 5; } },
  { text: 'Build a child (press B)', done: function (g) { return g.stats.built >= 1; } },
  { text: 'Get a farmer harvesting', done: function (g) { return g.stats.farmerHarvests >= 10; } },
  { text: 'Place a sensor (role 5)', done: function (g) { return g.rovers.some(function (r) { return r.role === 'sensor'; }); } },
  { text: 'Find the Warden (press M for the map)', done: function (g) { return g.boss.found >= 0; } },
  { text: 'Charge the Warden to half', done: function (g) { return g.boss.charge >= g.boss.capacity / 2; } },
  { text: 'Overcharge the Warden', done: function (g) { return g.won; } }
];

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

/* =====================================================================
   WORLD: Life plus rovers. Same order as the notebook: rovers move and eat one at a time, then Life steps.
   One call to step() is one turn.
   ===================================================================== */
var HULL = -1;   // value in occ[] for a ship's hull
function World(W, H, seed) {
  var self = this, N = W * H, P = RULES;
  var a = new Uint8Array(N), b = new Uint8Array(N);
  var occ = new Int32Array(N);            // rover id + 1 on its square, HULL on a ship, 0 when free
  var beacon = new Uint8Array(N);         // 1 where a rover harvested on its last turn
  var seenAt = new Int32Array(N), mem = new Uint8Array(N);
  var found = new Uint8Array(N);          // bit 1: your rover has seen it; bit 2: a scout or sensor has
  var ruleMap = new Uint8Array(N);        // which rule each square runs: 0 is Conway's, 1 and up are ships'
  var roomOf = new Uint8Array(N);         // which ship chamber a square belongs to (index + 1), 0 for none
  var BORN = [], SURV = [];
  function addRule(str) { var r = parseRule(str); BORN.push(r.born); SURV.push(r.survive); return BORN.length - 1; }
  addRule('B3/S23');
  var rng = mulberry32(seed), brain = mulberry32(seed ^ 0x9E3779B9);
  this.W = W; this.H = H; this.gen = 0; this.rovers = []; this.sites = new Map(); this.events = []; this.over = false; this.won = false;
  this.stats = { meals: 0, playerMeals: 0, built: 0, sitesFound: 0, farmerHarvests: 0, deaths: 0, charged: 0, mappedByYou: 0, mappedByAll: 0 };
  this.farmsNow = 0; this.notices = [];
  this.cells = function () { return a; }; this.seenAt = seenAt; this.mem = mem; this.found = found; this.occ = occ; this.ruleMap = ruleMap; this.roomOf = roomOf;
  function idx(x, y) { x %= W; if (x < 0) x += W; y %= H; if (y < 0) y += H; return y * W + x; }
  function wrapD(d, M) { d %= M; if (d > M / 2) d -= M; else if (d < -M / 2) d += M; return d; }
  this.idx = idx; this.wrapD = wrapD;
  this.byId = function (id) { for (var i = 0; i < self.rovers.length; i++) if (self.rovers[i].id === id) return self.rovers[i]; return null; };
  function notice(text) { self.notices.push(text); }

  // the world: a soup that decays into ash (blocks, blinkers, beehives...) and gliders that keep arriving
  for (var i = 0; i < N; i++) a[i] = rng() < P.soup ? 1 : 0;
  seenAt.fill(-1e9);
  var GL = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
  function spawnGlider() { var x = (rng() * W) | 0, y = (rng() * H) | 0, fx = rng() < 0.5, fy = rng() < 0.5;
    GL.forEach(function (c) { var ci = idx(x + (fx ? 2 - c[0] : c[0]), y + (fy ? 2 - c[1] : c[1])); if (occ[ci] !== HULL) a[ci] = 1; }); }

  // you start a quarter of the way across; the Warden waits on the far side
  var px0 = (W * 0.25) | 0, py0 = (H * 0.5) | 0;
  var ship = SHIPS[0], sh = ship.rows.length, sw = ship.rows[0].length;
  var bx = ((W * 0.75) | 0) + (((rng() - 0.5) * W * 0.15) | 0) - (sw >> 1), by = ((rng() * (H - sh)) | 0);
  this.boss = { name: ship.name, x: bx, y: by, w: sw, h: sh, cx: bx + (sw >> 1), cy: by + (sh >> 1),
                capacity: ship.capacity, bleed: ship.bleed, charge: 0, found: -1, hull: [], rooms: [], broken: false };
  var roomIndex = {};
  Object.keys(ship.rooms).forEach(function (key) {
    var def = ship.rooms[key], stages = [{ at: 0, rule: def.rule, ruleName: def.ruleName || def.rule }].concat(def.phases || []);
    stages.forEach(function (st) { st.id = addRule(st.rule); });
    roomIndex[key] = self.boss.rooms.length;
    self.boss.rooms.push({ key: key, name: def.name, color: def.color || [222, 138, 116], fill: def.fill || 0, stages: stages, stage: 0, squares: [] });
  });
  for (var dy = -3; dy <= sh + 2; dy++) for (var dx = -3; dx <= sw + 2; dx++) a[idx(bx + dx, by + dy)] = 0;   // clear the ground round it
  ship.rows.forEach(function (row, y) { [].forEach.call(row, function (ch, x) { var ci = idx(bx + x, by + y);
    if (ch === '#' || ch === 'C') { occ[ci] = HULL; a[ci] = 0; self.boss.hull.push(ci); if (ch === 'C') { self.boss.cx = bx + x; self.boss.cy = by + y; } }
    else if (ch !== ' ') { var room = self.boss.rooms[roomIndex[ch]]; if (!room) throw new Error('No chamber called ' + ch + ' in ' + ship.name);
      room.squares.push(ci); roomOf[ci] = roomIndex[ch] + 1; ruleMap[ci] = room.stages[0].id; a[ci] = rng() < room.fill ? 1 : 0; } }); });
  this.boss.core = idx(this.boss.cx, this.boss.cy);
  /* each chamber's rule follows the core: the last phase it has reached */
  function updatePhases(announce) {
    var frac = self.boss.charge / self.boss.capacity;
    self.boss.rooms.forEach(function (room) {
      var k = 0; room.stages.forEach(function (st, i) { if (frac >= st.at) k = i; });
      if (k === room.stage) return;
      var up = k > room.stage; room.stage = k;
      room.squares.forEach(function (ci) { ruleMap[ci] = room.stages[k].id; });
      if (announce) notice(self.boss.name.charAt(0).toUpperCase() + self.boss.name.slice(1) + '’s ' + room.name.toLowerCase() + (up ? ' has switched to ' : ' has fallen back to ') +
        room.stages[k].ruleName + ' (' + room.stages[k].rule + ').');
    });
  }
  for (dy = -2; dy <= 2; dy++) for (dx = -2; dx <= 2; dx++) a[idx(px0 + dx, py0 + dy)] = 0;
  function nextToCore(x, y) { var b = self.boss; return !b.broken && Math.max(Math.abs(wrapD(x - b.cx, W)), Math.abs(wrapD(y - b.cy, H))) === 1; }
  this.nextToCore = function (r) { return nextToCore(r.x, r.y); };
  this.isHull = function (x, y) { return occ[idx(x, y)] === HULL; };
  this.isShip = function (x, y) { var ci = idx(x, y); return occ[ci] === HULL || roomOf[ci] > 0; };

  /* ---------- pathfinding: distance fields over everything that isn't hull ----------
     A field holds, for every square, how many moves it is from the goal squares (moving like a rover, diagonals
     included). Walking one means stepping to any free neighbour that's closer. Fields are cached; the hull never
     changes until the ship breaks up. */
  var fields = new Map();
  function field(key, goals) {
    if (fields.has(key)) { var hit = fields.get(key); fields.delete(key); fields.set(key, hit); return hit; }
    var dist = new Int32Array(N).fill(-1), queue = new Int32Array(N), head = 0, tail = 0;
    goals.forEach(function (g) { if (occ[g] !== HULL && dist[g] < 0) { dist[g] = 0; queue[tail++] = g; } });
    while (head < tail) { var c = queue[head++], cx = c % W, cy = (c / W) | 0, d = dist[c] + 1;
      for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) { if (!i && !j) continue; var nb = idx(cx + i, cy + j);
        if (dist[nb] < 0 && occ[nb] !== HULL) { dist[nb] = d; queue[tail++] = nb; } } }
    fields.set(key, dist); if (fields.size > 12) fields.delete(fields.keys().next().value);
    return dist;
  }
  function coreField() { var b = self.boss, goals = [];
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) if (i || j) goals.push(idx(b.cx + i, b.cy + j));
    return field('core', goals); }
  /* where an order leads: to the core if it's anywhere on the ship's hull, otherwise to that square */
  function orderField(t) { var ci = idx(t[0], t[1]); return occ[ci] === HULL ? coreField() : field('sq' + ci, [ci]); }
  function followField(r, dist) {
    var here = dist[idx(r.x, r.y)];
    if (here === 0) return null;                    // arrived
    if (here < 0) return [0, 0];                    // no way there from here
    var best = null, bestD = here, ties = 0;
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) { if (!i && !j) continue;
      var d = dist[idx(r.x + i, r.y + j)]; if (d < 0 || d > bestD || !canMove(r, i, j)) continue;
      if (d < bestD) { bestD = d; best = [i, j]; ties = 1; } else if (d === bestD && best && brain() * ++ties < 1) best = [i, j]; }
    return best && bestD < here ? best : [0, 0];
  }
  this.reachable = function (r, x, y) { return orderField([x, y])[idx(r.x, r.y)] >= 0; };

  var nextId = 0;
  function addRover(role, x, y, e, face) {
    var r = { id: nextId++, role: role, x: x, y: y, e: e, face: face || 0, target: null, home: role === 'sentry' ? [x, y] : null,
              goal: null, stuck: 0, charging: false, meals: 0, born: self.gen, ranges: null };
    occ[idx(x, y)] = r.id + 1; self.rovers.push(r); return r;
  }
  this.player = addRover('player', px0, py0, P.startEnergy, 0);

  /* ---------- LIDAR ---------- */
  var RB = 6, BW = 13, belief = new Int8Array(BW * BW);
  function bel(dx, dy) { return (Math.abs(dx) > RB || Math.abs(dy) > RB) ? -1 : belief[(dy + RB) * BW + dx + RB]; }
  var RAYCELLS = [], RC = new Float32Array(72), RS = new Float32Array(72);
  for (var rk = 0; rk < 72; rk++) { var th0 = rk / 72 * Math.PI * 2, c0 = Math.cos(th0), s0 = Math.sin(th0), seq = [], plx = 0, ply = 0;
    RC[rk] = c0; RS[rk] = s0;
    for (var t0 = 0.5; t0 <= P.range; t0 += 0.35) { var qx = Math.round(c0 * t0), qy = Math.round(s0 * t0); if (qx === plx && qy === ply) continue; plx = qx; ply = qy; seq.push(qx, qy, t0); }
    RAYCELLS.push(seq); }
  this.fov = function (r) { if (r.role === 'scout' || r.role === 'sensor') return 360; var full = r.role === 'player' ? P.fovFull : P.childMax;
    return P.fovMin + (P.fovMax - P.fovMin) * Math.min(1, Math.max(0, r.e) / full); };
  function see(ci, mine) {
    seenAt[ci] = self.gen; mem[ci] = a[ci];
    var bit = mine ? 1 : 2;
    if (!(found[ci] & bit)) { if (mine) self.stats.mappedByYou++; if (!found[ci]) self.stats.mappedByAll++; found[ci] |= bit; }
    if ((occ[ci] === HULL || roomOf[ci]) && self.boss.found < 0) { self.boss.found = self.gen;
      notice('Found ' + self.boss.name + '. Its chambers run their own rules (' + self.boss.rooms.map(function (r) { return r.name.toLowerCase() + ': ' + r.stages[0].ruleName; }).join(', ') +
        '). Find a way in and charge the core from right next to it.'); }
  }
  /* Scan for one rover. `eyes` rovers (you, scouts and sensors) also light up the map. */
  function scan(r, eyes) {
    belief.fill(-1); var nearest = null, rx = r.x, ry = r.y, mine = r.role === 'player', spotter = r.role === 'scout' || r.role === 'sensor';
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) { var ni = idx(rx + i, ry + j);
      belief[(j + RB) * BW + i + RB] = (i || j) && occ[ni] ? 2 : a[ni]; if (eyes) see(ni, mine); }
    var half = self.fov(r) * Math.PI / 360, full = half >= Math.PI - 1e-6, ch = Math.cos(half), fc = Math.cos(r.face), fs = Math.sin(r.face);
    if (mine) r.ranges = r.ranges || new Float32Array(72);
    for (var k = 0; k < 72; k++) {
      if (!full && RC[k] * fc + RS[k] * fs < ch - 1e-6) { if (r.ranges) r.ranges[k] = 0; continue; }
      var sq = RAYCELLS[k], hit = P.range;
      for (var q = 0; q < sq.length; q += 3) { var cx2 = sq[q], cy2 = sq[q + 1], X = rx + cx2, Y = ry + cy2;
        if (X < 0) X += W; else if (X >= W) X -= W; if (Y < 0) Y += H; else if (Y >= H) Y -= H;
        var ci = Y * W + X, v = occ[ci] ? 2 : a[ci];
        if (eyes) see(ci, mine);
        if (cx2 <= RB && cx2 >= -RB && cy2 <= RB && cy2 >= -RB) { var bi = (cy2 + RB) * BW + cx2 + RB; if (belief[bi] < v) belief[bi] = v; }
        if (v) { hit = sq[q + 2]; if (v === 1) { if (!nearest || hit < nearest.t) nearest = { dx: cx2, dy: cy2, t: hit }; if (spotter) checkSite(X, Y); } break; } }
      if (r.ranges) r.ranges[k] = hit; }
    return nearest;
  }

  /* ---------- farm sites: blocks your scouts and sensors have reported ---------- */
  function isBlock(x, y) {   // (x, y) is the top-left of a 2x2 of live cells with nothing alive around it
    for (var j = 0; j < 2; j++) for (var i = 0; i < 2; i++) { var c = idx(x + i, y + j); if (!a[c] && !(occ[c] > 0)) return false; }
    for (j = -1; j <= 2; j++) for (i = -1; i <= 2; i++) { if (i >= 0 && i <= 1 && j >= 0 && j <= 1) continue; if (a[idx(x + i, y + j)]) return false; }
    return true;
  }
  function checkSite(X, Y) {
    for (var j = 0; j < 2; j++) for (var i = 0; i < 2; i++) { var x = X - i, y = Y - j, k = idx(x, y);
      if (!self.sites.has(k) && isBlock(x, y)) { self.sites.set(k, { k: k, x: k % W, y: (k / W) | 0, claim: -1, found: self.gen });
        if (!self.stats.sitesFound++) notice('Found a farm site: a block. Farmers will head for it.'); } }
  }
  function refreshSites() {
    self.sites.forEach(function (s, k) {
      var ok = true;   // a farmed block has its corner eaten and reborn every turn, so check after Life steps
      for (var j = 0; j < 2 && ok; j++) for (var i = 0; i < 2 && ok; i++) { var ci = idx(s.x + i, s.y + j); if (!a[ci] && !(occ[ci] > 0)) ok = false; }
      if (!ok) { var c = self.byId(s.claim); if (c) c.goal = null; self.sites.delete(k); }
      else if (s.claim >= 0 && !self.byId(s.claim)) s.claim = -1;
    });
  }

  /* ---------- the farmer's planner, as in the notebook (part 1.7) ---------- */
  var PH = 5, GAMMA = 0.9, SITE = 2, FW = BW + 2, FN = FW * FW, FC = (RB + 1) * FW + RB + 1;
  var G = [], NB = [], VA = new Float32Array(FN), VB = new Float32Array(FN), BASE = new Uint8Array(FN), BLOCK = new Uint8Array(FN), ROV = [];
  for (var h0 = 0; h0 <= PH; h0++) { G.push(new Uint8Array(FN)); NB.push(new Uint8Array(FN)); }
  function loadBelief(r) {
    BASE.fill(0); BLOCK.fill(0); ROV.length = 0;
    for (var y = 0; y < BW; y++) for (var x = 0; x < BW; x++) { var v = belief[y * BW + x], f = (y + 1) * FW + x + 1;
      if (v === 1) BASE[f] = 1; else if (v === 2) { BLOCK[f] = 1; ROV.push(f); }
      if ((x !== RB || y !== RB) && beacon[idx(r.x + x - RB, r.y + y - RB)]) {        // radio beacons fence off farms
        if (v !== 2) { BLOCK[f] = 1; ROV.push(f); }
        for (var q = -1; q <= 1; q++) for (var p = -1; p <= 1; p++) { var f2 = f + q * FW + p; if (f2 !== FC) BLOCK[f2] = 1; } } }
  }
  function forecast(park) {
    var g = G[0], i, y, x;
    g.set(BASE); g[park] = 0; for (i = 0; i < ROV.length; i++) g[ROV[i]] = 0;
    for (var t = 0; t < PH; t++) { var src = G[t], dst = G[t + 1], nb = NB[t];
      for (y = 1; y <= BW; y++) for (x = 1, i = y * FW + 1; x <= BW; x++, i++) {
        var n = src[i - FW - 1] + src[i - FW] + src[i - FW + 1] + src[i - 1] + src[i + 1] + src[i + FW - 1] + src[i + FW] + src[i + FW + 1];
        nb[i] = n; dst[i] = n === 3 || (n === 2 && src[i]) ? 1 : 0; }
      dst[park] = 0; for (i = 0; i < ROV.length; i++) dst[ROV[i]] = 0; }
  }
  function induct() {
    var cost = P.moveCost, R = P.meal, Vn = VA, Vc = VB, x, y, kk, m, k2, v;
    for (y = -PH; y <= PH; y++) for (x = -PH; x <= PH; x++) { kk = FC + y * FW + x; Vn[kk] = NB[PH - 1][kk] === 3 && NB[PH - 2][kk] === 3 ? SITE * R : 0; }
    for (var t = PH - 1; t >= 1; t--) {
      for (y = -t; y <= t; y++) for (x = -t; x <= t; x++) { kk = FC + y * FW + x; var best = -1e9;
        for (m = 0; m < 9; m++) { k2 = kk + (((m / 3) | 0) - 1) * FW + m % 3 - 1; if (BLOCK[k2]) continue;
          v = (m !== 4 ? (G[t + 1][k2] ? R : 0) - cost : (NB[t][k2] === 3 ? R : 0)) + GAMMA * Vn[k2];
          if (v > best) best = v; }
        Vc[kk] = best; }
      var tmp = Vn; Vn = Vc; Vc = tmp; }
    return Vn;
  }
  function plan(r) {
    loadBelief(r); forecast(FC);
    var cost = P.moveCost, R = P.meal, V1 = induct(), best = -1e9, m0 = 4, m, k1, v, foodMoves = [];
    for (m = 0; m < 9; m++) { k1 = FC + (((m / 3) | 0) - 1) * FW + m % 3 - 1; if (BLOCK[k1]) continue;
      var moved = m !== 4, food = BASE[k1] === 1;
      if (moved && (food ? r.e - cost + R < 0 : r.e < cost)) continue;
      if (moved && food) { foodMoves.push(m); continue; }
      v = (food ? R : 0) - (moved ? cost : 0) + GAMMA * V1[k1] + brain() * 0.01; if (v > best) { best = v; m0 = m; } }
    for (var fi = 0; fi < foodMoves.length; fi++) { m = foodMoves[fi]; k1 = FC + (((m / 3) | 0) - 1) * FW + m % 3 - 1;
      forecast(k1); v = R - cost + GAMMA * induct()[k1] + brain() * 0.01; if (v > best) { best = v; m0 = m; } }
    return { m: [m0 % 3 - 1, ((m0 / 3) | 0) - 1], v: best };
  }

  /* ---------- decisions ---------- */
  function canMove(r, dx, dy) { if (!dx && !dy) return true; var v = bel(dx, dy); if (v >= 2) return false;
    return v === 1 ? r.e - P.moveCost + P.meal >= 0 : r.e >= P.moveCost; }
  function toward(r, tx, ty) {           // one step toward (tx, ty) on the wrapping grid, going round rovers and hulls
    var dx = Math.sign(wrapD(tx - r.x, W)), dy = Math.sign(wrapD(ty - r.y, H));
    if (!dx && !dy) return null;
    var tries = [[dx, dy], [dx, 0], [0, dy], dy ? [brain() < 0.5 ? 1 : -1, dy] : [dx, brain() < 0.5 ? 1 : -1], dx ? [dx, brain() < 0.5 ? 1 : -1] : [brain() < 0.5 ? 1 : -1, dy]];
    for (var i = 0; i < tries.length; i++) { var d = tries[i]; if ((d[0] || d[1]) && canMove(r, d[0], d[1])) return d; }
    return [0, 0];
  }
  function adjacentFood(r, fenced) {
    var food = [];
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) if ((i || j) && bel(i, j) === 1 && (!fenced || !nearBeacon(r.x + i, r.y + j, r))) food.push([i, j]);
    return food.length ? food[(brain() * food.length) | 0] : null;
  }
  function nearBeacon(x, y, me) { for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) { var ci = idx(x + i, y + j); if (beacon[ci] && occ[ci] !== me.id + 1) return true; } return false; }
  function ahead(r) { return [Math.round(Math.cos(r.face)), Math.round(Math.sin(r.face))]; }

  this.input = { dx: 0, dy: 0, charge: false };
  function decide(r, nearest) {
    var e = r.e, under = bel(0, 0) === 1, d, f;
    if (r.role === 'player') {
      var inp = self.input;
      if (inp.charge) return [0, 0];
      if (inp.dx || inp.dy) { r.target = null; return canMove(r, inp.dx, inp.dy) ? [inp.dx, inp.dy] : [0, 0]; }
      if (r.target) {
        d = followField(r, orderField(r.target));
        if (!d) { r.target = null; return [0, 0]; }
        if (!d[0] && !d[1]) { if (++r.stuck > 6) { r.target = null; r.stuck = 0; } } else r.stuck = 0;
        return d;
      }
      return [0, 0];
    }
    if (r.role === 'sensor') return [0, 0];
    if (r.charging) return [0, 0];
    // an order from the player comes first
    if (r.target) {
      var toShip = occ[idx(r.target[0], r.target[1])] === HULL;
      d = followField(r, orderField(r.target));
      if (!d && toShip) { r.target = null; r.charging = true; return [0, 0]; }
      if (!d) { if (r.role === 'sentry') r.home = r.target; r.target = null; }
      else if (d[0] || d[1]) { r.stuck = 0; return d; }
      else if (++r.stuck > 20) { r.target = null; r.stuck = 0; }
      else return d;
    }
    if (r.role === 'sentry') {
      if (under) return [0, 0];
      f = adjacentFood(r, true); if (f) return f;
      if (r.home && (r.x !== r.home[0] || r.y !== r.home[1])) return toward(r, r.home[0], r.home[1]) || [0, 0];
      return [0, 0];
    }
    if (r.role === 'grazer') {
      if (under) return [0, 0];
      f = adjacentFood(r, false); if (f) return f;
      if (nearest && e > 2) { d = [Math.sign(nearest.dx), Math.sign(nearest.dy)]; if (canMove(r, d[0], d[1])) return d; }
      if (e > 8) { if (brain() < 0.05) r.face = brain() * Math.PI * 2; d = ahead(r); if (canMove(r, d[0], d[1])) return d; }
      return [0, 0];
    }
    if (r.role === 'scout') {
      if (under && e < 60) return [0, 0];
      if (e < 30) { f = adjacentFood(r, true); if (f) return f; }
      if (e < 15 && nearest) { d = [Math.sign(nearest.dx), Math.sign(nearest.dy)]; if (canMove(r, d[0], d[1])) return d; }
      if (e < 4) return [0, 0];
      if (brain() < 0.08) r.face += (brain() < 0.5 ? 1 : -1) * Math.PI / 4;
      d = ahead(r);
      if (!(d[0] || d[1]) || !canMove(r, d[0], d[1])) { r.face += Math.PI / 2; d = ahead(r); }
      return canMove(r, d[0], d[1]) ? d : [0, 0];
    }
    // farmer
    var p = plan(r);
    if (p.v >= 0.5) return p.m;
    if (r.goal != null && !self.sites.has(r.goal)) r.goal = null;
    if (r.goal == null) {                         // claim the nearest free site the colony has found
      var bestD = 1e9, pick = null;
      self.sites.forEach(function (s) { if (s.claim >= 0 && s.claim !== r.id) return;
        var dd = Math.max(Math.abs(wrapD(s.x - r.x, W)), Math.abs(wrapD(s.y - r.y, H))); if (dd < bestD) { bestD = dd; pick = s; } });
      if (pick) { pick.claim = r.id; r.goal = pick.k; }
    }
    if (r.goal != null && e > 3) { var s = self.sites.get(r.goal); d = toward(r, s.x, s.y); if (d && (d[0] || d[1])) return d; }
    if (e > 3 * P.moveCost + 5) {
      var tries = [nearest ? [Math.sign(nearest.dx), Math.sign(nearest.dy)] : null, ahead(r)];
      for (var ti = 0; ti < 2; ti++) { d = tries[ti]; if (d && (d[0] || d[1]) && canMove(r, d[0], d[1]) && !BLOCK[FC + d[1] * FW + d[0]]) return d; }
    }
    return p.m;
  }

  function chargeBoss(r, amount) {
    var boss = self.boss, give = Math.max(0, Math.min(amount, r.e - (r === self.player ? 1 : P.childKeeps)));
    if (!give || boss.broken) return 0;
    r.e -= give; boss.charge += give; self.stats.charged += give;
    self.events.push({ x: r.x, y: r.y, t: performance.now(), kind: 'charge' });
    return give;
  }

  /* ---------- one turn ---------- */
  this.step = function () {
    if (self.over) return;
    var rs = self.rovers, player = self.player, order = [player], sensors = 0;
    var kids = rs.filter(function (r) { return r !== player; });
    for (var z = kids.length - 1; z > 0; z--) { var w = (brain() * (z + 1)) | 0, t = kids[z]; kids[z] = kids[w]; kids[w] = t; }
    order = order.concat(kids);
    var dead = [];
    self.farmsNow = 0; self.lastCharge = 0;
    for (var oi = 0; oi < order.length; oi++) {
      var r = order[oi];
      if (r.role === 'sensor') { scan(r, true); sensors++; continue; }       // sensors watch; you power them
      var eyes = r.role === 'player' || r.role === 'scout';
      var nearest = scan(r, eyes), m = decide(r, nearest), moved = !!(m[0] || m[1]);
      beacon[idx(r.x, r.y)] = 0;                  // a beacon stays on until its rover's next turn
      if (moved) {
        var ti = idx(r.x + m[0], r.y + m[1]);
        if (occ[ti]) moved = false;               // never two rovers on one square, never onto a hull
        else { occ[idx(r.x, r.y)] = 0; r.x = ti % W; r.y = (ti / W) | 0; occ[ti] = r.id + 1; r.e -= P.moveCost; r.face = Math.atan2(m[1], m[0]); }
      }
      if (r === player && self.input.charge) { if (nextToCore(r.x, r.y)) self.lastCharge = chargeBoss(r, P.chargePerTurn); }
      else if (r.charging) { if (!nextToCore(r.x, r.y) || !chargeBoss(r, P.childCharge)) r.charging = false; }
      var ci = idx(r.x, r.y);
      if (a[ci]) {
        a[ci] = 0; r.e += P.meal; r.meals++; self.stats.meals++;
        if (r === player) self.stats.playerMeals++;
        if (!moved) { beacon[ci] = 1; if (r.role === 'farmer') { self.stats.farmerHarvests++; self.farmsNow++; } }
        if (r !== player && r.e > P.titheAbove) {   // children share their meals with you
          var give = P.meal * P.tithe; r.e -= give; player.e = Math.min(P.maxEnergy, player.e + give);
        }
        self.events.push({ x: r.x, y: r.y, t: performance.now(), kind: moved ? 'graze' : 'harvest' });
      } else if (!moved && r.role !== 'player') r.face += Math.PI / 4;   // idle: sweep the cone round
      r.e = Math.min(r === player ? P.maxEnergy : P.childMax, r.e) - (r === player ? P.upkeep : P.childUpkeep);
      if (r.e <= 0) dead.push(r);
    }
    player.e -= sensors * P.sensorPower;
    if (player.e <= 0 && dead.indexOf(player) < 0) dead.push(player);
    dead.forEach(function (r) {
      if (r === player) { r.e = 0; self.over = true; return; }
      occ[idx(r.x, r.y)] = 0; beacon[idx(r.x, r.y)] = 0; self.rovers.splice(self.rovers.indexOf(r), 1); self.stats.deaths++;
      var s = r.goal != null && self.sites.get(r.goal); if (s && s.claim === r.id) s.claim = -1;
      self.events.push({ x: r.x, y: r.y, t: performance.now(), kind: 'death' });
      notice('A ' + ROLE[r.role].name.toLowerCase() + ' ran out of energy.');
    });
    // Life steps; rovers are invisible to it, nothing grows in a wall, and each square follows its own rule
    for (var y = 0; y < H; y++) { var up = ((y + H - 1) % H) * W, md = y * W, dn = ((y + 1) % H) * W;
      for (var x = 0; x < W; x++) { var l = x === 0 ? W - 1 : x - 1, rr = x === W - 1 ? 0 : x + 1, c = md + x;
        var n = a[up + l] + a[up + x] + a[up + rr] + a[md + l] + a[md + rr] + a[dn + l] + a[dn + x] + a[dn + rr];
        b[c] = ((a[c] ? SURV[ruleMap[c]] : BORN[ruleMap[c]]) >> n) & 1; } }
    var tt = a; a = b; b = tt;
    var boss = self.boss;
    if (!boss.broken) boss.hull.forEach(function (ci) { a[ci] = 0; });
    self.gen++;
    var every = Math.max(P.gliderFloor, P.gliderEvery - 2 * Math.floor(self.gen / 250));   // the rain gets heavier
    if (self.gen % every === 0) spawnGlider();
    refreshSites();
    // the core leaks; fill it past capacity and the ship breaks up into Life
    if (!boss.broken && !self.over) {
      if (boss.charge >= boss.capacity) breakUp();
      else { boss.charge = Math.max(0, boss.charge - boss.bleed); updatePhases(true); }
    }
    if (self.events.length > 200) self.events.splice(0, self.events.length - 200);
  };
  function breakUp() {
    var boss = self.boss; boss.broken = true; boss.charge = boss.capacity;
    boss.hull.forEach(function (ci) { occ[ci] = 0; a[ci] = rng() < 0.45 ? 1 : 0; });
    boss.rooms.forEach(function (room) { room.squares.forEach(function (ci) { ruleMap[ci] = 0; roomOf[ci] = 0; }); });   // its rules die with it
    fields.clear();
    self.won = true; self.over = true;
    self.events.push({ x: boss.cx, y: boss.cy, t: performance.now(), kind: 'boom' });
  }

  /* ---------- orders ---------- */
  this.build = function (role) {
    var p = self.player;
    if (self.over) return 'The game is over.';
    if (self.rovers.length - 1 >= P.maxChildren) return 'Your colony is full (' + P.maxChildren + ' children).';
    if (p.e < P.buildMin) return 'You need at least ' + P.buildMin + ' energy to build (it costs ' + P.buildCost + ').';
    var empty = [], free = [];
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) { if (!i && !j) continue; var ci = idx(p.x + i, p.y + j);
      if (!occ[ci]) { free.push([i, j]); if (!a[ci]) empty.push([i, j]); } }
    var spots = empty.length ? empty : free;
    if (!spots.length) return 'There’s no free square next to you.';
    var sp = spots[(brain() * spots.length) | 0], ci2 = idx(p.x + sp[0], p.y + sp[1]);
    p.e -= P.buildCost; self.stats.built++;
    var c = addRover(role, ci2 % W, (ci2 / W) | 0, P.childStart, Math.atan2(sp[1], sp[0]));
    self.events.push({ x: c.x, y: c.y, t: performance.now(), kind: 'build' });
    if (role === 'sensor') scan(c, true);        // a new sensor looks round straight away
    return c;
  };
  this.setRole = function (r, role) {
    if (!r || r === self.player || r.role === role || r.role === 'sensor' || role === 'sensor') return false;
    var s = r.goal != null && self.sites.get(r.goal); if (s && s.claim === r.id) s.claim = -1;
    r.role = role; r.goal = null; r.home = role === 'sentry' ? [r.x, r.y] : null; return true;
  };
  this.send = function (r, x, y) { if (r && r.role !== 'sensor') { r.target = [((x % W) + W) % W, ((y % H) + H) % H]; r.stuck = 0; r.charging = false; return true; } return false; };
  this.score = function () { return self.stats.meals; };
}

/* =====================================================================
   GAME: overlay, camera, minimap, input, HUD
   ===================================================================== */
var root = null, state = null, opts = {}, lastFocus = null, pumpTimer = 0;
var REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
var REPEAT_MS = 110, FIRST_REPEAT_MS = 240;

var CSS = '' +
'.rg-root{position:fixed;inset:0;z-index:50;background:#141413;color:#f0eee6;font-family:"Hanken Grotesk","Segoe UI",system-ui,sans-serif;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}' +
'.rg-root canvas.rg-board{position:absolute;inset:0;image-rendering:pixelated;cursor:crosshair}' +
'.rg-panel{background:rgba(31,31,29,.88);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border:1px solid #3f3e39;border-radius:12px;padding:.6rem .8rem}' +
'.rg-top{position:absolute;top:max(.6rem,env(safe-area-inset-top));left:.6rem;right:.6rem;display:flex;justify-content:space-between;align-items:flex-start;gap:.6rem;pointer-events:none}' +
'.rg-top>*{pointer-events:auto}' +
'.rg-status{display:grid;gap:.3rem;font-size:.85rem;min-width:15rem;max-width:23rem}' +
'.rg-energy{display:flex;align-items:center;gap:.5rem}.rg-energy span{color:#b1afa4;min-width:3.4rem}' +
'.rg-bar{flex:1;height:.5rem;background:#34342f;border-radius:999px;overflow:hidden}.rg-bar i{display:block;height:100%;background:#f7f5ee;border-radius:999px;transition:width .15s}' +
'.rg-bar.low i{background:#e0685f}.rg-bar.core i{background:#e0685f}' +
'.rg-energy b{font-variant-numeric:tabular-nums;min-width:4.6rem;text-align:right;font-weight:500}' +
'.rg-meta,.rg-colony{color:#b1afa4;font-variant-numeric:tabular-nums}' +
'.rg-colony{display:flex;flex-wrap:wrap;gap:.2rem .8rem}.rg-colony i,.rg-chip i{display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.3rem;vertical-align:-.02rem}' +
'.rg-goal{color:#f0eee6}.rg-goal em{font-style:normal;color:#85837a}' +
'.rg-ctrls{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end;max-width:30rem}' +
'.rg-btn{font:500 .85rem/1 "Hanken Grotesk",system-ui,sans-serif;color:#f0eee6;background:rgba(38,38,36,.9);border:1px solid #57554d;border-radius:999px;padding:.5rem .8rem;cursor:pointer;white-space:nowrap}' +
'.rg-btn:hover{background:#34342f}.rg-btn:focus-visible,.rg-chip:focus-visible{outline:2px solid #9cbdf0;outline-offset:2px}' +
'.rg-btn.primary{background:#f0eee6;color:#1f1e1c;border-color:#f0eee6}.rg-btn.primary:hover{background:#fff}' +
'.rg-btn.hot{border-color:#e0685f;color:#f0a39c}' +
'.rg-btn[disabled]{opacity:.45;cursor:not-allowed}' +
'.rg-bottom{position:absolute;left:.6rem;right:.6rem;bottom:max(.6rem,env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end;justify-content:space-between;pointer-events:none}' +
'.rg-bottom>*{pointer-events:auto}' +
'.rg-build{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem}' +
'.rg-chip{font:500 .82rem/1 "Hanken Grotesk",system-ui,sans-serif;color:#b1afa4;background:none;border:1px solid #3f3e39;border-radius:999px;padding:.45rem .7rem;cursor:pointer}' +
'.rg-chip[aria-pressed="true"]{color:#f0eee6;border-color:#f0eee6;background:#34342f}' +
'.rg-chip kbd,.rg-btn kbd{font:inherit;color:#85837a;margin-left:.3rem}' +
'.rg-sel{font-size:.85rem;color:#b1afa4;display:grid;gap:.45rem;max-width:26rem}.rg-sel b{color:#f0eee6;font-weight:500}' +
'.rg-row{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center}' +
'.rg-map{position:absolute;right:.6rem;top:50%;transform:translateY(-50%);width:min(34rem,70vw);height:min(24rem,60vh);min-width:12rem;min-height:9rem;max-width:calc(100vw - 1.2rem);max-height:calc(100vh - 1.2rem);resize:both;overflow:hidden;display:flex;flex-direction:column;padding:0}' +
'.rg-map[hidden]{display:none}' +
'.rg-map-head{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .6rem;padding:.5rem .6rem;border-bottom:1px solid #3f3e39;font-size:.82rem;color:#b1afa4}' +
'.rg-map-head b{color:#f0eee6;font-weight:500}.rg-map-head label{display:flex;align-items:center;gap:.35rem;cursor:pointer}.rg-map-head .rg-sp{flex:1}' +
'.rg-map-head .rg-btn{padding:.3rem .55rem}' +
'.rg-map-scroll{flex:1;overflow:auto;background:#141413;cursor:crosshair;touch-action:pan-x pan-y}' +
'.rg-map-scroll canvas{display:block;image-rendering:pixelated}' +
'.rg-card{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(20,20,19,.74)}' +
'.rg-card[hidden]{display:none}' +
'.rg-dialog{max-width:36rem;max-height:100%;overflow:auto;background:#2d2d2a;border:1px solid #3f3e39;border-radius:16px;padding:1.4rem 1.5rem;font-size:.93rem;line-height:1.55;color:#b1afa4}' +
'.rg-dialog h2{font-family:"Source Serif 4",Georgia,serif;font-weight:500;font-size:1.8rem;line-height:1.1;margin:0 0 .6rem;color:#f0eee6}' +
'.rg-dialog h3{font-size:.9rem;color:#f0eee6;margin:1rem 0 .3rem}.rg-dialog p{margin:0 0 .7rem}.rg-dialog ul{margin:0 0 .7rem;padding-left:1.1rem}.rg-dialog li{margin:.2rem 0}' +
'.rg-dialog strong{color:#f0eee6;font-weight:500}.rg-dialog .rg-row{margin-top:1rem;gap:.5rem}' +
'.rg-roles{list-style:none;padding:0!important}.rg-roles li{display:flex;gap:.5rem}.rg-roles i{flex:none;width:.7rem;height:.7rem;border-radius:2px;margin-top:.4rem}' +
'.rg-toast{position:absolute;left:50%;top:6rem;transform:translateX(-50%);background:#f0eee6;color:#1f1e1c;font-weight:500;font-size:.88rem;padding:.55rem 1rem;border-radius:999px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:calc(100% - 2rem);text-align:center}' +
'.rg-toast.show{opacity:1}' +
'.rg-keys{color:#85837a}' +
'@media (max-width:700px){.rg-status{min-width:0;font-size:.8rem}.rg-keys,.rg-chip kbd,.rg-btn kbd{display:none}.rg-top{flex-direction:column}.rg-ctrls{justify-content:flex-start}.rg-toast{top:auto;bottom:9rem}.rg-map{top:auto;bottom:5.5rem;transform:none;width:calc(100vw - 1.2rem);height:45vh}}' +
'@media (max-height:520px){.rg-top{flex-direction:row}.rg-status{font-size:.74rem;gap:.1rem;min-width:0}.rg-colony,.rg-goal,.rg-keys{display:none}' +
'.rg-panel{padding:.35rem .5rem}.rg-btn{padding:.35rem .55rem;font-size:.75rem}.rg-chip{padding:.3rem .5rem;font-size:.74rem}.rg-toast{top:auto;bottom:4.5rem}' +
'.rg-map{top:.4rem;bottom:.4rem;left:.4rem;right:.4rem;transform:none;width:auto;height:auto;max-height:none;resize:none;z-index:2}}' +
'@media (prefers-reduced-motion: reduce){.rg-bar i,.rg-toast{transition:none}}';

function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmt(n) { return Math.round(n).toLocaleString('en-GB'); }
function pct(n) { return (n * 100 < 10 ? (n * 100).toFixed(1) : Math.round(n * 100)) + '%'; }
function store(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k) || 'null'); localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }

function build() {
  if (!document.getElementById('rg-style')) { var st = document.createElement('style'); st.id = 'rg-style'; st.textContent = CSS; document.head.appendChild(st); }
  root = document.createElement('div'); root.className = 'rg-root'; root.setAttribute('role', 'application'); root.setAttribute('aria-label', 'Rover Colony game');
  root.tabIndex = -1;
  var roleChips = ROLES.map(function (r) { return '<button type="button" class="rg-chip" data-role="' + r.id + '" aria-pressed="false"><i style="background:' + r.color + '"></i>' + r.name + '<kbd>' + r.key + '</kbd></button>'; }).join('');
  root.innerHTML =
    '<canvas class="rg-board" aria-hidden="true"></canvas>' +
    '<div class="rg-top">' +
      '<div class="rg-panel rg-status">' +
        '<div class="rg-energy"><span>Energy</span><div class="rg-bar" data-ebar><i></i></div><b data-e>0</b></div>' +
        '<div class="rg-energy" data-bossrow hidden><span>Warden</span><div class="rg-bar core" data-cbar><i></i></div><b data-c>0</b></div>' +
        '<div class="rg-meta" data-meta></div><div class="rg-colony" data-colony></div><div class="rg-goal" data-goal></div>' +
      '</div>' +
      '<div class="rg-panel rg-ctrls">' +
        '<button type="button" class="rg-btn" data-act="wait">Wait<kbd>Space</kbd></button>' +
        '<button type="button" class="rg-btn" data-act="charge">Charge<kbd>C</kbd></button>' +
        '<button type="button" class="rg-btn" data-act="map">Map<kbd>M</kbd></button>' +
        '<button type="button" class="rg-btn" data-act="help">How to play</button>' +
        '<button type="button" class="rg-btn" data-act="exit">Exit</button>' +
      '</div>' +
    '</div>' +
    '<div class="rg-bottom">' +
      '<div class="rg-panel rg-build" role="group" aria-label="Build a child"><span class="rg-keys">Next child:</span>' + roleChips +
        '<button type="button" class="rg-btn primary" data-act="build">Build<kbd>B</kbd></button></div>' +
      '<div class="rg-panel rg-sel" data-sel hidden></div>' +
    '</div>' +
    '<section class="rg-panel rg-map" data-map hidden aria-label="Map">' +
      '<div class="rg-map-head"><b>Map</b><span data-mapped></span><span class="rg-sp"></span>' +
        '<label><input type="checkbox" data-mapall> Include scouts and sensors</label>' +
        '<button type="button" class="rg-btn" data-act="zoomout" aria-label="Zoom out">−</button><button type="button" class="rg-btn" data-act="zoomin" aria-label="Zoom in">+</button>' +
        '<button type="button" class="rg-btn" data-act="map" aria-label="Close map">Close<kbd>M</kbd></button></div>' +
      '<div class="rg-map-scroll"><canvas data-mapcanvas></canvas></div>' +
    '</section>' +
    '<div class="rg-toast" role="status" aria-live="polite"></div>' +
    '<div class="rg-card" data-card="help"><div class="rg-dialog" role="dialog" aria-modal="true" aria-labelledby="rg-help-h">' +
      '<h2 id="rg-help-h">Rover Colony</h2>' +
      '<p>You’re the white rover, alone in Conway’s Game of Life. Rovers aren’t live cells, so Life can’t see you: you eat the cell you’re standing on, and a cell that’s born under you while you sit still is a free meal. Parked on the corner of a <strong>block</strong>, you get one every turn.</p>' +
      '<p>Somewhere on the far side of the world is a ship, <strong>the Warden</strong>. It’s built of sealed chambers, and each one runs its own Life rule instead of Conway’s: a <strong>Maze corridor</strong> round the outside and a <strong>Reactor</strong> in the middle, drawn in their own colours. What you know about blocks and gliders may not hold in there, and the reactor’s rule changes once its core is half full. Its core holds 800 energy and leaks a little every turn. Get inside, pour in more than it can hold, and it breaks apart. That’s how you win.</p>' +
      '<h3>Controls</h3><ul>' +
        '<li><strong>The world only moves when you do.</strong> Each move is one generation, and every child takes a turn too.</li>' +
        '<li><strong>Move:</strong> arrow keys or WASD (hold to keep going), or click or tap the map to walk there. <strong>Space</strong> waits a turn, which is how you harvest.</li>' +
        '<li><strong>Build a child (B):</strong> costs 40 energy. Pick its role first (1 to 5).</li>' +
        '<li><strong>Command a child:</strong> click it, change its role, then click the map to send it. Send one to the Warden’s hull and it finds its way to the core and charges it with its spare energy.</li>' +
        '<li><strong>Charge (C):</strong> from one of the 8 squares right next to the Warden’s core, puts 20 of your energy into it. Click the ship to walk to the core; rovers find their own way through the doors.</li>' +
        '<li><strong>Map (M):</strong> everything your rover has seen. Drag its corner to resize it, scroll it, and click it to walk there.</li></ul>' +
      '<h3>Roles</h3><ul class="rg-roles">' + ROLES.map(function (r) { return '<li><i style="background:' + r.color + '"></i><span><strong>' + r.name + '.</strong> ' + esc(r.text) + '</span></li>'; }).join('') + '</ul>' +
      '<h3>The catch</h3><p>Moving costs 1 energy and every rover burns a little each turn; each sensor adds to your own upkeep. Children send you 30% of their meals while they have more than 40 energy. A rover that runs out shuts down, and when you do, you lose. The glider rain gets heavier the longer you last.</p>' +
      '<div class="rg-row"><button type="button" class="rg-btn primary" data-act="start">Start</button><button type="button" class="rg-btn" data-act="exit">Back to the notebook</button></div>' +
    '</div></div>' +
    '<div class="rg-card" data-card="over" hidden><div class="rg-dialog" role="dialog" aria-modal="true" aria-labelledby="rg-over-h">' +
      '<h2 id="rg-over-h" data-overh>Your rover shut down</h2><p data-over></p>' +
      '<div class="rg-row"><button type="button" class="rg-btn primary" data-act="again">Play again</button><button type="button" class="rg-btn" data-act="exit">Back to the notebook</button></div>' +
    '</div></div>';
  document.body.appendChild(root);
}

function q(sel) { return root.querySelector(sel); }

function newGame() {
  var board = q('canvas.rg-board'), w = window.innerWidth, h = window.innerHeight;
  var s = Math.max(7, Math.min(12, Math.round(Math.min(w, h) / 60)));
  var vw = Math.ceil(w / s) + 2, vh = Math.ceil(h / s) + 2;
  var W = Math.max(150, Math.min(260, Math.ceil(vw * 2.2))), H = Math.max(100, Math.min(200, Math.ceil(vh * 2.2)));
  var dpr = Math.min(2, window.devicePixelRatio || 1);
  board.width = Math.round(w * dpr); board.height = Math.round(h * dpr); board.style.width = w + 'px'; board.style.height = h + 'px';
  var off = document.createElement('canvas'); off.width = vw; off.height = vh;
  var offCtx = off.getContext('2d'), img = offCtx.createImageData(vw, vh);
  var world = new World(W, H, (Math.random() * 1e9) | 0);
  state = { world: world, s: s, dpr: dpr, w: w, h: h, vw: vw, vh: vh, ctx: board.getContext('2d'), off: off, offCtx: offCtx, img: img, px: new Uint32Array(img.data.buffer),
            cam: [world.player.x, world.player.y], raf: 0, role: 'farmer', selected: null, goal: 0, held: {}, repeatAt: 0, walking: false,
            toastT: 0, overShown: false, map: { open: false, zoom: 3, all: false, dirty: true } };
  var cb = q('[data-mapall]'); if (cb) cb.checked = false;
  setRole('farmer'); updateHud(true);
}

function setRole(role) {
  state.role = role;
  root.querySelectorAll('.rg-build [data-role]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-role') === role)); });
}

function toast(msg) {
  var t = q('.rg-toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(state.toastT); state.toastT = setTimeout(function () { t.classList.remove('show'); }, 2800);
}

function showCard(name, on) { var c = q('[data-card="' + name + '"]'); c.hidden = !on; if (on) { var b = c.querySelector('.rg-btn.primary'); if (b) b.focus(); } }
function blocked() { return !q('[data-card="help"]').hidden || !q('[data-card="over"]').hidden; }

/* ---------- turns ---------- */
function turn(kind, dx, dy) {
  var wd = state.world;
  if (wd.over || blocked()) return false;
  if (kind === 'charge' && !wd.nextToCore(wd.player)) { toast(wd.boss.found >= 0 ? 'You can only charge the Warden from right next to its core. Find a way in.' : 'Nothing to charge here. Find the Warden first.'); return false; }
  wd.input.dx = kind === 'move' ? dx : 0; wd.input.dy = kind === 'move' ? dy : 0; wd.input.charge = kind === 'charge';
  wd.step();
  if (kind === 'charge' && !wd.lastCharge && !wd.over) toast('You don’t have energy to spare.');
  state.map.dirty = true;
  updateHud(false);
  return true;
}
var DIRS = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
function heldDir() { var dx = 0, dy = 0; for (var k in state.held) if (state.held[k] && DIRS[k]) { dx += DIRS[k][0]; dy += DIRS[k][1]; } return [Math.sign(dx), Math.sign(dy)]; }

/* ---------- drawing ---------- */
var LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function rgb(r, g, b) { return LE ? (255 << 24 | b << 16 | g << 8 | r) >>> 0 : (r << 24 | g << 16 | b << 8 | 255) >>> 0; }
var C_UNSEEN = rgb(20, 20, 19), C_GROUND = rgb(44, 44, 41), C_LIVE = rgb(111, 181, 125), C_HULL = rgb(92, 46, 42), C_HULL_DIM = rgb(56, 32, 30);
// inside a ship, each chamber has its own colours, so you can see where Conway's rule stops and another starts
function roomPalette(room) {
  if (room.pal) return room.pal;
  var c = room.color, mix = function (f, base) { return rgb(Math.round(base[0] + (c[0] - base[0]) * f), Math.round(base[1] + (c[1] - base[1]) * f), Math.round(base[2] + (c[2] - base[2]) * f)); };
  return (room.pal = { live: rgb(c[0], c[1], c[2]), ground: mix(0.12, [40, 40, 38]), memLive: mix(0.35, [20, 20, 19]), mem: mix(0.08, [26, 26, 24]) });
}
var C_MEM = [], C_MEMLIVE = [];
for (var mi = 0; mi < 16; mi++) { var f = 1 - mi / 16; C_MEM.push(rgb(Math.round(20 + 12 * f), Math.round(20 + 12 * f), Math.round(19 + 11 * f))); C_MEMLIVE.push(rgb(Math.round(20 + 40 * f), Math.round(20 + 70 * f), Math.round(19 + 45 * f))); }
function cellColor(wd, i, gen, M) {
  var age = gen - wd.seenAt[i], hull = wd.occ[i] === HULL, room = wd.roomOf[i] ? roomPalette(wd.boss.rooms[wd.roomOf[i] - 1]) : null;
  if (age <= 1) return hull ? C_HULL : room ? (wd.cells()[i] ? room.live : room.ground) : wd.cells()[i] ? C_LIVE : C_GROUND;
  if (age < M) { var k = Math.min(15, (age * 16 / M) | 0); return hull ? C_HULL_DIM : room ? (wd.mem[i] ? room.memLive : room.mem) : wd.mem[i] ? C_MEMLIVE[k] : C_MEM[k]; }
  return C_UNSEEN;
}

function draw() {
  var st = state, wd = st.world, W = wd.W, H = wd.H, s = st.s, ctx = st.ctx, gen = wd.gen, px = st.px, M = RULES.memory, p = wd.player;
  // the camera eases toward you, on the wrapping grid
  st.cam[0] += wd.wrapD(p.x - st.cam[0], W) * (REDUCED ? 1 : 0.25); st.cam[1] += wd.wrapD(p.y - st.cam[1], H) * (REDUCED ? 1 : 0.25);
  st.cam[0] = (st.cam[0] + W) % W; st.cam[1] = (st.cam[1] + H) % H;
  var left = st.cam[0] + 0.5 - st.w / s / 2, top = st.cam[1] + 0.5 - st.h / s / 2, x0 = Math.floor(left), y0 = Math.floor(top), fx = left - x0, fy = top - y0;
  for (var j = 0; j < st.vh; j++) { var wy = ((y0 + j) % H + H) % H;
    for (var i = 0; i < st.vw; i++) { var wx = ((x0 + i) % W + W) % W; px[j * st.vw + i] = cellColor(wd, wy * W + wx, gen, M); } }
  st.offCtx.putImageData(st.img, 0, 0);
  ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#141413'; ctx.fillRect(0, 0, st.w, st.h);
  ctx.drawImage(st.off, -fx * s, -fy * s, st.vw * s, st.vh * s);
  // screen position of a world square's top-left corner, taking the wrap into account
  function sx(x) { var d = wd.wrapD(x - left, W); return (d < -2 ? d + W : d) * s; }
  function sy(y) { var d = wd.wrapD(y - top, H); return (d < -2 ? d + H : d) * s; }
  function onScreen(x, y, m) { var X = sx(x), Y = sy(y); return X > -m && Y > -m && X < st.w + m && Y < st.h + m; }
  // your LIDAR
  if (p.ranges) { ctx.strokeStyle = 'rgba(116,163,227,0.10)'; ctx.lineWidth = 1; ctx.beginPath();
    var bx = sx(p.x) + s / 2, by = sy(p.y) + s / 2;
    for (var k2 = 0; k2 < 72; k2++) { var r = p.ranges[k2] * s; if (!r) continue; var th = k2 / 72 * Math.PI * 2; ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(th) * r, by + Math.sin(th) * r); }
    ctx.stroke(); }
  // the Warden's core, once you've seen it: fills up as you charge it
  var boss = wd.boss;
  if (boss.found >= 0 && !boss.broken && onScreen(boss.x, boss.y, boss.w * s + 40)) {
    var cx = sx(boss.cx) + s / 2, cy = sy(boss.cy) + s / 2, frac = Math.min(1, boss.charge / boss.capacity), R = s * 1.4;
    ctx.fillStyle = 'rgba(20,20,19,0.8)'; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(224,104,95,' + (0.35 + 0.6 * frac).toFixed(2) + ')'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = 'rgba(224,104,95,0.9)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
    ctx.font = '500 11px "Hanken Grotesk", system-ui, sans-serif'; ctx.textAlign = 'center';
    boss.rooms.forEach(function (room, k) { var st = room.stages[room.stage], c = room.color;
      ctx.fillStyle = 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',0.9)';
      ctx.fillText(room.name + ': ' + st.ruleName + ' · ' + st.rule, sx(boss.x) + boss.w * s / 2, sy(boss.y) + boss.h * s + 14 + k * 14); });
    ctx.textAlign = 'start';
  }
  // farm sites
  ctx.lineWidth = 1.5;
  wd.sites.forEach(function (site) { if (!onScreen(site.x, site.y, 3 * s)) return; ctx.strokeStyle = site.claim >= 0 ? 'rgba(116,163,227,0.8)' : 'rgba(230,184,92,0.85)'; ctx.strokeRect(sx(site.x) - 1.5, sy(site.y) - 1.5, 2 * s + 3, 2 * s + 3); });
  // orders
  ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  wd.rovers.forEach(function (r) { if (!r.target) return; ctx.strokeStyle = r === p ? 'rgba(247,245,238,0.5)' : 'rgba(247,245,238,0.3)';
    var X = sx(r.x) + s / 2, Y = sy(r.y) + s / 2, tx = X + wd.wrapD(r.target[0] - r.x, W) * s, ty = Y + wd.wrapD(r.target[1] - r.y, H) * s;
    ctx.beginPath(); ctx.moveTo(X, Y); ctx.lineTo(tx, ty); ctx.stroke(); ctx.strokeRect(tx - s / 2 + 1, ty - s / 2 + 1, s - 2, s - 2); });
  ctx.setLineDash([]);
  // rovers
  wd.rovers.forEach(function (r) {
    if (!onScreen(r.x, r.y, 3 * s)) return;
    var e = r === p ? Math.min(1, r.e / RULES.fovFull) : r.role === 'sensor' ? 1 : Math.min(1, r.e / RULES.childMax), X = sx(r.x), Y = sy(r.y);
    ctx.globalAlpha = 0.5 + 0.5 * e;
    ctx.fillStyle = r === p ? '#f7f5ee' : ROLE[r.role].color;
    var g = r === p ? 3 : 1.5;
    if (r.role === 'sensor') { ctx.beginPath(); ctx.moveTo(X + s / 2, Y - g); ctx.lineTo(X + s + g, Y + s / 2); ctx.lineTo(X + s / 2, Y + s + g); ctx.lineTo(X - g, Y + s / 2); ctx.closePath(); ctx.fill(); }
    else ctx.fillRect(X - g, Y - g, s + 2 * g, s + 2 * g);
    ctx.globalAlpha = 1;
    if (r === p) { ctx.strokeStyle = '#1f1e1c'; ctx.lineWidth = 1.5; ctx.strokeRect(X + 0.75, Y + 0.75, s - 1.5, s - 1.5); }
    if (r.charging) { ctx.strokeStyle = 'rgba(224,104,95,0.9)'; ctx.lineWidth = 1.5; ctx.strokeRect(X - 3.5, Y - 3.5, s + 7, s + 7); }
    if (r === state.selected) { ctx.strokeStyle = '#f7f5ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(X + s / 2, Y + s / 2, s * 1.6, 0, Math.PI * 2); ctx.stroke(); }
  });
  // events
  var now = performance.now();
  if (!REDUCED) wd.events = wd.events.filter(function (ev) {
    var life = ev.kind === 'boom' ? 2500 : ev.kind === 'death' || ev.kind === 'build' ? 1100 : 650, qn = (now - ev.t) / life; if (qn > 1) return false;
    var col = { harvest: '116,163,227', graze: '224,104,95', death: '133,131,122', charge: '224,104,95', boom: '224,104,95' }[ev.kind] || '247,245,238';
    ctx.strokeStyle = 'rgba(' + col + ',' + (1 - qn).toFixed(2) + ')';
    ctx.lineWidth = ev.kind === 'boom' ? 3 : 1.5; ctx.beginPath();
    ctx.arc(sx(ev.x) + s / 2, sy(ev.y) + s / 2, s * 0.7 + qn * s * (ev.kind === 'boom' ? 30 : ev.kind === 'harvest' || ev.kind === 'graze' || ev.kind === 'charge' ? 2 : 5), 0, Math.PI * 2); ctx.stroke(); return true; });
  else wd.events.length = 0;
  if (state.map.open && state.map.dirty) drawMap();
}

/* ---------- the minimap: what your rover has discovered ---------- */
function drawMap() {
  var st = state, wd = st.world, mp = st.map, W = wd.W, H = wd.H, z = mp.zoom, c = q('[data-mapcanvas]');
  mp.dirty = false;
  if (!mp.img || mp.img.width !== W || mp.img.height !== H) { mp.base = document.createElement('canvas'); mp.base.width = W; mp.base.height = H; mp.bctx = mp.base.getContext('2d'); mp.img = mp.bctx.createImageData(W, H); mp.px = new Uint32Array(mp.img.data.buffer); }
  if (c.width !== W * z || c.height !== H * z) { c.width = W * z; c.height = H * z; c.style.width = W * z + 'px'; c.style.height = H * z + 'px'; }
  var mask = mp.all ? 3 : 1, gen = wd.gen, px = mp.px, found = wd.found, M = RULES.memory, a = wd.cells();
  for (var i = 0; i < W * H; i++) {
    if (!(found[i] & mask)) { px[i] = C_UNSEEN; continue; }
    var age = gen - wd.seenAt[i];
    var room = wd.roomOf[i] ? roomPalette(wd.boss.rooms[wd.roomOf[i] - 1]) : null;
    px[i] = wd.occ[i] === HULL ? (age <= 1 ? C_HULL : C_HULL_DIM) : room ? (age <= 1 ? (a[i] ? room.live : room.ground) : wd.mem[i] ? room.memLive : room.mem)
      : age <= 1 ? (a[i] ? C_LIVE : C_GROUND) : wd.mem[i] ? C_MEMLIVE[Math.min(15, (Math.min(age, M - 1) * 16 / M) | 0)] : C_MEM[4];
  }
  mp.bctx.putImageData(mp.img, 0, 0);
  var ctx = c.getContext('2d'); ctx.imageSmoothingEnabled = false; ctx.drawImage(mp.base, 0, 0, W * z, H * z);
  // what's on screen now
  var vw = st.w / st.s, vh = st.h / st.s, lx = st.cam[0] + 0.5 - vw / 2, ly = st.cam[1] + 0.5 - vh / 2;
  ctx.strokeStyle = 'rgba(240,238,230,0.5)'; ctx.lineWidth = 1;
  [[0, 0], [-W, 0], [W, 0], [0, -H], [0, H]].forEach(function (o) { ctx.strokeRect((lx + o[0]) * z + 0.5, (ly + o[1]) * z + 0.5, vw * z, vh * z); });
  // farm sites, the Warden, rovers
  wd.sites.forEach(function (site) { if (!(found[site.k] & mask)) return; ctx.strokeStyle = 'rgba(230,184,92,0.9)'; ctx.strokeRect(site.x * z - 1, site.y * z - 1, 2 * z + 2, 2 * z + 2); });
  var boss = wd.boss;
  if (boss.found >= 0 && !boss.broken && boss.hull.some(function (ci) { return found[ci] & mask; })) { ctx.strokeStyle = '#e0685f'; ctx.lineWidth = 2; ctx.strokeRect(boss.x * z - 2, boss.y * z - 2, boss.w * z + 4, boss.h * z + 4); }
  var d = Math.max(3, z);
  wd.rovers.forEach(function (r) {
    if (r !== wd.player && !mp.all) return;
    if (r.role === 'sensor') { ctx.strokeStyle = 'rgba(154,208,200,0.25)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc((r.x + 0.5) * z, (r.y + 0.5) * z, RULES.range * z, 0, Math.PI * 2); ctx.stroke(); }
    var big = r === wd.player ? 2 : 0;
    ctx.fillStyle = r === wd.player ? '#f7f5ee' : ROLE[r.role].color;
    ctx.fillRect((r.x + 0.5) * z - d / 2 - big / 2, (r.y + 0.5) * z - d / 2 - big / 2, d + big, d + big);
  });
  q('[data-mapped]').textContent = 'you’ve mapped ' + pct(wd.stats.mappedByYou / (W * H)) + (mp.all ? ', the colony ' + pct(wd.stats.mappedByAll / (W * H)) : '');
}
function centerMap() {
  var sc = q('.rg-map-scroll'), z = state.map.zoom, p = state.world.player;
  sc.scrollLeft = (p.x + 0.5) * z - sc.clientWidth / 2; sc.scrollTop = (p.y + 0.5) * z - sc.clientHeight / 2;
}
function toggleMap(on) {
  var mp = state.map; mp.open = on === undefined ? !mp.open : on;
  q('[data-map]').hidden = !mp.open;
  if (mp.open) { mp.dirty = true; drawMap(); centerMap(); }
}
function zoomMap(dz) {
  var mp = state.map, sc = q('.rg-map-scroll'), old = mp.zoom;
  mp.zoom = Math.max(1, Math.min(8, mp.zoom + dz)); if (mp.zoom === old) return;
  var cx = (sc.scrollLeft + sc.clientWidth / 2) / old, cy = (sc.scrollTop + sc.clientHeight / 2) / old;
  mp.dirty = true; drawMap();
  sc.scrollLeft = cx * mp.zoom - sc.clientWidth / 2; sc.scrollTop = cy * mp.zoom - sc.clientHeight / 2;
}

/* ---------- HUD ---------- */
function updateHud(force) {
  var wd = state.world, p = wd.player, counts = {}, boss = wd.boss;
  wd.rovers.forEach(function (r) { if (r !== p) counts[r.role] = (counts[r.role] || 0) + 1; });
  var bar = q('[data-ebar]'); bar.firstChild.style.width = Math.max(0, Math.min(100, p.e / RULES.maxEnergy * 100)) + '%'; bar.classList.toggle('low', p.e < 15);
  q('[data-e]').textContent = fmt(Math.max(0, p.e)) + ' / ' + RULES.maxEnergy;
  q('[data-bossrow]').hidden = boss.found < 0;
  if (boss.found >= 0) { q('[data-cbar]').firstChild.style.width = Math.min(100, boss.charge / boss.capacity * 100) + '%'; q('[data-c]').textContent = fmt(boss.charge) + ' / ' + fmt(boss.capacity); }
  q('[data-meta]').textContent = 'Turn ' + fmt(wd.gen) + ' · view ' + Math.round(wd.fov(p)) + '° · mapped ' + pct(wd.stats.mappedByYou / (wd.W * wd.H)) + ' · score ' + fmt(wd.score());
  var kids = wd.rovers.length - 1;
  q('[data-colony]').innerHTML = kids ? ROLES.filter(function (r) { return counts[r.id]; }).map(function (r) { return '<span><i style="background:' + r.color + '"></i>' + counts[r.id] + ' ' + r.name.toLowerCase() + (counts[r.id] > 1 ? 's' : '') + '</span>'; }).join('') + '<span>' + wd.farmsNow + ' farming now</span>' : '<span>No children yet</span>';
  while (state.goal < GOALS.length && GOALS[state.goal].done(wd)) { if (!force) toast('Goal done: ' + GOALS[state.goal].text); state.goal++; }
  q('[data-goal]').innerHTML = state.goal < GOALS.length ? '<em>Goal ' + (state.goal + 1) + ' of ' + GOALS.length + ':</em> ' + esc(GOALS[state.goal].text) : '<em>All goals done.</em>';
  q('[data-act="build"]').disabled = !(p.e >= RULES.buildMin && kids < RULES.maxChildren && !wd.over);
  q('[data-act="charge"]').classList.toggle('hot', wd.nextToCore(p));
  var sel = q('[data-sel]'), r = state.selected;
  if (r && wd.rovers.indexOf(r) < 0) { r = state.selected = null; }
  if (!r) sel.hidden = true;
  else if (r === p) { sel.hidden = false; sel.removeAttribute('data-key'); sel.innerHTML = '<div><b>You</b> · energy ' + fmt(r.e) + ' · ' + r.meals + ' meals</div><div>Click the map to walk there, or use the arrow keys.</div>'; }
  else {
    sel.hidden = false;
    var key = r.role + '|' + (r.target ? 1 : 0) + '|' + (r.charging ? 1 : 0);
    if (force || sel.getAttribute('data-key') !== key || sel.getAttribute('data-id') !== String(r.id)) {
      sel.setAttribute('data-key', key); sel.setAttribute('data-id', String(r.id));
      sel.innerHTML = r.role === 'sensor'
        ? '<div><b>Sensor</b> · watching all the way round, ' + RULES.range + ' squares out. It can’t move or change role, and it adds ' + RULES.sensorPower + ' a turn to your upkeep.</div><div class="rg-row"><button type="button" class="rg-btn" data-act="deselect">Done<kbd>Esc</kbd></button></div>'
        : '<div><b>' + ROLE[r.role].name + '</b> · <span data-sel-e></span></div>' +
          '<div class="rg-row" role="group" aria-label="Change role">' + ROLES.filter(function (ro) { return ro.id !== 'sensor'; }).map(function (ro) { return '<button type="button" class="rg-chip" data-setrole="' + ro.id + '" aria-pressed="' + (ro.id === r.role) + '"><i style="background:' + ro.color + '"></i>' + ro.name + '</button>'; }).join('') + '</div>' +
          '<div>' + (r.charging ? 'Charging the Warden. ' : r.target ? 'On its way. ' : '') + 'Click the map to send it somewhere' + (r.role === 'sentry' ? ' (that becomes its post)' : '') + '. Send it to the Warden to charge it.</div>' +
          '<div class="rg-row">' + (r.target || r.charging ? '<button type="button" class="rg-btn" data-act="cancel">Cancel order</button>' : '') + '<button type="button" class="rg-btn" data-act="deselect">Done<kbd>Esc</kbd></button></div>';
    }
    var se = q('[data-sel-e]'); if (se) se.textContent = 'energy ' + fmt(r.e) + ' · ' + r.meals + ' meals';
  }
  var n; while ((n = wd.notices.shift())) toast(n);
  if (wd.over && !state.overShown) gameOver();
}

function gameOver() {
  var wd = state.world, score = wd.score(), best = store('rover-colony-best') || {};
  state.overShown = true; state.walking = false; state.held = {};
  var line;
  if (wd.won) {
    var prev = best.fastestWin;
    if (!prev || wd.gen < prev) best.fastestWin = wd.gen;
    q('[data-overh]').textContent = 'The Warden broke apart';
    line = 'You overcharged its core on turn <strong>' + fmt(wd.gen) + '</strong>' + (prev && prev <= wd.gen ? ' (your fastest is ' + fmt(prev) + ')' : ', your fastest yet') + '. ';
  } else {
    q('[data-overh]').textContent = 'Your rover shut down';
    line = 'It ran out of energy on turn <strong>' + fmt(wd.gen) + '</strong>' + (wd.boss.found >= 0 ? ', with the Warden’s core at ' + pct(wd.boss.charge / wd.boss.capacity) + '. ' : ', before you found the Warden. ');
  }
  if (score > (best.score || 0)) best.score = score;
  store('rover-colony-best', best);
  q('[data-over]').innerHTML = line + 'Your colony ate <strong>' + fmt(score) + '</strong> cells, you mapped ' + pct(wd.stats.mappedByYou / (wd.W * wd.H)) + ' of the world, and you built ' +
    wd.stats.built + (wd.stats.built === 1 ? ' child' : ' children') + ' (' + wd.stats.deaths + ' shut down).';
  // let the break-up play for a moment before the card covers it
  setTimeout(function () { if (state && state.overShown) showCard('over', true); }, wd.won && !REDUCED ? 1600 : 0);
}

/* ---------- loop ---------- */
// Held keys, and walking to a clicked spot, play turns on a timer, so the pace doesn't depend on the frame rate.
function pump() {
  if (!state) return;
  var t = performance.now();
  if (!blocked() && !state.world.over && t >= state.repeatAt) {
    var d = heldDir();
    if (d[0] || d[1]) { turn('move', d[0], d[1]); state.repeatAt = t + REPEAT_MS; }
    else if (state.held.Space) { turn('wait'); state.repeatAt = t + REPEAT_MS; }
    else if (state.held.KeyC) { if (turn('charge')) state.repeatAt = t + REPEAT_MS; else state.held.KeyC = false; }
    else if (state.walking) { if (!state.world.player.target) state.walking = false; else { turn('wait'); state.repeatAt = t + REPEAT_MS; } }
  }
}
function frame() {
  if (!state) return;
  state.raf = requestAnimationFrame(frame);
  draw();
}

/* ---------- input ---------- */
function onKey(ev) {
  if (!state) return;
  var helpOpen = !q('[data-card="help"]').hidden, overOpen = !q('[data-card="over"]').hidden;
  if (ev.type === 'keyup') { state.held[ev.code] = false; return; }
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName) && ev.target.type !== 'checkbox') return;
  if (ev.code === 'Escape') { ev.preventDefault();
    if (helpOpen && state.world.gen > 0) showCard('help', false);
    else if (helpOpen) exit();
    else if (state.map.open) toggleMap(false);
    else if (state.selected) { state.selected = null; updateHud(true); }
    else if (!overOpen) exit();
    return; }
  if (helpOpen || overOpen) return;
  if (ev.code === 'KeyM') { ev.preventDefault(); toggleMap(); return; }
  if (state.map.open && (ev.key === '+' || ev.key === '=')) { zoomMap(1); return; }
  if (state.map.open && (ev.key === '-' || ev.key === '_')) { zoomMap(-1); return; }
  if (DIRS[ev.code] || ev.code === 'Space' || ev.code === 'KeyC') {
    ev.preventDefault();
    if (ev.repeat) return;                       // our own timer paces repeats
    state.walking = false; state.world.player.target = null; state.held[ev.code] = true;
    var d = heldDir();
    if (d[0] || d[1]) turn('move', d[0], d[1]); else if (ev.code === 'Space') turn('wait'); else if (ev.code === 'KeyC' && !turn('charge')) state.held.KeyC = false;
    state.repeatAt = performance.now() + FIRST_REPEAT_MS; return;
  }
  if (ev.code === 'KeyB') { ev.preventDefault(); doBuild(); return; }
  var ro = ROLES.filter(function (r) { return r.key === ev.key; })[0];
  if (ro) { ev.preventDefault();
    if (state.selected && state.selected !== state.world.player) { if (!state.world.setRole(state.selected, ro.id)) toast('Sensors are fixed, and other rovers can’t become one.'); updateHud(true); }
    else setRole(ro.id); }
}

function doBuild() {
  var res = state.world.build(state.role);
  if (typeof res === 'string') toast(res); else toast('Built a ' + ROLE[res.role].name.toLowerCase() + '.');
  state.map.dirty = true; updateHud(true);
}

function command(x, y) {
  var st = state, wd = st.world;
  if (st.selected && st.selected !== wd.player) {
    if (!wd.send(st.selected, x, y)) { toast('Sensors stay where they’re built.'); return; }
    var who = 'the ' + ROLE[st.selected.role].name.toLowerCase();
    if (!wd.reachable(st.selected, x, y)) toast('There’s no way there from where ' + who + ' is.');
    else toast(wd.isHull(x, y) ? 'Sent ' + who + ' to charge the Warden’s core.' : 'Sent ' + who + ' there.');
    updateHud(true);
  } else { wd.player.target = [x, y]; wd.player.stuck = 0; st.walking = true; st.repeatAt = 0; }
}

function onPointer(ev) {
  ev.stopPropagation();
  if (ev.button > 0 || blocked()) return;
  var st = state, wd = st.world;
  if (ev.target.hasAttribute && ev.target.hasAttribute('data-mapcanvas')) {
    var r0 = ev.target.getBoundingClientRect(), z = st.map.zoom;
    command(Math.floor((ev.clientX - r0.left) / z), Math.floor((ev.clientY - r0.top) / z)); return;
  }
  if (!ev.target.classList || !ev.target.classList.contains('rg-board')) return;
  var left = st.cam[0] + 0.5 - st.w / st.s / 2, top = st.cam[1] + 0.5 - st.h / st.s / 2;
  var x = ((Math.floor(left + ev.clientX / st.s) % wd.W) + wd.W) % wd.W, y = ((Math.floor(top + ev.clientY / st.s) % wd.H) + wd.H) % wd.H;
  // a click has to land on a rover to select it; a tap may be a square off, since fingers are wide
  var hit = null, bestD = ev.pointerType === 'touch' ? 2 : 1;
  wd.rovers.forEach(function (r) { var d = Math.max(Math.abs(wd.wrapD(r.x - x, wd.W)), Math.abs(wd.wrapD(r.y - y, wd.H))); if (d < bestD) { bestD = d; hit = r; } });
  if (hit) { st.selected = hit === st.selected ? null : hit; st.walking = false; updateHud(true); return; }
  command(x, y);
}

function onClick(ev) {
  var b = ev.target.closest('button'); if (!b || !state) return;
  var act = b.getAttribute('data-act'), role = b.getAttribute('data-role'), setr = b.getAttribute('data-setrole');
  if (role) { setRole(role); return; }
  if (setr) { state.world.setRole(state.selected, setr); updateHud(true); return; }
  if (act === 'start') { showCard('help', false); root.focus(); }
  else if (act === 'help') { showCard('help', true); q('[data-act="start"]').textContent = state.world.gen ? 'Back to the game' : 'Start'; }
  else if (act === 'wait') turn('wait');
  else if (act === 'charge') turn('charge');
  else if (act === 'map') toggleMap();
  else if (act === 'zoomin') zoomMap(1);
  else if (act === 'zoomout') zoomMap(-1);
  else if (act === 'build') doBuild();
  else if (act === 'cancel' && state.selected) { state.selected.target = null; state.selected.charging = false; updateHud(true); }
  else if (act === 'deselect') { state.selected = null; updateHud(true); }
  else if (act === 'again') { showCard('over', false); toggleMap(false); cancelAnimationFrame(state.raf); newGame(); state.raf = requestAnimationFrame(frame); root.focus(); }
  else if (act === 'exit') exit();
}
function onChange(ev) { if (ev.target.hasAttribute('data-mapall')) { state.map.all = ev.target.checked; state.map.dirty = true; drawMap(); } }
function onWheel(ev) { if ((ev.ctrlKey || ev.metaKey) && ev.target.closest('.rg-map-scroll')) { ev.preventDefault(); zoomMap(ev.deltaY < 0 ? 1 : -1); } }

var resizeT = 0;
function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () {
  if (!state) return;
  if (state.world.gen === 0) { cancelAnimationFrame(state.raf); newGame(); state.raf = requestAnimationFrame(frame); return; }
  // keep the game, resize the view
  var w = window.innerWidth, h = window.innerHeight, s = state.s, board = q('canvas.rg-board');
  state.w = w; state.h = h; state.vw = Math.ceil(w / s) + 2; state.vh = Math.ceil(h / s) + 2;
  board.width = Math.round(w * state.dpr); board.height = Math.round(h * state.dpr); board.style.width = w + 'px'; board.style.height = h + 'px';
  state.off.width = state.vw; state.off.height = state.vh; state.img = state.offCtx.createImageData(state.vw, state.vh); state.px = new Uint32Array(state.img.data.buffer);
}, 200); }
function onBlur() { if (state) state.held = {}; }

function exit() { if (opts.onExit) opts.onExit(); else close(); }

function open(options) {
  if (root) return;
  opts = options || {};
  lastFocus = document.activeElement;
  build(); newGame();
  document.documentElement.style.overflow = 'hidden';
  root.addEventListener('pointerdown', onPointer);
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKey);
  window.addEventListener('resize', onResize); window.addEventListener('blur', onBlur);
  if (opts.suspendBackground) opts.suspendBackground(true);
  document.title = 'Rover Colony';
  showCard('help', true);
  state.raf = requestAnimationFrame(frame);
  pumpTimer = setInterval(pump, 20);
}
function close() {
  if (!root) return;
  clearInterval(pumpTimer);
  if (state) { cancelAnimationFrame(state.raf); var best = store('rover-colony-best') || {}; if (state.world.score() > (best.score || 0)) { best.score = state.world.score(); store('rover-colony-best', best); } }
  document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKey);
  window.removeEventListener('resize', onResize); window.removeEventListener('blur', onBlur);
  root.remove(); root = null; state = null;
  document.documentElement.style.overflow = '';
  if (opts.suspendBackground) opts.suspendBackground(false);
  if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
}

// world() returns the running game, for experimenting from the browser console (for example RoverGame.world().player.e = 150)
window.RoverGame = { open: open, close: close, isOpen: function () { return !!root; }, world: function () { return state && state.world; }, World: World, RULES: RULES, ROLES: ROLES, SHIPS: SHIPS, parseRule: parseRule };
})();
