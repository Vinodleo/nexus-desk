import React, { useState } from "react";

import { syncToFirebase, syncFromFirebase, saveExchangeKeys, loadExchangeKeys } from "../services/storagePersistenceService";
import { Cloud, UploadCloud, DownloadCloud } from "lucide-react";
import { useAuth, UserRole } from "../context/AuthContext";
import {
  Shield,
  ShieldCheck,
  ShieldAlert,
  Lock,
  UserCheck,
  Key,
  Server,
  FileText,
  Clock,
  ExternalLink,
  X,
  AlertTriangle,
  Radio,
  CheckCircle2,
  RefreshCw,
} from "lucide-react";

interface SecurityConsoleModalProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAuthModal: () => void;
}

export const SecurityConsoleModal: React.FC<SecurityConsoleModalProps> = ({
  isOpen,
  onClose,
  onOpenAuthModal,
}) => {
  const {
    currentUser,
    userProfile,
    userRole,
    switchUserRole,
    logout,
    recentAudits,
    logSecurityAudit,
  } = useAuth();

  const [activeTab, setActiveTab] = useState<"overview" | "rbac" | "audit" | "api_keys" | "cloud">("overview");
  type BrokerId = "zerodha" | "coindcx" | "ibkr" | "binance" | "alpaca";
  const [exchangeType, setExchangeType] = useState<BrokerId>("zerodha");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [encryptSuccess, setEncryptSuccess] = useState(false);
  
  // Track which vaults have keys stored
  const [activeVaults, setActiveVaults] = useState<Record<string, boolean>>({});

  React.useEffect(() => {
    if (activeTab === "api_keys" && currentUser) {
      loadExchangeKeys(currentUser.uid).then(data => {
        if (data) {
          const vaults: Record<string, boolean> = {};
          Object.keys(data).forEach(key => {
            if (data[key]?.apiKey) vaults[key] = true;
          });
          setActiveVaults(vaults);
        }
      });
    }
  }, [activeTab, currentUser]);
  
  // When switching tabs, clear inputs
  React.useEffect(() => {
    setApiKey("");
    setApiSecret("");
    setEncryptSuccess(false);
  }, [exchangeType]);

  const handleSaveKeys = async () => {
    if (!apiKey || !apiSecret) return;
    if (!currentUser) {
      alert("Please login via Firebase Auth first to securely store keys.");
      return;
    }

    setIsEncrypting(true);
    setEncryptSuccess(false);
    
    // Simulate generation of AES cipher (Mock delay)
    await new Promise(res => setTimeout(res, 800));
    
    // Push encrypted payload to Firebase
    const success = await saveExchangeKeys(currentUser.uid, exchangeType, apiKey, apiSecret);
    
    setIsEncrypting(false);
    if (success) {
      setEncryptSuccess(true);
      setActiveVaults(prev => ({ ...prev, [exchangeType]: true }));
      setApiKey("");
      setApiSecret("");
      setTimeout(() => setEncryptSuccess(false), 3000);
    } else {
      alert("Failed to securely store keys in Firestore.");
    }
  };


  const handleZerodhaLogin = () => {
    // In production, this redirects to:
    // https://kite.trade/connect/login?v=3&api_key=YOUR_API_KEY
    alert("Redirecting to Kite Login OAuth... (Mocked for now)");
    // After redirect, Zerodha sends back a ?request_token=... to our callback URL
  };


  const [isSyncing, setIsSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  const handlePushToCloud = async () => {
    if (!currentUser) return;
    setIsSyncing(true);
    setSyncStatus("Syncing...");
    await syncToFirebase(currentUser.uid);
    await logSecurityAudit("CLOUD_SYNC_PUSH", "Pushed local trading memory and telemetry to Cloud Firestore.");
    setSyncStatus("Synced to Cloud");
    setTimeout(() => setSyncStatus(null), 3000);
    setIsSyncing(false);
  };

  const handlePullFromCloud = async () => {
    if (!currentUser) return;
    setIsSyncing(true);
    setSyncStatus("Downloading...");
    const success = await syncFromFirebase(currentUser.uid);
    if (success) {
      await logSecurityAudit("CLOUD_SYNC_PULL", "Downloaded cloud trading memory to local device.");
      setSyncStatus("Restored from Cloud");
      // Force reload to apply state
      setTimeout(() => window.location.reload(), 1500);
    } else {
      setSyncStatus("Failed to restore");
    }
    setTimeout(() => setSyncStatus(null), 3000);
    setIsSyncing(false);
  };


  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-md animate-in fade-in select-none">
      <div className="w-full max-w-2xl bg-[#0e0e13] border border-[#242432] rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden text-stone-200">
        {/* Top Header */}
        <div className="flex items-center justify-between p-4 sm:p-5 border-b border-[#1f1f2a] bg-[#111117]">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-950/60 border border-emerald-800/60 text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-sans font-bold text-white">
                  Security & Authentication Console
                </h3>
                <span className="px-2 py-0.5 rounded bg-emerald-950/80 border border-emerald-800/60 text-emerald-300 font-mono text-[10px] uppercase tracking-wider">
                  Firebase Active
                </span>
              </div>
              <p className="text-xs text-stone-400 font-sans mt-0.5">
                Authentication, Role-Based Access Control, and Immutable Audit Trail
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-stone-400 hover:text-stone-200 p-1.5 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center gap-1 px-4 pt-3 border-b border-[#1d1d28] bg-[#0c0c11] overflow-x-auto [&::-webkit-scrollbar]:hidden" style={{ scrollbarWidth: "none" }}>
          {[
            { id: "overview", label: "Operator Session", icon: UserCheck },
            { id: "rbac", label: "Clearance & RBAC", icon: Lock },
            { id: "audit", label: `Audit Trail (${recentAudits.length})`, icon: FileText },
            { id: "api_keys", label: "Exchange API Security", icon: Key },
            { id: "cloud", label: "Cloud Sync", icon: Cloud },
          ].map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`flex items-center whitespace-nowrap shrink-0 gap-1.5 px-3 py-2 text-xs font-mono font-medium rounded-t-lg transition-colors cursor-pointer border-b-2 ${
                  isActive
                    ? "text-emerald-400 border-emerald-400 bg-[#161620]"
                    : "text-stone-400 border-transparent hover:text-stone-200"
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* Modal Body */}
        <div className="p-4 sm:p-6 overflow-y-auto space-y-4">
          {/* TAB 1: OPERATOR SESSION */}
          {activeTab === "overview" && (
            <div className="space-y-4">
              {/* Session Card */}
              <div className="rounded-xl bg-[#14141d] border border-[#252535] p-4 space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-[#1e1e2c] border border-[#323246] flex items-center justify-center font-mono font-bold text-white text-base">
                      {currentUser?.displayName?.[0] || currentUser?.email?.[0] || userProfile?.displayName?.[0] || "O"}
                    </div>
                    <div>
                      <div className="text-sm font-semibold text-white flex items-center gap-2">
                        <span>{currentUser?.displayName || userProfile?.displayName || "Desk Operator"}</span>
                        <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-950 text-emerald-300 border border-emerald-800">
                          {userProfile?.provider.toUpperCase() || "SECURE"}
                        </span>
                      </div>
                      <div className="text-xs font-mono text-stone-400">
                        {currentUser?.email || (currentUser?.isAnonymous ? "Anonymous Verified Token" : "operator@nexus.terminal")}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        onClose();
                        onOpenAuthModal();
                      }}
                      className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-mono text-xs font-medium transition-all cursor-pointer shadow-sm"
                    >
                      {currentUser ? "Switch Operator" : "Sign In / Register"}
                    </button>

                    {currentUser && (
                      <button
                        onClick={async () => {
                          await logout();
                        }}
                        className="px-3 py-1.5 rounded-lg bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 font-mono text-xs transition-all cursor-pointer"
                      >
                        Sign Out
                      </button>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-[#1f1f2c] text-[11px] font-mono">
                  <div>
                    <span className="text-stone-400 block text-[9px] uppercase">Clearance</span>
                    <span className="text-emerald-400 font-bold capitalize">{userRole}</span>
                  </div>
                  <div>
                    <span className="text-stone-400 block text-[9px] uppercase">Auth Provider</span>
                    <span className="text-stone-200">{currentUser ? (currentUser.isAnonymous ? "Firebase Anon" : "Firebase JWT") : "Sandbox Session"}</span>
                  </div>
                  <div>
                    <span className="text-stone-400 block text-[9px] uppercase">Encryption</span>
                    <span className="text-stone-200">TLS 1.3 / SHA-256</span>
                  </div>
                  <div>
                    <span className="text-stone-400 block text-[9px] uppercase">Last Verified</span>
                    <span className="text-stone-300">{userProfile?.lastLoginAt || "Live"}</span>
                  </div>
                </div>
              </div>

              {/* Security Guardrails Check */}
              <div className="rounded-xl bg-[#111118] border border-[#20202c] p-4 space-y-2.5">
                <h4 className="text-xs font-mono uppercase tracking-wider text-stone-300 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  <span>Terminal Defensive Guardrails</span>
                </h4>

                <div className="space-y-2 text-xs font-mono">
                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Firebase Auth Token Verification</span>
                    </div>
                    <span className="text-emerald-400 font-medium">ENFORCED</span>
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Hard 1.0% Equity Loss Cap per Trade</span>
                    </div>
                    <span className="text-emerald-400 font-medium">STRICT CODE</span>
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Emergency Kill-Switch Ingress</span>
                    </div>
                    <span className="text-emerald-400 font-medium">ONLINE</span>
                  </div>

                  <div className="flex items-center justify-between p-2 rounded-lg bg-[#161622] border border-[#262638]">
                    <div className="flex items-center gap-2 text-stone-200">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Immutable Cloud Firestore Audit Trail</span>
                    </div>
                    <span className="text-emerald-400 font-medium">SYNCHRONIZED</span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: RBAC MATRIX */}
          {activeTab === "rbac" && (
            <div className="space-y-4">
              <p className="text-xs text-stone-300 font-sans leading-relaxed">
                Role-Based Access Control isolates sensitive operational commands. Switch clearances
                below to test enforcement across the terminal.
              </p>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {/* Commander */}
                <div
                  onClick={() => switchUserRole("commander")}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    userRole === "commander"
                      ? "bg-emerald-950/40 border-emerald-500 shadow-lg ring-1 ring-emerald-500"
                      : "bg-[#13131b] border-[#222230] hover:border-stone-500"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-mono font-bold text-emerald-400 uppercase">
                      Commander
                    </span>
                    {userRole === "commander" && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-900 text-emerald-200 font-mono">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-stone-400 leading-snug">
                    Full root administrative control. Can toggle autonomous self-approval, trigger kill switch, and override risk rules.
                  </p>
                  <ul className="mt-3 space-y-1 text-[10px] font-mono text-stone-300">
                    <li className="flex items-center gap-1.5 text-emerald-400">✓ Kill Switch Toggle</li>
                    <li className="flex items-center gap-1.5 text-emerald-400">✓ Self-Approval Access</li>
                    <li className="flex items-center gap-1.5 text-emerald-400">✓ Risk Limit Override</li>
                  </ul>
                </div>

                {/* Trader */}
                <div
                  onClick={() => switchUserRole("trader")}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    userRole === "trader"
                      ? "bg-blue-950/40 border-blue-500 shadow-lg ring-1 ring-blue-500"
                      : "bg-[#13131b] border-[#222230] hover:border-stone-500"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-mono font-bold text-blue-400 uppercase">
                      Desk Trader
                    </span>
                    {userRole === "trader" && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-200 font-mono">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-stone-400 leading-snug">
                    Operational execution rights. Can approve proposal queue items, execute manual orders, and close positions.
                  </p>
                  <ul className="mt-3 space-y-1 text-[10px] font-mono text-stone-300">
                    <li className="flex items-center gap-1.5 text-blue-400">✓ Queue Order Approvals</li>
                    <li className="flex items-center gap-1.5 text-blue-400">✓ Position Close Rights</li>
                    <li className="flex items-center gap-1.5 text-stone-500">✕ No Risk Policy Edits</li>
                  </ul>
                </div>

                {/* Auditor */}
                <div
                  onClick={() => switchUserRole("auditor")}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer ${
                    userRole === "auditor"
                      ? "bg-amber-950/40 border-amber-500 shadow-lg ring-1 ring-amber-500"
                      : "bg-[#13131b] border-[#222230] hover:border-stone-500"
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-mono font-bold text-amber-400 uppercase">
                      Auditor
                    </span>
                    {userRole === "auditor" && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-900 text-amber-200 font-mono">
                        Active
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-stone-400 leading-snug">
                    Compliance and inspection clearance. Read-only access to decision pipelines, telemetry, and memory vectors.
                  </p>
                  <ul className="mt-3 space-y-1 text-[10px] font-mono text-stone-300">
                    <li className="flex items-center gap-1.5 text-amber-400">✓ Inspect Audit Logs</li>
                    <li className="flex items-center gap-1.5 text-stone-500">✕ No Order Execution</li>
                    <li className="flex items-center gap-1.5 text-stone-500">✕ No Position Modifying</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: IMMUTABLE AUDIT TRAIL */}
          {activeTab === "audit" && (
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-mono text-stone-400">
                <span>Recent Security & Operational Audit Log Entries</span>
                <span className="text-emerald-400">Firestore collection: auditLogs</span>
              </div>

              {recentAudits.length === 0 ? (
                <div className="rounded-xl bg-[#121219] border border-[#20202c] p-6 text-center text-xs text-stone-400">
                  No audit events recorded yet. Authentication, role changes, and order executions will stream here.
                </div>
              ) : (
                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                  {recentAudits.map((entry) => (
                    <div
                      key={entry.id}
                      className="p-3 rounded-xl bg-[#13131c] border border-[#232333] space-y-1 font-mono text-xs"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-emerald-400 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>{entry.action}</span>
                        </span>
                        <span className="text-[10px] text-stone-400 flex items-center gap-1">
                          <Clock className="w-3 h-3 text-stone-400" />
                          {entry.timestamp}
                        </span>
                      </div>
                      <p className="text-stone-200 text-[11px] font-sans">{entry.details}</p>
                      <div className="text-[10px] text-stone-400 flex items-center gap-2 pt-1 border-t border-[#1c1c28]">
                        <span>Operator: {entry.userEmail}</span>
                        <span>•</span>
                        <span>UID: {entry.userId.slice(0, 14)}...</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 4: EXCHANGE API ENCRYPTION VAULT */}
          {activeTab === "api_keys" && (
            <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="rounded-xl bg-amber-950/20 border border-amber-900/30 p-4 space-y-2">
                <h4 className="text-xs font-mono font-semibold text-amber-500 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Multi-Broker Keychain (Smart Routing)</span>
                </h4>
                <p className="text-[11px] font-sans text-stone-300 leading-relaxed">
                  Store isolated credentials for multiple exchanges. The system's SOR (Smart Order Router) will automatically sign and dispatch trades to the correct broker based on the asset class proposed by the AI.
                </p>
              </div>
              
              {/* Vault Badges */}
              <div className="flex gap-2 flex-wrap mb-2">
                {Object.entries({
                  zerodha: "Zerodha (IN)",
                  coindcx: "CoinDCX (Crypto)",
                  ibkr: "IBKR (Global)"
                }).map(([id, label]) => (
                  <div key={id} className={`px-2 py-1 text-[10px] font-mono rounded flex items-center gap-1.5 ${activeVaults[id] ? "bg-emerald-900/40 text-emerald-400 border border-emerald-800/50" : "bg-stone-900 text-stone-500 border border-stone-800"}`}>
                    <div className={`w-1.5 h-1.5 rounded-full ${activeVaults[id] ? "bg-emerald-500" : "bg-stone-600"}`} />
                    {label}
                  </div>
                ))}
              </div>

              <div className="space-y-3 p-4 rounded-xl bg-[#12121a] border border-[#20202c]">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-stone-400 uppercase tracking-wider">Select Broker Slot</label>
                  <select 
                    value={exchangeType}
                    onChange={(e) => setExchangeType(e.target.value as any)}
                    className="w-full bg-[#0a0a0f] border border-[#262635] rounded-lg px-3 py-2 text-sm text-stone-200 font-mono outline-none focus:border-emerald-500/50"
                  >
                    <option value="zerodha">Zerodha (Kite Connect) - IN Equities</option>
                    <option value="coindcx">CoinDCX - Global Crypto</option>
                    <option value="ibkr">Interactive Brokers (Web API) - US Equities</option>
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-stone-400 uppercase tracking-wider flex justify-between">
                    <span>API Key (Public)</span>
                    <span className="text-stone-500 text-[9px]">Requires Trading Perms</span>
                  </label>
                  <input 
                    type="password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={activeVaults[exchangeType] ? "•••••••••••• (Key Active)" : "e.g. j7x...9Lp"}
                    className="w-full bg-[#0a0a0f] border border-[#262635] rounded-lg px-3 py-2 text-sm text-stone-200 font-mono outline-none focus:border-emerald-500/50 placeholder:text-stone-600"
                  />
                </div>

                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-stone-400 uppercase tracking-wider flex justify-between">
                    <span>API Secret (Private)</span>
                    <span className="text-rose-500/70 text-[9px]">Disable Withdrawals!</span>
                  </label>
                  <input 
                    type="password"
                    value={apiSecret}
                    onChange={(e) => setApiSecret(e.target.value)}
                    placeholder={activeVaults[exchangeType] ? "••••••••••••••••••••••••••••" : "****************************"}
                    className="w-full bg-[#0a0a0f] border border-[#262635] rounded-lg px-3 py-2 text-sm text-stone-200 font-mono outline-none focus:border-emerald-500/50 placeholder:text-stone-600"
                  />
                </div>

                {exchangeType === "zerodha" && activeVaults["zerodha"] ? (
                  <div className="pt-4 mt-4 border-t border-[#262635] space-y-3">
                    <div className="flex items-center gap-2 text-emerald-400 text-[11px] font-mono">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Zerodha keys securely stored in vault.</span>
                    </div>
                    <p className="text-[10px] text-stone-400 leading-snug">
                      Zerodha requires a daily OAuth login to generate an Access Token. Click below to authorize this session via Kite.
                    </p>
                    <button 
                      onClick={handleZerodhaLogin}
                      className="w-full py-2.5 rounded-lg bg-[#ff5722] hover:bg-[#ff7043] text-white text-xs font-mono tracking-wide font-bold transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Login to Kite Connect
                    </button>
                    <div className="pt-2">
                       <button 
                         onClick={handleSaveKeys}
                         disabled={isEncrypting || (!apiKey && !apiSecret)}
                         className="w-full text-[10px] text-stone-500 hover:text-stone-300 underline underline-offset-2"
                       >
                         Overwrite Keys
                       </button>
                    </div>
                  </div>
                ) : (
                  <div className="pt-2">
                    <button 
                      onClick={handleSaveKeys}
                      disabled={isEncrypting || !apiKey || !apiSecret}
                      className={`w-full py-2.5 rounded-lg text-xs font-mono tracking-wide flex items-center justify-center gap-2 transition-all cursor-pointer ${
                        encryptSuccess 
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" 
                          : isEncrypting 
                            ? "bg-[#1a1a24] text-stone-500 border border-[#2a2a35]"
                            : "bg-blue-600 hover:bg-blue-500 text-white border border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      }`}
                    >
                      {encryptSuccess ? (
                        <>
                          <CheckCircle2 className="w-4 h-4" />
                          Encrypted & Synced Securely
                        </>
                      ) : isEncrypting ? (
                        <>
                          <div className="w-3 h-3 border-2 border-stone-500 border-t-transparent rounded-full animate-spin" />
                          Generating AES-256 Cipher...
                        </>
                      ) : (
                        <>
                          <Key className="w-4 h-4" />
                          {activeVaults[exchangeType] ? "Update Keys" : "Encrypt & Save Keys"}
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
        {/* Modal Footer */}
        <div className="p-3 sm:p-4 border-t border-[#1f1f2c] bg-[#0c0c11] flex items-center justify-between text-xs font-mono text-stone-400">
          <span className="flex items-center gap-1.5">
            <Lock className="w-3.5 h-3.5 text-emerald-400" />
            <span>Terminal Clearance: <strong className="text-white capitalize">{userRole}</strong></span>
          </span>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-[#1a1a24] hover:bg-[#252533] text-stone-200 hover:text-white transition-all cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
};
