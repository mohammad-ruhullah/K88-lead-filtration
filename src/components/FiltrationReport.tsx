/**
 * Filtration report: a reconciling account of where every input row went.
 *
 * The reasons are mutually exclusive and evaluated in pipeline order, so
 * `rowsScanned - sum(all reasons) === qualifiedRows` always holds. The
 * component asserts that invariant visually rather than hiding a mismatch.
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
  // Stage 4 - CRM dedupe
  alreadyInCrm: string;
  // Stage 5 - owner threshold
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
  children?: { label: string; removed: number }[];
  accent: string;
  bar: string;
}

const num = (value: string): number => Number(value ?? 0);

function buildLines(data: FiltrationReportData, threshold: number): ReportLine[] {
  return [
    {
      label: 'Already claimed',
      removed: num(data.unreadableClaim) + num(data.pendingClaim) + num(data.paidClaim),
      accent: 'text-rose-400',
      bar: 'bg-rose-500/70',
      children: [
        { label: 'unreadable claim value', removed: num(data.unreadableClaim) },
        { label: 'pending claim', removed: num(data.pendingClaim) },
        { label: 'paid claim', removed: num(data.paidClaim) },
      ],
    },
    {
      label: 'No owner address',
      removed: num(data.noAddress),
      accent: 'text-rose-400',
      bar: 'bg-rose-500/40',
    },
    {
      label: 'Non-cash property',
      removed:
        num(data.deniedKeyword) +
        num(data.notCashCode) +
        num(data.sharesReported) +
        num(data.hasCusip) +
        num(data.securitiesNamed),
      accent: 'text-amber-400',
      bar: 'bg-amber-500/70',
      children: [
        { label: 'denied keyword in type', removed: num(data.deniedKeyword) },
        { label: 'not an allowed cash code', removed: num(data.notCashCode) },
        { label: 'shares reported', removed: num(data.sharesReported) },
        { label: 'has CUSIP', removed: num(data.hasCusip) },
        { label: 'securities named', removed: num(data.securitiesNamed) },
      ],
    },
    {
      label: 'Already in Airtable',
      removed: num(data.alreadyInCrm),
      accent: 'text-sky-400',
      bar: 'bg-sky-500/60',
    },
    {
      label: `Owner total under $${threshold.toLocaleString()}`,
      removed: num(data.belowThreshold),
      accent: 'text-violet-400',
      bar: 'bg-violet-500/60',
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
  const pct = (value: number): string =>
    scanned > 0 ? `${((value / scanned) * 100).toFixed(1)}%` : '—';

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
      <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-6 py-4">
        <div>
          <h2 className="text-sm font-semibold text-white">Filtration Report</h2>
          <p className="mt-0.5 text-[10px] text-slate-500">
            Every input row accounted for, in pipeline order
          </p>
        </div>
        <span
          className={`rounded-full px-2.5 py-1 text-[10px] font-semibold ring-1 ring-inset ${
            reconciles
              ? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20'
              : 'bg-rose-500/10 text-rose-400 ring-rose-500/20'
          }`}
        >
          {reconciles ? 'Reconciled' : 'Mismatch'}
        </span>
      </div>

      {/* Proportional bar */}
      <div className="flex h-2 w-full overflow-hidden bg-slate-800">
        {lines.map((line) => (
          <div
            key={line.label}
            className={line.bar}
            style={{ width: `${scanned > 0 ? (line.removed / scanned) * 100 : 0}%` }}
            title={`${line.label}: ${line.removed.toLocaleString()}`}
          />
        ))}
        <div
          className="bg-emerald-500"
          style={{ width: `${scanned > 0 ? (qualified / scanned) * 100 : 0}%` }}
          title={`Qualified: ${qualified.toLocaleString()}`}
        />
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="border-b border-white/10 text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-6 py-2.5 font-medium">Reason</th>
              <th className="px-4 py-2.5 text-right font-medium">Removed</th>
              <th className="px-4 py-2.5 text-right font-medium">% of scanned</th>
              <th className="px-6 py-2.5 text-right font-medium">Remaining</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-white/5">
              <td className="px-6 py-3 font-semibold text-slate-200">Rows scanned</td>
              <td className="px-4 py-3" />
              <td className="px-4 py-3 text-right font-mono text-slate-500">100.0%</td>
              <td className="px-6 py-3 text-right font-mono font-semibold text-slate-200">
                {scanned.toLocaleString()}
              </td>
            </tr>

            {lines.map((line, index) => {
              const remaining = remainingAfter[index];
              const children = (line.children ?? []).filter((child) => child.removed > 0);

              return (
                <tr key={line.label} className="border-b border-white/5 align-top">
                  <td className="px-6 py-3">
                    <span className="font-medium text-slate-200">{line.label}</span>
                    {children.length > 0 && (
                      <div className="mt-1.5 space-y-0.5">
                        {children.map((child) => (
                          <div
                            key={child.label}
                            className="flex justify-between gap-4 text-[10px] text-slate-500"
                          >
                            <span>↳ {child.label}</span>
                            <span className="font-mono">{child.removed.toLocaleString()}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                  <td className={`px-4 py-3 text-right font-mono font-semibold ${line.accent}`}>
                    {line.removed > 0 ? `−${line.removed.toLocaleString()}` : '0'}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-slate-500">
                    {pct(line.removed)}
                  </td>
                  <td className="px-6 py-3 text-right font-mono text-slate-400">
                    {remaining.toLocaleString()}
                  </td>
                </tr>
              );
            })}

            <tr className="bg-emerald-500/5">
              <td className="px-6 py-4 text-sm font-bold text-emerald-400">QUALIFIED</td>
              <td className="px-4 py-4" />
              <td className="px-4 py-4 text-right font-mono text-emerald-500/70">
                {pct(qualified)}
              </td>
              <td className="px-6 py-4 text-right font-mono text-lg font-bold text-emerald-400">
                {qualified.toLocaleString()}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Owner-level summary */}
      <div className="grid grid-cols-2 gap-px border-t border-white/10 bg-white/5 sm:grid-cols-4">
        {[
          { label: 'Owner groups formed', value: data.ownerGroupsFormed, tone: 'text-slate-300' },
          { label: 'Owners qualified', value: data.ownersQualified, tone: 'text-emerald-400' },
          {
            label: 'Owners under threshold',
            value: data.ownersBelowThreshold,
            tone: 'text-violet-400',
          },
          {
            label: 'Unlocked by grouping',
            value: data.unlockedByGrouping,
            tone: 'text-amber-400',
          },
        ].map((cell) => (
          <div key={cell.label} className="bg-slate-900/40 px-4 py-3">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">{cell.label}</p>
            <p className={`mt-0.5 font-mono text-base font-bold ${cell.tone}`}>
              {num(cell.value).toLocaleString()}
            </p>
          </div>
        ))}
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
