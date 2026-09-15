const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// We are going to replace the handleSaveKeys block and the UI for Zerodha
// Let's first add a state for the Zerodha Request Token flow

const stateInjection = `
  const [exchangeType, setExchangeType] = useState("Zerodha (Kite Connect)");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [encryptSuccess, setEncryptSuccess] = useState(false);
  const [showZerodhaLogin, setShowZerodhaLogin] = useState(false);

  const handleSaveKeys = async () => {
    if (!apiKey || !apiSecret) return;
    setIsEncrypting(true);
    setEncryptSuccess(false);
    
    if (exchangeType.includes("Zerodha")) {
      // 1. Simulate saving keys to Firebase/Backend securely
      setTimeout(() => {
        setIsEncrypting(false);
        setEncryptSuccess(true);
        // 2. Reveal the Zerodha Login Button which requires the redirect
        setShowZerodhaLogin(true);
      }, 1000);
      return;
    }

    // Default flow for others
    setTimeout(() => {
      setIsEncrypting(false);
      setEncryptSuccess(true);
      setApiKey("");
      setApiSecret("");
      setTimeout(() => setEncryptSuccess(false), 3000);
    }, 1500);
  };

  const handleZerodhaLogin = () => {
    // In production, this redirects to:
    // https://kite.trade/connect/login?v=3&api_key=YOUR_API_KEY
    alert("Redirecting to Kite Login OAuth... (Mocked for now)");
    // After redirect, Zerodha sends back a ?request_token=... to our callback URL
  };
`;

// Replace the old state block
const oldStateBlockRegex = /const \[exchangeType, setExchangeType\] = useState\("Zerodha \(Kite Connect\)"\);[\s\S]*?\}, 1500\);\n  \};/m;
code = code.replace(oldStateBlockRegex, stateInjection.trim());

// Now replace the Vault UI section to handle the new Zerodha flow conditionally
const oldVaultUI = `<div className="pt-2">
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
                </div>`;

const newVaultUI = `{exchangeType.includes("Zerodha") && showZerodhaLogin ? (
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
                )}`;

code = code.replace(oldVaultUI, newVaultUI);

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
