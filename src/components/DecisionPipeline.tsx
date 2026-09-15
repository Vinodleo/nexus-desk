import React, { useState } from "react";
import {
  Database,
  Calculator,
  Compass,
  History,
  Tag,
  ShieldCheck,
  FileCheck,
  Send,
  CheckCircle,
  Activity,
  FileText,
  Brain,
  ChevronRight,
  Info,
  IndianRupee,
  AlertTriangle,
} from "lucide-react";
import {
  MarketBar,
  StrategySetup,
  ExperienceVector,
  MetaLabelScore,
  ExpectedValueAssessment,
  RiskCalculation,
  TradeProposal,
  RegimeType,
} from "../types";

interface DecisionPipelineProps {
  currentBar: MarketBar;
  setup: StrategySetup;
  regime: RegimeType;
  metaScore: MetaLabelScore;
  evAssessment: ExpectedValueAssessment;
  riskCalc: RiskCalculation;
  proposal: TradeProposal | null;
  similarExperiences: ExperienceVector[];
  onTriggerApproveProposal?: () => void;
}

export const DecisionPipeline: React.FC<DecisionPipelineProps> = ({
  currentBar,
  setup,
  regime,
  metaScore,
  evAssessment,
  riskCalc,
  proposal,
  similarExperiences,
  onTriggerApproveProposal,
}) => {
  const [selectedStep, setSelectedStep] = useState<number>(5); // default to Meta-labeling or Risk

  const steps = [
    {
      id: 1,
      title: "Market Data",
      subtitle: "Ticks & OHLCV",
      icon: Database,
      status: "COMPLETED",
      badge: `${setup.symbol} ₹${currentBar.close.toFixed(2)}`,
    },
    {
      id: 2,
      title: "Feature Calc",
      subtitle: "EMA, VWAP, ATR, ADX",
      icon: Calculator,
      status: "COMPLETED",
      badge: `ADX ${currentBar.adx} • RSI ${currentBar.rsi}`,
    },
    {
      id: 3,
      title: "Predefined Setup",
      subtitle: "Fixed Family Filter",
      icon: Compass,
      status: setup.qualifies ? "COMPLETED" : "BLOCKED",
      badge: setup.qualifies ? "Qualifies" : "Disqualified",
    },
    {
      id: 4,
      title: "Experience Memory",
      subtitle: "k-NN Similarity Search",
      icon: History,
      status: "COMPLETED",
      badge: `${similarExperiences.length} Matched Setups`,
    },
    {
      id: 5,
      title: "Meta-Labeling",
      subtitle: "Section 6F Confidence",
      icon: Tag,
      status: metaScore.confidence >= 0.52 ? "COMPLETED" : "CAUTION",
      badge: `Confidence ${(metaScore.confidence * 100).toFixed(1)}%`,
    },
    {
      id: 6,
      title: "EV & Costs",
      subtitle: "Section 7 Net Edge",
      icon: IndianRupee,
      status: evAssessment.isPositiveEdge ? "COMPLETED" : "BLOCKED",
      badge: `Net EV ₹${evAssessment.expectedNetValue}`,
    },
    {
      id: 7,
      title: "Risk Engine",
      subtitle: "Section 8 Kelly Sizing",
      icon: ShieldCheck,
      status: riskCalc.passedAllChecks ? "COMPLETED" : "BLOCKED",
      badge: riskCalc.passedAllChecks ? `Risk ₹${riskCalc.riskDollars.toLocaleString("en-IN")}` : "Rejected",
    },
    {
      id: 8,
      title: "Trade Proposal",
      subtitle: "Supervisor Synthesis",
      icon: FileCheck,
      status: proposal ? "COMPLETED" : "PENDING",
      badge: proposal?.status || "Pending",
    },
    {
      id: 9,
      title: "Approval Policy",
      subtitle: "Section 9 Workflow",
      icon: Send,
      status: proposal?.status === "APPROVED" || proposal?.status === "AUTO_EXECUTED" ? "COMPLETED" : "WAITING",
      badge: proposal?.status === "AUTO_EXECUTED" ? "Auto-Executed" : "User Approval Required",
    },
  ];

  return (
    <div id="decision-pipeline" className="space-y-4">
      {/* Pipeline Navigation Rail */}
      <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h3 className="font-semibold text-sm text-stone-900 flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-600" />
              <span>Section 5: Trading Decision Flow</span>
            </h3>
            <p className="text-xs text-stone-500">
              Strict execution lifecycle: from market tick to calibrated meta-labeling, EV cost deduction, and risk approval.
            </p>
          </div>
          <div className="text-xs text-stone-600 bg-stone-100 px-2.5 py-1 rounded-md border border-stone-200 font-mono">
            Pipeline Stage: {selectedStep} of 9
          </div>
        </div>

        {/* Step Rail Icons */}
        <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-9 gap-2">
          {steps.map((s) => {
            const Icon = s.icon;
            const isSelected = selectedStep === s.id;
            const isBlocked = s.status === "BLOCKED";
            const isCompleted = s.status === "COMPLETED";

            return (
              <button
                key={`step-${s.id}`}
                id={`pipeline-step-${s.id}`}
                onClick={() => setSelectedStep(s.id)}
                className={`flex flex-col items-center text-center p-2 rounded-lg border transition-all cursor-pointer ${
                  isSelected
                    ? "bg-emerald-50 border-emerald-500 ring-2 ring-emerald-500/20 shadow-xs"
                    : isBlocked
                    ? "bg-rose-50/50 border-rose-200 hover:bg-rose-50"
                    : "bg-stone-50 border-stone-200 hover:bg-stone-100"
                }`}
              >
                <div
                  className={`w-7 h-7 rounded-full flex items-center justify-center mb-1.5 ${
                    isBlocked
                      ? "bg-rose-100 text-rose-600"
                      : isCompleted
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-stone-200 text-stone-600"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                </div>
                <div className="font-semibold text-[11px] text-stone-800 line-clamp-1">{s.title}</div>
                <div className="text-[9px] text-stone-500 line-clamp-1">{s.subtitle}</div>
                <span
                  className={`mt-1.5 text-[9px] px-1.5 py-0.5 rounded font-mono font-medium ${
                    isBlocked
                      ? "bg-rose-100 text-rose-700"
                      : isCompleted
                      ? "bg-emerald-100 text-emerald-800"
                      : "bg-stone-200 text-stone-700"
                  }`}
                >
                  {s.badge}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Selected Step Drill-down Inspector */}
      <div className="bg-white border border-stone-200 rounded-xl p-5 shadow-xs">
        {selectedStep === 1 && (
          <div className="space-y-3">
            <h4 className="font-semibold text-sm text-stone-900">Step 1: Market Data Ingestion</h4>
            <p className="text-xs text-stone-600">
              Deterministic ticks and order-book snapshots are ingested into standard 5-minute bars with time, open, high, low, close, and volume.
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-xs">
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">Symbol:</span>
                <div className="font-bold text-stone-800">{setup.symbol}</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">Current Bar Close:</span>
                <div className="font-bold text-stone-800">₹{currentBar.close.toFixed(2)}</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">Volume:</span>
                <div className="font-bold text-stone-800">{currentBar.volume} units</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">Detected Regime:</span>
                <div className="font-bold text-emerald-700 capitalize">{regime.replace(/_/g, " ")}</div>
              </div>
            </div>
          </div>
        )}

        {selectedStep === 2 && (
          <div className="space-y-3">
            <h4 className="font-semibold text-sm text-stone-900">Step 2: Technical Feature Calculation</h4>
            <p className="text-xs text-stone-600">
              Indicators are computed deterministically before any agent or model evaluation:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 font-mono text-xs">
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">EMA 9:</span>
                <div className="font-bold text-blue-600">₹{currentBar.ema9}</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">EMA 21:</span>
                <div className="font-bold text-indigo-600">₹{currentBar.ema21}</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">VWAP:</span>
                <div className="font-bold text-cyan-600">₹{currentBar.vwap}</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">ADX (14):</span>
                <div className="font-bold text-stone-800">{currentBar.adx}</div>
              </div>
              <div className="p-2.5 rounded bg-stone-50 border border-stone-200">
                <span className="text-stone-500 text-[10px]">RSI (14):</span>
                <div className="font-bold text-stone-800">{currentBar.rsi}</div>
              </div>
            </div>
          </div>
        )}

        {selectedStep === 3 && (
          <div className="space-y-3">
            <h4 className="font-semibold text-sm text-stone-900">Step 3: Predefined Setup Detection (Section 6)</h4>
            <p className="text-xs text-stone-600">
              Evaluates whether the market matches one of the fixed strategy templates (Trend Momentum, Breakout Confirmation, or Range Mean Reversion).
            </p>
            <div className="p-3 rounded-lg border border-stone-200 bg-stone-50 flex items-center justify-between text-xs">
              <div>
                <span className="font-bold text-stone-800 text-sm">{setup.name}</span>
                <span className="ml-2 text-stone-500">Direction: <strong>{setup.direction}</strong></span>
              </div>
              <span className={`px-2.5 py-1 rounded font-bold ${setup.qualifies ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                {setup.qualifies ? "QUALIFIED" : "DISQUALIFIED"}
              </span>
            </div>
            {!setup.qualifies && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded">
                Disqualification Reason: {setup.disqualificationReason}
              </div>
            )}
          </div>
        )}

        {selectedStep === 4 && (
          <div className="space-y-3">
            <h4 className="font-semibold text-sm text-stone-900">Step 4: Historical Experience Retrieval (Section 10)</h4>
            <p className="text-xs text-stone-600">
              Retrieves the top-k historically similar setups from experience memory to calculate empirical win-rate.
            </p>
            <div className="grid grid-cols-3 gap-3 text-xs font-mono">
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Similar Records:</span>
                <div className="font-bold text-stone-800">{similarExperiences.length} setups</div>
              </div>
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Empirical Win Rate:</span>
                <div className="font-bold text-emerald-700">{(metaScore.historicalWinRate * 100).toFixed(1)}%</div>
              </div>
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Similarity Metric:</span>
                <div className="font-bold text-stone-800">Cosine Feature Distance</div>
              </div>
            </div>
          </div>
        )}

        {selectedStep === 5 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm text-stone-900">Step 5: Meta-Labeling / Confidence Model (Section 6F)</h4>
              <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 text-xs font-bold">
                Calibrated Confidence: {(metaScore.confidence * 100).toFixed(1)}%
              </span>
            </div>
            <p className="text-xs text-stone-600">
              Separates “does a setup qualify” from “how much do we trust this specific instance”. The meta-model produces the confidence value used directly for position sizing in Step 7.
            </p>
            <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-stone-600 font-medium">Regime Fit Assessment:</span>
                <span className="font-semibold uppercase text-emerald-700">{metaScore.regimeFit}</span>
              </div>
              <div className="text-stone-700 font-sans italic">
                "{metaScore.confidenceRationale}"
              </div>
            </div>
          </div>
        )}

        {selectedStep === 6 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm text-stone-900">Step 6: Expected Value & Cost Deduction (Section 7)</h4>
              <span className={`px-2 py-0.5 rounded text-xs font-bold ${evAssessment.isPositiveEdge ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                Net EV: ₹{evAssessment.expectedNetValue}
              </span>
            </div>
            <p className="text-xs text-stone-600">
              EV = P(win) × average win − P(loss) × average loss − conservative trading costs (spread, brokerage, slippage, latency).
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-2 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Spread Drag:</span>
                <div className="font-bold text-stone-800">₹{evAssessment.estimatedSpreadCost}</div>
              </div>
              <div className="p-2 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Brokerage Fee:</span>
                <div className="font-bold text-stone-800">₹{evAssessment.estimatedBrokerageFee}</div>
              </div>
              <div className="p-2 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Est. Slippage:</span>
                <div className="font-bold text-stone-800">₹{evAssessment.estimatedSlippageCost}</div>
              </div>
              <div className="p-2 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Total Cost:</span>
                <div className="font-bold text-rose-600">-₹{evAssessment.totalCost}</div>
              </div>
            </div>
          </div>
        )}

        {selectedStep === 7 && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm text-stone-900">Step 7: Deterministic Risk Engine & Bounded Kelly (Section 8)</h4>
              <span className={`px-2 py-0.5 rounded text-xs font-bold ${riskCalc.passedAllChecks ? "bg-emerald-100 text-emerald-800" : "bg-rose-100 text-rose-800"}`}>
                {riskCalc.passedAllChecks ? "ALL RISK CHECKS PASSED" : "REJECTED BY RISK"}
              </span>
            </div>
            <p className="text-xs text-stone-600">
              Position sizing scales with meta-confidence via Quarter-Kelly, bounded strictly above by the fixed 1.0% equity risk floor:
            </p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs font-mono">
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Fractional Kelly:</span>
                <div className="font-bold text-indigo-700">{(riskCalc.fractionalKellyFraction * 100).toFixed(2)}%</div>
              </div>
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Risk Ceiling:</span>
                <div className="font-bold text-stone-800">1.0% (₹{(riskCalc.equity * 0.01).toLocaleString("en-IN")})</div>
              </div>
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Allocated Units:</span>
                <div className="font-bold text-stone-800">{riskCalc.recommendedPositionSizeUnits}</div>
              </div>
              <div className="p-2.5 bg-stone-50 rounded border border-stone-200">
                <span className="text-stone-500 text-[10px]">Total Risk Capital:</span>
                <div className="font-bold text-emerald-700">₹{riskCalc.riskDollars.toLocaleString("en-IN")}</div>
              </div>
            </div>
            {!riskCalc.passedAllChecks && (
              <div className="p-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded">
                Rejection: {riskCalc.rejectionReason}
              </div>
            )}
          </div>
        )}

        {selectedStep === 8 && (
          <div className="space-y-3">
            <h4 className="font-semibold text-sm text-stone-900">Step 8: Supervisor Agent Proposal Synthesis</h4>
            <p className="text-xs text-stone-600">
              The AI Supervisor summarizes market context, similar history, and risk into a structured proposal.
            </p>
            {proposal ? (
              <div className="p-3 bg-stone-50 rounded-lg border border-stone-200 text-xs space-y-2">
                <div className="font-medium text-stone-800">Proposal ID: {proposal.id}</div>
                <div className="text-stone-600 italic">"{proposal.supervisorNotes}"</div>
              </div>
            ) : (
              <div className="text-xs text-stone-500">No active proposal pending evaluation.</div>
            )}
          </div>
        )}

        {selectedStep === 9 && (
          <div className="space-y-3">
            <h4 className="font-semibold text-sm text-stone-900">Step 9: Approval Policy & Limit Execution (Section 9)</h4>
            <p className="text-xs text-stone-600">
              Evaluates autonomy rules (Manual, Semi-Auto, Auto within limits). Semi-auto auto-executes high-confidence low-risk setups; all others require human token authorization.
            </p>
            {proposal && proposal.status === "PENDING_APPROVAL" && onTriggerApproveProposal && (
              <button
                onClick={onTriggerApproveProposal}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-semibold shadow-xs cursor-pointer"
              >
                Open Approval Modal for {proposal.id}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
