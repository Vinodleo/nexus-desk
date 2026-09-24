import React, { useState } from "react";
import { Check, X, Upload, Loader2, AlertTriangle } from "lucide-react";
import type { PromotedLabModel } from "../../types";
import {
  fetchRealHistoricalCandles,
  parseCSVToCandles,
  runGlobalMarketTraining,
  runRealDataWalkForward,
  type HistoricalSource,
  type RealDataLearningResult,
} from "../../services/realDataBacktestService";
import { SUPPORTED_SYMBOLS } from "../../services/marketDataService";
import { Card } from "./ui";

export interface LedgerLabProps {
  promotedLabModel: PromotedLabModel | null;
  onPromote: (result: RealDataLearningResult) => void;
  onRevert: () => void;
}

const MARKETS = ["BTCINR", "ETHINR", "SOLINR", "BNBUSDT", "XRPUSDT", "AVAXUSDT"];
const marketLabel = (m: string) => m.replace(/(INR|USDT)$/, "/$1");
type Interval = "15m" | "1h" | "4h";

/** Fewer test trades than this and the candidate's win rate is mostly noise. */
export const MIN_TEST_TRADES = 10;

/** Whether this result is the model already in use. */
export function isResultPromoted(result: RealDataLearningResult, promoted: PromotedLabModel | null): boolean {
  return Boolean(
    promoted &&
      promoted.datasetName === result.datasetName &&
      promoted.accuracyPct === result.learnedMetrics.accuracyPercent
  );
}

const selectClass =
  "w-full min-h-11 rounded-[10px] border border-line bg-surface px-3 text-sm text-ink cursor-pointer";

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="flex flex-col gap-1 text-xs text-muted min-w-0">
    {label}
    {children}
  </label>
);

const CompareRow: React.FC<{ label: string; before: string; after: string; better: boolean | null }> = ({
  label,
  before,
  after,
  better,
}) => (
  <div className="flex justify-between gap-3 text-[13px] tabular-nums py-1.5 border-b border-line last:border-b-0">
    <span>{label}</span>
    <span>
      <span className="text-muted">{before}</span> →{" "}
      <strong className={better === null ? "" : better ? "text-gain" : "text-loss"}>{after}</strong>
    </span>
  </div>
);

export const LedgerLab: React.FC<LedgerLabProps> = ({ promotedLabModel: promoted, onPromote, onRevert }) => {
  const [source, setSource] = useState<HistoricalSource>("BINANCE");
  const [market, setMarket] = useState("BTCINR");
  const [candle, setCandle] = useState<Interval>("1h");
  const [bars, setBars] = useState(500);
  const [busy, setBusy] = useState<null | "one" | "all" | "csv">(null);
  const [result, setResult] = useState<RealDataLearningResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmRevert, setConfirmRevert] = useState(false);

  const run = async (kind: "one" | "all" | "csv", work: () => Promise<RealDataLearningResult>) => {
    setBusy(kind);
    setError(null);
    try {
      setResult(await work());
    } catch (err: any) {
      console.error("Lab training failed", err);
      setError(err?.message || "Training failed. Try again.");
    } finally {
      setBusy(null);
    }
  };

  const trainOne = () =>
    run("one", async () => {
      const candles = await fetchRealHistoricalCandles(market, candle, bars, source);
      const r = await runRealDataWalkForward(candles, market);
      const from = candles[0]?.sourceExchange || (source === "COINBASE" ? "Coinbase" : "Binance");
      r.sourceExchange = from;
      r.isSynthetic = candles.some((c) => c.isSynthetic);
      r.totalCandles = candles.length;
      r.datasetName = `${marketLabel(market)} (${candle}, ${candles.length} bars via ${from})`;
      return r;
    });

  const trainAll = () => run("all", () => runGlobalMarketTraining(SUPPORTED_SYMBOLS.map((s) => s.symbol)));

  const onCsv = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const candles = parseCSVToCandles(String(reader.result ?? ""));
      if (candles.length <= 20) {
        setError(`${file.name} has ${candles.length} usable candles; at least 21 are needed.`);
        return;
      }
      void run("csv", async () => {
        const r = await runRealDataWalkForward(candles, file.name.replace(/\.csv$/i, ""));
        r.datasetName = `CSV: ${file.name} (${candles.length} bars)`;
        r.sourceExchange = "Your CSV";
        r.isSynthetic = false;
        r.totalCandles = candles.length;
        return r;
      });
    };
    reader.readAsText(file);
  };

  const b = result?.baselineMetrics;
  const l = result?.learnedMetrics;
  const foldsPassed = result ? result.folds.filter((f) => f.passed).length : 0;
  const alreadyPromoted = result ? isResultPromoted(result, promoted) : false;
  const tooFewTrades = l ? l.tradesCount < MIN_TEST_TRADES : false;

  return (
    <div className="font-ui text-ink flex flex-col gap-4 pb-4 select-none">
      <header className="pt-1">
        <h1 className="m-0 font-display text-[26px] font-semibold">Lab</h1>
        <div className="text-[13px] text-muted">Test strategy changes before they trade</div>
      </header>

      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="w-2 h-2 rounded-full bg-warn" />
        Sandbox · nothing here places trades until you promote it
      </div>

      <Card aria-label="Model in use" className="flex flex-col gap-2.5">
        <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em]">In use</div>
        {promoted ? (
          <>
            <div className="text-[15px] font-semibold">{promoted.datasetName}</div>
            <div className="text-[13px] text-muted tabular-nums">
              {promoted.winRatePct.toFixed(0)}% win rate · {promoted.accuracyPct}% accuracy in testing · promoted{" "}
              {new Date(promoted.promotedAt).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}
            </div>
            {confirmRevert ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px]">
                <span>Go back to the built-in rules?</span>
                <button
                  type="button"
                  onClick={() => {
                    setConfirmRevert(false);
                    onRevert();
                  }}
                  className="min-h-9 px-3.5 rounded-full bg-accent text-on-accent font-semibold cursor-pointer"
                >
                  Revert
                </button>
                <button type="button" onClick={() => setConfirmRevert(false)} className="min-h-9 px-3 text-muted cursor-pointer">
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmRevert(true)}
                className="self-start min-h-9 px-3.5 rounded-full border border-line text-[13px] font-semibold cursor-pointer"
              >
                Revert to built-in rules
              </button>
            )}
          </>
        ) : (
          <div className="text-[13px] text-muted">Built-in rules, adjusted by live learning. No Lab model promoted.</div>
        )}
      </Card>

      <Card aria-label="Train" className="flex flex-col gap-3">
        <div className="text-sm font-semibold">Train on price history</div>
        <div className="flex p-0.5 rounded-full bg-inset border border-line" role="group" aria-label="History source">
          {(["BINANCE", "COINBASE"] as const).map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={source === s}
              onClick={() => setSource(s)}
              className={`flex-1 min-h-9 rounded-full text-[13px] font-semibold cursor-pointer ${
                source === s ? "bg-surface border border-line text-ink" : "text-muted"
              }`}
            >
              {s === "BINANCE" ? "Binance" : "Coinbase"}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Market">
            <select className={selectClass} value={market} onChange={(e) => setMarket(e.target.value)}>
              {MARKETS.map((m) => (
                <option key={m} value={m}>
                  {marketLabel(m)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Candle">
            <select className={selectClass} value={candle} onChange={(e) => setCandle(e.target.value as Interval)}>
              <option value="15m">15 min</option>
              <option value="1h">1 hour</option>
              <option value="4h">4 hours</option>
            </select>
          </Field>
          <Field label="History">
            <select className={selectClass} value={bars} onChange={(e) => setBars(Number(e.target.value))}>
              <option value={200}>200 bars</option>
              <option value={500}>500 bars</option>
              <option value={1000}>1,000 bars</option>
            </select>
          </Field>
        </div>
        <button
          type="button"
          onClick={trainOne}
          disabled={busy !== null}
          className="min-h-12 rounded-full bg-accent text-on-accent font-semibold text-[15px] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
        >
          {busy === "one" && <Loader2 className="w-4 h-4 animate-spin" />}
          {busy === "one" ? "Training…" : `Train on ${marketLabel(market)}`}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={trainAll}
            disabled={busy !== null}
            className="flex-1 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer disabled:opacity-60"
          >
            {busy === "all" && <Loader2 className="w-4 h-4 animate-spin" />}
            {busy === "all" ? "Training all…" : "Train on all markets"}
          </button>
          <label
            className={`flex-1 min-h-11 rounded-full border border-line bg-surface text-sm font-semibold flex items-center justify-center gap-2 ${
              busy !== null ? "opacity-60 pointer-events-none" : "cursor-pointer"
            }`}
          >
            {busy === "csv" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            {busy === "csv" ? "Reading…" : "Upload CSV"}
            <input type="file" accept=".csv,text/csv" onChange={onCsv} className="hidden" aria-label="Upload a CSV of candles" />
          </label>
        </div>
        {error && <div className="text-xs text-loss">{error}</div>}
      </Card>

      {result && b && l && (
        <Card aria-label="Result" className="flex flex-col gap-3">
          <div>
            <div className="text-xs font-semibold text-muted uppercase tracking-[0.08em]">Candidate</div>
            <div className="text-[15px] font-semibold mt-0.5">{result.datasetName}</div>
            <div className="text-xs text-muted">
              {result.dateRange.start} → {result.dateRange.end}
            </div>
          </div>

          {result.isSynthetic && (
            <div className="flex gap-2.5 p-3 rounded-xl bg-danger-soft border border-danger-line text-xs leading-relaxed text-loss">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-px" strokeWidth={1.8} />
              <span>
                The exchange couldn't be reached, so this ran on generated prices, not market history. Its numbers say
                nothing about real trading and it can't be promoted. Try again, try the other source, or upload a CSV.
              </span>
            </div>
          )}

          <div className="flex flex-col">
            <div className="text-xs text-muted pb-1">Before learning → after, on data it didn't train on</div>
            <CompareRow
              label="Accuracy"
              before={`${b.accuracyPercent}%`}
              after={`${l.accuracyPercent}%`}
              better={l.accuracyPercent === b.accuracyPercent ? null : l.accuracyPercent > b.accuracyPercent}
            />
            <CompareRow
              label="Win rate"
              before={`${b.winRate}%`}
              after={`${l.winRate}%`}
              better={l.winRate === b.winRate ? null : l.winRate > b.winRate}
            />
            <CompareRow
              label="Worst drop"
              before={`${b.maxDrawdownPercent}%`}
              after={`${l.maxDrawdownPercent}%`}
              better={l.maxDrawdownPercent === b.maxDrawdownPercent ? null : l.maxDrawdownPercent < b.maxDrawdownPercent}
            />
            <CompareRow label="Trades" before={`${b.tradesCount}`} after={`${l.tradesCount}`} better={null} />
          </div>

          {result.folds.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-[13px]">
                <span className="font-semibold">Walk-forward test</span>
                <span className={foldsPassed === result.folds.length ? "text-gain font-semibold" : "text-muted"}>
                  {foldsPassed} of {result.folds.length} periods passed
                </span>
              </div>
              <div className="flex gap-1.5">
                {result.folds.map((f) => (
                  <div
                    key={f.fold}
                    title={`${f.testRange}: ${f.outOfSampleAccuracy}% accuracy`}
                    aria-label={`Period ${f.fold} ${f.passed ? "passed" : "failed"}`}
                    className={`flex-1 h-7 rounded-md flex items-center justify-center ${
                      f.passed ? "bg-accent-soft text-gain" : "bg-danger-soft text-loss"
                    }`}
                  >
                    {f.passed ? <Check className="w-3.5 h-3.5" strokeWidth={2.2} /> : <X className="w-3.5 h-3.5" strokeWidth={2.2} />}
                  </div>
                ))}
              </div>
              <div className="text-xs text-muted leading-relaxed">
                Trained on one stretch of history, then tested on the next, {result.folds.length} times over.
              </div>
            </div>
          )}

          {result.distilledLessons.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <div className="text-[13px] font-semibold">What it learned</div>
              <ul className="list-none m-0 p-0 flex flex-col gap-1.5">
                {result.distilledLessons.slice(0, 5).map((lesson) => (
                  <li key={lesson.id} className="text-[13px] leading-relaxed bg-inset rounded-[10px] px-3 py-2">
                    {lesson.rule}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!result.isSynthetic && tooFewTrades && (
            <div className="text-xs leading-relaxed text-warn-ink bg-warn-soft rounded-xl px-3 py-2.5">
              Only {l.tradesCount} test {l.tradesCount === 1 ? "trade" : "trades"}, too few to trust these numbers, so it
              can't be promoted. Train on more history or a longer candle.
            </div>
          )}

          {result.isSynthetic || tooFewTrades ? null : alreadyPromoted ? (
            <div className="text-[13px] text-gain font-semibold">This model is in use.</div>
          ) : (
            <button
              type="button"
              onClick={() => onPromote(result)}
              className="min-h-12 rounded-full bg-accent text-on-accent font-semibold text-[15px] cursor-pointer"
            >
              Promote to live
            </button>
          )}
        </Card>
      )}
    </div>
  );
};
