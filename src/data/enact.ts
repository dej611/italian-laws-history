/** Infer enactment date for graph nodes that lack a slug date (unresolved codes). */

const YEAR_IN_LABEL = /\b((?:18|19|20)\d{2})\b/;

/**
 * Italian codice redazionale often encodes the year in the leading digits:
 * `26G00119` → 2026, `012G0038` → 2012, `070U5956` → 1870.
 */
export function yearFromCodice(id: string): number | null {
  const t = id.match(/^T-?(\d{2})\d*$/i);
  if (t) {
    const yy = Number(t[1]);
    return yy <= 30 ? 2000 + yy : 1900 + yy;
  }

  const two = id.match(/^(\d{2})[A-Za-z]/);
  if (two) {
    const yy = Number(two[1]);
    return yy <= 30 ? 2000 + yy : 1900 + yy;
  }

  const three = id.match(/^(\d{3})([A-Za-z])/);
  if (three) {
    const n = Number(three[1]);
    const letter = three[2].toUpperCase();
    if (n <= 30) return 2000 + n;
    if (letter === "U") return 1800 + n;
    if (n < 100) return 1900 + n;
  }

  return null;
}

export function yearFromLabel(label: string | undefined | null): number | null {
  if (!label) return null;
  const m = label.match(YEAR_IN_LABEL);
  return m ? Number(m[1]) : null;
}

/** Best-effort YYYY-MM-DD; null if unknown (must not appear in early brush years). */
export function inferEnactDate(slug: string, label?: string | null): string | null {
  const fromLabel = yearFromLabel(label);
  if (fromLabel != null) return `${fromLabel}-01-01`;

  const fromCode = yearFromCodice(slug);
  if (fromCode != null) return `${fromCode}-01-01`;

  return null;
}

export function resolveEnactDate(act: {
  slug: string;
  label?: string;
  enactDate: string | null;
}): string | null {
  return act.enactDate ?? inferEnactDate(act.slug, act.label);
}
