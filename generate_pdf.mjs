import { jsPDF } from "jspdf";
import fs from "fs";
import path from "path";

const doc = new jsPDF({
  orientation: "portrait",
  unit: "mm",
  format: "a4",
});

const pageWidth = 210;
const pageHeight = 297;
const margin = 18;
const contentWidth = pageWidth - margin * 2;
let y = margin;

function checkPage(needed = 15) {
  if (y + needed > pageHeight - margin) {
    doc.addPage();
    y = margin;
    drawHeaderFooter();
  }
}

function drawHeaderFooter() {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(140, 140, 140);
  doc.text("NEXUS DESK · SYSTEM ARCHITECTURE & LEARNING SPECIFICATION", margin, 10);
  doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, 10, { align: "right" });
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.2);
  doc.line(margin, 12, pageWidth - margin, 12);

  // Footer
  doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
  doc.text("CONFIDENTIAL · INSTITUTIONAL RISK & QUANT ARCHITECTURE", margin, pageHeight - 8);
  doc.text("GENERATED: " + new Date().toISOString().split("T")[0], pageWidth - margin, pageHeight - 8, { align: "right" });
}

// First page header
drawHeaderFooter();

// Title Block
doc.setFillColor(15, 23, 42); // slate-900
doc.rect(margin, y, contentWidth, 28, "F");

doc.setFont("helvetica", "bold");
doc.setFontSize(16);
doc.setTextColor(255, 255, 255);
doc.text("NEXUS DESK TRADING TERMINAL", margin + 6, y + 10);

doc.setFont("helvetica", "normal");
doc.setFontSize(10);
doc.setTextColor(148, 163, 184); // slate-400
doc.text("Technical Architecture, Multi-Agent Workflow & In-Context Learning Engine", margin + 6, y + 18);

y += 36;

// Section Function
function addHeading(title) {
  checkPage(18);
  y += 4;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(15, 23, 42);
  doc.text(title, margin, y);
  y += 2;
  doc.setDrawColor(16, 185, 129); // emerald-500
  doc.setLineWidth(1.0);
  doc.line(margin, y, margin + 28, y);
  y += 6;
}

function addSubheading(title) {
  checkPage(12);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(10.5);
  doc.setTextColor(30, 41, 59);
  doc.text(title, margin, y);
  y += 5;
}

function addParagraph(text) {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9.5);
  doc.setTextColor(51, 65, 85);
  const lines = doc.splitTextToSize(text, contentWidth);
  checkPage(lines.length * 5 + 3);
  doc.text(lines, margin, y);
  y += lines.length * 4.8 + 3;
}

function addBullet(label, text) {
  checkPage(10);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(15, 23, 42);
  doc.text("• " + label + ":", margin + 3, y);
  
  const labelWidth = doc.getTextWidth("• " + label + ": ");
  doc.setFont("helvetica", "normal");
  doc.setTextColor(51, 65, 85);
  
  const availableFirstLineWidth = contentWidth - 3 - labelWidth;
  const words = text.split(" ");
  let firstLine = "";
  let remainingWords = [...words];

  while (remainingWords.length > 0) {
    const testLine = firstLine ? firstLine + " " + remainingWords[0] : remainingWords[0];
    if (doc.getTextWidth(testLine) < availableFirstLineWidth) {
      firstLine = testLine;
      remainingWords.shift();
    } else {
      break;
    }
  }

  doc.text(firstLine, margin + 3 + labelWidth, y);
  y += 4.5;

  if (remainingWords.length > 0) {
    const remainingText = remainingWords.join(" ");
    const lines = doc.splitTextToSize(remainingText, contentWidth - 8);
    checkPage(lines.length * 4.5);
    doc.text(lines, margin + 8, y);
    y += lines.length * 4.5;
  }
  y += 1.5;
}

// 1. Executive Overview
addHeading("1. Executive Overview & Design Principles");
addParagraph(
  "Nexus Desk is an autonomous institutional paper-trading terminal built with a multi-agent hierarchy and a fail-closed risk management engine. Rather than operating as an unobservable, black-box trading system, the terminal enforces explicit boundaries between Signal Detection, Pre-Flight Risk Filtering, Multi-Agent Veto Gates, and Execution Monitoring."
);
addBullet("Fail-Closed Architecture", "Trading halts immediately if connectivity breaks, a circuit breaker trips, or the manual Kill Switch is engaged.");
addBullet("Human-in-the-Loop Supervision", "Three execution modes (Manual, Semi-Auto, Auto Within Limits) allow operators to maintain direct veto authority over strategy recommendations.");
addBullet("Continuous In-Context Adaptation", "Closed trades automatically undergo post-mortem autopsies that update a persistent Memory Bank to reject low-probability setups in future iterations.");

// 2. Multi-Agent Hierarchy
addHeading("2. Multi-Agent Hierarchy & Roles");
addParagraph(
  "The terminal coordinates five specialized algorithmic agents, each responsible for an isolated step in the trade decision pipeline:"
);
addBullet("Market Radar Scanner", "Continuously ingests order book ticks, monitoring price velocity, 24-hour volume surges, and RSI divergence across pairs (BTC, ETH, SOL, JUP, etc.).");
addBullet("Strategy Agent (Breakout-v2.0)", "Evaluates trend breakouts above dynamic resistance levels with volume threshold confirmation. Automatically computes calibrated Entry, Stop-Loss, and Take-Profit price levels.");
addBullet("Pre-Flight Risk Engine", "Evaluates candidate proposals against capital constraints, ensuring gross open positions do not exceed 5, individual ticket sizing respects max equity percentage, and market spread remains acceptable.");
addBullet("Commander Supervisor", "Maintains high-level oversight of gross desk exposure, win/loss streaks, and market volatility regimes. Authorizes autonomous self-approval and generates the executive briefing.");
addBullet("Autopsy & Reflection Agent", "Inspects every closed position immediately upon exit, categorizing whether profit or loss was driven by trend continuation, false breakout, or chop, and formulating persistent lessons.");

// 3. Step-by-Step Execution Lifecycle
addHeading("3. Step-by-Step Execution Lifecycle");
addSubheading("Step 1: Signal Identification & Radar Scoring");
addParagraph(
  "The Market Radar analyzes high-frequency tick data. When an asset crosses key momentum thresholds and breaks its 20-period moving average with elevated relative volume, a trade candidate is flagged."
);

addSubheading("Step 2: Proposal Formulation & Risk Verification");
addParagraph(
  "The Strategy Agent computes position sizing using ATR (Average True Range) stop-loss positioning and a 2:1 reward-to-risk ratio. The proposal enters the Queue with status PENDING_APPROVAL and an agent confidence score (e.g., 88%)."
);

addSubheading("Step 3: Approval Gate & Clearance Enforcement");
addParagraph(
  "The system verifies operator clearance and active decision mode. In MANUAL mode, trades require Commander or Trader approval. In AUTO_WITHIN_LIMITS, the Commander agent cross-references the proposal against recent memory lessons and executes automatically if no veto conditions are triggered."
);

addSubheading("Step 4: Active Book Monitoring & Order Execution");
addParagraph(
  "Approved orders enter the active Book. The execution loop recomputes unrealized PnL every 2 seconds. Automated stop-losses protect downside capital, take-profit limits capture returns at targets, and operators can trigger immediate manual market exits."
);

// 4. Current Learning & Training Methodology
addHeading("4. Current Training & Learning Methodology");
addParagraph(
  "In live quant trading, neural network weights are not continuously fine-tuned directly on noisy financial price ticks to prevent catastrophic forgetting and overfitting. Nexus Desk utilizes a sophisticated hybrid approach combining Mathematical Walk-Forward Optimization with LLM In-Context Memory Reflexion:"
);

addSubheading("A. Reflexion & Memory Bank (The Post-Mortem Loop)");
addBullet("Trigger Event", "Every closed position triggers an automated autopsy function.");
addBullet("Diagnostic Extraction", "The system identifies entry conditions, market regime (trending, consolidating, choppy), and the primary reason for success or stop-out.");
addBullet("Distilled Heuristic", "The post-mortem translates the loss into an explicit heuristic (e.g., 'Do not long SOL when BTC 15m correlation is divergent and volume is declining').");
addBullet("Prompt Pre-Conditioning", "Future candidate proposals are matched against active memory heuristics. If a candidate matches a prior failure condition, confidence is degraded or auto-vetoed.");

addSubheading("B. Walk-Forward Lab (Quantitative Model Selection)");
addBullet("Train / Test Slices", "The Lab tests model configurations across rolling historical windows (e.g., 30-day in-sample training, 7-day out-of-sample testing).");
addBullet("Champion vs. Challenger", "The active 'Champion' model is benchmarked against candidate models on Sharpe Ratio, Max Drawdown, Profit Factor, and Win Rate.");
addBullet("Promotion Gate", "A challenger model can only be promoted to active production trading if it statistically outperforms the Champion across out-of-sample test splits.");

// 5. Security & Role-Based Access Control
addHeading("5. Security, RBAC & Immutable Audit Ledger");
addParagraph(
  "Nexus Desk integrates Firebase Authentication and Firestore Security Rules to enforce strict operational clearance:"
);
addBullet("Commander Clearance", "Full operational authority. Can toggle the emergency Kill Switch, activate Autonomous Self-Approval, and promote models in the Lab.");
addBullet("Desk Trader Clearance", "Execution authority. Can approve or veto queued tickets and execute manual position exits. Prohibited from enabling Autonomous mode.");
addBullet("Auditor Clearance", "Read-only compliance authority. Can observe the trading floor, review active book positions, and inspect real-time audit trails without trade execution permissions.");
addBullet("Immutable Audit Ledger", "All critical actions (sign-in, role changes, kill switch toggles, order approvals, manual exits) are permanently written to Cloud Firestore under strict security rules forbidding updates or deletions.");

// Save the PDF
const outputDir = path.join(process.cwd(), "public");
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}
const pdfPath = path.join(outputDir, "Nexus_Desk_System_Architecture_and_Learning_Specification.pdf");
const pdfBuffer = Buffer.from(doc.output("arraybuffer"));
fs.writeFileSync(pdfPath, pdfBuffer);

console.log("PDF generated successfully at:", pdfPath);
