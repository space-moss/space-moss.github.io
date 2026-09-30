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
| The Warden | A 13 × 9 ship on the far side of the world. Its core holds 800 and leaks 1.5 a turn. You charge 20 a turn from next to the hull; a child sent to it gives 10 a turn until it's down to 15 | The ending: overcharge it and it breaks apart into Life |
| Colony size | 24 children | Keeps it fast on phones |

**Roles**

- **Farmer:** the part 1.7 planner, plus it walks to farm sites your scouts and sensors reported, and claims one.
- **Scout:** 360° LIDAR at any energy. It explores in long lines, reports blocks as farm sites, and lights up the map.
- **Grazer:** the greedy eater. It's fast energy, but it destroys structures.
- **Sentry:** holds a post and eats anything that comes next to it, including gliders heading for a farm.
- **Sensor:** never moves, never eats, and costs you 0.03 a turn. It watches all the way round, reports farm sites, and keeps its patch of the map live. It can't change role, and nothing can become one.

**Goals** teach the game in order: eat 5 cells, build a child, get a farmer harvesting, place a sensor, find the Warden, charge it to half, then overcharge it.

**How it ends:** you win by overcharging the Warden, and you lose if your rover runs out of energy. Your fastest win (in turns) and best score are saved in your own browser.

**Balance so far:** a scripted player that grows a farming colony and then ferries energy to the Warden won 2 of 4 games (turns 960 and 3,088). It lost one because the core leaked empty between trips, and it stalled in the other. So the leak is doing its job: you have to charge faster than it bleeds, which means several rovers charging at once. It needs real playtesting.

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

The Warden is the first ship, and for now all you do is feed it. Ships are defined in `SHIPS` at the top of `game.js`: a hull drawn in text, a core capacity and a leak rate. Ideas for turning them into the designed ships and systems you described:

1. **Each ship runs its own Life rule inside the hull.** Give the hull an interior (cells marked `.` inside `#` walls) that steps with a different rule, for example HighLife (B36/S23, which has replicators), Seeds (B2/S, where everything explodes and nothing survives) or Day & Night (B3678/S34678, dense and blobby). Your farmer's forecast assumes Conway's rules, so inside a ship its predictions are wrong. That's the "different logic" you mentioned, and the first thing a player has to work out.
2. **Learning the rule.** A sensor parked at an airlock watches the interior. After enough turns it works out the rule (compare what it saw against what each candidate rule predicted), and from then on your rovers' forecasts are right inside that ship. So infiltrating starts as a research job.
3. **Airlocks on a clock.** Openings in the hull made of oscillators: a blinker gate is open every other turn. Turn-based movement makes timing puzzles fair, since you can wait exactly one turn.
4. **Systems to take down, in any order.** A ship has several subsystems (shield emitter, reactor, gun) at fixed spots inside. Each one needs a different trick: overcharge it, starve it (eat the cells feeding it), or block it (park a sentry in its output). The core only becomes chargeable once the shield is down.
5. **Rovers become visible inside.** Inside a hull, rovers count as live cells, like the hunter in part 1.6. Your presence changes the ship's Life, so you can break structures just by standing next to them, and so can it.
6. **The ship fights back as it fills up.** At 25% it starts firing gliders from a gun in its hull. At 50% it drains energy from any rover within 3 squares. At 75% it jumps to a new spot on the map, and you have to find it again (sensors pay off here).
7. **A ship designer.** Ships are just text grids plus a rule string, so a small page like `farms.html` could let you draw hulls, choose rules and place systems, then save them to `ships.json` for the game to load.

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
