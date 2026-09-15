const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

const oldHooks = `  const [exchangeType, setExchangeType] = useState("Zerodha (Kite Connect)");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [encryptSuccess, setEncryptSuccess] = useState(false);
  const [showZerodhaLogin, setShowZerodhaLogin] = useState(false);

  
  const [hasExistingKeys, setHasExistingKeys] = useState(false);

  React.useEffect(() => {
    if (activeTab === "api_keys" && currentUser) {
      loadExchangeKeys(currentUser.uid).then(data => {
        if (data && data.apiKey) {
          setHasExistingKeys(true);
          setExchangeType(data.exchangeType || "Zerodha (Kite Connect)");
          if (data.exchangeType?.includes("Zerodha")) {
            setShowZerodhaLogin(true);
          }
        }
      });
    }
  }, [activeTab, currentUser]);

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
      setHasExistingKeys(true);
      if (exchangeType.includes("Zerodha")) {
        setShowZerodhaLogin(true);
      } else {
        setApiKey("");
        setApiSecret("");
        setTimeout(() => setEncryptSuccess(false), 3000);
      }
    } else {
      alert("Failed to securely store keys in Firestore.");
    }
  };`;

const newHooks = `  type BrokerId = "zerodha" | "coindcx" | "ibkr" | "binance" | "alpaca";
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
  };`;

code = code.replace(oldHooks, newHooks);

// Need to update the UI section for api_keys
const oldUI = `          {activeTab === "api_keys" && (
            <div className="space-y-4 animate-in fade-in zoom-in-95 duration-200">
              <div className="rounded-xl bg-amber-950/20 border border-amber-900/30 p-4 space-y-2">
                <h4 className="text-xs font-mono font-semibold text-amber-500 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  <span>Zero-Trust Vault Architecture</span>
                  {hasExistingKeys && <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-400 text-[9px] border border-emerald-800/50 uppercase tracking-wider">Vault Active</span>}
                </h4>
                <p className="text-[11px] font-sans text-stone-300 leading-relaxed">
                  Keys entered here are strictly client-side encrypted using AES-256 before being transmitted and stored in your Firebase node. They are never logged in plain text.
                </p>
              </div>

              <div className="space-y-3 p-4 rounded-xl bg-[#12121a] border border-[#20202c]">
                <div className="space-y-1.5">
                  <label className="text-[10px] font-mono text-stone-400 uppercase tracking-wider">Exchange Provider</label>
                  <select 
                    value={exchangeType}
                    onChange={(e) => setExchangeType(e.target.value)}
                    className="w-full bg-[#0a0a0f] border border-[#262635] rounded-lg px-3 py-2 text-sm text-stone-200 font-mono outline-none focus:border-emerald-500/50"
                  >
                    <option>Zerodha (Kite Connect)</option>
                    <option>Binance (Spot/Futures)</option>
                    <option>Alpaca (Paper/Live)</option>
                    <option>Interactive Brokers</option>
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
                    placeholder="e.g. j7x...9Lp"
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
                    placeholder="****************************"
                    className="w-full bg-[#0a0a0f] border border-[#262635] rounded-lg px-3 py-2 text-sm text-stone-200 font-mono outline-none focus:border-emerald-500/50 placeholder:text-stone-600"
                  />
                </div>

                {exchangeType.includes("Zerodha") && showZerodhaLogin ? (
                  <div className="pt-4 mt-4 border-t border-[#262635] space-y-3">
                    <div className="flex items-center gap-2 text-emerald-400 text-[11px] font-mono">
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Keys securely stored in vault.</span>
                    </div>
                    <p className="text-[10px] text-stone-400 leading-snug">
                      Zerodha requires a daily login to generate an Access Token. Click below to authorize this session via Kite.
                    </p>
                    <button 
                      onClick={handleZerodhaLogin}
                      className="w-full py-2.5 rounded-lg bg-[#ff5722] hover:bg-[#ff7043] text-white text-xs font-mono tracking-wide font-bold transition-all shadow-md flex items-center justify-center gap-2 cursor-pointer"
                    >
                      <ExternalLink className="w-4 h-4" />
                      Login to Kite Connect
                    </button>
                  </div>
                ) : (
                  <div className="pt-2">
                    <button 
                      onClick={handleSaveKeys}
                      disabled={isEncrypting || !apiKey || !apiSecret}
                      className={\`w-full py-2.5 rounded-lg text-xs font-mono tracking-wide flex items-center justify-center gap-2 transition-all cursor-pointer \${
                        encryptSuccess 
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" 
                          : isEncrypting 
                            ? "bg-[#1a1a24] text-stone-500 border border-[#2a2a35]"
                            : "bg-blue-600 hover:bg-blue-500 text-white border border-blue-500"
                      }\`}
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
                          Encrypt & Save Keys
                        </>
                      )}
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}`;

const newUI = `          {activeTab === "api_keys" && (
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
                  <div key={id} className={\`px-2 py-1 text-[10px] font-mono rounded flex items-center gap-1.5 \${activeVaults[id] ? "bg-emerald-900/40 text-emerald-400 border border-emerald-800/50" : "bg-stone-900 text-stone-500 border border-stone-800"}\`}>
                    <div className={\`w-1.5 h-1.5 rounded-full \${activeVaults[id] ? "bg-emerald-500" : "bg-stone-600"}\`} />
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
                      className={\`w-full py-2.5 rounded-lg text-xs font-mono tracking-wide flex items-center justify-center gap-2 transition-all cursor-pointer \${
                        encryptSuccess 
                          ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40" 
                          : isEncrypting 
                            ? "bg-[#1a1a24] text-stone-500 border border-[#2a2a35]"
                            : "bg-blue-600 hover:bg-blue-500 text-white border border-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                      }\`}
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
          )}`;

code = code.replace(oldUI, newUI);

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
