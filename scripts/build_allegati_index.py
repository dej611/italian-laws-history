#!/usr/bin/env python3
"""Build gitignored allegati.json from history filenames.

Usage:
  python3 scripts/build_allegati_index.py
  python3 scripts/build_allegati_index.py --out allegati.json --until 2024-11-30
"""

from __future__ import annotations

import argparse
import calendar
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STEM_RE = re.compile(
    r"^(.+)-([^-]+)-del-(\d{2})-(\d{2})-(\d{4})\.allegato-\d+\.txt$"
)

# Filename prefix (spaces → dashes, same as build_file_name) → URN denomination
# (DENOMINATION_URN_MAP). Anything not listed falls back to hyphen → dot.
PREFIX_TO_URN_DENOM = {
    "costituzione": "costituzione",
    "decreto": "decreto",
    "decreto-del-capo-del-governo": "decreto.capo.governo",
    "decreto-del-capo-provvisorio-dello-stato": "decreto.capo.provvisorio.stato",
    "decreto-del-duce": "decreto.duce",
    "decreto-del-presidente-del-consiglio-dei-ministri": "decreto.presidente.consiglio.ministri",
    "decreto-del-presidente-della-repubblica": "decreto.presidente.repubblica",
    "decreto-legislativo": "decreto.legislativo",
    "decreto-legislativo-del-capo-provvisorio-dello-stato": "decreto.legislativo.capo.provvisorio.stato",
    "decreto-legislativo-luogotenenziale": "decreto.legislativo.luogotenenziale",
    "decreto-legislativo-presidenziale": "decreto.legislativo.presidenziale",
    "decreto-luogotenenziale": "decreto.luogotenenziale",
    "decreto-ministeriale": "decreto.ministeriale",
    "decreto-presidenziale": "decreto.presidenziale",
    "decreto-reale": "regio.decreto",
    "decreto-legge": "decreto.legge",
    "decreto-legge-luogotenenziale": "decreto.legge.luogotenenziale",
    "deliberazione": "deliberazione",
    "legge": "legge",
    "legge-costituzionale": "legge.costituzionale",
    "ordinanza": "ordinanza",
    "regio-decreto": "regio.decreto",
    "regio-decreto-legge": "regio.decreto.legge",
    "regio-decreto-legislativo": "regio.decreto.legislativo",
    "regolamento": "regolamento",
}


def urn_denom(prefix: str) -> str:
    return PREFIX_TO_URN_DENOM.get(prefix, prefix.replace("-", "."))


def month_end(yyyy_mm_dd: str) -> str:
    y, m, _d = (int(p) for p in yyyy_mm_dd.split("-"))
    last = calendar.monthrange(y, m)[1]
    return f"{y:04d}-{m:02d}-{last:02d}"


def checkpoint_until(repo: Path) -> str | None:
    candidates = [repo / "progress-rs.json"]
    backups = sorted((repo / "backups").glob("scrape-state-*/progress-rs.json"))
    candidates.extend(reversed(backups))
    for path in candidates:
        if not path.is_file():
            continue
        with path.open() as f:
            data = json.load(f)
        raw = data.get("lastFullyScannedDate")
        if isinstance(raw, str) and len(raw) >= 10:
            return month_end(raw[:10])
    return None


def history_files(repo: Path) -> list[str]:
    out = subprocess.check_output(
        ["git", "ls-tree", "-r", "--name-only", "history"],
        cwd=repo,
        text=True,
    )
    return out.splitlines()


def build_urns(files: list[str]) -> dict[str, bool]:
    allegati: dict[str, bool] = {}
    unmatched = 0
    for name in files:
        if ".allegato-" not in name or not name.endswith(".txt"):
            continue
        m = STEM_RE.match(name)
        if not m:
            unmatched += 1
            continue
        prefix, num, dd, mm, yyyy = m.groups()
        urn = f"urn:nir:stato:{urn_denom(prefix)}:{yyyy}-{mm}-{dd};{num}"
        allegati[urn] = True
    if unmatched:
        print(f"warning: {unmatched} allegato txt names did not match", file=sys.stderr)
    return allegati


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=ROOT)
    parser.add_argument("--out", type=Path, default=None)
    parser.add_argument("--until", default=None, help="YYYY-MM-DD (default: last fully scanned month end)")
    args = parser.parse_args()

    until = args.until or checkpoint_until(args.repo)
    if not until:
        print("error: could not infer dataUntil; pass --until YYYY-MM-DD", file=sys.stderr)
        return 1

    allegati = build_urns(history_files(args.repo))
    payload = {"dataUntil": until, "allegati": dict(sorted(allegati.items()))}
    dest = args.out or (args.repo / "allegati.json")
    dest.write_text(json.dumps(payload, separators=(",", ":"), ensure_ascii=False) + "\n")
    print(f"wrote {dest} ({len(allegati)} urns, dataUntil={until})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
