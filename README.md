# italian-laws-history (Rust port)

Tracks Italian law changes via the [Normattiva](https://www.normattiva.it/) API
and records each modification as a git commit. Faithful 1:1 port of the
Node.js + TypeScript scraper that lives on the `main` / `history` branches.

## Layout

The two implementations are namespace-disjoint and can coexist in the same repo:

| Concern              | TypeScript (on `main`) | Rust (on `rust`)            |
| -------------------- | ---------------------- | --------------------------- |
| Source code branch   | `main`                 | `rust` (this branch)        |
| Data branch          | `history`              | `history-rs`                |
| Provisional DL       | `dl/<codice>`          | `dl-rs/<codice>`            |
| Provisional RDL      | —                      | `rdl-rs/<codice>`           |
| Provisional DLL      | —                      | `dll-rs/<codice>`           |
| Provisional DLCPS    | —                      | `dlcps-rs/<codice>`         |
| Checkpoint file      | `progress.json`        | `progress-rs.json`          |

## One-time setup

Install Rust (skip if already present):

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
```

Then check out this branch:

```bash
cd /path/to/italian-laws-history
git checkout rust
```

## Build

```bash
cargo build --release
# Binary: ./target/release/italian-laws-history
```

For iteration, `cargo build` produces a debug build that compiles faster.

## Run modes

The binary writes data to the `history-rs` and `dl-rs/<codice>` (and friends)
branches in `OUTPUT_REPO` (defaults to the current directory), and persists
state to `progress-rs.json`.

### Resume from checkpoint (default)

```bash
./target/release/italian-laws-history --ci
```

### Start from a specific date

```bash
./target/release/italian-laws-history --ci 2024-12-01
```

### Reprocess everything from scratch

```bash
./target/release/italian-laws-history --ci --force 1861-01-01
```

### Interactive TUI dashboard (no `--ci`)

```bash
./target/release/italian-laws-history 2024-12-01
# q or Ctrl-C to quit
```

The TUI shows a list of recently-discovered acts, a decade chart, a
reference-count distribution, a type-share gauge, a scrolling log, and a
status line. Falls back to the plain stdout logger automatically when the
terminal is too small (< 40×10).

### With Chrome trace profiling

```bash
./target/release/italian-laws-history --ci --perf 2024-12-01
# Produces trace-<timestamp>.json — open in chrome://tracing
```

## Output to a separate directory (recommended for testing)

The binary's writes land on `history-rs` / `dl-rs/...` branches, which by
default live in the same repo as your `rust` source code. To keep them
isolated, point `OUTPUT_REPO` at a separate directory:

```bash
mkdir -p /tmp/laws-data && cd /tmp/laws-data && git init -q
git config user.email "you@example.com"
git config user.name "Your Name"

cd /path/to/italian-laws-history
OUTPUT_REPO=/tmp/laws-data ./target/release/italian-laws-history --ci 2024-12-01
```

Inspect:

```bash
cd /tmp/laws-data
git branch -a
git log history-rs --oneline | head
```

## All flags

```
./target/release/italian-laws-history --help
```

- `[SINCE_DATE]` — optional `YYYY-MM-DD`, overrides the checkpoint
- `--force` — ignore checkpoint, reprocess everything
- `--ci` / `--headless` — no TUI, plain stdout logger
- `--perf` — emit `trace-*.json`
- `-V` / `--version`, `-h` / `--help`

## Environment overrides

| Variable                | Default                                                       |
| ----------------------- | ------------------------------------------------------------- |
| `OUTPUT_REPO`           | `./`                                                          |
| `NORMATTIVA_API_BASE`   | `https://api.normattiva.it/t/normattiva.api/bff-opendata/v1`  |
| `NORMATTIVA_API_TOKEN`  | *(empty — most endpoints are public)*                         |
| `GIT_AUTHOR_NAME`       | `GU Bot`                                                      |
| `GIT_AUTHOR_EMAIL`      | `gu-bot@example.org`                                          |
| `BATCH_SIZE`            | `10`                                                          |
| `CONCURRENCY`           | `3`                                                           |
| `MIN_TIME_MS`           | `300`                                                         |
| `MAX_RETRIES`           | `5`                                                           |
| `CACHE_TTL_SEC`         | `3600`                                                        |
| `CHECKPOINT_FILE`       | `progress-rs.json`                                            |

## Stopping safely

`Ctrl-C` is safe at any time. The checkpoint is written atomically after
every commit, so the next run resumes from where it stopped (use the same
command without `--force`).

## Provisional-act handling

Italian law has several act types that are *provisional* — they enter into
force immediately but only become permanent after a separate ratification.
The binary commits each one to a dedicated branch and merges it into
`history-rs` once its lifecycle resolves:

| Type    | Namespace              | Decadenza window | Notes                                                              |
| ------- | ---------------------- | ---------------- | ------------------------------------------------------------------ |
| `dl`    | `dl-rs/<codice>`       | 60 days          | Modern Decreto-Legge (post-1948, art. 77 Cost.)                    |
| `rdl`   | `rdl-rs/<codice>`      | 730 days *or* none | Regio decreto-legge: 730d post-L. 100/1926 (≥ 1926-02-09); pre-1926 has no automatic decadenza |
| `dll`   | `dll-rs/<codice>`      | none             | Decreto-legge luogotenenziale: WWI individual conversion / 1944–46 cohort awaiting L. 561/1956 sanatoria |
| `dlcps` | `dlcps-rs/<codice>`    | none             | Decreto legislativo del Capo provvisorio dello Stato (1946–47), ratified en bloc by L. 561/1956 |

Acts with no automatic decadenza wait indefinitely on their branch until
either a ratifying law is published or Normattiva flags them as abrogated.

## Architecture (one-liner per module)

- [src/main.rs](src/main.rs) — CLI parsing, runtime bootstrap, monthly-window loop
- [src/config.rs](src/config.rs) — env-var-driven `Config`
- [src/types.rs](src/types.rs) — DTOs, `Checkpoint`, `BranchableShort`, `PendingAct`
- [src/http.rs](src/http.rs) — `safe_fetch`: `governor` rate limiter + `Semaphore` + `moka` TTL cache + recursive backoff (`Retry-After` seconds *and* HTTP-date) + 30s timeout
- [src/api/text.rs](src/api/text.rs) — pure helpers: HTML→plaintext, URN extraction, denomination map, filename builders, `resolve_branchable_type`
- [src/api/windows.rs](src/api/windows.rs) — `monthly_windows` iterator
- [src/api/search.rs](src/api/search.rs) — `ricerca/avanzata`, `ricerca/aggiornati`; `scrape_month` async stream
- [src/api/detail.rs](src/api/detail.rs) — `dettaglio-atto-urn`, conversion-law search, status lookup
- [src/processor.rs](src/processor.rs) — Phase A (`process_batches`), Phase B (`process_modified_acts`), `reconcile_pending_acts`
- [src/checkpoint.rs](src/checkpoint.rs) — atomic JSON I/O via `tempfile`
- [src/git.rs](src/git.rs) — shell-out git wrapper, branch constants, history-branch bootstrap
- [src/logger/](src/logger/) — `Logger` trait + `CiLogger` + `FileLogWrapper` + `ratatui` TUI
- [src/tracing_setup.rs](src/tracing_setup.rs) — `tracing-subscriber` + `tracing-chrome` on `--perf`

## Development

```bash
cargo build              # debug build
cargo test               # unit tests
cargo clippy --all-targets
cargo build --release    # optimized binary
```

## CI

[.github/workflows/daily-scrape.yml](.github/workflows/daily-scrape.yml) runs
the binary daily at 12:00 UTC on the `rust` branch with `--ci`. The
`progress-rs.json` checkpoint is cached across runs.
