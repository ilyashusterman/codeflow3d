/**
 * Line diff between two revisions of a file.
 *
 * The panels show what actually changed, so a positional comparison is not
 * good enough: inserting one line at the top would mark the whole file dirty.
 * This trims the common prefix and suffix, then runs an LCS over what is left,
 * which is exact for the small edits a save produces and bounded for the large
 * ones (a wholesale rewrite reports as one replaced block rather than melting).
 */

export type ChangeType = "add" | "del";

export interface LineChange {
  type: ChangeType;
  /** 1-based line number in the new file (for `del`, where it was removed). */
  line: number;
  text: string;
}

export interface FileDiff {
  changes: LineChange[];
  added: number;
  removed: number;
  /** 1-based line numbers in the new file that are new or modified. */
  touched: Set<number>;
  /** First changed line in the new file, for anchoring the panel view. */
  anchor: number | null;
}

const EMPTY: FileDiff = { changes: [], added: 0, removed: 0, touched: new Set(), anchor: null };

/** Above this many differing lines on a side, report a replaced block. */
const LCS_LIMIT = 1500;

export function diffLines(before: string, after: string): FileDiff {
  if (before === after) return EMPTY;
  const a = before.split("\n");
  const b = after.split("\n");

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  if (!midA.length && !midB.length) return EMPTY;

  const changes: LineChange[] =
    midA.length > LCS_LIMIT || midB.length > LCS_LIMIT
      ? [
          ...midA.map((text, i) => ({ type: "del" as const, line: start + 1, text })).slice(0, 200),
          ...midB.map((text, i) => ({ type: "add" as const, line: start + i + 1, text })).slice(0, 200),
        ]
      : lcsChanges(midA, midB, start);

  const touched = new Set<number>();
  let added = 0;
  let removed = 0;
  for (const c of changes) {
    if (c.type === "add") {
      added++;
      touched.add(c.line);
    } else {
      removed++;
      // A deletion makes the surrounding line worth showing as changed.
      touched.add(Math.max(1, c.line));
    }
  }

  return { changes, added, removed, touched, anchor: changes.length ? changes[0].line : null };
}

/** Classic LCS backtrack, emitting adds and deletes in file order. */
function lcsChanges(a: string[], b: string[], offset: number): LineChange[] {
  const n = a.length;
  const m = b.length;
  // table[i][j] = LCS length of a[i..] and b[j..]
  const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = table[i];
    const next = table[i + 1];
    for (let j = m - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }

  const changes: LineChange[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      changes.push({ type: "del", line: offset + j + 1, text: a[i] });
      i++;
    } else {
      changes.push({ type: "add", line: offset + j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) changes.push({ type: "del", line: offset + j + 1, text: a[i++] });
  while (j < m) {
    changes.push({ type: "add", line: offset + j + 1, text: b[j] });
    j++;
  }
  return changes;
}
