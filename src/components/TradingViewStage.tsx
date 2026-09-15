import React, { useState, useRef } from "react";
import {
  Play,
  Pause,
  SkipForward,
  RotateCcw,
  Sparkles,
  TrendingUp,
  Sliders,
  Layers,
  BarChart2,
  DollarSign,
  AlertCircle,
  Eye,
  CheckCircle2,
} from "lucide-react";
import { MarketBar, OrderBook, Position, RegimeType, StrategySetup, TradeProposal } from "../types";
import { SUPPORTED_SYMBOLS } from "../services/marketDataService";

interface TradingViewStageProps {
  bars: MarketBar[];
  currentSymbol: string;
  onSymbolChange: (symbol: string) => void;
  orderBook: OrderBook;
  regime: RegimeType;
  isPlaying: boolean;
  onTogglePlay: () => void;
  onStepForward: () => void;
  onFastForward: () => void;
  onReset: () => void;
  onTriggerAnalysis: () => void;
  activeProposal: TradeProposal | null;
  activeSetups: StrategySetup[];
  isAnalyzing: boolean;
  onScanAllMarkets?: () => void;
  pendingProposalsCount?: number;
  onScrollToQueue?: () => void;
  activePositions?: Position[];
  onClosePosition?: (pos: Position) => void;
}

export const TradingViewStage: React.FC<TradingViewStageProps> = ({
  bars,
  currentSymbol,
  onSymbolChange,
  orderBook,
  regime,
  isPlaying,
  onTogglePlay,
  onStepForward,
  onFastForward,
  onReset,
  onTriggerAnalysis,
  activeProposal,
  activeSetups,
  isAnalyzing,
  onScanAllMarkets,
  pendingProposalsCount = 0,
  onScrollToQueue,
  activePositions = [],
  onClosePosition,
}) => {
  const [showEma, setShowEma] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showBb, setShowBb] = useState(false);
  const [hoveredBar, setHoveredBar] = useState<MarketBar | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  if (!bars || bars.length === 0) {
    return (
      <div className="p-8 text-center text-stone-500">
        Loading historical market feed...
      </div>
    );
  }

  const currentBar = bars[bars.length - 1];
  const prevBar = bars[bars.length - 2] || currentBar;
  const priceChange = currentBar.close - prevBar.close;
  const priceChangePercent = (priceChange / prevBar.close) * 100;

  // Chart dimensions & scaling
  const visibleBars = bars.slice(-45);
  const width = 820;
  const height = 360;
  const paddingLeft = 10;
  const paddingRight = 65;
  const paddingTop = 20;
  const paddingBottom = 60;
  const plotWidth = width - paddingLeft - paddingRight;
  const plotHeight = height - paddingTop - paddingBottom;

  const minPrice = Math.min(...visibleBars.map((b) => b.low));
  const maxPrice = Math.max(...visibleBars.map((b) => b.high));
  const priceRange = maxPrice - minPrice || 1;
  const maxVolume = Math.max(...visibleBars.map((b) => b.volume)) || 1;

  const getY = (val: number) => {
    return paddingTop + plotHeight - ((val - minPrice) / priceRange) * plotHeight;
  };

  const getX = (index: number) => {
    return paddingLeft + (index / (visibleBars.length - 1 || 1)) * plotWidth;
  };

  const candleWidth = Math.max(4, Math.floor(plotWidth / visibleBars.length) - 3);

  // SVG paths for indicators
  const ema9Points = visibleBars
    .map((b, i) => (b.ema9 ? `${getX(i)},${getY(b.ema9)}` : null))
    .filter(Boolean)
    .join(" ");

  const ema21Points = visibleBars
    .map((b, i) => (b.ema21 ? `${getX(i)},${getY(b.ema21)}` : null))
    .filter(Boolean)
    .join(" ");

  const vwapPoints = visibleBars
    .map((b, i) => (b.vwap ? `${getX(i)},${getY(b.vwap)}` : null))
    .filter(Boolean)
    .join(" ");

  const bbUpperPoints = visibleBars
    .map((b, i) => (b.bbUpper ? `${getX(i)},${getY(b.bbUpper)}` : null))
    .filter(Boolean)
    .join(" ");

  const bbLowerPoints = visibleBars
    .map((b, i) => (b.bbLower ? `${getX(i)},${getY(b.bbLower)}` : null))
    .filter(Boolean)
    .join(" ");

  const activeSetup = activeSetups.find((s) => s.qualifies) || activeSetups[0];
  const symbolPosition = activePositions.find((p) => p.symbol === currentSymbol);

  return (
    <div id="trading-stage" className="space-y-4">
      {/* Live Agent Active Trade Banner */}
      {symbolPosition && (
        <div className="bg-emerald-950/95 text-emerald-100 p-3.5 sm:p-4 rounded-xl border border-emerald-600 shadow-md flex flex-wrap items-center justify-between gap-3 animate-in fade-in">
          <div className="flex items-center gap-3">
            <span className="flex h-3.5 w-3.5 relative">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-3.5 w-3.5 bg-emerald-500"></span>
            </span>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-extrabold text-xs uppercase tracking-wider text-emerald-300">
                  Agent Live Trade Running
                </span>
                <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-800 border border-emerald-600 text-emerald-100">
                  {symbolPosition.direction} {symbolPosition.quantity} units @ ${symbolPosition.entryPrice.toFixed(2)}
                </span>
                <span className="text-emerald-300/80 text-[11px] font-mono hidden sm:inline">
                  Setup: {symbolPosition.setupName}
                </span>
              </div>
              <div className="text-[11px] text-emerald-200 mt-1 flex items-center gap-3 font-mono">
                <span>SL: <strong className="text-rose-300">${symbolPosition.stopLoss.toFixed(2)}</strong></span>
                <span>TP: <strong className="text-emerald-300">${symbolPosition.takeProfit.toFixed(2)}</strong></span>
                <span>Current: <strong>${currentBar.close.toFixed(2)}</strong></span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="text-right">
              <span className="text-[10px] text-emerald-300 uppercase tracking-wider font-semibold block">
                Live Unrealized PnL
              </span>
              <span
                className={`font-mono font-bold text-base ${
                  symbolPosition.unrealizedPnl >= 0 ? "text-emerald-300" : "text-rose-300"
                }`}
              >
                {symbolPosition.unrealizedPnl >= 0 ? "+" : ""}${symbolPosition.unrealizedPnl.toFixed(2)} (
                {symbolPosition.unrealizedPnlPercent >= 0 ? "+" : ""}
                {symbolPosition.unrealizedPnlPercent.toFixed(2)}%)
              </span>
            </div>

            {onClosePosition && (
              <button
                onClick={() => onClosePosition(symbolPosition)}
                className="px-3.5 py-1.5 bg-emerald-800 hover:bg-emerald-700 text-white rounded-lg text-xs font-bold border border-emerald-600 cursor-pointer transition-colors shadow-xs"
                title="Manually exit trade and generate trade autopsy"
              >
                Close Trade
              </button>
            )}
          </div>
        </div>
      )}

      {/* Top Bar: Symbol selector, Price, Controls, Regime badge */}
      <div className="bg-white border border-stone-200 rounded-xl p-3.5 shadow-xs flex flex-wrap items-center justify-between gap-4">
        {/* Left: Symbol & Price readout */}
        <div className="flex items-center gap-3">
          <select
            id="symbol-selector"
            value={currentSymbol}
            onChange={(e) => onSymbolChange(e.target.value)}
            className="font-bold text-sm bg-stone-100 border border-stone-300 rounded-lg px-3 py-1.5 text-stone-800 focus:outline-none focus:ring-2 focus:ring-emerald-500 cursor-pointer"
          >
            {SUPPORTED_SYMBOLS.map((s) => (
              <option key={s.symbol} value={s.symbol}>
                {s.symbol} ({s.name})
              </option>
            ))}
          </select>

          <div className="flex items-baseline gap-2">
            <span className="font-mono text-xl font-bold text-stone-900">
              ₹{currentBar.close.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span
              className={`text-xs font-semibold font-mono ${
                priceChange >= 0 ? "text-emerald-600" : "text-rose-600"
              }`}
            >
              {priceChange >= 0 ? "+" : ""}
              ₹{Math.abs(priceChange).toFixed(2)} ({priceChangePercent >= 0 ? "+" : ""}
              {priceChangePercent.toFixed(2)}%)
            </span>
          </div>

          <div className="hidden sm:flex items-center gap-1.5 pl-3 border-l border-stone-200 text-xs">
            <span className="text-stone-500">Regime:</span>
            <span className="px-2 py-0.5 rounded-full bg-stone-100 border border-stone-200 text-stone-700 font-medium capitalize">
              {regime.replace(/_/g, " ")}
            </span>
          </div>
        </div>

        {/* Center: Indicator Toggles */}
        <div className="flex items-center gap-1 bg-stone-50 border border-stone-200 rounded-lg p-1 text-xs">
          <button
            id="toggle-ema-btn"
            onClick={() => setShowEma(!showEma)}
            className={`px-2 py-1 rounded font-medium cursor-pointer transition-colors ${
              showEma ? "bg-white text-blue-600 shadow-xs border border-stone-200" : "text-stone-500 hover:text-stone-800"
            }`}
          >
            EMA (9/21)
          </button>
          <button
            id="toggle-vwap-btn"
            onClick={() => setShowVwap(!showVwap)}
            className={`px-2 py-1 rounded font-medium cursor-pointer transition-colors ${
              showVwap ? "bg-white text-cyan-600 shadow-xs border border-stone-200" : "text-stone-500 hover:text-stone-800"
            }`}
          >
            VWAP
          </button>
          <button
            id="toggle-bb-btn"
            onClick={() => setShowBb(!showBb)}
            className={`px-2 py-1 rounded font-medium cursor-pointer transition-colors ${
              showBb ? "bg-white text-amber-600 shadow-xs border border-stone-200" : "text-stone-500 hover:text-stone-800"
            }`}
          >
            Bollinger
          </button>
        </div>

        {/* Right: Simulation playback controls & Trigger Analysis */}
        <div className="flex items-center gap-2">
          <div className="flex items-center bg-stone-100 rounded-lg p-0.5 border border-stone-200">
            <button
              id="playback-toggle-btn"
              onClick={onTogglePlay}
              className={`p-1.5 rounded cursor-pointer transition-colors ${
                isPlaying ? "bg-emerald-600 text-white" : "text-stone-700 hover:bg-stone-200"
              }`}
              title={isPlaying ? "Pause real-time tick playback" : "Start real-time tick playback"}
            >
              {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              id="playback-step-btn"
              onClick={onStepForward}
              disabled={isPlaying}
              className="p-1.5 text-stone-700 hover:bg-stone-200 rounded disabled:opacity-40 cursor-pointer"
              title="Next 1 Bar"
            >
              <SkipForward className="w-4 h-4" />
            </button>
            <button
              id="playback-fast-btn"
              onClick={onFastForward}
              className="px-2 py-1 text-[11px] font-semibold text-stone-700 hover:bg-stone-200 rounded cursor-pointer"
              title="Advance 10 Bars"
            >
              +10
            </button>
            <button
              id="playback-reset-btn"
              onClick={onReset}
              className="p-1.5 text-stone-700 hover:bg-stone-200 rounded cursor-pointer"
              title="Reset feed"
            >
              <RotateCcw className="w-4 h-4" />
            </button>
          </div>

          {onScanAllMarkets && (
            <button
              id="stage-scan-markets-btn"
              onClick={onScanAllMarkets}
              disabled={isAnalyzing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-stone-900 hover:bg-stone-800 text-white font-medium text-xs shadow-xs transition-colors cursor-pointer disabled:opacity-50"
              title="Agents scan all markets (NIFTY, BTC, SPY, ETH) and queue qualifying proposals"
            >
              <Sparkles className="w-3.5 h-3.5 text-amber-400" />
              <span>Scan Markets</span>
            </button>
          )}

          <button
            id="evaluate-setup-now-btn"
            onClick={onTriggerAnalysis}
            disabled={isAnalyzing}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium text-xs shadow-xs transition-colors cursor-pointer disabled:opacity-50"
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{isAnalyzing ? "Analyzing Pipeline..." : "Evaluate Setup"}</span>
          </button>

          {pendingProposalsCount > 0 && onScrollToQueue && (
            <button
              id="stage-view-queue-btn"
              onClick={onScrollToQueue}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-amber-50 hover:bg-amber-100 text-amber-900 border border-amber-300 font-semibold text-xs cursor-pointer transition-colors"
            >
              <span className="w-2 h-2 rounded-full bg-amber-500 animate-ping" />
              <span>Queue: {pendingProposalsCount} Pending</span>
            </button>
          )}
        </div>
      </div>

      {/* Main Grid: Chart Canvas + Order Book Depth */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Candlestick & Indicator Chart Canvas */}
        <div className="lg:col-span-3 bg-white border border-stone-200 rounded-xl p-4 shadow-xs">
          {/* Chart Header details */}
          <div className="flex items-center justify-between text-xs text-stone-500 mb-2 font-mono">
            <div className="flex items-center gap-3">
              <span>Time: {hoveredBar ? hoveredBar.time : currentBar.time}</span>
              <span>O: <strong className="text-stone-800">{(hoveredBar || currentBar).open}</strong></span>
              <span>H: <strong className="text-stone-800">{(hoveredBar || currentBar).high}</strong></span>
              <span>L: <strong className="text-stone-800">{(hoveredBar || currentBar).low}</strong></span>
              <span>C: <strong className="text-stone-800">{(hoveredBar || currentBar).close}</strong></span>
              <span>Vol: <strong className="text-stone-800">{(hoveredBar || currentBar).volume}</strong></span>
            </div>
            <div className="hidden sm:flex items-center gap-2">
              <span className="text-blue-600">EMA9: {currentBar.ema9}</span>
              <span className="text-indigo-600">EMA21: {currentBar.ema21}</span>
              <span className="text-cyan-600">VWAP: {currentBar.vwap}</span>
              <span className="text-stone-700">ADX: {currentBar.adx}</span>
              <span className="text-stone-700">RSI: {currentBar.rsi}</span>
            </div>
          </div>

          {/* SVG Candlestick Viewport */}
          <div ref={containerRef} className="w-full overflow-hidden relative">
            <svg
              viewBox={`0 0 ${width} ${height}`}
              className="w-full h-auto select-none"
              style={{ background: "#ffffff" }}
            >
              {/* Horizontal Grid lines */}
              {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
                const y = paddingTop + plotHeight * ratio;
                const priceLabel = (maxPrice - ratio * priceRange).toFixed(2);
                return (
                  <g key={ratio}>
                    <line
                      x1={paddingLeft}
                      y1={y}
                      x2={width - paddingRight}
                      y2={y}
                      stroke="#f1f5f9"
                      strokeWidth="1"
                    />
                    <text
                      x={width - paddingRight + 6}
                      y={y + 4}
                      fontSize="10"
                      fill="#94a3b8"
                      fontFamily="monospace"
                    >
                      {priceLabel}
                    </text>
                  </g>
                );
              })}

              {/* Bollinger Bands Shaded Zone */}
              {showBb && bbUpperPoints && bbLowerPoints && (
                <polygon
                  points={`${bbUpperPoints} ${bbLowerPoints.split(" ").reverse().join(" ")}`}
                  fill="#fef3c7"
                  opacity="0.35"
                />
              )}

              {/* Volume Bars at Bottom */}
              {visibleBars.map((bar, i) => {
                const x = getX(i) - candleWidth / 2;
                const volHeight = (bar.volume / maxVolume) * 45;
                const y = height - paddingBottom + 45 - volHeight;
                const isGreen = bar.close >= bar.open;
                return (
                  <rect
                    key={`vol-${i}`}
                    x={x}
                    y={y}
                    width={candleWidth}
                    height={volHeight}
                    fill={isGreen ? "#86efac" : "#fca5a5"}
                    opacity="0.65"
                  />
                );
              })}

              {/* Indicator Lines */}
              {showBb && bbUpperPoints && (
                <polyline points={bbUpperPoints} fill="none" stroke="#d97706" strokeWidth="1.2" strokeDasharray="3,3" />
              )}
              {showBb && bbLowerPoints && (
                <polyline points={bbLowerPoints} fill="none" stroke="#d97706" strokeWidth="1.2" strokeDasharray="3,3" />
              )}
              {showVwap && vwapPoints && (
                <polyline points={vwapPoints} fill="none" stroke="#0891b2" strokeWidth="1.5" strokeDasharray="4,3" />
              )}
              {showEma && ema9Points && (
                <polyline points={ema9Points} fill="none" stroke="#2563eb" strokeWidth="1.5" />
              )}
              {showEma && ema21Points && (
                <polyline points={ema21Points} fill="none" stroke="#6366f1" strokeWidth="1.5" />
              )}

              {/* Candlesticks */}
              {visibleBars.map((bar, i) => {
                const x = getX(i);
                const isGreen = bar.close >= bar.open;
                const highY = getY(bar.high);
                const lowY = getY(bar.low);
                const openY = getY(bar.open);
                const closeY = getY(bar.close);

                const bodyTop = Math.min(openY, closeY);
                const bodyHeight = Math.max(2, Math.abs(closeY - openY));
                const color = isGreen ? "#10b981" : "#ef4444";

                return (
                  <g
                    key={`bar-${i}`}
                    onMouseEnter={() => setHoveredBar(bar)}
                    onMouseLeave={() => setHoveredBar(null)}
                    className="cursor-crosshair"
                  >
                    {/* Wick */}
                    <line
                      x1={x}
                      y1={highY}
                      x2={x}
                      y2={lowY}
                      stroke={color}
                      strokeWidth="1.2"
                    />
                    {/* Candle Body */}
                    <rect
                      x={x - candleWidth / 2}
                      y={bodyTop}
                      width={candleWidth}
                      height={bodyHeight}
                      fill={color}
                      rx="1"
                    />
                  </g>
                );
              })}

              {/* Live Active Position Overlay on Chart (When Trade Started by Agent) */}
              {symbolPosition ? (
                <g id="active-position-overlay">
                  {/* Shaded Profit Target Zone */}
                  <rect
                    x={paddingLeft}
                    y={Math.min(getY(symbolPosition.entryPrice), getY(symbolPosition.takeProfit))}
                    width={width - paddingLeft - paddingRight}
                    height={Math.abs(getY(symbolPosition.entryPrice) - getY(symbolPosition.takeProfit))}
                    fill="#10b981"
                    fillOpacity="0.08"
                  />

                  {/* Shaded Stop Loss Zone */}
                  <rect
                    x={paddingLeft}
                    y={Math.min(getY(symbolPosition.entryPrice), getY(symbolPosition.stopLoss))}
                    width={width - paddingLeft - paddingRight}
                    height={Math.abs(getY(symbolPosition.entryPrice) - getY(symbolPosition.stopLoss))}
                    fill="#f43f5e"
                    fillOpacity="0.08"
                  />

                  {/* Live Entry Line */}
                  <line
                    x1={paddingLeft}
                    y1={getY(symbolPosition.entryPrice)}
                    x2={width - paddingRight}
                    y2={getY(symbolPosition.entryPrice)}
                    stroke="#0284c7"
                    strokeWidth="2"
                    strokeDasharray="5,4"
                  />
                  <rect
                    x={paddingLeft + 4}
                    y={getY(symbolPosition.entryPrice) - 16}
                    width={260}
                    height={15}
                    fill="#0284c7"
                    rx="3"
                  />
                  <text
                    x={paddingLeft + 8}
                    y={getY(symbolPosition.entryPrice) - 5}
                    fontSize="9.5"
                    fill="#ffffff"
                    fontWeight="bold"
                    fontFamily="monospace"
                  >
                    ENTRY: {symbolPosition.direction} {symbolPosition.quantity}u @ ₹{symbolPosition.entryPrice.toFixed(2)} | PnL: {symbolPosition.unrealizedPnl >= 0 ? "+" : "-"}₹{Math.abs(symbolPosition.unrealizedPnl).toFixed(2)}
                  </text>

                  {/* Stop Loss Line */}
                  <line
                    x1={paddingLeft}
                    y1={getY(symbolPosition.stopLoss)}
                    x2={width - paddingRight}
                    y2={getY(symbolPosition.stopLoss)}
                    stroke="#e11d48"
                    strokeWidth="1.8"
                    strokeDasharray="4,4"
                  />
                  <rect
                    x={paddingLeft + 4}
                    y={getY(symbolPosition.stopLoss) - 15}
                    width={155}
                    height={14}
                    fill="#e11d48"
                    rx="3"
                  />
                  <text
                    x={paddingLeft + 8}
                    y={getY(symbolPosition.stopLoss) - 4}
                    fontSize="9.5"
                    fill="#ffffff"
                    fontWeight="bold"
                    fontFamily="monospace"
                  >
                    STOP LOSS: ₹{symbolPosition.stopLoss.toFixed(2)}
                  </text>

                  {/* Take Profit Line */}
                  <line
                    x1={paddingLeft}
                    y1={getY(symbolPosition.takeProfit)}
                    x2={width - paddingRight}
                    y2={getY(symbolPosition.takeProfit)}
                    stroke="#059669"
                    strokeWidth="1.8"
                    strokeDasharray="4,4"
                  />
                  <rect
                    x={paddingLeft + 4}
                    y={getY(symbolPosition.takeProfit) - 15}
                    width={160}
                    height={14}
                    fill="#059669"
                    rx="3"
                  />
                  <text
                    x={paddingLeft + 8}
                    y={getY(symbolPosition.takeProfit) - 4}
                    fontSize="9.5"
                    fill="#ffffff"
                    fontWeight="bold"
                    fontFamily="monospace"
                  >
                    TAKE PROFIT: ₹{symbolPosition.takeProfit.toFixed(2)}
                  </text>
                </g>
              ) : (
                /* Pre-Trade Setup Overlays (Entry, Stop Loss, Take Profit) */
                activeSetup && (
                  <g id="setup-target-overlay">
                    {/* Entry Line */}
                    <line
                      x1={paddingLeft}
                      y1={getY(activeSetup.entryPrice)}
                      x2={width - paddingRight}
                      y2={getY(activeSetup.entryPrice)}
                      stroke="#2563eb"
                      strokeWidth="1.5"
                      strokeDasharray="4,4"
                    />
                    <text
                      x={paddingLeft + 6}
                      y={getY(activeSetup.entryPrice) - 4}
                      fontSize="9"
                      fill="#1d4ed8"
                      fontWeight="bold"
                    >
                      ENTRY: ₹{activeSetup.entryPrice}
                    </text>

                    {/* Stop Loss Line */}
                    <line
                      x1={paddingLeft}
                      y1={getY(activeSetup.stopLoss)}
                      x2={width - paddingRight}
                      y2={getY(activeSetup.stopLoss)}
                      stroke="#dc2626"
                      strokeWidth="1.5"
                      strokeDasharray="4,4"
                    />
                    <text
                      x={paddingLeft + 6}
                      y={getY(activeSetup.stopLoss) - 4}
                      fontSize="9"
                      fill="#b91c1c"
                      fontWeight="bold"
                    >
                      STOP LOSS: ₹{activeSetup.stopLoss}
                    </text>

                    {/* Take Profit Line */}
                    <line
                      x1={paddingLeft}
                      y1={getY(activeSetup.takeProfit)}
                      x2={width - paddingRight}
                      y2={getY(activeSetup.takeProfit)}
                      stroke="#059669"
                      strokeWidth="1.5"
                      strokeDasharray="4,4"
                    />
                    <text
                      x={paddingLeft + 6}
                      y={getY(activeSetup.takeProfit) - 4}
                      fontSize="9"
                      fill="#047857"
                      fontWeight="bold"
                    >
                      TARGET (R:R {activeSetup.riskRewardRatio}): ₹{activeSetup.takeProfit}
                    </text>
                  </g>
                )
              )}
            </svg>
          </div>

          {/* Active Candidate Strip */}
          <div className="mt-3 pt-3 border-t border-stone-100 flex flex-wrap items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-stone-700">Predefined Setup:</span>
              <span className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 font-medium border border-blue-200">
                {activeSetup?.name} ({activeSetup?.direction})
              </span>
              {activeSetup?.qualifies ? (
                <span className="flex items-center gap-1 text-emerald-600 font-medium">
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Setup Qualifies</span>
                </span>
              ) : (
                <span className="flex items-center gap-1 text-amber-600 font-medium">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>{activeSetup?.disqualificationReason}</span>
                </span>
              )}
            </div>

            <div className="flex items-center gap-4 text-stone-500 font-mono">
              <span>ATR(14): ₹{currentBar.atr}</span>
              <span>ADX: {currentBar.adx}</span>
              <span>RSI(14): {currentBar.rsi}</span>
            </div>
          </div>
        </div>

        {/* Right Side: Order Book & Section 7 Liquidity Filter */}
        <div className="bg-white border border-stone-200 rounded-xl p-4 shadow-xs flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between pb-2 border-b border-stone-200 mb-3">
              <div className="font-semibold text-stone-800 text-xs flex items-center gap-1.5">
                <BarChart2 className="w-4 h-4 text-stone-600" />
                <span>Order Book Depth (L2)</span>
              </div>
              <span className="text-[10px] text-stone-500 font-mono">
                Spread: ₹{orderBook.spread.toFixed(2)}
              </span>
            </div>

            {/* Asks (Sells) */}
            <div className="space-y-1 mb-2 font-mono text-[11px]">
              {orderBook.asks.slice(0, 5).reverse().map((ask, idx) => (
                <div key={`ask-${idx}`} className="relative flex items-center justify-between px-1.5 py-0.5 rounded">
                  <div
                    className="absolute inset-y-0 right-0 bg-rose-100 rounded opacity-60"
                    style={{ width: `${Math.min(100, (ask.total / 30) * 100)}%` }}
                  />
                  <span className="relative z-10 text-rose-600 font-semibold">₹{ask.price.toFixed(2)}</span>
                  <span className="relative z-10 text-stone-600">{ask.size.toFixed(2)}</span>
                </div>
              ))}
            </div>

            {/* Spread Mid Indicator */}
            <div className="py-1.5 my-1 bg-stone-100 rounded text-center font-mono text-xs font-bold text-stone-800 border border-stone-200">
              ₹{orderBook.midPrice.toFixed(2)}
            </div>

            {/* Bids (Buys) */}
            <div className="space-y-1 font-mono text-[11px]">
              {orderBook.bids.slice(0, 5).map((bid, idx) => (
                <div key={`bid-${idx}`} className="relative flex items-center justify-between px-1.5 py-0.5 rounded">
                  <div
                    className="absolute inset-y-0 right-0 bg-emerald-100 rounded opacity-60"
                    style={{ width: `${Math.min(100, (bid.total / 30) * 100)}%` }}
                  />
                  <span className="relative z-10 text-emerald-600 font-semibold">₹{bid.price.toFixed(2)}</span>
                  <span className="relative z-10 text-stone-600">{bid.size.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Section 7 Liquidity Metric Card */}
          <div className="mt-4 pt-3 border-t border-stone-200">
            <div className="flex items-center justify-between text-xs mb-1">
              <span className="text-stone-600 font-medium">Liquidity Score (Sec 7):</span>
              <span className={`font-mono font-bold ${orderBook.depthScore >= 35 ? "text-emerald-600" : "text-rose-600"}`}>
                {orderBook.depthScore} / 100
              </span>
            </div>
            <div className="w-full bg-stone-200 rounded-full h-2 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  orderBook.depthScore >= 35 ? "bg-emerald-500" : "bg-rose-500"
                }`}
                style={{ width: `${orderBook.depthScore}%` }}
              />
            </div>
            <div className="text-[10px] text-stone-500 mt-1">
              {orderBook.depthScore >= 35
                ? "Depth filter PASSED: adequate size for limit execution."
                : "Depth filter BLOCKED: thin order book hazard."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
