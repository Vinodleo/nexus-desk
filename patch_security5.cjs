const fs = require('fs');
let code = fs.readFileSync('src/components/SecurityConsoleModal.tsx', 'utf-8');

const stateInjection = `
  const [exchangeType, setExchangeType] = useState("Zerodha (Kite Connect)");
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [encryptSuccess, setEncryptSuccess] = useState(false);

  const handleSaveKeys = () => {
    if (!apiKey || !apiSecret) return;
    setIsEncrypting(true);
    setEncryptSuccess(false);
    
    // Simulate secure encryption & Firebase sync
    setTimeout(() => {
      setIsEncrypting(false);
      setEncryptSuccess(true);
      setApiKey("");
      setApiSecret("");
      
      setTimeout(() => setEncryptSuccess(false), 3000);
    }, 1500);
  };
`;

code = code.replace(
  'const [activeTab, setActiveTab] = useState<"overview" | "rbac" | "audit" | "api_keys" | "cloud">("overview");',
  'const [activeTab, setActiveTab] = useState<"overview" | "rbac" | "audit" | "api_keys" | "cloud">("overview");' + stateInjection
);

fs.writeFileSync('src/components/SecurityConsoleModal.tsx', code);
