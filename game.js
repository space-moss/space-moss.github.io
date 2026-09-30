/* Rover Colony: a game built on the notebook's farm simulation (LIDAR, parts 1.5 to 1.7).
   You drive the first rover. Build children, give them roles, and keep the colony fed.

   Rules are the notebook's, with a few game changes (all in RULES below):
   - Rovers aren't live cells: Life never sees them. Each generation a rover moves or stays, then eats the cell
     it's standing on if that cell is alive. No two rovers can ever share a square.
   - Moving costs energy, eating earns it, and every rover pays a little upkeep each generation. A rover that
     runs out of energy shuts down for good; when yours does, the game is over.
   - You build children instead of splitting automatically. Children send you part of each meal while they're
     comfortably fed.
   - LIDAR is a cone that widens with energy. You only see what your LIDAR and your scouts see.

   Exposes window.RoverGame = { open(options), close(), isOpen() }. */
(function () {
'use strict';

var RULES = {
  moveCost: 1, meal: 10, upkeep: 0.06, childUpkeep: 0.05,
  startEnergy: 60, maxEnergy: 150, childMax: 100,
  buildCost: 40, buildMin: 50, childStart: 20, maxChildren: 24,
  tithe: 0.3, titheAbove: 40,
  fovMin: 90, fovMax: 360, fovFull: 100, range: 20,
  soup: 0.16, gliderEvery: 24, gliderFloor: 6, memory: 400
};
var ROLES = [
  { id: 'farmer', name: 'Farmer', color: '#74a3e3', key: '1', text: 'Looks five generations ahead to find squares where food keeps being born, and parks there. Walks to farm sites your scouts report.' },
  { id: 'scout', name: 'Scout', color: '#e6b85c', key: '2', text: 'Sees all the way round, whatever its energy. Explores, reports blocks as farm sites, and lets you see what it sees.' },
  { id: 'grazer', name: 'Grazer', color: '#e0685f', key: '3', text: 'Eats anything it can reach. Quick energy, but it wrecks structures, so keep it away from farms.' },
  { id: 'sentry', name: 'Sentry', color: '#c58fd6', key: '4', text: 'Guards a post and eats whatever comes next to it, like a glider heading for your farm. Send it somewhere to move its post.' }
];
var ROLE = {}; ROLES.forEach(function (r) { ROLE[r.id] = r; });
var GOALS = [
  { text: 'Eat 5 cells', done: function (g) { return g.stats.playerMeals >= 5; } },
  { text: 'Build a child (press B)', done: function (g) { return g.stats.built >= 1; } },
  { text: 'Have a scout find a farm site', done: function (g) { return g.stats.sitesFound >= 1; } },
  { text: 'Get a farmer harvesting', done: function (g) { return g.stats.farmerHarvests >= 10; } },
  { text: 'Grow the colony to 8 rovers', done: function (g) { return g.rovers.length >= 8; } },
  { text: 'Run 4 farms at once', done: function (g) { return g.farmsNow >= 4; } },
  { text: 'Reach generation 3,000', done: function (g) { return g.gen >= 3000; } }
];

function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function rule(alive, n) { return n === 3 || (alive && n === 2) ? 1 : 0; }

/* =====================================================================
   WORLD: Life plus rovers. Same order as the notebook: rovers move and eat one at a time, then Life steps.
   ===================================================================== */
function World(W, H, seed) {
  var self = this, N = W * H, P = RULES;
  var a = new Uint8Array(N), b = new Uint8Array(N);
  var occ = new Int32Array(N);            // rover id + 1 on its square, 0 when free
  var beacon = new Uint8Array(N);         // 1 where a rover harvested this generation
  var seenAt = new Int32Array(N), mem = new Uint8Array(N);
  var rng = mulberry32(seed), brain = mulberry32(seed ^ 0x9E3779B9);
  this.W = W; this.H = H; this.gen = 0; this.rovers = []; this.sites = new Map(); this.events = []; this.over = false;
  this.stats = { meals: 0, playerMeals: 0, built: 0, sitesFound: 0, farmerHarvests: 0, deaths: 0 };
  this.farmsNow = 0; this.notices = [];
  this.cells = function () { return a; }; this.seenAt = seenAt; this.mem = mem;
  function idx(x, y) { x %= W; if (x < 0) x += W; y %= H; if (y < 0) y += H; return y * W + x; }
  function wrapD(d, M) { d %= M; if (d > M / 2) d -= M; else if (d < -M / 2) d += M; return d; }
  this.idx = idx; this.wrapD = wrapD;
  this.roverAt = function (x, y) { var id = occ[idx(x, y)] - 1; return id >= 0 ? self.byId(id) : null; };
  this.byId = function (id) { for (var i = 0; i < self.rovers.length; i++) if (self.rovers[i].id === id) return self.rovers[i]; return null; };
  function notice(text) { self.notices.push(text); }

  // the world: a soup that decays into ash (blocks, blinkers, beehives...) and gliders that keep arriving
  for (var i = 0; i < N; i++) a[i] = rng() < P.soup ? 1 : 0;
  seenAt.fill(-1e9);
  var GL = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
  function spawnGlider() { var x = (rng() * W) | 0, y = (rng() * H) | 0, fx = rng() < 0.5, fy = rng() < 0.5;
    GL.forEach(function (c) { a[idx(x + (fx ? 2 - c[0] : c[0]), y + (fy ? 2 - c[1] : c[1]))] = 1; }); }

  var nextId = 0;
  function addRover(role, x, y, e, face) {
    var r = { id: nextId++, role: role, x: x, y: y, e: e, face: face || 0, target: null, home: role === 'sentry' ? [x, y] : null,
              goal: null, stuck: 0, plan: null, meals: 0, born: self.gen, ranges: null };
    occ[idx(x, y)] = r.id + 1; self.rovers.push(r); return r;
  }
  // clear a little room for the player to start in
  var cx = W >> 1, cy = H >> 1;
  for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) a[idx(cx + dx, cy + dy)] = 0;
  this.player = addRover('player', cx, cy, P.startEnergy, 0);

  /* ---------- LIDAR ---------- */
  var RB = 6, BW = 13, belief = new Int8Array(BW * BW);
  function bel(dx, dy) { return (Math.abs(dx) > RB || Math.abs(dy) > RB) ? -1 : belief[(dy + RB) * BW + dx + RB]; }
  var RAYCELLS = [], RC = new Float32Array(72), RS = new Float32Array(72);
  for (var rk = 0; rk < 72; rk++) { var th0 = rk / 72 * Math.PI * 2, c0 = Math.cos(th0), s0 = Math.sin(th0), seq = [], plx = 0, ply = 0;
    RC[rk] = c0; RS[rk] = s0;
    for (var t0 = 0.5; t0 <= P.range; t0 += 0.35) { var qx = Math.round(c0 * t0), qy = Math.round(s0 * t0); if (qx === plx && qy === ply) continue; plx = qx; ply = qy; seq.push(qx, qy, t0); }
    RAYCELLS.push(seq); }
  this.fov = function (r) { if (r.role === 'scout') return 360; var full = r.role === 'player' ? P.fovFull : P.childMax;
    return P.fovMin + (P.fovMax - P.fovMin) * Math.min(1, Math.max(0, r.e) / full); };
  function see(ci) { seenAt[ci] = self.gen; mem[ci] = a[ci]; }
  /* Scan for one rover. `eyes` rovers (you and your scouts) also light up the map for the player. */
  function scan(r, eyes) {
    belief.fill(-1); var nearest = null, rx = r.x, ry = r.y;
    for (var j = -1; j <= 1; j++) for (var i = -1; i <= 1; i++) { var ni = idx(rx + i, ry + j);
      belief[(j + RB) * BW + i + RB] = (i || j) && occ[ni] ? 2 : a[ni]; if (eyes) see(ni); }
    var half = self.fov(r) * Math.PI / 360, full = half >= Math.PI - 1e-6, ch = Math.cos(half), fc = Math.cos(r.face), fs = Math.sin(r.face);
    if (r.role === 'player') r.ranges = r.ranges || new Float32Array(72);
    for (var k = 0; k < 72; k++) {
      if (!full && RC[k] * fc + RS[k] * fs < ch - 1e-6) { if (r.ranges) r.ranges[k] = 0; continue; }
      var sq = RAYCELLS[k], hit = P.range;
      for (var q = 0; q < sq.length; q += 3) { var cx2 = sq[q], cy2 = sq[q + 1], X = rx + cx2, Y = ry + cy2;
        if (X < 0) X += W; else if (X >= W) X -= W; if (Y < 0) Y += H; else if (Y >= H) Y -= H;
        var ci = Y * W + X, v = occ[ci] ? 2 : a[ci];
        if (eyes) see(ci);
        if (cx2 <= RB && cx2 >= -RB && cy2 <= RB && cy2 >= -RB) { var bi = (cy2 + RB) * BW + cx2 + RB; if (belief[bi] < v) belief[bi] = v; }
        if (v) { hit = sq[q + 2]; if (v === 1) { if (!nearest || hit < nearest.t) nearest = { dx: cx2, dy: cy2, t: hit }; if (r.role === 'scout') checkSite(X, Y); } break; } }
      if (r.ranges) r.ranges[k] = hit; }
    return nearest;
  }

  /* ---------- farm sites: blocks the scouts have reported ---------- */
  function isBlock(x, y) {   // (x, y) is the top-left of a 2x2 of live cells with nothing alive around it
    for (var j = 0; j < 2; j++) for (var i = 0; i < 2; i++) if (!a[idx(x + i, y + j)] && !occ[idx(x + i, y + j)]) return false;
    for (j = -1; j <= 2; j++) for (i = -1; i <= 2; i++) { if (i >= 0 && i <= 1 && j >= 0 && j <= 1) continue; if (a[idx(x + i, y + j)]) return false; }
    return true;
  }
  function checkSite(X, Y) {
    for (var j = 0; j < 2; j++) for (var i = 0; i < 2; i++) { var x = X - i, y = Y - j, k = idx(x, y);
      if (!self.sites.has(k) && isBlock(x, y)) { self.sites.set(k, { k: k, x: k % W, y: (k / W) | 0, claim: -1, found: self.gen });
        self.stats.sitesFound++; notice('A scout found a farm site: a block.'); } }
  }
  function refreshSites() {
    self.sites.forEach(function (s, k) {
      var ok = true;   // a farmed block has its corner eaten and reborn every generation, so check after Life steps
      for (var j = 0; j < 2 && ok; j++) for (var i = 0; i < 2 && ok; i++) { var ci = idx(s.x + i, s.y + j); if (!a[ci] && !occ[ci]) ok = false; }
      if (!ok) { var c = self.byId(s.claim); if (c) c.goal = null; self.sites.delete(k); }
      else if (s.claim >= 0 && !self.byId(s.claim)) s.claim = -1;
    });
  }

  /* ---------- the farmer's planner, as in the notebook (part 1.7) ---------- */
  var PH = 5, GAMMA = 0.9, SITE = 2, FW = BW + 2, FN = FW * FW, FC = (RB + 1) * FW + RB + 1;
  var G = [], NB = [], PICK = [], VA = new Float32Array(FN), VB = new Float32Array(FN), BASE = new Uint8Array(FN), BLOCK = new Uint8Array(FN), ROV = [];
  for (var h0 = 0; h0 <= PH; h0++) { G.push(new Uint8Array(FN)); NB.push(new Uint8Array(FN)); PICK.push(new Int8Array(FN)); }
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
      for (y = -t; y <= t; y++) for (x = -t; x <= t; x++) { kk = FC + y * FW + x; var best = -1e9, pick = 4;
        for (m = 0; m < 9; m++) { k2 = kk + (((m / 3) | 0) - 1) * FW + m % 3 - 1; if (BLOCK[k2]) continue;
          v = (m !== 4 ? (G[t + 1][k2] ? R : 0) - cost : (NB[t][k2] === 3 ? R : 0)) + GAMMA * Vn[k2];
          if (v > best) { best = v; pick = m; } }
        Vc[kk] = best; PICK[t][kk] = pick; }
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
  function toward(r, tx, ty) {           // one step toward (tx, ty) on the wrapping grid, going round rovers
    var dx = Math.sign(wrapD(tx - r.x, W)), dy = Math.sign(wrapD(ty - r.y, H));
    if (!dx && !dy) return null;
    var tries = [[dx, dy], [dx, 0], [0, dy], [dx || (brain() < 0.5 ? 1 : -1), dy ? 0 : (brain() < 0.5 ? 1 : -1)]];
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

  this.input = { dx: 0, dy: 0 };
  function decide(r, nearest) {
    var e = r.e, under = bel(0, 0) === 1, d;
    if (r.role === 'player') {
      var inp = self.input;
      if (inp.dx || inp.dy) { r.target = null; return canMove(r, inp.dx, inp.dy) ? [inp.dx, inp.dy] : [0, 0]; }
      if (r.target) { d = toward(r, r.target[0], r.target[1]); if (!d) { r.target = null; return [0, 0]; } return d; }
      return [0, 0];
    }
    // an order from the player comes first
    if (r.target) {
      d = toward(r, r.target[0], r.target[1]);
      if (!d) { if (r.role === 'sentry') r.home = r.target; r.target = null; }
      else if (d[0] || d[1]) { r.stuck = 0; return d; }
      else if (++r.stuck > 20) { r.target = null; r.stuck = 0; }
      else return d;
    }
    if (r.role === 'sentry') {
      if (under) return [0, 0];
      var f = adjacentFood(r, true); if (f) return f;
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
    if (r.goal == null) {                         // claim the nearest free site the scouts have found
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

  /* ---------- one generation ---------- */
  this.step = function () {
    if (self.over) return;
    var rs = self.rovers, player = self.player, order = [player];
    var kids = rs.filter(function (r) { return r !== player; });
    for (var z = kids.length - 1; z > 0; z--) { var w = (brain() * (z + 1)) | 0, t = kids[z]; kids[z] = kids[w]; kids[w] = t; }
    order = order.concat(kids);
    var dead = [];
    self.farmsNow = 0;
    for (var oi = 0; oi < order.length; oi++) {
      var r = order[oi], eyes = r.role === 'player' || r.role === 'scout';
      var nearest = scan(r, eyes), m = decide(r, nearest), moved = !!(m[0] || m[1]);
      beacon[idx(r.x, r.y)] = 0;                  // a beacon stays on until its rover's next turn
      if (moved) {
        var ti = idx(r.x + m[0], r.y + m[1]);
        if (occ[ti]) moved = false;               // never two rovers on one square
        else { occ[idx(r.x, r.y)] = 0; r.x = ti % W; r.y = (ti / W) | 0; occ[ti] = r.id + 1; r.e -= P.moveCost; r.face = Math.atan2(m[1], m[0]); }
      }
      var ci = idx(r.x, r.y);
      if (a[ci]) {
        a[ci] = 0; r.e += P.meal; r.meals++; self.stats.meals++;
        if (r === player) self.stats.playerMeals++;
        if (!moved) { beacon[ci] = 1; if (r.role === 'farmer') { self.stats.farmerHarvests++; self.farmsNow++; } }
        if (r !== player && r.e > P.titheAbove && !self.over) {   // children share their meals with you
          var give = P.meal * P.tithe; r.e -= give; player.e = Math.min(P.maxEnergy, player.e + give);
        }
        self.events.push({ x: r.x, y: r.y, t: performance.now(), kind: moved ? 'graze' : 'harvest' });
      } else if (!moved && r.role !== 'player') r.face += Math.PI / 4;   // idle: sweep the cone round
      r.e = Math.min(r === player ? P.maxEnergy : P.childMax, r.e) - (r === player ? P.upkeep : P.childUpkeep);
      if (r.e <= 0) dead.push(r);
    }
    dead.forEach(function (r) {
      if (r === player) { r.e = 0; self.over = true; return; }
      occ[idx(r.x, r.y)] = 0; beacon[idx(r.x, r.y)] = 0; self.rovers.splice(self.rovers.indexOf(r), 1); self.stats.deaths++;
      var s = r.goal != null && self.sites.get(r.goal); if (s && s.claim === r.id) s.claim = -1;
      self.events.push({ x: r.x, y: r.y, t: performance.now(), kind: 'death' });
      notice('A ' + ROLE[r.role].name.toLowerCase() + ' ran out of energy.');
    });
    // Life steps; rovers are invisible to it
    for (var y = 0; y < H; y++) { var up = ((y + H - 1) % H) * W, md = y * W, dn = ((y + 1) % H) * W;
      for (var x = 0; x < W; x++) { var l = x === 0 ? W - 1 : x - 1, rr = x === W - 1 ? 0 : x + 1;
        var n = a[up + l] + a[up + x] + a[up + rr] + a[md + l] + a[md + rr] + a[dn + l] + a[dn + x] + a[dn + rr];
        b[md + x] = (n === 3 || (n === 2 && a[md + x] === 1)) ? 1 : 0; } }
    var tt = a; a = b; b = tt;
    self.gen++;
    var every = Math.max(P.gliderFloor, P.gliderEvery - 2 * Math.floor(self.gen / 250));   // the rain gets heavier
    if (self.gen % every === 0) spawnGlider();
    refreshSites();
    if (self.events.length > 200) self.events.splice(0, self.events.length - 200);
  };

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
    return c;
  };
  this.setRole = function (r, role) {
    if (!r || r === self.player || r.role === role) return;
    var s = r.goal != null && self.sites.get(r.goal); if (s && s.claim === r.id) s.claim = -1;
    r.role = role; r.goal = null; r.home = role === 'sentry' ? [r.x, r.y] : null;
  };
  this.send = function (r, x, y) { if (r) { r.target = [((x % W) + W) % W, ((y % H) + H) % H]; r.stuck = 0; } };
  this.score = function () { return self.stats.meals; };
}

/* =====================================================================
   GAME: overlay, drawing, input, HUD
   ===================================================================== */
var root = null, state = null, opts = {}, lastFocus = null;
var REDUCED = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
var SPEEDS = [6, 12, 24];

var CSS = '' +
'.rg-root{position:fixed;inset:0;z-index:50;background:#161615;color:#f0eee6;font-family:"Hanken Grotesk","Segoe UI",system-ui,sans-serif;overflow:hidden;touch-action:none;-webkit-user-select:none;user-select:none}' +
'.rg-root canvas.rg-board{position:absolute;inset:0;image-rendering:pixelated;cursor:crosshair}' +
'.rg-panel{background:rgba(31,31,29,.86);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);border:1px solid #3f3e39;border-radius:12px;padding:.6rem .8rem}' +
'.rg-top{position:absolute;top:max(.6rem,env(safe-area-inset-top));left:.6rem;right:.6rem;display:flex;justify-content:space-between;align-items:flex-start;gap:.6rem;pointer-events:none}' +
'.rg-top>*{pointer-events:auto}' +
'.rg-status{display:grid;gap:.3rem;font-size:.85rem;min-width:15rem;max-width:22rem}' +
'.rg-energy{display:flex;align-items:center;gap:.5rem}.rg-energy span{color:#b1afa4}' +
'.rg-bar{flex:1;height:.5rem;background:#34342f;border-radius:999px;overflow:hidden}.rg-bar i{display:block;height:100%;background:#f7f5ee;border-radius:999px;transition:width .2s}' +
'.rg-bar.low i{background:#e0685f}' +
'.rg-energy b{font-variant-numeric:tabular-nums;min-width:2.2rem;text-align:right;font-weight:500}' +
'.rg-meta,.rg-colony{color:#b1afa4;font-variant-numeric:tabular-nums}' +
'.rg-colony{display:flex;flex-wrap:wrap;gap:.2rem .8rem}.rg-colony i,.rg-chip i{display:inline-block;width:.6rem;height:.6rem;border-radius:2px;margin-right:.3rem;vertical-align:-.02rem}' +
'.rg-goal{color:#f0eee6}.rg-goal em{font-style:normal;color:#85837a}' +
'.rg-ctrls{display:flex;gap:.35rem;flex-wrap:wrap;justify-content:flex-end}' +
'.rg-btn{font:500 .85rem/1 "Hanken Grotesk",system-ui,sans-serif;color:#f0eee6;background:rgba(38,38,36,.9);border:1px solid #57554d;border-radius:999px;padding:.5rem .8rem;cursor:pointer;white-space:nowrap}' +
'.rg-btn:hover{background:#34342f}.rg-btn:focus-visible{outline:2px solid #9cbdf0;outline-offset:2px}' +
'.rg-btn.primary{background:#f0eee6;color:#1f1e1c;border-color:#f0eee6}.rg-btn.primary:hover{background:#fff}' +
'.rg-btn[disabled]{opacity:.45;cursor:not-allowed}' +
'.rg-bottom{position:absolute;left:.6rem;right:.6rem;bottom:max(.6rem,env(safe-area-inset-bottom));display:flex;flex-wrap:wrap;gap:.6rem;align-items:flex-end;justify-content:space-between;pointer-events:none}' +
'.rg-bottom>*{pointer-events:auto}' +
'.rg-build{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem}' +
'.rg-chip{font:500 .82rem/1 "Hanken Grotesk",system-ui,sans-serif;color:#b1afa4;background:none;border:1px solid #3f3e39;border-radius:999px;padding:.45rem .7rem;cursor:pointer}' +
'.rg-chip[aria-pressed="true"]{color:#f0eee6;border-color:#f0eee6;background:#34342f}' +
'.rg-chip kbd,.rg-btn kbd{font:inherit;color:#85837a;margin-left:.3rem}' +
'.rg-sel{font-size:.85rem;color:#b1afa4;display:grid;gap:.45rem;max-width:26rem}.rg-sel b{color:#f0eee6;font-weight:500}' +
'.rg-sel .rg-row{display:flex;flex-wrap:wrap;gap:.35rem;align-items:center}' +
'.rg-card{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(22,22,21,.72)}' +
'.rg-card[hidden]{display:none}' +
'.rg-dialog{max-width:34rem;max-height:100%;overflow:auto;background:#2d2d2a;border:1px solid #3f3e39;border-radius:16px;padding:1.4rem 1.5rem;font-size:.93rem;line-height:1.55;color:#b1afa4}' +
'.rg-dialog h2{font-family:"Source Serif 4",Georgia,serif;font-weight:500;font-size:1.8rem;line-height:1.1;margin:0 0 .6rem;color:#f0eee6}' +
'.rg-dialog h3{font-size:.9rem;color:#f0eee6;margin:1rem 0 .3rem}.rg-dialog p{margin:0 0 .7rem}.rg-dialog ul{margin:0 0 .7rem;padding-left:1.1rem}.rg-dialog li{margin:.2rem 0}' +
'.rg-dialog strong{color:#f0eee6;font-weight:500}.rg-dialog .rg-row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:1rem}' +
'.rg-roles{list-style:none;padding:0!important}.rg-roles li{display:flex;gap:.5rem}.rg-roles i{flex:none;width:.7rem;height:.7rem;border-radius:2px;margin-top:.4rem}' +
'.rg-toast{position:absolute;left:50%;top:5.5rem;transform:translateX(-50%);background:#f0eee6;color:#1f1e1c;font-weight:500;font-size:.88rem;padding:.55rem 1rem;border-radius:999px;opacity:0;transition:opacity .25s;pointer-events:none;max-width:calc(100% - 2rem);text-align:center}' +
'.rg-toast.show{opacity:1}' +
'.rg-keys{color:#85837a}' +
'@media (max-width:700px){.rg-status{min-width:0;font-size:.8rem}.rg-keys,.rg-chip kbd,.rg-btn kbd{display:none}.rg-top{flex-direction:column}.rg-ctrls{justify-content:flex-start}.rg-toast{top:auto;bottom:9rem}}' +
'@media (max-height:520px){.rg-top{flex-direction:row}.rg-status{font-size:.74rem;gap:.1rem;min-width:0}.rg-colony,.rg-goal,.rg-keys{display:none}' +
'.rg-panel{padding:.35rem .5rem}.rg-btn{padding:.35rem .55rem;font-size:.75rem}.rg-chip{padding:.3rem .5rem;font-size:.74rem}.rg-ctrls{flex-direction:column}.rg-toast{top:auto;bottom:4.5rem}}' +
'@media (prefers-reduced-motion: reduce){.rg-bar i,.rg-toast{transition:none}}';

function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function fmt(n) { return Math.round(n).toLocaleString('en-GB'); }
function getBest() { try { return +localStorage.getItem('rover-colony-best') || 0; } catch (e) { return 0; } }
function setBest(v) { try { localStorage.setItem('rover-colony-best', String(v)); } catch (e) {} }

function build() {
  if (!document.getElementById('rg-style')) { var st = document.createElement('style'); st.id = 'rg-style'; st.textContent = CSS; document.head.appendChild(st); }
  root = document.createElement('div'); root.className = 'rg-root'; root.setAttribute('role', 'application'); root.setAttribute('aria-label', 'Rover Colony game');
  root.tabIndex = -1;
  var roleChips = ROLES.map(function (r) { return '<button type="button" class="rg-chip" data-role="' + r.id + '" aria-pressed="false"><i style="background:' + r.color + '"></i>' + r.name + '<kbd>' + r.key + '</kbd></button>'; }).join('');
  root.innerHTML =
    '<canvas class="rg-board" aria-hidden="true"></canvas>' +
    '<div class="rg-top">' +
      '<div class="rg-panel rg-status" aria-live="off">' +
        '<div class="rg-energy"><span>Energy</span><div class="rg-bar"><i></i></div><b data-e>0</b></div>' +
        '<div class="rg-meta" data-meta></div><div class="rg-colony" data-colony></div><div class="rg-goal" data-goal></div>' +
      '</div>' +
      '<div class="rg-panel rg-ctrls">' +
        '<button type="button" class="rg-btn" data-act="pause">Pause<kbd>Space</kbd></button>' +
        '<button type="button" class="rg-btn" data-act="speed">Speed 1×</button>' +
        '<button type="button" class="rg-btn" data-act="help">How to play</button>' +
        '<button type="button" class="rg-btn" data-act="exit">Exit</button>' +
      '</div>' +
    '</div>' +
    '<div class="rg-bottom">' +
      '<div class="rg-panel rg-build" role="group" aria-label="Build a child"><span class="rg-keys">Next child:</span>' + roleChips +
        '<button type="button" class="rg-btn primary" data-act="build">Build<kbd>B</kbd></button></div>' +
      '<div class="rg-panel rg-sel" data-sel hidden></div>' +
    '</div>' +
    '<div class="rg-toast" role="status" aria-live="polite"></div>' +
    '<div class="rg-card" data-card="help"><div class="rg-dialog" role="dialog" aria-modal="true" aria-labelledby="rg-help-h">' +
      '<h2 id="rg-help-h">Rover Colony</h2>' +
      '<p>You’re the white rover, alone in Conway’s Game of Life. Rovers aren’t live cells, so Life can’t see you: you eat the cell you’re standing on, and a cell that’s born under you while you sit still is a free meal. Parked on the corner of a <strong>block</strong>, you get one every generation.</p>' +
      '<h3>Controls</h3><ul>' +
        '<li><strong>Move:</strong> arrow keys or WASD, or click or tap the map to walk there.</li>' +
        '<li><strong>Build a child (B):</strong> costs 40 energy. Pick its role first (1 to 4).</li>' +
        '<li><strong>Command a child:</strong> click it to select it, change its role, then click the map to send it somewhere. Esc lets go.</li>' +
        '<li><strong>Space</strong> pauses. Your LIDAR sees further round the more energy you have, and you only see what you and your scouts can see.</li></ul>' +
      '<h3>Roles</h3><ul class="rg-roles">' + ROLES.map(function (r) { return '<li><i style="background:' + r.color + '"></i><span><strong>' + r.name + '.</strong> ' + esc(r.text) + '</span></li>'; }).join('') + '</ul>' +
      '<h3>The catch</h3><p>Moving costs 1 energy and every rover burns a little each generation. Children send you 30% of their meals while they have more than 40 energy. A rover that runs out shuts down, and when you do, it’s over. The glider rain gets heavier the longer you last.</p>' +
      '<div class="rg-row"><button type="button" class="rg-btn primary" data-act="start">Start</button><button type="button" class="rg-btn" data-act="exit">Back to the notebook</button></div>' +
    '</div></div>' +
    '<div class="rg-card" data-card="over" hidden><div class="rg-dialog" role="dialog" aria-modal="true" aria-labelledby="rg-over-h">' +
      '<h2 id="rg-over-h">Your rover shut down</h2><p data-over></p>' +
      '<div class="rg-row"><button type="button" class="rg-btn primary" data-act="again">Play again</button><button type="button" class="rg-btn" data-act="exit">Back to the notebook</button></div>' +
    '</div></div>';
  document.body.appendChild(root);
}

function q(sel) { return root.querySelector(sel); }

function newGame() {
  var board = q('canvas.rg-board'), w = window.innerWidth, h = window.innerHeight;
  var s = Math.max(6, Math.min(12, Math.round(Math.min(w, h) / 64)));
  var W = Math.ceil(w / s), H = Math.ceil(h / s), dpr = Math.min(2, window.devicePixelRatio || 1);
  board.width = W * s * dpr; board.height = H * s * dpr; board.style.width = W * s + 'px'; board.style.height = H * s + 'px';
  var off = document.createElement('canvas'); off.width = W; off.height = H;
  var offCtx = off.getContext('2d'), img = offCtx.createImageData(W, H);
  state = { world: new World(W, H, (Math.random() * 1e9) | 0), s: s, dpr: dpr, ctx: board.getContext('2d'), off: off, offCtx: offCtx, img: img,
            px: new Uint32Array(img.data.buffer), paused: true, speed: 0, acc: 0, last: 0, raf: 0, role: 'farmer', selected: null,
            goal: 0, held: {}, toastT: 0, overShown: false };
  setRole('farmer'); updateHud(true);
}

function setRole(role) {
  state.role = role;
  root.querySelectorAll('.rg-build [data-role]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-role') === role)); });
}

function toast(msg) {
  var t = q('.rg-toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(state.toastT); state.toastT = setTimeout(function () { t.classList.remove('show'); }, 2600);
}

function showCard(name, on) { var c = q('[data-card="' + name + '"]'); c.hidden = !on; if (on) { var b = c.querySelector('.rg-btn.primary'); if (b) b.focus(); } }
function setPaused(p) { state.paused = p; var b = q('[data-act="pause"]'); b.firstChild.nodeValue = p ? 'Play' : 'Pause'; }

/* ---------- drawing ---------- */
var LE = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;
function rgb(r, g, b) { return LE ? (255 << 24 | b << 16 | g << 8 | r) >>> 0 : (r << 24 | g << 16 | b << 8 | 255) >>> 0; }
var C_UNSEEN = rgb(20, 20, 19), C_GROUND = rgb(44, 44, 41), C_LIVE = rgb(111, 181, 125);
var C_MEM = [], C_MEMLIVE = [];
for (var mi = 0; mi < 16; mi++) { var f = 1 - mi / 16; C_MEM.push(rgb(Math.round(20 + 12 * f), Math.round(20 + 12 * f), Math.round(19 + 11 * f))); C_MEMLIVE.push(rgb(Math.round(20 + 40 * f), Math.round(20 + 70 * f), Math.round(19 + 45 * f))); }

function draw() {
  var st = state, wd = st.world, W = wd.W, H = wd.H, s = st.s, ctx = st.ctx, a = wd.cells(), seen = wd.seenAt, mem = wd.mem, gen = wd.gen, px = st.px, M = RULES.memory;
  for (var i = 0; i < W * H; i++) {
    var age = gen - seen[i];
    if (age <= 1) px[i] = a[i] ? C_LIVE : C_GROUND;
    else if (age < M) { var k = Math.min(15, (age * 16 / M) | 0); px[i] = mem[i] ? C_MEMLIVE[k] : C_MEM[k]; }
    else px[i] = C_UNSEEN;
  }
  st.offCtx.putImageData(st.img, 0, 0);
  ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0); ctx.imageSmoothingEnabled = false;
  ctx.drawImage(st.off, 0, 0, W * s, H * s);
  var p = wd.player;
  // your LIDAR
  if (p.ranges) { ctx.strokeStyle = 'rgba(116,163,227,0.10)'; ctx.lineWidth = 1; ctx.beginPath();
    var bx = (p.x + 0.5) * s, by = (p.y + 0.5) * s;
    for (var k2 = 0; k2 < 72; k2++) { var r = p.ranges[k2] * s; if (!r) continue; var th = k2 / 72 * Math.PI * 2; ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(th) * r, by + Math.sin(th) * r); }
    ctx.stroke(); }
  // farm sites the scouts found
  ctx.lineWidth = 1.5;
  wd.sites.forEach(function (site) { ctx.strokeStyle = site.claim >= 0 ? 'rgba(116,163,227,0.8)' : 'rgba(230,184,92,0.85)'; ctx.strokeRect(site.x * s - 1.5, site.y * s - 1.5, 2 * s + 3, 2 * s + 3); });
  // orders
  ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  wd.rovers.forEach(function (r) { if (!r.target) return; ctx.strokeStyle = r === p ? 'rgba(247,245,238,0.5)' : 'rgba(247,245,238,0.3)';
    var tx = r.x + wd.wrapD(r.target[0] - r.x, W), ty = r.y + wd.wrapD(r.target[1] - r.y, H);
    ctx.beginPath(); ctx.moveTo((r.x + 0.5) * s, (r.y + 0.5) * s); ctx.lineTo((tx + 0.5) * s, (ty + 0.5) * s); ctx.stroke();
    ctx.strokeRect(r.target[0] * s + 1, r.target[1] * s + 1, s - 2, s - 2); });
  ctx.setLineDash([]);
  // rovers
  wd.rovers.forEach(function (r) {
    var e = r === p ? Math.min(1, r.e / RULES.fovFull) : Math.min(1, r.e / RULES.childMax);
    ctx.globalAlpha = 0.5 + 0.5 * e;
    ctx.fillStyle = r === p ? '#f7f5ee' : ROLE[r.role].color;
    var g = r === p ? 3 : 1.5; ctx.fillRect(r.x * s - g, r.y * s - g, s + 2 * g, s + 2 * g);
    ctx.globalAlpha = 1;
    if (r === p) { ctx.strokeStyle = '#1f1e1c'; ctx.lineWidth = 1.5; ctx.strokeRect(r.x * s + 0.75, r.y * s + 0.75, s - 1.5, s - 1.5); }
    if (r === state.selected) { ctx.strokeStyle = '#f7f5ee'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc((r.x + 0.5) * s, (r.y + 0.5) * s, s * 1.6, 0, Math.PI * 2); ctx.stroke(); }
  });
  // events
  var now = performance.now();
  if (!REDUCED) wd.events = wd.events.filter(function (ev) {
    var life = ev.kind === 'death' || ev.kind === 'build' ? 1100 : 650, qn = (now - ev.t) / life; if (qn > 1) return false;
    ctx.strokeStyle = ev.kind === 'harvest' ? 'rgba(116,163,227,' + (1 - qn) + ')' : ev.kind === 'graze' ? 'rgba(224,104,95,' + (1 - qn) + ')' : ev.kind === 'death' ? 'rgba(133,131,122,' + (1 - qn) + ')' : 'rgba(247,245,238,' + (1 - qn) + ')';
    ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc((ev.x + 0.5) * s, (ev.y + 0.5) * s, s * 0.7 + qn * s * (ev.kind === 'harvest' || ev.kind === 'graze' ? 2 : 5), 0, Math.PI * 2); ctx.stroke(); return true; });
  else wd.events.length = 0;
}

/* ---------- HUD ---------- */
function updateHud(force) {
  var wd = state.world, p = wd.player, counts = {};
  wd.rovers.forEach(function (r) { if (r !== p) counts[r.role] = (counts[r.role] || 0) + 1; });
  var bar = q('.rg-bar'); bar.firstChild.style.width = Math.max(0, Math.min(100, p.e / RULES.maxEnergy * 100)) + '%'; bar.classList.toggle('low', p.e < 15);
  q('[data-e]').textContent = fmt(Math.max(0, p.e));
  q('[data-meta]').textContent = 'View ' + Math.round(wd.fov(p)) + '° · generation ' + fmt(wd.gen) + ' · score ' + fmt(wd.score()) + ' · best ' + fmt(Math.max(getBest(), wd.score()));
  var kids = wd.rovers.length - 1;
  q('[data-colony]').innerHTML = kids ? ROLES.filter(function (r) { return counts[r.id]; }).map(function (r) { return '<span><i style="background:' + r.color + '"></i>' + counts[r.id] + ' ' + r.name.toLowerCase() + (counts[r.id] > 1 ? 's' : '') + '</span>'; }).join('') + '<span>' + wd.farmsNow + ' farming now</span>' : '<span>No children yet</span>';
  while (state.goal < GOALS.length && GOALS[state.goal].done(wd)) { if (!force) toast('Goal done: ' + GOALS[state.goal].text); state.goal++; }
  q('[data-goal]').innerHTML = state.goal < GOALS.length ? '<em>Goal ' + (state.goal + 1) + ' of ' + GOALS.length + ':</em> ' + esc(GOALS[state.goal].text) : '<em>All goals done.</em> Keep the colony alive.';
  var canBuild = p.e >= RULES.buildMin && kids < RULES.maxChildren && !wd.over;
  q('[data-act="build"]').disabled = !canBuild;
  var sel = q('[data-sel]'), r = state.selected;
  if (r && wd.rovers.indexOf(r) < 0) { r = state.selected = null; }
  if (!r) { sel.hidden = true; }
  else if (r === p) {
    sel.hidden = false;
    sel.innerHTML = '<div><b>You</b> · energy ' + fmt(r.e) + ' · ' + r.meals + ' meals</div><div>Click the map to walk there, or use the arrow keys.</div>';
  } else {
    sel.hidden = false;
    var key = r.role + '|' + (r.target ? 1 : 0);
    if (force || sel.getAttribute('data-key') !== key || sel.getAttribute('data-id') !== String(r.id)) {
      sel.setAttribute('data-key', key); sel.setAttribute('data-id', String(r.id));
      sel.innerHTML = '<div><b>' + ROLE[r.role].name + '</b> · <span data-sel-e></span></div>' +
        '<div class="rg-row" role="group" aria-label="Change role">' + ROLES.map(function (ro) { return '<button type="button" class="rg-chip" data-setrole="' + ro.id + '" aria-pressed="' + (ro.id === r.role) + '"><i style="background:' + ro.color + '"></i>' + ro.name + '</button>'; }).join('') + '</div>' +
        '<div>' + (r.target ? 'On its way. ' : '') + 'Click the map to send it somewhere' + (r.role === 'sentry' ? ' (that becomes its post)' : '') + '.</div>' +
        '<div class="rg-row">' + (r.target ? '<button type="button" class="rg-btn" data-act="cancel">Cancel order</button>' : '') + '<button type="button" class="rg-btn" data-act="deselect">Done<kbd>Esc</kbd></button></div>';
    }
    q('[data-sel-e]').textContent = 'energy ' + fmt(r.e) + ' · ' + r.meals + ' meals';
  }
  var n; while ((n = wd.notices.shift())) toast(n);
  if (wd.over && !state.overShown) gameOver();
}

function gameOver() {
  var wd = state.world, score = wd.score(), best = getBest();
  state.overShown = true; setPaused(true);
  if (score > best) setBest(score);
  q('[data-over]').innerHTML = 'It ran out of energy at generation <strong>' + fmt(wd.gen) + '</strong>. Your colony ate <strong>' + fmt(score) + '</strong> cells' +
    (score > best ? ', a new best.' : ' (best ' + fmt(best) + ').') + ' You built ' + wd.stats.built + (wd.stats.built === 1 ? ' child' : ' children') + ', ' + wd.stats.deaths + ' shut down, and you reached goal ' + Math.min(state.goal + 1, GOALS.length) + ' of ' + GOALS.length + '.';
  showCard('over', true);
}

/* ---------- loop ---------- */
function frame(t) {
  if (!state) return;
  state.raf = requestAnimationFrame(frame);
  var dt = Math.min(0.1, (t - state.last) / 1000 || 0); state.last = t;
  if (!state.paused && !document.hidden) {
    state.acc += dt * SPEEDS[state.speed]; var n = Math.min(4, Math.floor(state.acc)); state.acc -= n;
    for (var i = 0; i < n; i++) { readHeld(); state.world.step(); }
    if (n) updateHud(false);
  }
  draw();
}

/* ---------- input ---------- */
var DIRS = { ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1], ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0] };
function readHeld() { var dx = 0, dy = 0; for (var k in state.held) if (state.held[k]) { dx += DIRS[k][0]; dy += DIRS[k][1]; }
  state.world.input.dx = Math.sign(dx); state.world.input.dy = Math.sign(dy); }

function onKey(ev) {
  if (!state) return;
  var helpOpen = !q('[data-card="help"]').hidden, overOpen = !q('[data-card="over"]').hidden;
  if (ev.type === 'keyup') { if (DIRS[ev.code]) state.held[ev.code] = false; return; }
  if (ev.target && /input|textarea|select/i.test(ev.target.tagName)) return;
  if (ev.code === 'Escape') { ev.preventDefault();
    if (helpOpen && state.world.gen > 0) { showCard('help', false); setPaused(false); }
    else if (helpOpen) exit();
    else if (state.selected) { state.selected = null; updateHud(true); }
    else if (!helpOpen && !overOpen) exit();
    return; }
  if (helpOpen || overOpen) return;
  if (DIRS[ev.code]) { ev.preventDefault(); state.held[ev.code] = true; state.world.player.target = null; if (state.paused) { setPaused(false); } return; }
  if (ev.code === 'Space') { ev.preventDefault(); setPaused(!state.paused); return; }
  if (ev.code === 'KeyB') { ev.preventDefault(); doBuild(); return; }
  var ro = ROLES.filter(function (r) { return r.key === ev.key; })[0];
  if (ro) { ev.preventDefault(); if (state.selected && state.selected !== state.world.player) { state.world.setRole(state.selected, ro.id); updateHud(true); } else setRole(ro.id); }
}

function doBuild() {
  var res = state.world.build(state.role);
  if (typeof res === 'string') toast(res);
  else { toast('Built a ' + ROLE[res.role].name.toLowerCase() + '.'); }
  updateHud(true);
}

function onPointer(ev) {
  ev.stopPropagation();
  if (ev.target.tagName !== 'CANVAS' || ev.button > 0) return;
  var st = state, rect = ev.target.getBoundingClientRect(), x = Math.floor((ev.clientX - rect.left) / st.s), y = Math.floor((ev.clientY - rect.top) / st.s), wd = st.world;
  // a click has to land on a rover to select it; a tap may be a square off, since fingers are wide
  var hit = null, bestD = ev.pointerType === 'touch' ? 2 : 1;
  wd.rovers.forEach(function (r) { var d = Math.max(Math.abs(wd.wrapD(r.x - x, wd.W)), Math.abs(wd.wrapD(r.y - y, wd.H))); if (d < bestD) { bestD = d; hit = r; } });
  if (hit) { st.selected = hit === st.selected ? null : hit; updateHud(true); return; }
  if (st.selected && st.selected !== wd.player) { wd.send(st.selected, x, y); toast('Sent the ' + ROLE[st.selected.role].name.toLowerCase() + ' there.'); updateHud(true); }
  else { wd.player.target = [x, y]; if (st.paused && q('[data-card="help"]').hidden && q('[data-card="over"]').hidden) setPaused(false); }
}

function onClick(ev) {
  var b = ev.target.closest('button'); if (!b || !state) return;
  var act = b.getAttribute('data-act'), role = b.getAttribute('data-role'), setr = b.getAttribute('data-setrole');
  if (role) { setRole(role); return; }
  if (setr) { state.world.setRole(state.selected, setr); updateHud(true); return; }
  if (act === 'start') { showCard('help', false); setPaused(false); root.focus(); }
  else if (act === 'help') { setPaused(true); showCard('help', true); q('[data-act="start"]').textContent = state.world.gen ? 'Back to the game' : 'Start'; }
  else if (act === 'pause') setPaused(!state.paused);
  else if (act === 'speed') { state.speed = (state.speed + 1) % SPEEDS.length; b.textContent = 'Speed ' + [1, 2, 4][state.speed] + '×'; }
  else if (act === 'build') doBuild();
  else if (act === 'cancel' && state.selected) { state.selected.target = null; updateHud(true); }
  else if (act === 'deselect') { state.selected = null; updateHud(true); }
  else if (act === 'again') { showCard('over', false); cancelAnimationFrame(state.raf); newGame(); setPaused(false); state.raf = requestAnimationFrame(frame); root.focus(); }
  else if (act === 'exit') exit();
}

var resizeT = 0;
function onResize() { clearTimeout(resizeT); resizeT = setTimeout(function () { if (!state || state.world.gen > 0) return; cancelAnimationFrame(state.raf); newGame(); state.raf = requestAnimationFrame(frame); }, 250); }
function onVisibility() { if (document.hidden && state && !state.paused && q('[data-card="help"]').hidden) setPaused(true); }

function exit() { if (opts.onExit) opts.onExit(); else close(); }

function open(options) {
  if (root) return;
  opts = options || {};
  lastFocus = document.activeElement;
  build(); newGame();
  document.documentElement.style.overflow = 'hidden';
  root.addEventListener('pointerdown', onPointer);
  root.addEventListener('click', onClick);
  document.addEventListener('keydown', onKey); document.addEventListener('keyup', onKey);
  window.addEventListener('resize', onResize); document.addEventListener('visibilitychange', onVisibility);
  if (opts.suspendBackground) opts.suspendBackground(true);
  document.title = 'Rover Colony';
  showCard('help', true);
  state.raf = requestAnimationFrame(frame);
}
function close() {
  if (!root) return;
  if (state) { cancelAnimationFrame(state.raf); if (state.world.score() > getBest()) setBest(state.world.score()); }
  document.removeEventListener('keydown', onKey); document.removeEventListener('keyup', onKey);
  window.removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisibility);
  root.remove(); root = null; state = null;
  document.documentElement.style.overflow = '';
  if (opts.suspendBackground) opts.suspendBackground(false);
  if (lastFocus && lastFocus.focus) try { lastFocus.focus(); } catch (e) {}
}

// world() returns the running game, for experimenting from the browser console (for example RoverGame.world().player.e = 150)
window.RoverGame = { open: open, close: close, isOpen: function () { return !!root; }, world: function () { return state && state.world; }, World: World, RULES: RULES, ROLES: ROLES };
})();
