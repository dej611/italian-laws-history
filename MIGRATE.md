# Normoscopio lives on `explore`

The Vite app is the root of the `explore` branch. `gh-pages` is the built site.

- `LAWS_REPO` defaults to this checkout (`progress-rs.json` at the root, texts on `history`).
- Codemotion `build-data.mjs`, `build-graph.mjs`, and `graph-layout-worker.mjs` are borrowed under `scripts/codemotion/`.
- `.github/workflows/pages.yml` on `main` runs `npm run refresh` and publishes `dist/` to `gh-pages`.
- `manifest.json` `asOf` stays `progress-rs.json` `lastFullyScannedDate`.

Unchanged: no API keys, the brush never says «vigente», the graph is desktop-only, Digesto is WebGPU-gated.
