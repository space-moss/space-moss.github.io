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
