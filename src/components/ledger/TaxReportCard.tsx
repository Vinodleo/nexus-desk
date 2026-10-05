import React, { useMemo, useState } from "react";
import type { HistoricalTrade } from "../../types";
import { Card } from "./ui";
import { Fold } from "./labUi";
import { formatMoney, pnlTone } from "./format";
import { taxReport, taxReportCsv, taxYears } from "../../services/taxReport";

// Book → Breakdown → Tax report: a financial year's closed trades, by how
// India taxes each market (services/taxReport.ts), and a CSV for the CA.
// Live trades are what's taxed; paper ones show what the report will look like.

const button = "min-h-9 px-3.5 rounded-full border text-[13px] font-semibold cursor-pointer";

/** Saves the CSV on this device. The byte-order mark lets spreadsheets read ₹. */
function downloadCsv(name: string, text: string): void {
  try {
    const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch {}
}

const money = (x: number) => formatMoney(x, { decimals: 0 });
const tradesText = (n: number) => `${n} trade${n === 1 ? "" : "s"}`;

export const TaxReportCard: React.FC<{ trades: HistoricalTrade[]; save?: (name: string, text: string) => void }> = ({ trades, save = downloadCsv }) => {
  // Live trades are the ones taxed: shown first once there are any.
  const [live, setLive] = useState(() => trades.some((t) => t.isLiveOrder));
  const years = useMemo(() => taxYears(trades, live), [trades, live]);
  const [picked, setPicked] = useState<string | null>(null);
  const fy = picked !== null && years.includes(picked) ? picked : years[0];
  const report = useMemo(() => (fy ? taxReport(trades, fy, live) : null), [trades, fy, live]);
  const { coins, us, india } = report ?? { coins: null, us: null, india: null };

  return (
    <Card aria-label="Tax report" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-semibold">Tax report</div>
        {years.length > 1 ? (
          <select
            aria-label="Financial year"
            value={fy}
            onChange={(e) => setPicked(e.target.value)}
            className="min-h-9 rounded-full border border-line bg-surface px-2.5 text-[13px] text-ink"
          >
            {years.map((y) => (
              <option key={y} value={y}>
                FY {y}
              </option>
            ))}
          </select>
        ) : (
          fy && <span className="text-xs text-muted tabular-nums">FY {fy}</span>
        )}
      </div>
      <div className="flex gap-2" role="group" aria-label="Trades">
        {([true, false] as const).map((on) => (
          <button
            key={String(on)}
            type="button"
            aria-pressed={live === on}
            onClick={() => setLive(on)}
            className={`${button} ${live === on ? "bg-accent-soft border-accent text-accent" : "border-line text-ink"}`}
          >
            {on ? "Live" : "Paper"}
          </button>
        ))}
      </div>
      {!live && (
        <div className="text-xs text-muted leading-relaxed" data-testid="tax-paper-note">
          Paper trades: no tax is due on these. It shows what the report of your real trades will look like.
        </div>
      )}
      {!report ? (
        <div className="text-xs text-muted" data-testid="tax-empty">
          No {live ? "live" : "paper"} trades closed yet.
        </div>
      ) : (
        <>
          {coins!.rows.length > 0 && (
            <div className="flex flex-col gap-0.5 text-xs leading-relaxed" data-testid="tax-coins">
              <div className="font-semibold">Coins · {tradesText(coins!.rows.length)}</div>
              <div className="text-muted">
                Winners gained <span className="text-gain">{money(coins!.gains)}</span>, losers lost{" "}
                <span className="text-loss">{money(Math.abs(coins!.losses))}</span>: losses offset nothing.
              </div>
              <div className="text-muted">
                Tax on the winners: about <b className="text-ink">{money(coins!.tax)}</b> (30% plus 4% cess).
              </div>
              <div className="text-muted">
                TDS: {money(coins!.tds)} {live ? "withheld" : "would be withheld"} (1% of each sale), credited when you file.
              </div>
            </div>
          )}
          {us!.rows.length > 0 && (
            <div className="flex flex-col gap-0.5 text-xs leading-relaxed" data-testid="tax-us">
              <div className="font-semibold">US stocks · {tradesText(us!.rows.length)}</div>
              <div className="text-muted">
                Short-term <span className={pnlTone(us!.shortTerm)}>{formatMoney(us!.shortTerm, { signed: true, decimals: 0 })}</span> (your slab
                rate) · long-term <span className={pnlTone(us!.longTerm)}>{formatMoney(us!.longTerm, { signed: true, decimals: 0 })}</span> (12.5%),
                after fees, losses offsetting gains.
              </div>
            </div>
          )}
          {india!.rows.length > 0 && (
            <div className="flex flex-col gap-0.5 text-xs leading-relaxed" data-testid="tax-india">
              <div className="font-semibold">Indian stocks · {tradesText(india!.rows.length)}</div>
              <div className="text-muted">
                <span className={pnlTone(india!.net)}>{formatMoney(india!.net, { signed: true, decimals: 0 })}</span> after costs: intraday, business
                income at your slab rate.
              </div>
            </div>
          )}
          <button
            type="button"
            onClick={() => save(`nexus-desk-tax-${report.fy}-${live ? "live" : "paper"}.csv`, taxReportCsv(report))}
            className={`${button} self-start border-line text-ink`}
          >
            Download for your CA (CSV)
          </button>
        </>
      )}
      <Fold title="How it's worked out">
        <div className="text-xs text-muted leading-relaxed">
          The rules as we understand them (2026); your CA decides. A financial year runs 1 April to 31 March. Coins are crypto: 30% plus 4% cess
          on each winning trade's gain, a loss offsets nothing, and nothing but the purchase is deducted, so the estimate counts gains before
          fees. CoinDCX withholds 1% of each sale as TDS, credited when you file. US stocks are capital gains: held 24 months or less at your slab
          rate, longer at 12.5%, losses offsetting gains and brokerage deducted; amounts are in rupees at the day's rate the app used, and your CA
          may convert at SBI's rate. Indian intraday trades are speculative business income at your slab rate.
        </div>
      </Fold>
    </Card>
  );
};
