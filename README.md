# Shyam Vaidyanathan: Robotics notebook

Findings, experiments, and dead ends from learning robotics, with live Game of Life and LIDAR simulations running in the background.

The whole site is one self-contained file, `index.html`. The entries are stored as JSON inside it, in the `<script id="site-data">` block, and the simulations run in the reader's browser, so there is no build step and no server.

## Publishing with GitHub Pages

1. Put `index.html` at the root of the repository.
2. In the repository, go to **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to **Deploy from a branch**, choose `main` and `/ (root)`, and save.

The site appears at `https://<username>.github.io/<repository>/` after a minute or two. A repository named `<username>.github.io` is served at `https://<username>.github.io/` instead.

## Updating

Write and edit entries in the Claude-hosted version, then replace `index.html` here with a fresh export. Entry links look like `#/e/entry-id`, so they keep working on any host.

## Spotted farms

`farms.html` is a separate page listing the structures in the Game of Life that feed a parked rover forever, with the data in `farms.json`. It checks `farms.json` every 15 seconds and shows new farms as they arrive. Two tools in `tools/` (Node.js, no dependencies) keep it up to date. They run the farm simulation straight out of `index.html`, so a fresh export changes what they simulate. Keep the `log` hook in `FarmSim` when you export.

- `tools/farm-log.js` runs the farmer simulation headless and writes one log per run to `logs/` (ignored by git): every meal, every split, and a snapshot of the cells around a rover at its 1st and 10th harvest on a square. After each run it calls the parser.
- `tools/farm-parse.js` reads the logs and finds parking sessions of 10 or more harvests on one square. It cuts out the structure the rover was feeding from and tests it alone. It counts as a farm only if it keeps feeding a parked rover forever. It merges the results into `farms.json`, counting each run once. It also rebuilds the table of which common still lifes and oscillators survive being eaten.

```
node tools/farm-log.js                          # 8 new seeds in each world, 1,500 generations each
node tools/farm-log.js --world soup --seeds 1-20 --gens 3000
node tools/farm-log.js --watch --serve 8080     # keep searching; watch http://127.0.0.1:8080/farms.html update live
node tools/farm-log.js --watch --push           # also commit and push farms.json whenever a new farm is spotted
node tools/farm-parse.js                        # rebuild farms.json from the logs you already have
```

The live site also updates by itself: `.github/workflows/spot-farms.yml` runs the logger on 4 new seeds per world every 6 hours, commits `farms.json` (and `farm-runs.json`, the list of runs already counted), and asks GitHub Pages to rebuild. You can also start it from the repository's **Actions** tab with **Run workflow**. The workflow pushes to `main`, so pull before you push your own changes.

## Rover Colony

`game.js` is a playable game built on the same world: you drive a rover, build children, and give them roles (farmer, scout, grazer, sentry). It opens from the **Play Rover Colony** button on the home page, or at `#/play`. It's separate from `index.html`, which only loads it and adds the button and the route. `GAME-DESIGN.md` explains the rules and lists roles, rule changes and modes to try next.
