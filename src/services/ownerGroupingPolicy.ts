import { envField, matchColumn, quoteColumn } from './columnResolver';

/**
 * Owner-grouping policy (client requirement).
 *
 * A lead is an OWNER, not a property. Rows belong to the same owner when the
 * owner name and the full address match exactly. Such an owner qualifies when
 * the combined balance of their properties reaches the threshold, even if no
 * single property does.
 *
 * Two row-level gates run before any grouping happens:
 *  - claim gate:      only unclaimed properties (no pending and no paid claims)
 *  - address gate:    rows without a street address are dropped outright, so
 *                     unrelated same-name people can never collapse into one
 *                     bogus owner group.
 */

export interface OwnerGroupingColumns {
  pendingClaimsColumn: string | null;
  paidClaimsColumn: string | null;
  ownerNameColumn: string | null;
  street1Column: string | null;
  street2Column: string | null;
  street3Column: string | null;
  cityColumn: string | null;
  stateColumn: string | null;
  zipColumn: string | null;
  countryColumn: string | null;
  propertyIdColumn: string | null;
  cashBalanceColumn: string | null;
}

const FIELD_PENDING_CLAIMS = envField(import.meta.env.VITE_CSV_FIELD_PENDING_CLAIMS);
const FIELD_PAID_CLAIMS = envField(import.meta.env.VITE_CSV_FIELD_PAID_CLAIMS);
const FIELD_OWNER_NAME = envField(import.meta.env.VITE_AIRTABLE_FIELD_OWNER_NAME);
const FIELD_PROPERTY_ID = envField(import.meta.env.VITE_AIRTABLE_FIELD_PROPERTY_ID);
const FIELD_OWNER_STREET_1 = envField(import.meta.env.VITE_CSV_FIELD_OWNER_STREET_1);
const FIELD_OWNER_STREET_2 = envField(import.meta.env.VITE_CSV_FIELD_OWNER_STREET_2);
const FIELD_OWNER_STREET_3 = envField(import.meta.env.VITE_CSV_FIELD_OWNER_STREET_3);
const FIELD_OWNER_CITY = envField(import.meta.env.VITE_CSV_FIELD_OWNER_CITY);
const FIELD_OWNER_STATE = envField(import.meta.env.VITE_CSV_FIELD_OWNER_STATE);
const FIELD_OWNER_ZIP = envField(import.meta.env.VITE_CSV_FIELD_OWNER_ZIP);
const FIELD_OWNER_COUNTRY = envField(import.meta.env.VITE_CSV_FIELD_OWNER_COUNTRY);
const FIELD_CASH_BALANCE = envField(import.meta.env.VITE_CSV_FIELD_CURRENT_CASH_BALANCE);

export function resolveOwnerGroupingColumns(headers: string[]): OwnerGroupingColumns {
  return {
    pendingClaimsColumn: matchColumn(headers, [
      FIELD_PENDING_CLAIMS,
      'NUMBER_OF_PENDING_CLAIMS',
      'Number of Pending Claims',
      'PENDING_CLAIMS',
    ]),
    paidClaimsColumn: matchColumn(headers, [
      FIELD_PAID_CLAIMS,
      'NUMBER_OF_PAID_CLAIMS',
      'Number of Paid Claims',
      'PAID_CLAIMS',
    ]),
    ownerNameColumn: matchColumn(headers, [FIELD_OWNER_NAME, 'OWNER_NAME', 'Owner Name', 'OwnerName']),
    street1Column: matchColumn(headers, [
      FIELD_OWNER_STREET_1,
      'OWNER_STREET_1',
      'Owner Street 1',
      'OWNER_ADDRESS',
      'OWNER_STREET',
    ]),
    street2Column: matchColumn(headers, [FIELD_OWNER_STREET_2, 'OWNER_STREET_2', 'Owner Street 2']),
    street3Column: matchColumn(headers, [FIELD_OWNER_STREET_3, 'OWNER_STREET_3', 'Owner Street 3']),
    cityColumn: matchColumn(headers, [FIELD_OWNER_CITY, 'OWNER_CITY', 'Owner City', 'City']),
    stateColumn: matchColumn(headers, [FIELD_OWNER_STATE, 'OWNER_STATE', 'Owner State', 'State']),
    zipColumn: matchColumn(headers, [FIELD_OWNER_ZIP, 'OWNER_ZIP', 'Owner Zip', 'ZIP', 'ZIPCODE']),
    countryColumn: matchColumn(headers, [
      FIELD_OWNER_COUNTRY,
      'OWNER_COUNTRY_CODE',
      'Owner Country Code',
      'OWNER_COUNTRY',
    ]),
    propertyIdColumn: matchColumn(headers, [FIELD_PROPERTY_ID, 'PROPERTY_ID', 'Property ID', 'PropertyID']),
    cashBalanceColumn: matchColumn(headers, [
      FIELD_CASH_BALANCE,
      'CURRENT_CASH_BALANCE',
      'Cash Balance',
      'CashBalance',
      'Balance',
    ]),
  };
}

/** Columns without which a rule would be silently skipped. Filtration hard-blocks if any is missing. */
export function collectMissingRequiredColumns(columns: OwnerGroupingColumns): string[] {
  const missing: string[] = [];
  if (!columns.pendingClaimsColumn) missing.push('NUMBER_OF_PENDING_CLAIMS');
  if (!columns.paidClaimsColumn) missing.push('NUMBER_OF_PAID_CLAIMS');
  if (!columns.ownerNameColumn) missing.push('OWNER_NAME');
  if (!columns.street1Column) missing.push('OWNER_STREET_1');
  if (!columns.propertyIdColumn) missing.push('PROPERTY_ID');
  if (!columns.cashBalanceColumn) missing.push('CURRENT_CASH_BALANCE');
  return missing;
}

/** Rule 1: only properties with no pending AND no paid claims. NULL/unparsable counts as claimed. */
export function buildClaimGateSQL(columns: OwnerGroupingColumns): string {
  const parts = buildClaimGateParts(columns);
  const predicates = [parts.pendingOkSQL, parts.paidOkSQL].filter(
    (predicate): predicate is string => Boolean(predicate),
  );

  return predicates.length > 0 ? predicates.join('\n      AND ') : 'TRUE';
}

/**
 * The claim gate as its individual predicates, so the filtration report can say
 * whether a row was rejected for a pending claim, a paid claim, or an
 * unreadable claim value. `buildClaimGateSQL` composes these so the two cannot
 * drift apart.
 *
 * `pendingOkSQL` / `paidOkSQL` are TRUE when the row is acceptable;
 * `unreadableSQL` is TRUE when either count could not be parsed at all.
 */
export interface ClaimGateParts {
  pendingOkSQL: string | null;
  paidOkSQL: string | null;
  unreadableSQL: string;
}

export function buildClaimGateParts(columns: OwnerGroupingColumns): ClaimGateParts {
  const okPredicate = (column: string | null): string | null =>
    column ? `COALESCE(TRY_CAST(${quoteColumn(column)} AS BIGINT), -1) = 0` : null;

  const unreadableChecks = [columns.pendingClaimsColumn, columns.paidClaimsColumn]
    .filter((column): column is string => Boolean(column))
    .map((column) => `TRY_CAST(${quoteColumn(column)} AS BIGINT) IS NULL`);

  return {
    pendingOkSQL: okPredicate(columns.pendingClaimsColumn),
    paidOkSQL: okPredicate(columns.paidClaimsColumn),
    unreadableSQL: unreadableChecks.length > 0 ? `(${unreadableChecks.join(' OR ')})` : 'FALSE',
  };
}

/** Rule 6: a usable street address is mandatory. */
export function buildAddressRequiredSQL(columns: OwnerGroupingColumns): string {
  if (!columns.street1Column) {
    return 'TRUE';
  }

  const ref = quoteColumn(columns.street1Column);
  return `(${ref} IS NOT NULL AND trim(CAST(${ref} AS VARCHAR)) <> '')`;
}

/**
 * Rule 2: owner identity = exact owner name + exact address.
 *
 * Normalisation is trim + uppercase + whitespace collapse only. That absorbs
 * trailing/doubled spaces (data noise) without loosening the match itself.
 * Parts are joined with chr(31), a control character that cannot occur in the
 * source data, so values can never bleed across field boundaries.
 */
export function buildOwnerKeySQL(columns: OwnerGroupingColumns): string {
  const keyColumns = [
    columns.ownerNameColumn,
    columns.street1Column,
    columns.street2Column,
    columns.street3Column,
    columns.cityColumn,
    columns.stateColumn,
    columns.zipColumn,
    columns.countryColumn,
  ].filter((column): column is string => Boolean(column));

  const parts = keyColumns.map(
    (column) =>
      `upper(trim(regexp_replace(COALESCE(CAST(${quoteColumn(column)} AS VARCHAR), ''), '\\s+', ' ', 'g')))`,
  );

  return parts.join(` || chr(31) || `);
}
