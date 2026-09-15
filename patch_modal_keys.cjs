const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

// Update import
code = code.replace(
  'import { syncToFirebase, syncFromFirebase } from "../services/storagePersistenceService";',
  'import { syncToFirebase, syncFromFirebase, saveExchangeKeys, loadExchangeKeys } from "../services/storagePersistenceService";'
);

// We need to add useEffect to load keys when the modal opens or tab changes, and modify handleSaveKeys
const oldHandleSaveKeys = `const handleSaveKeys = async () => {
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
  };`;

const newHandleSaveKeys = `
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
  };
`;

code = code.replace(oldHandleSaveKeys, newHandleSaveKeys);

// We should also replace the prompt text in Tab 4 to indicate keys exist if they do.
// I'll add a little indicator next to "Zero-Trust Vault Architecture"
const oldVaultHeader = `<span>Zero-Trust Vault Architecture</span>
                </h4>`;
const newVaultHeader = `<span>Zero-Trust Vault Architecture</span>
                  {hasExistingKeys && <span className="ml-2 px-1.5 py-0.5 rounded bg-emerald-900/60 text-emerald-400 text-[9px] border border-emerald-800/50 uppercase tracking-wider">Vault Active</span>}
                </h4>`;
code = code.replace(oldVaultHeader, newVaultHeader);

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
