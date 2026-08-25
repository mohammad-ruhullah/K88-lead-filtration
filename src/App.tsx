import { useEffect, useState, type ChangeEvent } from 'react';
import {
  duckDBRuntimeService,
  type DuckDBRuntimeLifecycle,
  type DuckDBRuntimeStatus,
  type RegisteredCSVFile,
} from './services/duckdbRuntime';
import { airtableService } from './services/airtableService';
import {
  buildPropertyTypeFilterParts,
  buildPropertyTypeFilterSQL,
  resolvePropertyTypeColumns,
} from './services/propertyTypePolicy';
import {
  buildAddressRequiredSQL,
  buildClaimGateParts,
  buildClaimGateSQL,
  buildOwnerKeySQL,
  collectMissingRequiredColumns,
  resolveOwnerGroupingColumns,
} from './services/ownerGroupingPolicy';
import { matchColumn } from './services/columnResolver';
import { FiltrationReport, type FiltrationReportData } from './components/FiltrationReport';

type FileRegistrationStatus = 'idle' | 'processing' | 'ready' | 'error';
type FilterRunStatus = 'idle' | 'running' | 'ready' | 'error';
type ExportStatus = 'idle' | 'exporting' | 'ready' | 'error';

interface HeaderSnapshot {
  fileName: string;
  columns: string[];
}

interface FilterCriteria {
  minCurrentCashBalance: number;
}

interface PreviewRow {
  PROPERTY_ID: string | null;
  PROPERTY_TYPE: string | null;
  OWNER_NAME: string | null;
  OWNER_STREET_1: string | null;
  OWNER_CITY: string | null;
  OWNER_STATE: string | null;
  CURRENT_CASH_BALANCE: string | number | null;
  HOLDER_NAME: string | null;
  OWNER_GROUP_TOTAL: string | number | null;
  OWNER_GROUP_PROPERTY_COUNT: string | number | null;
  OWNER_GROUP_ID: string | number | null;
}

const EMPTY_REPORT: FiltrationReportData = {
  rowsScanned: '0',
  unreadableClaim: '0',
  pendingClaim: '0',
  paidClaim: '0',
  noAddress: '0',
  deniedKeyword: '0',
  notCashCode: '0',
  sharesReported: '0',
  hasCusip: '0',
  securitiesNamed: '0',
  alreadyInCrm: '0',
  belowThreshold: '0',
  qualifiedRows: '0',
  ownerGroupsFormed: '0',
  ownersQualified: '0',
  ownersBelowThreshold: '0',
  unlockedByGrouping: '0',
};

/** Tile figures derived from the report, so both read from one source of truth. */
function summarise(report: FiltrationReportData) {
  const n = (value: string) => Number(value ?? 0);
  return {
    skippedClaimed: n(report.unreadableClaim) + n(report.pendingClaim) + n(report.paidClaim),
    skippedNonCash:
      n(report.deniedKeyword) +
      n(report.notCashCode) +
      n(report.sharesReported) +
      n(report.hasCusip) +
      n(report.securitiesNamed),
  };
}

const DEFAULT_FILTER_CRITERIA: FilterCriteria = {
  minCurrentCashBalance: 5000,
};

const FILTERED_DATASET_VIEW_NAME = 'merged_filtered_dataset';
const ELIGIBLE_ROWS_TABLE_NAME = 'eligible_rows';
const OWNER_TOTALS_TABLE_NAME = 'owner_totals';

const RUNTIME_STATUS_LABELS: Record<DuckDBRuntimeStatus, string> = {
  idle: 'Idle',
  initializing: 'Initializing',
  ready: 'Ready',
  error: 'Error',
};

const RUNTIME_STATUS_BADGE_STYLES: Record<DuckDBRuntimeStatus, string> = {
  idle: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  initializing: 'bg-amber-500/10 text-amber-500 ring-amber-500/20',
  ready: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20',
  error: 'bg-rose-500/10 text-rose-500 ring-rose-500/20',
};

const FILE_STATUS_LABELS: Record<FileRegistrationStatus, string> = {
  idle: 'No Assets Loaded',
  processing: 'Analyzing...',
  ready: 'Assets Registered',
  error: 'Registration Issue',
};

const FILE_STATUS_BADGE_STYLES: Record<FileRegistrationStatus, string> = {
  idle: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  processing: 'bg-amber-500/10 text-amber-500 ring-amber-500/20',
  ready: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20',
  error: 'bg-rose-500/10 text-rose-500 ring-rose-500/20',
};

const FILTER_STATUS_LABELS: Record<FilterRunStatus, string> = {
  idle: 'Awaiting Filtration',
  running: 'Filtering Assets...',
  ready: 'Filtration Complete',
  error: 'Filtration Failed',
};

const FILTER_STATUS_BADGE_STYLES: Record<FilterRunStatus, string> = {
  idle: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  running: 'bg-amber-500/10 text-amber-500 ring-amber-500/20',
  ready: 'bg-emerald-500/10 text-emerald-100 ring-emerald-500/30',
  error: 'bg-rose-500/10 text-rose-500 ring-rose-500/20',
};

const EXPORT_STATUS_LABELS: Record<ExportStatus, string> = {
  idle: 'Pending Export',
  exporting: 'Preparing CSV...',
  ready: 'Export Successful',
  error: 'Export Failed',
};

const EXPORT_STATUS_BADGE_STYLES: Record<ExportStatus, string> = {
  idle: 'bg-slate-500/10 text-slate-400 ring-slate-500/20',
  exporting: 'bg-amber-500/10 text-amber-500 ring-amber-500/20',
  ready: 'bg-emerald-500/10 text-emerald-500 ring-emerald-500/20',
  error: 'bg-rose-500/10 text-rose-500 ring-rose-500/20',
};

// --- UI Components for Processing & Errors ---

const ProcessingOverlay = ({ message }: { message: string }) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#020617]/80 backdrop-blur-sm">
    <div className="flex flex-col items-center gap-4">
      <div className="relative">
        <div className="h-12 w-12 animate-spin rounded-full border-4 border-amber-500/20 border-t-amber-500" />
        <div className="absolute inset-0 h-12 w-12 animate-pulse rounded-full bg-amber-500/10" />
      </div>
      <p className="text-sm font-medium text-amber-500">{message}</p>
    </div>
  </div>
);

const ErrorModal = ({ title, message, onClose }: { title: string; message: string; onClose: () => void }) => (
  <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-md p-6">
    <div className="w-full max-w-md overflow-hidden rounded-2xl border border-rose-500/20 bg-slate-900 shadow-2xl">
      <div className="border-b border-rose-500/10 bg-rose-500/5 px-6 py-4">
        <h3 className="flex items-center gap-2 text-lg font-bold text-rose-400">
          <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          {title}
        </h3>
      </div>
      <div className="p-6">
        <p className="text-sm leading-relaxed text-slate-300">{message}</p>
        <button
          onClick={onClose}
          className="mt-6 w-full rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-700"
        >
          Dismiss
        </button>
      </div>
    </div>
  </div>
);

const SuccessModal = ({
  count,
  excludedCount,
  ownerCount,
  unlockedCount,
  onDownload,
  onClose,
  isDownloading,
}: {
  count: string;
  excludedCount: string;
  ownerCount: string;
  unlockedCount: string;
  onDownload: () => void;
  onClose: () => void;
  isDownloading: boolean;
}) => (
  <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-md p-6">
    <div className="w-full max-w-md overflow-hidden rounded-3xl border border-emerald-500/20 bg-slate-900 shadow-[0_0_50px_rgba(16,185,129,0.1)]">
      <div className="flex flex-col items-center p-8 text-center">
        <div className="mb-6 flex h-20 w-20 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.2)]">
          <svg className="h-10 w-10" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        
        <h3 className="text-2xl font-bold text-white">Filtration Complete</h3>
        <p className="mt-2 text-slate-400">Unclaimed cash assets, grouped by owner and deduplicated.</p>

        <div className="mt-8 flex flex-col items-center gap-1">
          <span className="text-5xl font-black text-emerald-400">
            {Number(ownerCount).toLocaleString()}
          </span>
          <span className="text-xs font-bold uppercase tracking-widest text-emerald-500/60">
            Owners Qualified
          </span>
          <p className="mt-1 text-sm text-slate-400">
            across {Number(count).toLocaleString()} properties
          </p>
        </div>

        {unlockedCount !== '0' && (
          <div className="mt-6 w-full rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
            <p className="text-lg font-bold text-amber-400">
              {Number(unlockedCount).toLocaleString()}
            </p>
            <p className="text-[10px] leading-relaxed text-slate-400">
              of these qualified <span className="font-semibold text-amber-400/80">only</span> by
              combining multiple properties &mdash; every one would have been missed before.
            </p>
          </div>
        )}

        {excludedCount !== '0' && (
          <p className="mt-4 text-[10px] text-slate-500">
            {Number(excludedCount).toLocaleString()} non-cash assets skipped by the cash-only rule
          </p>
        )}

        <div className="mt-10 grid w-full grid-cols-1 gap-3">
          <button
            onClick={onDownload}
            disabled={isDownloading || count === '0'}
            className="flex items-center justify-center gap-2 rounded-2xl bg-emerald-600 px-6 py-4 text-sm font-bold text-black transition hover:bg-emerald-500 disabled:opacity-30"
          >
            {isDownloading ? (
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            ) : (
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            )}
            Download Qualified CSV
          </button>
          
          <button
            onClick={onClose}
            className="rounded-2xl border border-white/5 bg-white/5 px-6 py-4 text-sm font-bold text-slate-400 transition hover:bg-white/10 hover:text-white"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  </div>
);

function App() {
  const [lifecycle, setLifecycle] = useState<DuckDBRuntimeLifecycle>(() =>
    duckDBRuntimeService.getLifecycle(),
  );
  const [duckDBVersion, setDuckDBVersion] = useState<string>('Pending');

  // Processing & Error State
  const [isProcessing, setIsProcessing] = useState(false);
  const [processingMessage, setProcessingMessage] = useState('');
  const [errorModal, setErrorModal] = useState<{ title: string; message: string } | null>(null);
  const [isSuccessModalOpen, setIsSuccessModalOpen] = useState(false);

  const [fileStatus, setFileStatus] = useState<FileRegistrationStatus>('idle');
  const [fileMessage, setFileMessage] = useState<string>(
    'Upload local CSV files to begin the asset filtration process.',
  );
  const [fileError, setFileError] = useState<string | null>(null);
  const [registeredFiles, setRegisteredFiles] = useState<RegisteredCSVFile[]>([]);
  const [referenceHeader, setReferenceHeader] = useState<string[]>([]);

  const [isCustomRuleEnabled, setIsCustomRuleEnabled] = useState(false);
  const [filterCriteria, setFilterCriteria] = useState<FilterCriteria>(DEFAULT_FILTER_CRITERIA);
  const [filterStatus, setFilterStatus] = useState<FilterRunStatus>('idle');
  const [filterMessage, setFilterMessage] = useState<string>(
    'Configure criteria and click "Start Filtration" to filter assets.',
  );
  const [filterError, setFilterError] = useState<string | null>(null);
  const [filteredRowCount, setFilteredRowCount] = useState<string>('0');
  const [excludedNonCashCount, setExcludedNonCashCount] = useState<string>('0');
  const [report, setReport] = useState<FiltrationReportData>(EMPTY_REPORT);
  const tiles = summarise(report);
  const [previewRows, setPreviewRows] = useState<PreviewRow[]>([]);
  const [exportStatus, setExportStatus] = useState<ExportStatus>('idle');

  useEffect(() => {
    const unsubscribe = duckDBRuntimeService.subscribe(setLifecycle);

    void duckDBRuntimeService
      .initialize()
      .then(() => duckDBRuntimeService.getVersion())
      .then((version) => {
        setDuckDBVersion(version);
      })
      .catch(() => {
        setDuckDBVersion('Unavailable');
      });

    return () => {
      unsubscribe();
    };
  }, []);

  const handleCSVSelection = async (
    event: ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const selectedFiles = Array.from(event.target.files ?? []);

    if (selectedFiles.length === 0) {
      return;
    }

    setFileStatus('processing');
    setFileError(null);
    setFileMessage('Reading small header slices and validating schema consistency.');

    try {
      const headerSnapshots = await Promise.all(
        selectedFiles.map(async (file) => ({
          fileName: file.name,
          columns: await readCSVHeaderColumns(file),
        })),
      );

      const baselineHeader = headerSnapshots[0]?.columns ?? [];
      const mismatchDetails = collectHeaderMismatches(headerSnapshots);

      if (mismatchDetails.length > 0) {
        await duckDBRuntimeService.clearRegisteredCSVFiles();
        setRegisteredFiles([]);
        setReferenceHeader(baselineHeader);
        setFileStatus('error');
        setFileError(mismatchDetails.join(' | '));
        setFileMessage('Selected files do not share the same header schema.');
        resetFilterResults();
        return;
      }

      const registered = await duckDBRuntimeService.registerCSVFiles(selectedFiles);
      setRegisteredFiles(registered);
      setReferenceHeader(baselineHeader);
      setFileStatus('ready');
      setFileError(null);
      setFileMessage(
        `${registered.length} file(s) registered from local machine using browser file handles.`,
      );
      resetFilterResults();
    } catch (error) {
      setRegisteredFiles([]);
      setFileStatus('error');
      setFileMessage('Registration failed.');
      setFileError(toErrorMessage(error));
      resetFilterResults();
    } finally {
      event.target.value = '';
    }
  };

  const runFilterPipeline = async (): Promise<void> => {
    if (registeredFiles.length === 0) {
      return;
    }

    if (referenceHeader.length === 0) {
      setFilterStatus('error');
      setFilterError('Asset metadata is missing. Please re-import files.');
      return;
    }

    // Resolve owner identity, claim gate and address columns
    const ownerColumns = resolveOwnerGroupingColumns(referenceHeader);

    // Resolve property type + securities evidence columns for the cash-only rule
    const propertyTypeColumns = resolvePropertyTypeColumns(referenceHeader);

    // Hard-block rather than silently skipping a rule when a column is absent.
    const missingColumns = collectMissingRequiredColumns(ownerColumns);
    if (missingColumns.length > 0) {
      setFilterStatus('error');
      setFilterError(
        `Could not find required columns in CSV: ${missingColumns.join(', ')}. ` +
          'These are needed for the claim gate, address rule and owner grouping, so filtration was blocked.',
      );
      return;
    }

    if (!propertyTypeColumns.typeColumn) {
      setFilterStatus('error');
      setFilterError(
        'Could not find the property type column (PROPERTY_TYPE) in CSV. It is required to enforce the cash-only rule, so filtration was blocked.',
      );
      return;
    }

    const csvPropIdCol = ownerColumns.propertyIdColumn as string;
    const csvOwnerNameCol = ownerColumns.ownerNameColumn as string;
    const csvCashBalanceCol = ownerColumns.cashBalanceColumn as string;

    setIsProcessing(true);
    resetExportState();
    setFilterStatus('running');
    setFilterError(null);

    const connection = duckDBRuntimeService.getConnection();

    try {
      // Step 1: Sync with Airtable
      setProcessingMessage('Syncing with Airtable database...');
      const existingLeads = await airtableService.fetchAllExistingLeads();

      // Step 2: Register existing leads in DuckDB
      setProcessingMessage('Analyzing duplicates...');
      await duckDBRuntimeService.registerExistingLeads(existingLeads);

      // Step 3: Run SQL Pipeline with Anti-Join
      setProcessingMessage('Applying filtration rules and deduplicating...');
      
      const sourceSQL = buildUnionSourceSQL(
        registeredFiles.map((file) => file.virtualPath),
        referenceHeader
      );
      const minBalanceLiteral = toSQLNumericLiteral(filterCriteria.minCurrentCashBalance);
      const propertyTypeFilterSQL = buildPropertyTypeFilterSQL(propertyTypeColumns);
      const claimGateSQL = buildClaimGateSQL(ownerColumns);
      const addressRequiredSQL = buildAddressRequiredSQL(ownerColumns);
      const ownerKeySQL = buildOwnerKeySQL(ownerColumns);
      const csvTypeCol = propertyTypeColumns.typeColumn as string;

      const dropAirtableTableSQL = `DROP TABLE IF EXISTS airtable_leads_lookup`;

      // Create a temporary table for Airtable leads for efficient joining
      const createAirtableLookupSQL = `
        CREATE TEMP TABLE airtable_leads_lookup AS
        SELECT DISTINCT * FROM read_csv_auto('airtable_existing_leads.csv', header=true)
      `;

      // Step A - a single CSV pass applying every row-level gate, in order:
      //   claim gate -> address required -> cash-only policy -> Airtable dedupe.
      // The dedupe deliberately runs BEFORE any summing, so a property already
      // in the CRM can never help an owner reach the threshold.
      const materializeEligibleSQL = `
        CREATE TEMP TABLE ${ELIGIBLE_ROWS_TABLE_NAME} AS
        SELECT
          csv.*,
          ${ownerKeySQL} AS __owner_key,
          TRY_CAST(csv."${csvCashBalanceCol}" AS DOUBLE) AS __balance
        ${sourceSQL} AS csv
        LEFT JOIN airtable_leads_lookup AS air
          ON TRIM(UPPER(CAST(csv."${csvPropIdCol}" AS VARCHAR))) = TRIM(UPPER(CAST(air."PROPERTY_ID" AS VARCHAR)))
          AND TRIM(UPPER(CAST(csv."${csvOwnerNameCol}" AS VARCHAR))) = TRIM(UPPER(CAST(air."OWNER_NAME" AS VARCHAR)))
        WHERE ${claimGateSQL}
          AND ${addressRequiredSQL}
          AND ${propertyTypeFilterSQL}
          AND air."PROPERTY_ID" IS NULL
      `;

      // Step B - owner totals summed over DISTINCT properties. A jointly held
      // property emits one row per co-owner sharing a PROPERTY_ID, so summing
      // rows would invent money that does not exist.
      const materializeOwnerTotalsSQL = `
        CREATE TEMP TABLE ${OWNER_TOTALS_TABLE_NAME} AS
        WITH per_property AS (
          SELECT
            __owner_key,
            "${csvPropIdCol}" AS __property_id,
            MAX(__balance) AS __property_balance
          FROM ${ELIGIBLE_ROWS_TABLE_NAME}
          GROUP BY __owner_key, __property_id
        )
        SELECT
          __owner_key,
          SUM(COALESCE(__property_balance, 0)) AS __owner_total,
          COUNT(*)::BIGINT AS __owner_property_count,
          MAX(COALESCE(__property_balance, 0)) AS __max_property_balance
        FROM per_property
        GROUP BY __owner_key
      `;

      // Step C - keep EVERY row of a qualifying owner (small properties ride
      // along) and order so an owner's properties sit on consecutive rows.
      const materializeSQL = `
        CREATE TEMP TABLE ${FILTERED_DATASET_VIEW_NAME} AS
        SELECT
          e.*,
          t.__owner_total,
          t.__owner_property_count,
          DENSE_RANK() OVER (ORDER BY t.__owner_total DESC, e.__owner_key) AS __owner_group_id
        FROM ${ELIGIBLE_ROWS_TABLE_NAME} e
        JOIN ${OWNER_TOTALS_TABLE_NAME} t USING (__owner_key)
        WHERE t.__owner_total >= ${minBalanceLiteral}
        ORDER BY t.__owner_total DESC, e.__owner_key, e."${csvPropIdCol}"
      `;

      const countSQL = `
        SELECT COUNT(*)::BIGINT AS row_count
        FROM ${FILTERED_DATASET_VIEW_NAME}
      `;

      // One scan producing the full rejection funnel.
      //
      // Every predicate is evaluated exactly ONCE per row in the `flags`
      // subquery, then aggregated over the resulting booleans. Repeating them
      // inside a dozen FILTER clauses would re-run regexp_matches a dozen times
      // per row across millions of rows.
      //
      // Each FILTER is conditioned on passing all PRIOR stages, which is what
      // makes the reasons mutually exclusive and the funnel reconcile:
      //   rows scanned - sum(all reasons) === qualified
      //
      // The CRM check uses EXISTS rather than a LEFT JOIN: a join would inflate
      // COUNT(*) if the Airtable lookup held a duplicate (PROPERTY_ID,
      // OWNER_NAME) pair, silently corrupting total_rows.
      const claimParts = buildClaimGateParts(ownerColumns);
      const typeParts = buildPropertyTypeFilterParts(propertyTypeColumns);
      const flag = (sql: string | null): string => sql ?? 'TRUE';

      const funnelSQL = `
        WITH flags AS (
          SELECT
            ${claimParts.unreadableSQL} AS bad_claim,
            ${flag(claimParts.pendingOkSQL)} AS pend_ok,
            ${flag(claimParts.paidOkSQL)} AS paid_ok,
            ${addressRequiredSQL} AS addr_ok,
            ${flag(typeParts.keywordSQL)} AS kw_ok,
            ${flag(typeParts.codeSQL)} AS code_ok,
            ${flag(typeParts.sharesSQL)} AS sh_ok,
            ${flag(typeParts.cusipSQL)} AS cu_ok,
            ${flag(typeParts.securitiesNameSQL)} AS sn_ok,
            EXISTS (
              SELECT 1 FROM airtable_leads_lookup air
              WHERE TRIM(UPPER(CAST(csv."${csvPropIdCol}" AS VARCHAR))) = TRIM(UPPER(CAST(air."PROPERTY_ID" AS VARCHAR)))
                AND TRIM(UPPER(CAST(csv."${csvOwnerNameCol}" AS VARCHAR))) = TRIM(UPPER(CAST(air."OWNER_NAME" AS VARCHAR)))
            ) AS in_crm
          ${sourceSQL} AS csv
        ), staged AS (
          SELECT
            *,
            (NOT bad_claim AND pend_ok AND paid_ok) AS ok_claim,
            (kw_ok AND code_ok AND sh_ok AND cu_ok AND sn_ok) AS ok_cash
          FROM flags
        )
        SELECT
          COUNT(*)::BIGINT AS total_rows,
          COUNT(*) FILTER (WHERE bad_claim)::BIGINT AS c_unreadable_claim,
          COUNT(*) FILTER (WHERE NOT bad_claim AND NOT pend_ok)::BIGINT AS c_pending,
          COUNT(*) FILTER (WHERE NOT bad_claim AND pend_ok AND NOT paid_ok)::BIGINT AS c_paid,
          COUNT(*) FILTER (WHERE ok_claim AND NOT addr_ok)::BIGINT AS c_no_address,
          COUNT(*) FILTER (WHERE ok_claim AND addr_ok AND NOT kw_ok)::BIGINT AS c_denied_keyword,
          COUNT(*) FILTER (WHERE ok_claim AND addr_ok AND kw_ok AND NOT code_ok)::BIGINT AS c_not_cash_code,
          COUNT(*) FILTER (WHERE ok_claim AND addr_ok AND kw_ok AND code_ok AND NOT sh_ok)::BIGINT AS c_shares,
          COUNT(*) FILTER (WHERE ok_claim AND addr_ok AND kw_ok AND code_ok AND sh_ok AND NOT cu_ok)::BIGINT AS c_cusip,
          COUNT(*) FILTER (WHERE ok_claim AND addr_ok AND kw_ok AND code_ok AND sh_ok AND cu_ok AND NOT sn_ok)::BIGINT AS c_securities_named,
          COUNT(*) FILTER (WHERE ok_claim AND addr_ok AND ok_cash AND in_crm)::BIGINT AS c_in_crm
        FROM staged
      `;

      // Threshold stage and owner-level counts run on the already-materialised
      // tables, so neither costs another pass over the CSVs.
      const thresholdSQL = `
        SELECT
          COUNT(*) FILTER (WHERE t.__owner_total < ${minBalanceLiteral})::BIGINT AS rows_below_threshold,
          COUNT(*) FILTER (WHERE t.__owner_total >= ${minBalanceLiteral})::BIGINT AS rows_qualified
        FROM ${ELIGIBLE_ROWS_TABLE_NAME} e
        JOIN ${OWNER_TOTALS_TABLE_NAME} t USING (__owner_key)
      `;

      // "Unlocked by grouping" = owners that qualify only because their
      // properties were combined; no single property reached the threshold.
      const ownerStatsSQL = `
        SELECT
          COUNT(*)::BIGINT AS owner_groups_formed,
          COUNT(*) FILTER (WHERE __owner_total >= ${minBalanceLiteral})::BIGINT AS qualifying_owners,
          COUNT(*) FILTER (WHERE __owner_total < ${minBalanceLiteral})::BIGINT AS owners_below_threshold,
          COUNT(*) FILTER (
            WHERE __owner_total >= ${minBalanceLiteral}
              AND __owner_property_count > 1
              AND __max_property_balance < ${minBalanceLiteral}
          )::BIGINT AS unlocked_by_grouping
        FROM ${OWNER_TOTALS_TABLE_NAME}
      `;

      const previewSQL = `
        SELECT
          "${csvPropIdCol}" AS "PROPERTY_ID",
          "${csvTypeCol}" AS "PROPERTY_TYPE",
          "${csvOwnerNameCol}" AS "OWNER_NAME",
          "${ownerColumns.street1Column}" AS "OWNER_STREET_1",
          "${matchColumn(referenceHeader, ['OWNER_CITY', 'Owner City', 'City']) || csvOwnerNameCol}" AS "OWNER_CITY",
          "${matchColumn(referenceHeader, ['OWNER_STATE', 'Owner State', 'State']) || csvOwnerNameCol}" AS "OWNER_STATE",
          "${csvCashBalanceCol}" AS "CURRENT_CASH_BALANCE",
          "${matchColumn(referenceHeader, ['HOLDER_NAME', 'Holder Name', 'Holder']) || csvOwnerNameCol}" AS "HOLDER_NAME",
          __owner_total AS "OWNER_GROUP_TOTAL",
          __owner_property_count AS "OWNER_GROUP_PROPERTY_COUNT",
          __owner_group_id AS "OWNER_GROUP_ID"
        FROM ${FILTERED_DATASET_VIEW_NAME}
        ORDER BY __owner_total DESC, __owner_key, "${csvPropIdCol}"
        LIMIT 30
      `;

      await connection.query(`DROP TABLE IF EXISTS ${FILTERED_DATASET_VIEW_NAME}`);
      await connection.query(`DROP TABLE IF EXISTS ${OWNER_TOTALS_TABLE_NAME}`);
      await connection.query(`DROP TABLE IF EXISTS ${ELIGIBLE_ROWS_TABLE_NAME}`);
      await connection.query(dropAirtableTableSQL);
      await connection.query(createAirtableLookupSQL);

      setProcessingMessage('Applying claim, address and cash-only rules...');
      await connection.query(materializeEligibleSQL);

      setProcessingMessage('Grouping properties by owner and totalling...');
      await connection.query(materializeOwnerTotalsSQL);
      await connection.query(materializeSQL);

      setProcessingMessage('Summarising results...');

      const countResult = await connection.query(countSQL);
      const countRow = countResult.toArray()[0]?.toJSON() as
        | { row_count?: string | number | bigint }
        | undefined;

      const funnelResult = await connection.query(funnelSQL);
      const funnelRow = funnelResult.toArray()[0]?.toJSON() as
        | Record<string, string | number | bigint>
        | undefined;

      const thresholdResult = await connection.query(thresholdSQL);
      const thresholdRow = thresholdResult.toArray()[0]?.toJSON() as
        | Record<string, string | number | bigint>
        | undefined;

      const ownerStatsResult = await connection.query(ownerStatsSQL);
      const ownerStatsRow = ownerStatsResult.toArray()[0]?.toJSON() as
        | Record<string, string | number | bigint>
        | undefined;

      const previewResult = await connection.query(previewSQL);
      const nextPreviewRows = previewResult
        .toArray()
        .map((row) => row.toJSON() as PreviewRow);

      const cell = (
        row: Record<string, string | number | bigint> | undefined,
        key: string,
      ): string => String(row?.[key] ?? 0);

      const nextReport: FiltrationReportData = {
        rowsScanned: cell(funnelRow, 'total_rows'),
        unreadableClaim: cell(funnelRow, 'c_unreadable_claim'),
        pendingClaim: cell(funnelRow, 'c_pending'),
        paidClaim: cell(funnelRow, 'c_paid'),
        noAddress: cell(funnelRow, 'c_no_address'),
        deniedKeyword: cell(funnelRow, 'c_denied_keyword'),
        notCashCode: cell(funnelRow, 'c_not_cash_code'),
        sharesReported: cell(funnelRow, 'c_shares'),
        hasCusip: cell(funnelRow, 'c_cusip'),
        securitiesNamed: cell(funnelRow, 'c_securities_named'),
        alreadyInCrm: cell(funnelRow, 'c_in_crm'),
        belowThreshold: cell(thresholdRow, 'rows_below_threshold'),
        qualifiedRows: String(countRow?.row_count ?? 0),
        ownerGroupsFormed: cell(ownerStatsRow, 'owner_groups_formed'),
        ownersQualified: cell(ownerStatsRow, 'qualifying_owners'),
        ownersBelowThreshold: cell(ownerStatsRow, 'owners_below_threshold'),
        unlockedByGrouping: cell(ownerStatsRow, 'unlocked_by_grouping'),
      };

      const qualifyingOwners = nextReport.ownersQualified;
      const unlockedByGrouping = nextReport.unlockedByGrouping;

      setFilteredRowCount(String(countRow?.row_count ?? 0));
      setExcludedNonCashCount(String(summarise(nextReport).skippedNonCash));
      setReport(nextReport);
      setPreviewRows(nextPreviewRows);
      setFilterStatus('ready');
      setFilterError(null);
      setFilterMessage(
        `Filtration complete. ${Number(qualifyingOwners).toLocaleString()} qualifying owners across ` +
          `${Number(countRow?.row_count ?? 0).toLocaleString()} properties. ` +
          `${Number(unlockedByGrouping).toLocaleString()} owners qualified only by combining their properties.`,
      );
      setIsSuccessModalOpen(true);
    } catch (error) {
      setFilterStatus('error');
      const msg = toErrorMessage(error);
      setFilterError(msg);
      setFilterMessage('Filtration pipeline failed.');
      setFilteredRowCount('0');
      setExcludedNonCashCount('0');
      setReport(EMPTY_REPORT);
      setPreviewRows([]);
      setErrorModal({
        title: 'Filtration Pipeline Failed',
        message: msg,
      });
    } finally {
      setIsProcessing(false);
      setProcessingMessage('');
    }
  };

  const downloadFilteredCSV = async (): Promise<void> => {
    if (filterStatus !== 'ready') {
      return;
    }

    const connection = duckDBRuntimeService.getConnection();
    const now = new Date();
    const formattedDate = now.toISOString().split('T')[0]; // YYYY-MM-DD
    const downloadFileName = `K88_Qualified Lead_${formattedDate}_${filteredRowCount}.csv`;
    const virtualExportPath = `filtered_export_${Date.now()}.csv`;

    setExportStatus('exporting');

    try {
      // A materialised table does not guarantee scan order, so the grouping
      // order is re-stated here or it would be lost in the downloaded file.
      // Internal helper columns are dropped; the group columns are exported
      // under client-facing names alongside every original CSV column.
      await connection.query(`
        COPY (
          SELECT
            * EXCLUDE (__owner_key, __balance, __owner_total, __owner_property_count, __owner_group_id),
            __owner_group_id AS "OWNER_GROUP_ID",
            __owner_property_count AS "OWNER_GROUP_PROPERTY_COUNT",
            __owner_total AS "OWNER_GROUP_TOTAL"
          FROM ${FILTERED_DATASET_VIEW_NAME}
          ORDER BY __owner_group_id, __balance DESC
        ) TO '${virtualExportPath}' (FORMAT csv, HEADER true)
      `);

      const buffer = await duckDBRuntimeService.copyFileToBuffer(virtualExportPath);
      downloadBufferAsFile(buffer, downloadFileName, 'text/csv');

      setExportStatus('ready');
    } catch (error) {
      setExportStatus('error');
      const msg = toErrorMessage(error);
      setErrorModal({
        title: 'CSV Export Failed',
        message: msg,
      });
    } finally {
      try {
        await duckDBRuntimeService.dropFile(virtualExportPath);
      } catch {
        // Ignore export cleanup issues.
      }
    }
  };

  const resetFilterResults = (): void => {
    setFilterStatus('idle');
    setFilterMessage('Filter is configured but has not run yet.');
    setFilterError(null);
    setFilteredRowCount('0');
    setExcludedNonCashCount('0');
    setReport(EMPTY_REPORT);
    setPreviewRows([]);
    setIsSuccessModalOpen(false);
    resetExportState();
  };

  const resetExportState = (): void => {
    setExportStatus('idle');
  };

  return (
    <main className="min-h-screen bg-[#020617] text-slate-200 selection:bg-amber-500/30">
      {isProcessing && <ProcessingOverlay message={processingMessage} />}
      {errorModal && (
        <ErrorModal
          title={errorModal.title}
          message={errorModal.message}
          onClose={() => setErrorModal(null)}
        />
      )}
      {isSuccessModalOpen && (
        <SuccessModal
          count={filteredRowCount}
          excludedCount={excludedNonCashCount}
          ownerCount={report.ownersQualified}
          unlockedCount={report.unlockedByGrouping}
          onDownload={() => void downloadFilteredCSV()}
          onClose={() => setIsSuccessModalOpen(false)}
          isDownloading={exportStatus === 'exporting'}
        />
      )}
      {/* Navigation / Header */}
      <nav className="sticky top-0 z-50 border-b border-white/5 bg-[#020617]/80 backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500 shadow-[0_0_20px_rgba(245,158,11,0.3)]">
              <svg
                className="h-6 w-6 text-black"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z"
                />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-white">Kollective88</h1>
              <p className="text-[10px] font-medium uppercase tracking-[0.2em] text-amber-500/80">
                Asset Recovery
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2 rounded-full border border-white/5 bg-white/5 px-3 py-1.5">
              <div
                className={`h-2 w-2 animate-pulse rounded-full ${lifecycle.status === 'ready' ? 'bg-emerald-500' : 'bg-amber-500'}`}
              />
              <span className="text-xs font-medium text-slate-400">
                {RUNTIME_STATUS_LABELS[lifecycle.status]}
              </span>
            </div>
            <span className="text-[10px] font-mono text-slate-500">v{duckDBVersion}</span>
          </div>
        </div>
      </nav>

      <div className="mx-auto max-w-7xl px-6 py-8">
        <div className="grid gap-8 lg:grid-cols-12">
          {/* Left Column: Controls */}
          <div className="space-y-6 lg:col-span-4">
            {/* File Registration Card */}
            <section className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/40 p-6 shadow-xl">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <svg
                  className="h-4 w-4 text-amber-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"
                  />
                </svg>
                Asset Import
              </h2>
              <p className="mt-1 text-xs text-slate-400">Register local CSV files for analysis.</p>

              <div className="mt-6">
                <label className="group relative flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed border-white/10 bg-white/5 py-8 transition hover:border-amber-500/50 hover:bg-amber-500/5">
                  <svg
                    className="h-8 w-8 text-slate-500 transition group-hover:text-amber-500"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={1.5}
                      d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  <span className="mt-3 text-sm font-medium text-slate-300">Choose CSV Files</span>
                  <span className="mt-1 text-[10px] text-slate-500">
                    Files remain private on your device
                  </span>
                  <input
                    type="file"
                    accept=".csv,text/csv"
                    multiple
                    className="hidden"
                    onChange={(event) => {
                      void handleCSVSelection(event);
                    }}
                  />
                </label>
              </div>

              <div className="mt-4 flex items-center justify-between">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${FILE_STATUS_BADGE_STYLES[fileStatus]}`}
                >
                  {FILE_STATUS_LABELS[fileStatus]}
                </span>
              </div>

              {fileError && (
                <div className="mt-4 rounded-lg border border-rose-500/20 bg-rose-500/5 p-3 text-xs text-rose-400">
                  {fileError}
                </div>
              )}

              {registeredFiles.length > 0 && (
                <div className="mt-6 space-y-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                    Selected Assets
                  </p>
                  {registeredFiles.map((file) => (
                    <div
                      key={file.virtualPath}
                      className="flex items-center justify-between rounded-lg border border-white/5 bg-white/5 px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-slate-200">
                          {file.sourceName}
                        </p>
                        <p className="text-[10px] text-slate-500">{formatBytes(file.sizeBytes)}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Configuration Card */}
            <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 shadow-xl">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-white">
                <svg
                  className="h-4 w-4 text-amber-500"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
                  />
                </svg>
                Filtration Logic
              </h2>
              <div className="mt-6 space-y-4">
                <div className="flex items-center gap-3 rounded-xl border border-white/5 bg-white/5 p-3">
                  <input
                    type="checkbox"
                    id="enableCustomRule"
                    checked={isCustomRuleEnabled}
                    onChange={(e) => {
                      setIsCustomRuleEnabled(e.target.checked);
                      if (!e.target.checked) {
                        setFilterCriteria(DEFAULT_FILTER_CRITERIA);
                        resetFilterResults();
                      }
                    }}
                    className="h-4 w-4 rounded border-white/10 bg-slate-800 text-amber-500 focus:ring-amber-500"
                  />
                  <label htmlFor="enableCustomRule" className="cursor-pointer text-xs font-medium text-slate-300">
                    Do you want to change the Minimum Owner Total?
                  </label>
                </div>

                <div className={isCustomRuleEnabled ? 'opacity-100' : 'opacity-40 grayscale pointer-events-none'}>
                  <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    Minimum Owner Total
                  </label>
                  <div className="mt-2 flex items-center gap-3">
                    <div className="relative flex-1">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-semibold text-slate-400">
                        $
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="100"
                        disabled={!isCustomRuleEnabled}
                        value={filterCriteria.minCurrentCashBalance}
                        onChange={(e) => {
                          const val = Number.parseFloat(e.target.value) || 0;
                          setFilterCriteria({ minCurrentCashBalance: val });
                          resetFilterResults();
                        }}
                        className="w-full rounded-xl border border-white/10 bg-white/5 py-2.5 pl-7 pr-3 text-lg font-bold text-white outline-none transition-all focus:border-amber-500/50 focus:ring-1 focus:ring-amber-500/50"
                      />
                    </div>
                    <span className="shrink-0 rounded bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-500">
                      Per Owner
                    </span>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={
                    registeredFiles.length === 0 ||
                    lifecycle.status !== 'ready' ||
                    filterStatus === 'running'
                  }
                  onClick={() => {
                    void runFilterPipeline();
                  }}
                  className="group relative w-full overflow-hidden rounded-xl bg-amber-600 px-4 py-3 text-sm font-bold text-black transition-all hover:bg-amber-500 disabled:cursor-not-allowed disabled:bg-slate-800 disabled:text-slate-500"
                >
                  <div className="relative flex items-center justify-center gap-2">
                    {filterStatus === 'running' ? (
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                        <circle
                          className="opacity-25"
                          cx="12"
                          cy="12"
                          r="10"
                          stroke="currentColor"
                          strokeWidth="4"
                          fill="none"
                        />
                        <path
                          className="opacity-75"
                          fill="currentColor"
                          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={2.5}
                          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                        />
                      </svg>
                    )}
                    {filterStatus === 'running' ? 'Filtering...' : 'Start Filtration'}
                  </div>
                </button>

                {filterStatus === 'ready' && (
                  <button
                    type="button"
                    disabled={exportStatus === 'exporting'}
                    onClick={() => {
                      void downloadFilteredCSV();
                    }}
                    className="flex w-full items-center justify-center gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm font-bold text-emerald-400 transition hover:bg-emerald-500/20 disabled:opacity-30"
                  >
                    {exportStatus === 'exporting' ? (
                      <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                    ) : (
                      <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                      </svg>
                    )}
                    Download Results (.csv)
                  </button>
                )}

                <div className="flex items-center gap-2">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset ${FILTER_STATUS_BADGE_STYLES[filterStatus]}`}
                  >
                    {FILTER_STATUS_LABELS[filterStatus]}
                  </span>
                  <p className="truncate text-[10px] text-slate-500">
                    Owner total: ≥ ${filterCriteria.minCurrentCashBalance.toLocaleString()}
                  </p>
                </div>

                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                    Unclaimed Only (Always On)
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    Properties with any pending or paid claim are removed first, before any other rule runs.
                  </p>
                </div>

                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                    Cash-Only Policy (Always On)
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    Securities and safe-deposit box properties are excluded automatically before any lead is counted.
                  </p>
                </div>

                <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-sky-400">
                    Owner Grouping (Always On)
                  </p>
                  <p className="mt-1 text-xs text-slate-300">
                    Properties sharing an exact owner name and address count as one owner. An owner qualifies on
                    their combined total, and all of their properties export together.
                  </p>
                  <p className="mt-2 text-[10px] text-slate-500">
                    Rows without a street address are excluded. Properties already in Airtable are removed before
                    totalling.
                  </p>
                </div>
              </div>
            </section>
          </div>

          {/* Right Column: Results & Table */}
          <div className="space-y-6 lg:col-span-8">
            {/* Metrics Overview */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-2xl border border-emerald-500/20 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Qualifying Owners
                </p>
                <p
                  className={`mt-1 text-2xl font-bold ${report.ownersQualified !== '0' ? 'text-emerald-400' : 'text-slate-600'}`}
                >
                  {Number(report.ownersQualified).toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Qualified Properties
                </p>
                <p
                  className={`mt-1 text-2xl font-bold ${filteredRowCount !== '0' ? 'text-emerald-400' : 'text-slate-600'}`}
                >
                  {Number(filteredRowCount).toLocaleString()}
                </p>
              </div>
              <div className="col-span-2 rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-amber-500/70">
                  Unlocked by Grouping
                </p>
                <p
                  className={`mt-1 text-2xl font-bold ${report.unlockedByGrouping !== '0' ? 'text-amber-400' : 'text-slate-600'}`}
                >
                  {Number(report.unlockedByGrouping).toLocaleString()}
                </p>
                <p className="mt-1 text-[10px] text-slate-500">
                  Owners qualified only by combining properties
                </p>
              </div>
            </div>

            {/* Rejection funnel */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Rows Scanned
                </p>
                <p className="mt-1 text-xl font-bold text-slate-300">
                  {Number(report.rowsScanned).toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Skipped Claimed
                </p>
                <p
                  className={`mt-1 text-xl font-bold ${tiles.skippedClaimed > 0 ? 'text-rose-400/80' : 'text-slate-600'}`}
                >
                  {tiles.skippedClaimed.toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Skipped No Address
                </p>
                <p
                  className={`mt-1 text-xl font-bold ${report.noAddress !== '0' ? 'text-rose-400/80' : 'text-slate-600'}`}
                >
                  {Number(report.noAddress).toLocaleString()}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Skipped Non-Cash
                </p>
                <p
                  className={`mt-1 text-xl font-bold ${excludedNonCashCount !== '0' ? 'text-amber-400' : 'text-slate-600'}`}
                >
                  {Number(excludedNonCashCount).toLocaleString()}
                </p>
              </div>
            </div>

            <FiltrationReport
              data={report}
              threshold={filterCriteria.minCurrentCashBalance}
              hasRun={filterStatus === 'ready'}
            />

            {/* Table Container */}
            <section className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/40 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-6 py-4">
                <h2 className="text-sm font-semibold text-white">Filtration Preview</h2>
                <p className="text-[10px] text-slate-400">
                  First 30 records &middot; grouped by owner
                </p>
              </div>

              <div className="relative min-h-[400px] flex-1 overflow-x-auto">
                {previewRows.length > 0 ? (
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 border-b border-white/10 bg-slate-900/90 text-slate-400 backdrop-blur">
                      <tr>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">
                          Property ID
                        </th>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">Type</th>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">
                          Owner Name
                        </th>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">Address</th>
                        <th className="px-4 py-3 text-right font-medium uppercase tracking-wider">
                          Cash Balance
                        </th>
                        <th className="px-4 py-3 text-right font-medium uppercase tracking-wider">
                          Owner Total
                        </th>
                      </tr>
                    </thead>
                    <tbody className="text-slate-300">
                      {previewRows.map((row, index) => {
                        const groupId = String(row.OWNER_GROUP_ID ?? '');
                        const isFirstOfGroup =
                          index === 0 || String(previewRows[index - 1].OWNER_GROUP_ID ?? '') !== groupId;
                        const isBanded = Number(groupId) % 2 === 0;
                        const propertyCount = Number(row.OWNER_GROUP_PROPERTY_COUNT ?? 0);

                        return (
                          <tr
                            key={`${row.PROPERTY_ID ?? 'row'}-${index}`}
                            className={`transition-colors hover:bg-white/[0.04] ${
                              isBanded ? 'bg-white/[0.02]' : ''
                            } ${isFirstOfGroup ? 'border-t border-amber-500/20' : ''}`}
                          >
                            <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">
                              {row.PROPERTY_ID}
                            </td>
                            <td className="max-w-[180px] truncate px-4 py-3 text-[10px] text-emerald-400/80">
                              {row.PROPERTY_TYPE}
                            </td>
                            <td className="px-4 py-3 font-medium text-slate-100">
                              {isFirstOfGroup ? (
                                <div className="flex items-center gap-2">
                                  <span>{row.OWNER_NAME}</span>
                                  {propertyCount > 1 && (
                                    <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold text-amber-400">
                                      {propertyCount} props
                                    </span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-slate-600">↳ same owner</span>
                              )}
                            </td>
                            <td className="max-w-[200px] truncate px-4 py-3 text-[10px] text-slate-400">
                              {isFirstOfGroup ? `${row.OWNER_STREET_1}, ${row.OWNER_CITY} ${row.OWNER_STATE}` : ''}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right font-mono text-slate-300">
                              ${formatMoney(row.CURRENT_CASH_BALANCE)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-3 text-right font-mono font-bold text-emerald-400">
                              {isFirstOfGroup ? `$${formatMoney(row.OWNER_GROUP_TOTAL)}` : ''}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div className="flex h-full min-h-[400px] flex-col items-center justify-center p-8 text-center">
                    <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-slate-600">
                      <svg
                        className="h-6 w-6"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.5}
                          d="M3 10h18M3 14h18m-9-4v8m-7 0h14a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
                        />
                      </svg>
                    </div>
                    <p className="text-sm font-medium text-slate-400">No data filtered yet</p>
                    <p className="mt-1 text-xs text-slate-600">
                      Complete the steps on the left to analyze your assets.
                    </p>
                  </div>
                )}
              </div>
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}

function formatMoney(value: string | number | null): string {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return String(value ?? '');
  }

  return numeric.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildCSVColumnsLiteral(headerColumns: string[]): string {
  const entries = headerColumns.map(
    (columnName) => `'${escapeSQLStringLiteral(columnName)}': 'VARCHAR'`,
  );

  return `{ ${entries.join(', ')} }`;
}

function escapeSQLStringLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function buildUnionSourceSQL(
  virtualPaths: string[],
  headerColumns: string[],
): string {
  const quotedPaths = virtualPaths
    .map((path) => `'${path.replace(/'/g, "''")}'`)
    .join(', ');
  const columnsLiteral = buildCSVColumnsLiteral(headerColumns);

  return `
    FROM read_csv([
      ${quotedPaths}
    ],
      header = true,
      auto_detect = false,
      delim = ',',
      quote = '"',
      escape = '"',
      columns = ${columnsLiteral}
    )
  `;
}

function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
}

async function readCSVHeaderColumns(file: File): Promise<string[]> {
  const previewText = await file.slice(0, 256 * 1024).text();
  const normalizedPreview = previewText.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const firstLine = normalizedPreview.split('\n', 1)[0]?.trim();

  if (!firstLine) {
    throw new Error(`Could not read a header row from ${file.name}.`);
  }

  const columns = parseCSVLine(firstLine);
  if (columns.length === 0) {
    throw new Error(`No columns were detected in ${file.name}.`);
  }

  return columns;
}

function collectHeaderMismatches(snapshots: HeaderSnapshot[]): string[] {
  if (snapshots.length <= 1) {
    return [];
  }

  const baselineColumns = snapshots[0].columns;
  const baselineSet = new Set(baselineColumns);
  const mismatchDetails: string[] = [];

  for (const snapshot of snapshots.slice(1)) {
    const currentSet = new Set(snapshot.columns);
    const missing = baselineColumns.filter((column) => !currentSet.has(column));
    const extra = snapshot.columns.filter((column) => !baselineSet.has(column));

    if (missing.length === 0 && extra.length === 0) {
      continue;
    }

    mismatchDetails.push(
      `${snapshot.fileName} missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    );
  }

  return mismatchDetails;
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 1024) {
    return `${value} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let size = value / 1024;
  let unit = units[0];

  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }

  return `${size.toFixed(2)} ${unit}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toSQLNumericLiteral(value: number): string {
  if (!Number.isFinite(value)) {
    throw new Error('Filter value must be a finite number.');
  }

  return String(value);
}

function downloadBufferAsFile(
  buffer: Uint8Array,
  fileName: string,
  mimeType: string,
): void {
  const blob = new Blob([buffer], { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = blobUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(blobUrl);
}

export default App;
