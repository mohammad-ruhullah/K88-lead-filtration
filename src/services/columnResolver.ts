/**
 * Shared helpers for resolving user CSV headers to the columns the filtration
 * pipeline needs, and for safely embedding those names in generated SQL.
 */

/** Strips the surrounding quotes Vite keeps when an .env value is written as KEY="value". */
export function envField(rawValue: string | undefined): string {
  return (rawValue || '').replace(/^["']|["']$/g, '');
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

/**
 * Finds the first candidate that exists in `headers`, comparing case- and
 * whitespace-insensitively, and returns the header spelled exactly as the CSV
 * spells it (so it can be quoted straight into SQL).
 */
export function matchColumn(headers: string[], candidates: string[]): string | null {
  const normalizedHeaders = headers.map((header) => header.toLowerCase().trim());
  for (const candidate of unique(candidates)) {
    const index = normalizedHeaders.indexOf(candidate.toLowerCase().trim());
    if (index !== -1) {
      return headers[index];
    }
  }
  return null;
}

/** Qualified, double-quote-escaped reference to a column on the `csv` relation. */
export function quoteColumn(columnName: string): string {
  return `csv."${columnName.replace(/"/g, '""')}"`;
}

/** Bare, double-quote-escaped column reference with no relation prefix. */
export function quoteBareColumn(columnName: string): string {
  return `"${columnName.replace(/"/g, '""')}"`;
}
