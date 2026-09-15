const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// Add states
const stateCode = `
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
`;

code = code.replace(
  'const [activeTab, setActiveTab] = useState<"overview" | "rbac" | "audit" | "api_keys">("overview");',
  'const [activeTab, setActiveTab] = useState<"overview" | "rbac" | "audit" | "api_keys" | "cloud">("overview");\\n' + stateCode
);

// Add tab to map
code = code.replace(
  '{ id: "api_keys", label: "Exchange API Security", icon: Key },',
  '{ id: "api_keys", label: "Exchange API Security", icon: Key },\\n            { id: "cloud", label: "Cloud Sync", icon: Cloud },'
);


// Add tab content before the end of the modal body
const cloudTabContent = `
          {/* TAB: CLOUD SYNC */}
          {activeTab === "cloud" && (
            <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-300">
              <div className="bg-[#121217] border border-[#1e1e24] rounded-xl p-4 sm:p-5">
                <h3 className="text-sm font-semibold font-sans text-stone-200 mb-2 flex items-center gap-2">
                  <Cloud className="w-4 h-4 text-emerald-400" />
                  Cloud Memory Synchronization
                </h3>
                <p className="text-xs text-stone-400 font-mono leading-relaxed mb-6">
                  Back up your bot's learned Experience Vectors, historical trades, and capital metrics to Firebase Firestore. This allows you to safely persist your trading brain across devices and clear your local cache without losing your model's intelligence.
                </p>

                {!currentUser ? (
                  <div className="text-center py-6 border border-dashed border-[#2a2a35] rounded-xl bg-[#0d0d10]">
                    <Lock className="w-6 h-6 text-stone-500 mx-auto mb-3" />
                    <p className="text-xs text-stone-400 font-mono mb-4">
                      Authentication required for secure cloud sync.
                    </p>
                    <button
                      onClick={onOpenAuthModal}
                      className="px-4 py-2 bg-[#1c1c24] hover:bg-[#252530] text-stone-200 text-xs font-mono rounded-lg transition-colors border border-[#2a2a35] cursor-pointer"
                    >
                      Sign In to Sync
                    </button>
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <button
                      onClick={handlePushToCloud}
                      disabled={isSyncing}
                      className="flex flex-col items-center justify-center gap-3 p-5 rounded-xl border border-[#202028] bg-[#0e0e11] hover:bg-[#14141a] hover:border-emerald-900/50 transition-all group disabled:opacity-50 cursor-pointer"
                    >
                      <div className="p-3 bg-[#181820] rounded-full group-hover:bg-[#152520] transition-colors">
                        <UploadCloud className="w-6 h-6 text-emerald-400" />
                      </div>
                      <div className="text-center">
                        <div className="text-sm font-semibold text-stone-200 font-sans">Push to Cloud</div>
                        <div className="text-[10px] text-stone-500 font-mono mt-1">Backup local memory to Firestore</div>
                      </div>
                    </button>

                    <button
                      onClick={handlePullFromCloud}
                      disabled={isSyncing}
                      className="flex flex-col items-center justify-center gap-3 p-5 rounded-xl border border-[#202028] bg-[#0e0e11] hover:bg-[#14141a] hover:border-blue-900/50 transition-all group disabled:opacity-50 cursor-pointer"
                    >
                      <div className="p-3 bg-[#181820] rounded-full group-hover:bg-[#152030] transition-colors">
                        <DownloadCloud className="w-6 h-6 text-blue-400" />
                      </div>
                      <div className="text-center">
                        <div className="text-sm font-semibold text-stone-200 font-sans">Restore from Cloud</div>
                        <div className="text-[10px] text-stone-500 font-mono mt-1">Overwrite local memory with Cloud data</div>
                      </div>
                    </button>
                  </div>
                )}
                
                {syncStatus && (
                  <div className="mt-4 p-3 bg-[#121217] border border-[#202028] rounded-lg text-center">
                    <span className="text-xs font-mono text-emerald-400 flex items-center justify-center gap-2">
                      {isSyncing && <RefreshCw className="w-3.5 h-3.5 animate-spin" />}
                      {syncStatus}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}
`;

code = code.replace(
  '        </div>\\n      </div>\\n    </div>',
  '\\n' + cloudTabContent + '\\n        </div>\\n      </div>\\n    </div>'
);

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
