/**
 * Filtration report: the total lead count, then how many each stage removed.
 *
 * The stages are mutually exclusive and evaluated in pipeline order, so
 * `rowsScanned - sum(all stages) === qualifiedRows` always holds. That check
 * still runs on every render but is deliberately silent when it passes - the
 * report is meant to be read at a glance. It only speaks up when the numbers
 * do not add up, because a silent wrong number is worse than a visible one.
 */

export interface FiltrationReportData {
  rowsScanned: string;
  // Stage 1 - claim gate
  unreadableClaim: string;
  pendingClaim: string;
  paidClaim: string;
  // Stage 2 - address
  noAddress: string;
  // Stage 3 - cash-only policy
  deniedKeyword: string;
  notCashCode: string;
  sharesReported: string;
  hasCusip: string;
  securitiesNamed: string;
  // Stage 4 - individual owners only
  entityKeyword: string;
  entityOrgName: string;
  // Stage 5 - CRM dedupe
  alreadyInCrm: string;
  // Stage 6 - owner threshold
  belowThreshold: string;
  // Survivors
  qualifiedRows: string;
  // Owner-level
  ownerGroupsFormed: string;
  ownersQualified: string;
  ownersBelowThreshold: string;
  unlockedByGrouping: string;
}

interface ReportLine {
  label: string;
  removed: number;
}

const num = (value: string): number => Number(value ?? 0);

/**
 * One line per pipeline stage, in pipeline order. That order is what makes the
 * `Remaining` column step down correctly, so it must keep matching the FILTER
 * conditioning order in `funnelSQL` (src/App.tsx).
 *
 * The per-stage sub-reasons are still computed by the SQL; they are summed into
 * a single figure here rather than displayed, because the report is meant to
 * answer one question: how many leads did each stage remove.
 */
function buildLines(data: FiltrationReportData, threshold: number): ReportLine[] {
  return [
    {
      label: 'Already claimed',
      removed: num(data.unreadableClaim) + num(data.pendingClaim) + num(data.paidClaim),
    },
    {
      label: 'No owner address',
      removed: num(data.noAddress),
    },
    {
      label: 'Not cash',
      removed:
        num(data.deniedKeyword) +
        num(data.notCashCode) +
        num(data.sharesReported) +
        num(data.hasCusip) +
        num(data.securitiesNamed),
    },
    {
      label: 'Owner is not a person',
      removed: num(data.entityKeyword) + num(data.entityOrgName),
    },
    {
      label: 'Already in Airtable',
      removed: num(data.alreadyInCrm),
    },
    {
      label: `Owner total under $${threshold.toLocaleString()}`,
      removed: num(data.belowThreshold),
    },
  ];
}

export function FiltrationReport({
  data,
  threshold,
  hasRun,
}: {
  data: FiltrationReportData;
  threshold: number;
  hasRun: boolean;
}) {
  const scanned = num(data.rowsScanned);
  const qualified = num(data.qualifiedRows);
  const lines = buildLines(data, threshold);
  const totalRemoved = lines.reduce((sum, line) => sum + line.removed, 0);
  const reconciles = scanned - totalRemoved === qualified;

  if (!hasRun || scanned === 0) {
    return (
      <section className="rounded-2xl border border-white/10 bg-slate-900/40 p-6 shadow-xl">
        <h2 className="text-sm font-semibold text-white">Filtration Report</h2>
        <p className="mt-1 text-xs text-slate-500">
          Run filtration to see exactly how many records each rule removed.
        </p>
      </section>
    );
  }

  // Running remainder after each stage, computed up front so nothing is
  // mutated during render.
  const remainingAfter = lines.reduce<number[]>((acc, line) => {
    acc.push((acc.length > 0 ? acc[acc.length - 1] : scanned) - line.removed);
    return acc;
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/40 shadow-xl">
      <div className="border-b border-white/10 bg-white/5 px-6 py-4">
        <h2 className="text-sm font-semibold text-white">Filtration Report</h2>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-6 py-2.5 font-medium">Stage</th>
              <th className="px-4 py-2.5 text-right font-medium">Removed</th>
              <th className="px-6 py-2.5 text-right font-medium">Remaining</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-white/5">
              <td className="px-6 py-3 font-semibold text-slate-200">Total leads scanned</td>
              <td className="px-4 py-3" />
              <td className="px-6 py-3 text-right font-mono font-semibold text-slate-200">
                {scanned.toLocaleString()}
              </td>
            </tr>

            {lines.map((line, index) => (
              <tr key={line.label} className="border-b border-white/5">
                <td className="px-6 py-3 font-medium text-slate-200">{line.label}</td>
                <td className="px-4 py-3 text-right font-mono font-semibold text-rose-400">
                  {line.removed > 0 ? `−${line.removed.toLocaleString()}` : '0'}
                </td>
                <td className="px-6 py-3 text-right font-mono text-slate-400">
                  {remainingAfter[index].toLocaleString()}
                </td>
              </tr>
            ))}

            <tr className="bg-emerald-500/5">
              <td className="px-6 py-4 text-sm font-bold text-emerald-400">QUALIFIED</td>
              <td className="px-4 py-4" />
              <td className="px-6 py-4 text-right font-mono text-lg font-bold text-emerald-400">
                {qualified.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {!reconciles && (
        <p className="border-t border-rose-500/20 bg-rose-500/5 px-6 py-3 text-[10px] text-rose-400">
          Report does not reconcile: {scanned.toLocaleString()} scanned −{' '}
          {totalRemoved.toLocaleString()} removed ≠ {qualified.toLocaleString()} qualified. Treat
          these counts as unreliable and report this.
        </p>
      )}
    </section>
  );
}
