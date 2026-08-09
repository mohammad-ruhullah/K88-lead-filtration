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

const FIELD_PROPERTY_TYPE = (import.meta.env.VITE_CSV_FIELD_PROPERTY_TYPE || '').replace(/^["']|["']$/g, '');
const FIELD_SHARES_REPORTED = (import.meta.env.VITE_CSV_FIELD_SHARES_REPORTED || '').replace(/^["']|["']$/g, '');
const FIELD_CUSIP = (import.meta.env.VITE_CSV_FIELD_CUSIP || '').replace(/^["']|["']$/g, '');
const FIELD_NAME_OF_SECURITIES_REPORTED = (import.meta.env.VITE_CSV_FIELD_NAME_OF_SECURITIES_REPORTED || '').replace(
  /^["']|["']$/g,
  '',
);

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

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function matchColumn(headers: string[], candidates: string[]): string | null {
  const normalizedHeaders = headers.map((header) => header.toLowerCase().trim());
  for (const candidate of unique(candidates)) {
    const index = normalizedHeaders.indexOf(candidate.toLowerCase().trim());
    if (index !== -1) {
      return headers[index];
    }
  }
  return null;
}

export function resolvePropertyTypeColumns(headers: string[]): PropertyTypeColumnMapping {
  return {
    typeColumn: matchColumn(headers, TYPE_COLUMN_CANDIDATES),
    sharesColumn: matchColumn(headers, SHARES_COLUMN_CANDIDATES),
    cusipColumn: matchColumn(headers, CUSIP_COLUMN_CANDIDATES),
    securitiesNameColumn: matchColumn(headers, SECURITIES_NAME_COLUMN_CANDIDATES),
  };
}

function quoteColumn(columnName: string): string {
  return `csv."${columnName.replace(/"/g, '""')}"`;
}

export function buildPropertyTypeFilterSQL(mapping: PropertyTypeColumnMapping): string {
  const predicates: string[] = [];

  if (mapping.typeColumn) {
    const typeRef = `lower(trim(try_cast(${quoteColumn(mapping.typeColumn)} as varchar)))`;
    const codeRef = `split_part(${typeRef}, ':', 1)`;
    const familyList = CASH_FAMILY_PREFIXES.map((prefix) => `'${prefix}'`).join(', ');
    const excludedMsList = EXCLUDED_MS_CODES.map((code) => `'${code}'`).join(', ');
    const specificList = CASH_SPECIFIC_CODES.map((code) => `'${code}'`).join(', ');

    predicates.push(`(
      NOT regexp_matches(${typeRef}, '${DENY_KEYWORD_PATTERN}')
      AND (
        (left(${codeRef}, 2) IN (${familyList}) AND ${codeRef} NOT IN (${excludedMsList}))
        OR ${codeRef} IN (${specificList})
      )
    )`);
  }

  if (mapping.sharesColumn) {
    const ref = quoteColumn(mapping.sharesColumn);
    predicates.push(`(
      ${ref} IS NULL
      OR try_cast(${ref} AS DOUBLE) IS NULL
      OR try_cast(${ref} AS DOUBLE) <= 0
    )`);
  }

  if (mapping.cusipColumn) {
    const ref = quoteColumn(mapping.cusipColumn);
    predicates.push(`(${ref} IS NULL OR trim(cast(${ref} AS VARCHAR)) = '')`);
  }

  if (mapping.securitiesNameColumn) {
    const ref = quoteColumn(mapping.securitiesNameColumn);
    predicates.push(`(${ref} IS NULL OR trim(cast(${ref} AS VARCHAR)) = '')`);
  }

  return predicates.join('\n      AND ');
}
