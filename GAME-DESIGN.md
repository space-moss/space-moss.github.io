# Rover Colony: design notes

The game lives in `game.js` and opens from the **Play Rover Colony** button on the home page (or `#/play`). It uses the same world as LIDAR part 1.7: rovers aren't live cells, each rover eats the cell under it, and no two rovers can share a square. Every number below is in the `RULES` object at the top of `game.js`. You can also change them while playing, from the browser console: `RoverGame.world()` returns the running game.

## What's in it now

| Rule | Value | Why |
|---|---|---|
| Move cost / meal | 1 / 10 energy | Same as part 1.7 |
| Upkeep | 0.06 per generation for you, 0.05 for children | Without it, parking anywhere is free and nothing is at stake |
| Out of energy | A child shuts down for good; you shutting down ends the game | Gives upkeep teeth |
| Building a child | You press B: costs 40, needs 50, child starts with 20 | You decide when the colony grows, instead of splitting at 100 |
| Tithe | Children send you 30% of each meal while above 40 energy | Your income is your colony's farming |
| LIDAR | Cone from 90° to 360° as energy rises (scouts always 360°) | Part 1.7's rule; a starving rover is nearly blind |
| Fog of war | You see only what you and your scouts' LIDAR sees; memory fades over 400 generations | Makes scouting worth something |
| Glider rain | One every 24 generations at first, speeding up by 2 every 250 generations, down to every 6 | Gliders are food, but they also wreck farms |
| Colony size | 24 children | Keeps it fast on phones |

**Roles**

- **Farmer:** the part 1.7 planner, plus it walks to farm sites your scouts reported and claims one.
- **Scout:** 360° LIDAR at any energy. It explores in long lines, reports blocks as farm sites, and lights up the map for you.
- **Grazer:** the greedy eater. It's fast energy, but it destroys structures.
- **Sentry:** holds a post and eats anything that comes next to it, including gliders heading for a farm.

**Goals** teach the game in order: eat 5 cells, build a child, scout a farm site, get a farmer harvesting, grow to 8 rovers, run 4 farms at once, then reach generation 3,000. Your score is the colony's total meals, and your best score is saved in your own browser.

**Balance so far:** a scripted player that builds whenever it can reaches scores of 14,000 to 21,000 by generation 3,000. It loses a lot of children, and one game in four ends early when the heavier rain wrecks its farms. An idle player survives but scores almost nothing. It needs real playtesting.

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

## Game modes

- **Survival** (what's there now): last as long as you can while the rain gets heavier.
- **Time trial:** the best score in 2,000 generations on a fixed seed, so runs are comparable.
- **Puzzles:** hand-built boards with one question each, for example "this board has no blocks; make one" (needs the gardener) or "protect this farm from a glider stream for 500 generations".
- **Rival colony:** an AI colony using a different strategy mix competes for the same blocks. It's the "mixed strategies in one world" experiment from part 1.7, turned into an opponent.
- **Daily seed:** everyone gets the same board each day. A shared leaderboard would need a server (or a GitHub Action writing a JSON file, like the farms page).

## Controls to add

- Drag to select several children, then send them together.
- Rally points: newly built children walk to a marked spot.
- Per-role default orders (for example "farmers: only claim sites within 20 squares of me").
