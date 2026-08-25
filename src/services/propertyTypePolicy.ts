import { envField, matchColumn, quoteColumn } from './columnResolver';

export interface PropertyTypeColumnMapping {
  typeColumn: string | null;
  sharesColumn: string | null;
  cusipColumn: string | null;
  securitiesNameColumn: string | null;
}

const CASH_FAMILY_PREFIXES = ['ac', 'ck', 'in', 'ms', 'mi', 'ut', 'ct', 'tr'];
const EXCLUDED_MS_CODES = ['ms13', 'ms17', 'ms20'];
const CASH_SPECIFIC_CODES = [
  'ir01', 'ir05', 'cs01', 'hs01', 'ed01',
  '28', '55', '56', '58', '59', '60', '61', '62', '64', '65', '68',
  '69', '78', '79', '81', '82', '85', '87',
];
const DENY_KEYWORDS = [
  'dividend',
  'stock',
  'bond',
  'mutual fund',
  'money market',
  'securities',
  'debenture',
  'demut',
  'safe deposit',
  'safekeeping',
  'tangible',
  'box contents',
  'investm',
];
const DENY_KEYWORD_PATTERN = DENY_KEYWORDS.join('|');

const FIELD_PROPERTY_TYPE = envField(import.meta.env.VITE_CSV_FIELD_PROPERTY_TYPE);
const FIELD_SHARES_REPORTED = envField(import.meta.env.VITE_CSV_FIELD_SHARES_REPORTED);
const FIELD_CUSIP = envField(import.meta.env.VITE_CSV_FIELD_CUSIP);
const FIELD_NAME_OF_SECURITIES_REPORTED = envField(import.meta.env.VITE_CSV_FIELD_NAME_OF_SECURITIES_REPORTED);

const TYPE_COLUMN_CANDIDATES = [
  FIELD_PROPERTY_TYPE,
  'PROPERTY_TYPE',
  'Property Type',
  'PropertyType',
  'TYPE',
  'ASSET_TYPE',
  'CLAIM_TYPE',
];
const SHARES_COLUMN_CANDIDATES = [FIELD_SHARES_REPORTED, 'SHARES_REPORTED', 'Shares Reported', 'SHARES'];
const CUSIP_COLUMN_CANDIDATES = [FIELD_CUSIP, 'CUSIP'];
const SECURITIES_NAME_COLUMN_CANDIDATES = [
  FIELD_NAME_OF_SECURITIES_REPORTED,
  'NAME_OF_SECURITIES_REPORTED',
  'Name of Securities Reported',
  'SECURITIES_NAME',
];

export function resolvePropertyTypeColumns(headers: string[]): PropertyTypeColumnMapping {
  return {
    typeColumn: matchColumn(headers, TYPE_COLUMN_CANDIDATES),
    sharesColumn: matchColumn(headers, SHARES_COLUMN_CANDIDATES),
    cusipColumn: matchColumn(headers, CUSIP_COLUMN_CANDIDATES),
    securitiesNameColumn: matchColumn(headers, SECURITIES_NAME_COLUMN_CANDIDATES),
  };
}

/**
 * The cash-only policy as its individual predicates, so the filtration report
 * can attribute each rejected row to the exact rule that rejected it.
 * `buildPropertyTypeFilterSQL` composes these, so the two can never drift.
 *
 * Each field is a predicate that is TRUE when the row is acceptable.
 */
export interface PropertyTypeFilterParts {
  keywordSQL: string | null;
  codeSQL: string | null;
  sharesSQL: string | null;
  cusipSQL: string | null;
  securitiesNameSQL: string | null;
}

export function buildPropertyTypeFilterParts(
  mapping: PropertyTypeColumnMapping,
): PropertyTypeFilterParts {
  let keywordSQL: string | null = null;
  let codeSQL: string | null = null;

  if (mapping.typeColumn) {
    const typeRef = `lower(trim(try_cast(${quoteColumn(mapping.typeColumn)} as varchar)))`;
    const codeRef = `split_part(${typeRef}, ':', 1)`;
    const familyList = CASH_FAMILY_PREFIXES.map((prefix) => `'${prefix}'`).join(', ');
    const excludedMsList = EXCLUDED_MS_CODES.map((code) => `'${code}'`).join(', ');
    const specificList = CASH_SPECIFIC_CODES.map((code) => `'${code}'`).join(', ');

    keywordSQL = `(NOT regexp_matches(${typeRef}, '${DENY_KEYWORD_PATTERN}'))`;
    codeSQL = `(
      (left(${codeRef}, 2) IN (${familyList}) AND ${codeRef} NOT IN (${excludedMsList}))
      OR ${codeRef} IN (${specificList})
    )`;
  }

  return {
    keywordSQL,
    codeSQL,
    sharesSQL: mapping.sharesColumn
      ? `(
      ${quoteColumn(mapping.sharesColumn)} IS NULL
      OR try_cast(${quoteColumn(mapping.sharesColumn)} AS DOUBLE) IS NULL
      OR try_cast(${quoteColumn(mapping.sharesColumn)} AS DOUBLE) <= 0
    )`
      : null,
    cusipSQL: mapping.cusipColumn
      ? `(${quoteColumn(mapping.cusipColumn)} IS NULL OR trim(cast(${quoteColumn(mapping.cusipColumn)} AS VARCHAR)) = '')`
      : null,
    securitiesNameSQL: mapping.securitiesNameColumn
      ? `(${quoteColumn(mapping.securitiesNameColumn)} IS NULL OR trim(cast(${quoteColumn(mapping.securitiesNameColumn)} AS VARCHAR)) = '')`
      : null,
  };
}

export function buildPropertyTypeFilterSQL(mapping: PropertyTypeColumnMapping): string {
  const parts = buildPropertyTypeFilterParts(mapping);

  const predicates = [
    parts.keywordSQL && parts.codeSQL ? `(
      ${parts.keywordSQL}
      AND (${parts.codeSQL})
    )` : null,
    parts.sharesSQL,
    parts.cusipSQL,
    parts.securitiesNameSQL,
  ].filter((predicate): predicate is string => Boolean(predicate));

  return predicates.join('\n      AND ');
}
