import { useEffect, useState, type ChangeEvent } from 'react';
import {
  duckDBRuntimeService,
  type DuckDBRuntimeLifecycle,
  type DuckDBRuntimeStatus,
  type RegisteredCSVFile,
} from './services/duckdbRuntime';
import { airtableService } from './services/airtableService';

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
  OWNER_NAME: string | null;
  OWNER_CITY: string | null;
  OWNER_STATE: string | null;
  CURRENT_CASH_BALANCE: string | number | null;
  HOLDER_NAME: string | null;
  HOLDER_CITY: string | null;
  HOLDER_STATE: string | null;
}

const DEFAULT_FILTER_CRITERIA: FilterCriteria = {
  minCurrentCashBalance: 5000,
};

const FILTERED_DATASET_VIEW_NAME = 'merged_filtered_dataset';

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
  onDownload,
  onClose,
  isDownloading,
}: {
  count: string;
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
        <p className="mt-2 text-slate-400">Successfully processed and deduplicated all assets.</p>
        
        <div className="mt-8 flex flex-col items-center gap-1">
          <span className="text-5xl font-black text-emerald-400">{Number(count).toLocaleString()}</span>
          <span className="text-xs font-bold uppercase tracking-widest text-emerald-500/60">New Leads Qualified</span>
        </div>

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

const FIELD_PROPERTY_ID = (import.meta.env.VITE_AIRTABLE_FIELD_PROPERTY_ID || 'PROPERTY_ID').replace(/^["']|["']$/g, '');
const FIELD_OWNER_NAME = (import.meta.env.VITE_AIRTABLE_FIELD_OWNER_NAME || 'OWNER_NAME').replace(/^["']|["']$/g, '');

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

    // Resolve actual CSV column names based on the reference header
    const csvPropIdCol = findBestColumnMatch(referenceHeader, [FIELD_PROPERTY_ID, 'PROPERTY_ID', 'Property ID', 'PropertyID']);
    const csvOwnerNameCol = findBestColumnMatch(referenceHeader, [FIELD_OWNER_NAME, 'OWNER_NAME', 'Owner Name', 'OwnerName']);
    const csvCashBalanceCol = findBestColumnMatch(referenceHeader, ['CURRENT_CASH_BALANCE', 'Cash Balance', 'CashBalance', 'Balance']);

    if (!csvPropIdCol || !csvOwnerNameCol || !csvCashBalanceCol) {
      setFilterStatus('error');
      const missing = [];
      if (!csvPropIdCol) missing.push('Property ID');
      if (!csvOwnerNameCol) missing.push('Owner Name');
      if (!csvCashBalanceCol) missing.push('Cash Balance');
      setFilterError(`Could not find required columns in CSV: ${missing.join(', ')}`);
      return;
    }

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

      const dropTableSQL = `DROP TABLE IF EXISTS ${FILTERED_DATASET_VIEW_NAME}`;
      const dropAirtableTableSQL = `DROP TABLE IF EXISTS airtable_leads_lookup`;

      // Create a temporary table for Airtable leads for efficient joining
      const createAirtableLookupSQL = `
        CREATE TEMP TABLE airtable_leads_lookup AS 
        SELECT * FROM read_csv_auto('airtable_existing_leads.csv', header=true)
      `;

      // The Materialize SQL now includes robust case-insensitive matching and dynamic column resolution
      const materializeSQL = `
        CREATE TEMP TABLE ${FILTERED_DATASET_VIEW_NAME} AS
        SELECT csv.*
        ${sourceSQL} AS csv
        LEFT JOIN airtable_leads_lookup AS air
          ON TRIM(UPPER(CAST(csv."${csvPropIdCol}" AS VARCHAR))) = TRIM(UPPER(CAST(air."PROPERTY_ID" AS VARCHAR)))
          AND TRIM(UPPER(CAST(csv."${csvOwnerNameCol}" AS VARCHAR))) = TRIM(UPPER(CAST(air."OWNER_NAME" AS VARCHAR)))
        WHERE TRY_CAST(csv."${csvCashBalanceCol}" AS DOUBLE) >= ${minBalanceLiteral}
          AND air."PROPERTY_ID" IS NULL
      `;

      const countSQL = `
        SELECT COUNT(*)::BIGINT AS row_count
        FROM ${FILTERED_DATASET_VIEW_NAME}
      `;

      const previewSQL = `
        SELECT
          "${csvPropIdCol}" AS "PROPERTY_ID",
          "${csvOwnerNameCol}" AS "OWNER_NAME",
          "${findBestColumnMatch(referenceHeader, ['OWNER_CITY', 'Owner City', 'City']) || csvOwnerNameCol}" AS "OWNER_CITY",
          "${findBestColumnMatch(referenceHeader, ['OWNER_STATE', 'Owner State', 'State']) || csvOwnerNameCol}" AS "OWNER_STATE",
          "${csvCashBalanceCol}" AS "CURRENT_CASH_BALANCE",
          "${findBestColumnMatch(referenceHeader, ['HOLDER_NAME', 'Holder Name', 'Holder']) || csvOwnerNameCol}" AS "HOLDER_NAME",
          "${findBestColumnMatch(referenceHeader, ['HOLDER_CITY', 'Holder City']) || csvOwnerNameCol}" AS "HOLDER_CITY",
          "${findBestColumnMatch(referenceHeader, ['HOLDER_STATE', 'Holder State']) || csvOwnerNameCol}" AS "HOLDER_STATE"
        FROM ${FILTERED_DATASET_VIEW_NAME}
        LIMIT 20
      `;

      await connection.query(dropTableSQL);
      await connection.query(dropAirtableTableSQL);
      await connection.query(createAirtableLookupSQL);
      await connection.query(materializeSQL);

      const countResult = await connection.query(countSQL);
      const countRow = countResult.toArray()[0]?.toJSON() as
        | { row_count?: string | number | bigint }
        | undefined;

      const previewResult = await connection.query(previewSQL);
      const nextPreviewRows = previewResult
        .toArray()
        .map((row) => row.toJSON() as PreviewRow);

      setFilteredRowCount(String(countRow?.row_count ?? 0));
      setPreviewRows(nextPreviewRows);
      setFilterStatus('ready');
      setFilterError(null);
      setFilterMessage(
        `Filtration complete. Found ${Number(countRow?.row_count ?? 0).toLocaleString()} new assets meeting criteria.`,
      );
      setIsSuccessModalOpen(true);
    } catch (error) {
      setFilterStatus('error');
      const msg = toErrorMessage(error);
      setFilterError(msg);
      setFilterMessage('Filtration pipeline failed.');
      setFilteredRowCount('0');
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
      await connection.query(`
        COPY (
          SELECT *
          FROM ${FILTERED_DATASET_VIEW_NAME}
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
                    Do you want to change the Minimum Cash Balance?
                  </label>
                </div>

                <div className={isCustomRuleEnabled ? 'opacity-100' : 'opacity-40 grayscale pointer-events-none'}>
                  <label className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                    Minimum Cash Balance
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
                      Minimum Cash Balance
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
                    Minimum Cash Balance: ≥ ${filterCriteria.minCurrentCashBalance.toLocaleString()}
                  </p>
                </div>
              </div>
            </section>
          </div>

          {/* Right Column: Results & Table */}
          <div className="space-y-6 lg:col-span-8">
            {/* Metrics Overview */}
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Total Assets
                </p>
                <p className="mt-1 text-2xl font-bold text-white">{registeredFiles.length}</p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Attributes
                </p>
                <p className="mt-1 text-2xl font-bold text-white">{referenceHeader.length}</p>
              </div>
              <div className="col-span-2 rounded-2xl border border-white/10 bg-slate-900/40 p-4 shadow-xl">
                <p className="text-[10px] font-medium uppercase tracking-wider text-slate-500">
                  Recovered Leads
                </p>
                <p
                  className={`mt-1 text-2xl font-bold ${filteredRowCount !== '0' ? 'text-emerald-400' : 'text-slate-600'}`}
                >
                  {Number(filteredRowCount).toLocaleString()}
                </p>
              </div>
            </div>

            {/* Table Container */}
            <section className="flex flex-col overflow-hidden rounded-2xl border border-white/10 bg-slate-900/40 shadow-2xl">
              <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-6 py-4">
                <h2 className="text-sm font-semibold text-white">Filtration Preview</h2>
                <p className="text-[10px] text-slate-400">Showing first 20 records</p>
              </div>

              <div className="relative min-h-[400px] flex-1 overflow-x-auto">
                {previewRows.length > 0 ? (
                  <table className="w-full text-left text-xs">
                    <thead className="sticky top-0 z-10 border-b border-white/10 bg-slate-900/90 text-slate-400 backdrop-blur">
                      <tr>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">
                          Property ID
                        </th>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">
                          Owner Name
                        </th>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">Location</th>
                        <th className="px-4 py-3 text-right font-medium uppercase tracking-wider">
                          Cash Balance
                        </th>
                        <th className="px-4 py-3 font-medium uppercase tracking-wider">Holder</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-slate-300">
                      {previewRows.map((row, index) => (
                        <tr
                          key={`${row.PROPERTY_ID ?? 'row'}-${index}`}
                          className="transition-colors hover:bg-white/[0.02]"
                        >
                          <td className="whitespace-nowrap px-4 py-3 font-mono text-[10px] text-slate-500">
                            {row.PROPERTY_ID}
                          </td>
                          <td className="px-4 py-3 font-medium text-slate-100">{row.OWNER_NAME}</td>
                          <td className="px-4 py-3 text-slate-400">
                            {row.OWNER_CITY}, {row.OWNER_STATE}
                          </td>
                          <td className="whitespace-nowrap px-4 py-3 text-right font-mono font-bold text-emerald-400">
                            $
                            {typeof row.CURRENT_CASH_BALANCE === 'number'
                              ? row.CURRENT_CASH_BALANCE.toLocaleString()
                              : row.CURRENT_CASH_BALANCE}
                          </td>
                          <td className="max-w-[150px] truncate px-4 py-3 text-[10px] text-slate-500">
                            {row.HOLDER_NAME}
                          </td>
                        </tr>
                      ))}
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

function findBestColumnMatch(headers: string[], candidates: string[]): string | null {
  const normalizedHeaders = headers.map((h) => h.toLowerCase().trim());
  for (const candidate of candidates) {
    const idx = normalizedHeaders.indexOf(candidate.toLowerCase().trim());
    if (idx !== -1) {
      return headers[idx];
    }
  }
  return null;
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

function buildUnionSourceSQL_Simple(virtualPaths: string[]): string {
  const quotedPaths = virtualPaths
    .map((path) => `'${path.replace(/'/g, "''")}'`)
    .join(', ');

  return `
    FROM read_csv([
      ${quotedPaths}
    ], union_by_name = true, header = true, auto_detect = true)
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
