# Rover Colony: design notes

The game lives in `game.js` and opens from the **Play Rover Colony** button on the home page (or `#/play`). It uses the same world as LIDAR part 1.7: rovers aren't live cells, each rover eats the cell under it, and no two rovers can share a square. Every number below is in the `RULES` object at the top of `game.js`. You can also change them while playing, from the browser console: `RoverGame.world()` returns the running game.

## What's in it now

The world is larger than the screen (up to 260 × 200 squares, wrapping at the edges), and the camera follows you.

| Rule | Value | Why |
|---|---|---|
| Turns | One generation per move, wait (Space) or charge (C); every child acts once per turn | You set the pace, and nothing happens while you think |
| Move cost / meal | 1 / 10 energy | Same as part 1.7 |
| Upkeep | 0.06 per turn for you, 0.05 for children, plus 0.03 for you per sensor | Without it, parking anywhere is free and nothing is at stake |
| Out of energy | A child shuts down for good; you shutting down is a loss | Gives upkeep teeth |
| Building a child | You press B: costs 40, needs 50, child starts with 20 | You decide when the colony grows, instead of splitting at 100 |
| Tithe | Children send you 30% of each meal while above 40 energy | Your income is your colony's farming |
| LIDAR | Cone from 90° to 360° as energy rises (scouts and sensors always 360°), 20 squares out | Part 1.7's rule; a starving rover is nearly blind |
| Fog of war | You see what you, your scouts and your sensors see right now; memory fades over 400 turns | Makes scouting worth something |
| Map (M) | Everything your own rover has discovered, optionally with what scouts and sensors found. Resizable, scrollable, zoomable; click it to walk there | You plan routes on what you know |
| Glider rain | One every 24 turns at first, speeding up by 2 every 250 turns, down to every 6 | Gliders are food, but they also wreck farms |
| The Warden | A 25 × 17 ship on the far side of the world, built of two sealed chambers, each with its own Life rule against the Conway plane: a **Maze corridor** (B3/S12345) round the outside, with a door on each side, and a **Reactor** (Walled Cities, B45678/S2345) in the middle, entered through a door at its top or bottom. When the core is half full the reactor switches to **Seeds** (B2/S), and back again if it leaks below. The core holds 800 and leaks 1.5 a turn. You can only charge it from the 8 squares next to it (20 a turn); a child sent to the ship finds its way to the core and gives 10 a turn until it's down to 15 | The ending: get inside, overcharge it, and it breaks apart into Life, taking its rules with it |
| Colony size | 24 children | Keeps it fast on phones |

**Roles**

- **Farmer:** the part 1.7 planner, plus it walks to farm sites your scouts and sensors reported, and claims one.
- **Scout:** 360° LIDAR at any energy. It explores in long lines, reports blocks as farm sites, and lights up the map.
- **Grazer:** the greedy eater. It's fast energy, but it destroys structures.
- **Sentry:** holds a post and eats anything that comes next to it, including gliders heading for a farm.
- **Sensor:** never moves, never eats, and costs you 0.03 a turn. It watches all the way round, reports farm sites, and keeps its patch of the map live. It can't change role, and nothing can become one.

**Goals** teach the game in order: eat 5 cells, build a child, get a farmer harvesting, place a sensor, find the Warden, charge it to half, then overcharge it.

**How it ends:** you win by overcharging the Warden, and you lose if your rover runs out of energy. Your fastest win (in turns) and best score are saved in your own browser.

**Balance so far:** with core-only charging, a scripted player reached the Seeds phase in all 4 test games but won only 1 (on turn 358). Once the reactor starves, the core leaks faster than a naive player refills it, so the second half is about bringing energy in from outside: farms, a chain of children charging, or both. It needs real playtesting.

## New roles

Ordered roughly from most to least game-changing.

1. **Gardener: plant cells.** Spend energy (say 15) to bring a dead cell to life. Three plants turn an L-shape into a block, so a gardener can *build* farms instead of hoping to find them. It's the first time a rover changes Life on purpose, and it opens up construction: guns, walls, bait. This is the biggest lever.
2. **Courier: carry energy.** Replace the radio tithe with couriers that walk energy from farms back to you. The colony's shape starts to matter (farms far away are expensive), and it gives the player routing problems to solve.
3. **Relay: radio range.** Make the tithe and beacons work only within, say, 12 squares of you or a relay. Relays chain, so expanding the colony means building a network, and losing a relay cuts off everything past it.
4. **Cartographer: share maps.** Children inherit what their parent's LIDAR saw, and cartographers merge scans colony-wide. This is the "what I'd try next" from part 1.7, and it fixes children wandering off half blind.
5. **Glider catcher: a smarter sentry.** It predicts glider paths from two scans and moves to intercept one before it reaches a farm. It's the same forecast the farmer runs, pointed at threats instead of food.
6. **Medic.** Transfers energy to children about to shut down. It's cheap to build, and it makes you choose between growing and keeping what you have.
7. **Hunter (from part 1.6).** Deliberately destroys a structure, for example a blinker next to a block that keeps breaking the farm, or a rival's farm.

## Rule changes worth trying

- **Colony overhead:** your upkeep grows with colony size (for example +0.01 per child). Growth then has a real cost, and the question becomes how big you should get.
- **LIDAR range scales with energy too**, not just the cone. Hungry rovers become short-sighted as well as narrow.
- **Wrecks become food:** a rover that shuts down leaves a block where it stood. Deaths seed new farms, a nice loop.
- **Farm fatigue:** a block that has fed a rover for N generations loses a cell. Farms become temporary, so scouting never stops mattering.
- **Different Life rules per level:** HighLife (B36/S23) grows replicators, Day & Night is denser and noisier. Same rovers, different ecology.
- **A glider gun on the map:** a steady stream of food that is also a stream of wrecking balls. It's a resource worth fighting over.
- **LIDAR noise and dropouts** from part 1's "what the toy gets wrong" list: occasional false hits and missed returns, worse at night.

## Ships to infiltrate

Ships are defined in `SHIPS` at the top of `game.js`. A ship is a text grid (`#` wall, `C` core, space for outside, and a letter for each chamber) plus a list of chambers. Each chamber has a name, a Life rule, how much of it starts alive, a colour, and optional `phases`: rules it switches to once the core is at least a given share full. Every square of the world carries a rule, so each chamber steps by its own while the rest of the world keeps Conway's. Chambers are sealed by straight single walls, so Life on either side can't touch (cells two squares apart aren't neighbours); they only meet at their doors, where each cell follows the rule of the square it's on. Rovers find their way through the doors with pathfinding (a distance field over everything that isn't hull). Your farmers' forecast still assumes Conway's rule, so inside a ship their predictions are wrong: that's the "different logic".

**Why Seeds for the second phase:** in this game, live cells are food. Serviettes (87% of the reactor flipping every turn) would feed charging rovers more and make the second half easier. Seeds keeps the reactor sparse (about 11% alive), so it becomes a famine exactly when you're halfway, and you have to carry energy in.

### Rules for hulls

Any Life-like rule works: `B` lists the neighbour counts that bring a dead cell to life, `S` the counts that keep a live one alive. How each behaves inside the Warden's interior (86 squares, walls count as dead), measured over 8 worlds and turns 100 to 300:

| Rule | B/S | Alive | Changing per turn | Died out | What it would feel like |
|---|---|---|---|---|---|
| Walled Cities (the Warden) | B45678/S2345 | 60% | 24% | 0 of 8 | Dense, churning districts: lots to eat, always regrowing |
| Assimilation | B345/S4567 | 70% | 29% | 0 of 8 | A thick living mass that heals itself; an armoured ship |
| Serviettes | B234/S | 44% | 87% | 0 of 8 | Almost everything flips every turn: a reactor that never settles, nothing to plan around |
| Replicator | B1357/S1357 | 50% | 50% | 0 of 8 | Every pattern copies itself; anything you break comes back doubled |
| Gnarl | B1/S1 | 26% | 38% | 0 of 8 | Explosive, spidery growth from single cells |
| Seeds | B2/S | 11% | 22% | 0 of 8 | Every cell dies each turn, but sparks keep catching; flickering, dangerous corridors |
| Life without Death | B3/S012345678 | 72% | 0% | 0 of 8 | Cells never die, so the inside fills solid; you tunnel in by eating |
| Maze | B3/S12345 | 65% | 0% | 0 of 8 | Grows into corridors; an infiltration labyrinth |
| Long Life | B345/S5 | 16% | 32% | 2 of 8 | Slow, long-period oscillators: timing puzzles |
| HighLife | B36/S23 | 6% | 2% | 0 of 8 | Looks like Conway's rule, which is the trap: replicators appear where you don't expect them |
| 2x2 | B36/S125 | 7% | 0% | 0 of 8 | Settles into 2 × 2 tiles; quiet |
| Day & Night | B3678/S34678 | 2% | 2% | 6 of 8 | Dies out in a small hull; needs a big open one to form its blobs |
| Coral, Anneal, Morley, Diamoeba | various | 0 to 2% | about 1% | 5 to 8 of 8 | Mostly die in a hull this small |

You can measure a new rule the same way before using it: change a ship's `rule` and count its inside over a few hundred turns with `new RoverGame.World(...)` in the browser console.

### Ideas beyond one fixed rule

- **The rule changes as you charge it** (done): the Warden's reactor starves when you pass halfway. More phases are one line each in `phases`, for example the corridor turning to Life without Death at 75% so it fills in behind you.
- **Different rules in different chambers** (done): the Maze corridor and the Reactor. A third chamber, like a Serviettes antechamber you have to cross quickly, is a new letter in the grid and a new entry in `rooms`.
- **Rovers count as live cells inside** (part 1.6's rule). Standing next to something changes it, so every step inside the ship matters.
- **Multi-state rules** like Brian's Brain, where dying cells linger for a turn. They'd need a second byte per square, but they give walls of "dying" cells rovers can't cross.

### More ship ideas

1. **Learning the rule.** A sensor parked at an airlock watches the interior. After enough turns it works out the rule (compare what it saw against what each candidate rule predicted), and from then on your rovers' forecasts are right inside that ship. So infiltrating starts as a research job.
2. **Airlocks on a clock.** Openings in the hull made of oscillators: a blinker gate is open every other turn. Turn-based movement makes timing puzzles fair, since you can wait exactly one turn.
3. **Systems to take down, in any order.** A ship has several subsystems (shield emitter, reactor, gun) at fixed spots inside. Each one needs a different trick: overcharge it, starve it (eat the cells feeding it), or block it (park a sentry in its output). The core only becomes chargeable once the shield is down.
4. **The ship fights back as it fills up.** At 25% it starts firing gliders from a gun in its hull. At 50% it drains energy from any rover within 3 squares. At 75% it jumps to a new spot on the map, and you have to find it again (sensors pay off here).
5. **A ship designer.** Ships are just text grids plus a rule string, so a small page like `farms.html` could let you draw hulls, choose rules and place systems, then save them to `ships.json` for the game to load.

## Game modes

- **Survival:** no Warden; last as long as you can while the rain gets heavier. (The game now ends by overcharging the Warden.)
- **Time trial:** the best score in 2,000 generations on a fixed seed, so runs are comparable.
- **Puzzles:** hand-built boards with one question each, for example "this board has no blocks; make one" (needs the gardener) or "protect this farm from a glider stream for 500 generations".
- **Rival colony:** an AI colony using a different strategy mix competes for the same blocks. It's the "mixed strategies in one world" experiment from part 1.7, turned into an opponent.
- **Daily seed:** everyone gets the same board each day. A shared leaderboard would need a server (or a GitHub Action writing a JSON file, like the farms page).

## Controls to add

- Drag to select several children, then send them together.
- Rally points: newly built children walk to a marked spot.
- Per-role default orders (for example "farmers: only claim sites within 20 squares of me").
