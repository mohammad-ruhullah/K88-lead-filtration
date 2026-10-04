import { matchColumn, quoteColumn } from './columnResolver';

/**
 * Sole-owner-only policy (client requirement: "only single person property").
 *
 * The client works one owner at a time, so a property split between people is
 * useless to them: the claim needs every co-owner, and the money divides. One
 * owner holding *many* properties is still wanted - this rule is about the
 * property having a single owner, never about how many properties that owner
 * has. Owner grouping and the balance threshold are untouched.
 *
 * Three independent signals, because each catches what the others miss:
 *
 *  1. `NO_OF_OWNERS` - the state's own count. Direct, but blank or `0` in a
 *     measurable share of rows, so it cannot be the only test.
 *  2. The same `PROPERTY_ID` carrying more than one distinct owner name. This
 *     is the signal that survives bad data, and the only one that catches a
 *     co-owned property whose `NO_OF_OWNERS` is unreadable.
 *  3. A joint marker inside `OWNER_NAME` - `SMITH JOHN & MARY` is ONE row
 *     naming TWO people, so signals 1 and 2 can both read it as sole-owned.
 *
 * ## Why the counts must be computed before any filter runs
 *
 * Signal 2 is only true if it sees every row. Suppose property 12345 is held by
 * `SMITH JOHN` and `ACME LLC`: the individual-owner rule deletes the ACME row,
 * and the property then appears exactly once and looks sole-owned. It is not -
 * John owns half of it. The same happens whenever a co-owner's row is dropped
 * for being claimed, having no address, or being non-cash: every earlier stage
 * manufactures fake sole owners.
 *
 * So `buildCoOwnershipFlagParts` is evaluated in an UNFILTERED scan CTE and the
 * resulting flags are carried forward. The filter never re-derives them from
 * whatever survived.
 *
 * ## Why an unreadable `NO_OF_OWNERS` is treated as sole-owned
 *
 * Signal 1 defaults a NULL or `0` to one owner rather than dropping the row.
 * That is safe *because* signal 2 is computed over raw rows: a genuinely
 * co-owned property still emits a row per co-owner, so it is caught there
 * regardless of what the count column says. Dropping on an unreadable count
 * would discard rows for a data-quality gap the next signal already covers.
 */

export interface CoOwnershipColumnMapping {
  propertyIdColumn: string | null;
  ownerNameColumn: string | null;
  ownerCountColumn: string | null;
}

/**
 * Joint-ownership markers, matched against the space-padded normalised name.
 *
 * Deliberately short. Every entry here is a word that would be a disaster as a
 * surname match, which is why they are tested as whole tokens against the
 * padded form rather than as substrings - `OR` would otherwise hit `ORTIZ`, and
 * `TEN` would hit `TENNANT`.
 *
 * `&` is NOT in this list: normalisation strips punctuation, so by the time a
 * name reaches the padded form the ampersand is gone. It is tested separately
 * against the RAW column in `buildCoOwnershipFlagParts`.
 *
 * BANNED - never add these:
 *   `jt`, `jts` - read as a person's initials far more often than as joint
 *   tenancy. Measured on a 200,000-row slice, every row the bare `jt` token
 *   rejected was a plausible individual: `WETZEL JT`, `PEREZ JT`,
 *   `WORKMAN JT II`. The spelled-out `jtten` / `jtwros` forms are unambiguous
 *   and stay. The one genuine joint venture the bare token caught
 *   (`GARY MARTONE & ANDERSON JT VENT`) is already caught by the ampersand.
 */
const JOINT_NAME_TOKENS = [
  'and',
  'or',
  'et al',
  'etal',
  'etux',
  'et ux',
  'jtten',
  'jtwros',
  'ten com',
  'tenants',
  'joint',
  'survivor',
  'trustees',
];

const JOINT_PATTERN = JOINT_NAME_TOKENS.join('|');

const PROPERTY_ID_COLUMN_CANDIDATES = ['PROPERTY_ID', 'Property ID', 'PropertyId'];
const OWNER_NAME_COLUMN_CANDIDATES = ['OWNER_NAME', 'Owner Name', 'OwnerName'];
const OWNER_COUNT_COLUMN_CANDIDATES = [
  'NO_OF_OWNERS',
  'No of Owners',
  'Number of Owners',
  'NumberOfOwners',
];

export function resolveCoOwnershipColumns(headers: string[]): CoOwnershipColumnMapping {
  return {
    propertyIdColumn: matchColumn(headers, PROPERTY_ID_COLUMN_CANDIDATES),
    ownerNameColumn: matchColumn(headers, OWNER_NAME_COLUMN_CANDIDATES),
    ownerCountColumn: matchColumn(headers, OWNER_COUNT_COLUMN_CANDIDATES),
  };
}

/** Columns without which the rule would be silently skipped. Filtration hard-blocks if any is missing. */
export function collectMissingCoOwnershipColumns(
  mapping: CoOwnershipColumnMapping,
): string[] {
  const missing: string[] = [];
  if (!mapping.propertyIdColumn) missing.push('PROPERTY_ID');
  if (!mapping.ownerNameColumn) missing.push('OWNER_NAME');
  if (!mapping.ownerCountColumn) missing.push('NO_OF_OWNERS');
  return missing;
}

/**
 * Expressions for the three flags, to be selected in an **unfiltered** scan CTE
 * where the source relation is still aliased `csv`. See the module docstring:
 * computing these after any `WHERE` silently turns co-owned properties into
 * sole-owned ones.
 */
export interface CoOwnershipFlagParts {
  /** Rows in the whole dataset sharing this row's PROPERTY_ID. */
  propertyRowCountSQL: string | null;
  /** Rows sharing this row's PROPERTY_ID *and* owner name. */
  ownerRowCountSQL: string | null;
  /** TRUE when the raw owner name names more than one person. */
  jointNameSQL: string | null;
  /** The reported owner count, parsed. */
  reportedOwnersSQL: string | null;
}

export function buildCoOwnershipFlagParts(
  mapping: CoOwnershipColumnMapping,
  normalizedNameRef?: string,
): CoOwnershipFlagParts {
  const { propertyIdColumn, ownerNameColumn, ownerCountColumn } = mapping;

  if (!propertyIdColumn || !ownerNameColumn) {
    return {
      propertyRowCountSQL: null,
      ownerRowCountSQL: null,
      jointNameSQL: null,
      reportedOwnersSQL: null,
    };
  }

  const propertyRef = quoteColumn(propertyIdColumn);
  const nameRef = quoteColumn(ownerNameColumn);

  // Two window functions over the same partition key rather than
  // COUNT(DISTINCT ...) OVER (...), which DuckDB does not support. Comparing
  // them distinguishes a genuinely co-owned property (several owner names on
  // one PROPERTY_ID) from the same row appearing twice across the unioned
  // files, which is not co-ownership and must not be treated as such.
  const propertyRowCountSQL = `COUNT(*) OVER (PARTITION BY ${propertyRef})`;
  const ownerRowCountSQL = `COUNT(*) OVER (PARTITION BY ${propertyRef}, ${nameRef})`;

  // The ampersand test reads the RAW column: normalisation strips punctuation,
  // so `SMITH JOHN & MARY` is already `smith john mary` by the time the padded
  // form exists and the only evidence of two people has been erased.
  const rawName = `COALESCE(CAST(${nameRef} AS VARCHAR), '')`;
  const paddedName =
    normalizedNameRef ??
    `' ' || trim(regexp_replace(lower(${rawName}), '[^a-z0-9]+', ' ', 'g')) || ' '`;

  const jointNameSQL = `(
      regexp_matches(${rawName}, '&')
      OR regexp_matches(${paddedName}, ' (${JOINT_PATTERN}) ')
    )`;

  const reportedOwnersSQL = ownerCountColumn
    ? `TRY_CAST(${quoteColumn(ownerCountColumn)} AS INTEGER)`
    : null;

  return { propertyRowCountSQL, ownerRowCountSQL, jointNameSQL, reportedOwnersSQL };
}

/**
 * The rule as its individual predicates, so the filtration report can
 * attribute each rejected row to the exact signal that rejected it.
 * `buildCoOwnershipFilterSQL` composes these, so the two can never drift.
 *
 * Each field is a predicate that is TRUE when the property is sole-owned, i.e.
 * acceptable. All three read flag columns materialised earlier, so none of the
 * underlying expressions is evaluated more than once per row.
 */
export interface CoOwnershipFilterParts {
  reportedOwnersOkSQL: string | null;
  soleOwnerOkSQL: string | null;
  jointNameOkSQL: string | null;
}

export interface CoOwnershipFlagRefs {
  propertyRowCountRef: string;
  ownerRowCountRef: string;
  jointNameRef: string;
  reportedOwnersRef: string;
}

export function buildCoOwnershipFilterParts(
  refs: CoOwnershipFlagRefs,
): CoOwnershipFilterParts {
  return {
    // NULLIF folds a reported `0` in with blank: both mean "not stated", and
    // neither is evidence of co-ownership. See the module docstring for why
    // defaulting these to sole-owned is safe.
    reportedOwnersOkSQL: `(COALESCE(NULLIF(${refs.reportedOwnersRef}, 0), 1) <= 1)`,
    soleOwnerOkSQL: `(${refs.propertyRowCountRef} <= ${refs.ownerRowCountRef})`,
    jointNameOkSQL: `(NOT ${refs.jointNameRef})`,
  };
}

export function buildCoOwnershipFilterSQL(refs: CoOwnershipFlagRefs): string {
  const parts = buildCoOwnershipFilterParts(refs);

  const predicates = [
    parts.reportedOwnersOkSQL,
    parts.soleOwnerOkSQL,
    parts.jointNameOkSQL,
  ].filter((predicate): predicate is string => Boolean(predicate));

  return predicates.length > 0 ? predicates.join('\n      AND ') : 'TRUE';
}
