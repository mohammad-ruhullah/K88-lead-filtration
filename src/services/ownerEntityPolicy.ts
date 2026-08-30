import { envField, matchColumn, quoteColumn } from './columnResolver';

/**
 * Individual-owner-only policy (client requirement: "only person data").
 *
 * The source CSV has no owner-type column, no business flag and no first/last
 * name split - `OWNER_NAME` is a single free-text field holding both
 * `ROBINSON EUDON JR` and `AMERICAN HOUSING TRUST`. So the only available
 * signal is the name itself, classified by keyword.
 *
 * Two tiers:
 *  - Tier A (hard): head nouns that name what an organisation *is*. A single
 *    match rejects the row outright.
 *  - Tier B (soft): words with real entity volume that are also real surnames
 *    (Church, Banks, Temple, Lodge, Co). A match rejects only when the name
 *    does not read as a person - see `buildOwnerEntityFilterParts`.
 *
 * The rule is purely negative: it rejects on evidence of an entity and never
 * requires proof of personhood. A given-name allowlist would silently delete
 * uncommon, immigrant and transliterated names (KOBZEFF CONSUELO, SINGH JASBIR,
 * NG MARINA KWA K) - exactly the leads nobody else is calling. A false positive
 * is a permanently lost lead; a false negative is one wasted phone call.
 */

export interface OwnerEntityColumnMapping {
  ownerNameColumn: string | null;
}

/**
 * Tier A - a single match rejects the row.
 *
 * These are HEAD NOUNS only: the thing the organisation *is*. Modifiers
 * (`american`, `first`, `national`) are deliberately absent - they are
 * redundant, because the head noun catches the name anyway, and they add risk
 * for nothing.
 *
 * Occupational and place words are banned from this list because they are
 * overwhelmingly surnames or given names in this dataset. Verified against a
 * 284,171-row sample, with row counts:
 *   loan 114 (NGUYEN LOAN T - Vietnamese given name), young 635, king 428,
 *   park 389 (Korean surname), hall 330, dean 228, st 226 (ST JOHN B),
 *   marshall 214, sun 173, house 150, bishop 105, glass 90, love 79, best 71,
 *   rich 61, marina 69, field 60, abbott 45, pa 45, cable 44, chapel 28,
 *   grill 24, bonds 14, parish 8 (all 8 are people), mart/market/music/records.
 * None of them may ever enter this list.
 */
const ENTITY_HARD_KEYWORDS = [
  // Legal forms
  'inc', 'incorporated', 'llc', 'llp', 'lllp', 'lp', 'plc', 'pllc', 'pc',
  'corp', 'corporation', 'company', 'companies', 'ltd', 'limited', 'gmbh',
  'bros', 'sons', 'dba',
  // Trust / estate / fiduciary
  'trust', 'trusts', 'trustee', 'trustees', 'ttee', 'tr', 'ua', 'uta', 'utd',
  'udt', 'dtd', 'uwo', 'estate', 'estates', 'irrevocable', 'revocable',
  'testamentary', 'conservator', 'custodian', 'fiduciary', 'fbo',
  // Financial
  'bancorp', 'bancshares', 'banking', 'credit union', 'savings', 'federal',
  'financial', 'finance', 'capital', 'securities', 'investment', 'investments',
  'holdings', 'holding', 'fund', 'funds', 'foundation', 'endowment', 'pension',
  'escrow', 'mortgage', 'lending', 'loans', 'equity', 'assets', 'title', 'ins',
  'insurance', 'assurance', 'underwriters', 'brokers', 'brokerage', 'agency',
  'agencies',
  // Organisational / civic
  'association', 'associations', 'assoc', 'assocs', 'assn', 'society',
  'societies', 'league', 'federation', 'council', 'committee', 'organization',
  'institute', 'institution', 'academy', 'university', 'college', 'school',
  'schools', 'department', 'dept', 'bureau', 'commission', 'authority',
  'administration', 'municipal', 'township', 'district', 'commonwealth',
  'county of', 'city of', 'town of', 'state of', 'local', 'club', 'fraternal',
  'veterans', 'legion',
  // Religious
  'baptist', 'methodist', 'catholic', 'lutheran', 'presbyterian', 'episcopal',
  'pentecostal', 'congregation', 'synagogue', 'mosque', 'islamic', 'ministries',
  'ministry', 'tabernacle', 'diocese', 'archdiocese', 'evangelical',
  'missionary',
  // Commercial
  'services', 'service', 'serv', 'svcs', 'svs', 'solutions', 'systems',
  'technologies', 'technology', 'consulting', 'consultants', 'contractors',
  'contracting', 'construction', 'const', 'constr', 'engineering',
  'development', 'management', 'mgmt', 'properties', 'realty', 'realtors',
  'enterprises', 'enterprise', 'industries', 'industrial', 'manufacturing',
  'mfg', 'distributing', 'distributors', 'distribution', 'wholesale', 'supply',
  'supplies', 'products', 'group', 'partners', 'partnership', 'ventures',
  'international', 'worldwide', 'communications', 'media', 'publishing',
  'productions', 'entertainment', 'broadcasting', 'radio', 'films', 'pictures',
  'studios',
  // Medical
  'laboratories', 'laboratory', 'labs', 'pharmaceutical', 'pharmacy', 'pharm',
  'medical', 'clinic', 'hospital', 'healthcare', 'dental', 'diagnostic',
  'diagnostics', 'imaging', 'surgical', 'veterinary',
  // Trade / retail / property
  'motors', 'automotive', 'trucking', 'transport', 'transportation',
  'logistics', 'airlines', 'tire', 'restaurant', 'catering', 'hotel', 'motel',
  'cafe', 'deli', 'pizza', 'bakery', 'liquor', 'liquors', 'tavern', 'lounge',
  'salon', 'cleaners', 'laundry', 'landscaping', 'plumbing', 'roofing',
  'remodeling', 'builders', 'lumber', 'hardware', 'furniture', 'apparel',
  'fashions', 'jewelers', 'florist', 'nursery', 'farms', 'ranch', 'dairy',
  'winery', 'brewery', 'center', 'centers', 'centre', 'museum', 'library',
  'theatre', 'theater', 'resort', 'apartments', 'apts', 'homes', 'housing',
  'village', 'storage', 'warehouse', 'printing', 'design', 'security',
  'staffing', 'personnel', 'employment', 'moving', 'energy', 'electric',
  'electrical', 'oil', 'gas', 'petroleum', 'utilities', 'telephone', 'telecom',
  'shop', 'store', 'stores',
  // Pure abbreviations - no surname collision exists for these, unlike the
  // spelled-out `mart` / `market` (MART CLARENCE N), which stay banned.
  'mkt', 'mkts', 'whse',
];

/**
 * Tier B - real entity volume, but also real surnames. Rejected only when the
 * name does not read as a person.
 *   co 2,408 (also the Filipino surname Co: HERMOGENES O CO)
 *   bank 555 (BANKS DEBRA A), church 106 (CHURCH MARY A), temple (KEEFER TEMPLE T)
 */
const ENTITY_SOFT_KEYWORDS = [
  'co', 'bank', 'banks', 'church', 'churches', 'temple', 'lodge', 'union',
];

/**
 * Words that betray an organisation when they sit alongside a Tier-B keyword.
 * This is what stops `BANK AMERICA N A` being rescued as a person.
 */
const ORG_CONTEXT_WORDS = [
  'of', 'the', 'and', 'america', 'american', 'national', 'first', 'united',
  'mutual', 'new', 'general', 'st', 'saint', 'holy', 'memorial', 'family',
  'community', 'valley', 'western', 'eastern', 'southern', 'northern',
  'central', 'us', 'usa', 'states',
];

const HARD_PATTERN = ENTITY_HARD_KEYWORDS.join('|');
const SOFT_PATTERN = ENTITY_SOFT_KEYWORDS.join('|');
const CONTEXT_PATTERN = ORG_CONTEXT_WORDS.join('|');

/** A person is `LAST FIRST MIDDLE [SUFFIX]`, so four tokens is the ceiling. */
const MAX_PERSON_TOKENS = 4;

const FIELD_OWNER_NAME = envField(import.meta.env.VITE_CSV_FIELD_OWNER_NAME);

const OWNER_NAME_COLUMN_CANDIDATES = [
  FIELD_OWNER_NAME,
  'OWNER_NAME',
  'Owner Name',
  'OwnerName',
];

export function resolveOwnerEntityColumns(headers: string[]): OwnerEntityColumnMapping {
  return {
    ownerNameColumn: matchColumn(headers, OWNER_NAME_COLUMN_CANDIDATES),
  };
}

/** Columns without which the rule would be silently skipped. Filtration hard-blocks if any is missing. */
export function collectMissingOwnerEntityColumns(mapping: OwnerEntityColumnMapping): string[] {
  return mapping.ownerNameColumn ? [] : ['OWNER_NAME'];
}

/**
 * Owner name normalised to a space-padded, punctuation-free, lower-cased
 * string, so `' keyword '` matches whole words by construction.
 *
 * DuckDB uses RE2: no lookahead/lookbehind, and `\y` is PostgreSQL-only. Padded
 * matching sidesteps word-boundary syntax entirely, and folds `L.L.C.` to
 * `l l c` and `C/O` to `c o` on the way.
 */
export function buildOwnerNameNormalizationSQL(
  mapping: OwnerEntityColumnMapping,
): string | null {
  if (!mapping.ownerNameColumn) {
    return null;
  }

  const ref = quoteColumn(mapping.ownerNameColumn);
  return `' ' || trim(regexp_replace(lower(COALESCE(CAST(${ref} AS VARCHAR), '')), '[^a-z0-9]+', ' ', 'g')) || ' '`;
}

/**
 * The individual-owner rule as its individual predicates, so the filtration
 * report can attribute each rejected row to the exact tier that rejected it.
 * `buildOwnerEntityFilterSQL` composes these, so the two can never drift.
 *
 * Each field is a predicate that is TRUE when the row is acceptable.
 */
export interface OwnerEntityFilterParts {
  hardEntitySQL: string | null;
  softEntitySQL: string | null;
}

/**
 * `normalizedNameRef` lets a caller that has already materialised the
 * normalised name pass its column name in, so the expression is evaluated once
 * per row rather than once per predicate reference - the soft predicate alone
 * reads it five times. Omit it and the normalisation is inlined, keeping the
 * module usable standalone.
 */
export function buildOwnerEntityFilterParts(
  mapping: OwnerEntityColumnMapping,
  normalizedNameRef?: string,
): OwnerEntityFilterParts {
  const name = normalizedNameRef ?? buildOwnerNameNormalizationSQL(mapping);
  if (!name) {
    return { hardEntitySQL: null, softEntitySQL: null };
  }

  // Spaces in a padded string = tokens + 1, so a 4-token name has 5.
  const maxSpaces = MAX_PERSON_TOKENS + 1;

  return {
    hardEntitySQL: `(NOT regexp_matches(${name}, ' (${HARD_PATTERN}) '))`,
    // A Tier-B hit is a person only when every rescue condition holds:
    //   1. the keyword sits in token position 0 or 1 - a real Church is
    //      `CHURCH MARY A`, an entity is `ADVANTA NATIONAL BANK`;
    //   2. the name is at most four tokens;
    //   3. it carries no digits (`SUBWAY 3395`);
    //   4. no organisation-context word (`BANK AMERICA N A`);
    //   5. no second Tier-B keyword (`UNION STAMPING CO`).
    softEntitySQL: `(
      NOT regexp_matches(${name}, ' (${SOFT_PATTERN}) ')
      OR (
        regexp_matches(${name}, '^ ([a-z0-9]+ )?(${SOFT_PATTERN}) ')
        AND length(${name}) - length(replace(${name}, ' ', '')) <= ${maxSpaces}
        AND NOT regexp_matches(${name}, '[0-9]')
        AND NOT regexp_matches(${name}, ' (${CONTEXT_PATTERN}) ')
        AND NOT regexp_matches(${name}, ' (${SOFT_PATTERN}) (.* )?(${SOFT_PATTERN}) ')
      )
    )`,
  };
}

export function buildOwnerEntityFilterSQL(
  mapping: OwnerEntityColumnMapping,
  normalizedNameRef?: string,
): string {
  const parts = buildOwnerEntityFilterParts(mapping, normalizedNameRef);

  const predicates = [parts.hardEntitySQL, parts.softEntitySQL].filter(
    (predicate): predicate is string => Boolean(predicate),
  );

  return predicates.length > 0 ? predicates.join('\n      AND ') : 'TRUE';
}
