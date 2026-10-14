# Normoscopio

Public Italian narrative + desktop graph explorer for `italian-laws-history`.
Source branch: `explore`. Built site: `gh-pages`.

## Quick start

```sh
git checkout explore
pnpm install
pnpm run refresh
pnpm run dev
```

`npm run refresh` reads `progress-rs.json` in this checkout and the `history`
branch. Set `LAWS_REPO` if the checkpoint lives in another checkout of the
same repo.

## Scripts

| Command | Role |
|---------|------|
| `pnpm run refresh` | Rebuild `public/data/*` from the borrowed Codemotion builders + acts/blame/rag/manifest |
| `pnpm run dev` | Vite |
| `pnpm run build` | Production build (`VITE_BASE=./` when publishing to GitHub Pages) |

The Codemotion `build-data.mjs` / `build-graph.mjs` builders are borrowed under
`scripts/codemotion/` and write beside themselves. `pnpm run refresh` copies
`data.json` and `graph.json` into `public/data/`.

Optional env: `BLAME_LIMIT` (extra hubs for blame, default 400), `RAG_HUB_LIMIT` (default 400), `BLAME_REFRESH_SUBJECTS=1`.

## Pages

`main` runs `.github/workflows/pages.yml` after the daily scrape (and on
`workflow_dispatch`). It checks out this branch, refreshes data, and force-pushes
`dist/` to `gh-pages`.

## Product locks

- Italian dry copy; brand **Normoscopio**; light paper + azzurro spento
- Desktop graph + brush labeled **Emanate entro … · non decadute** (never «vigente»)
- Mobile: scrolly only (no graph / no mini-explore)
- Digesto: Chrome Prompt API if available, else wllama GGUF; tools stay local; no API keys
- Hard-refuse personal legal advice
