const fs = require('fs');
let content = fs.readFileSync('src/services/storagePersistenceService.ts', 'utf-8');

// 1. Add istDateString to AgentCapitalState
content = content.replace(
  '  dailyRealizedPnl: number;\n}',
  '  dailyRealizedPnl: number;\n  istDateString?: string;\n}'
);

// 2. Modify loadStoredCapital
const loadOld = `export function loadStoredCapital(): AgentCapitalState {
  const fallback: AgentCapitalState = {
    equity: 100000,
    cash: 100000,
    dailyRealizedPnl: 0,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY_CAPITAL);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        equity: Number(parsed.equity) || fallback.equity,
        cash: Number(parsed.cash) || fallback.cash,
        dailyRealizedPnl: Number(parsed.dailyRealizedPnl) || 0,
      };
    }
  } catch (err) {
    console.warn("Failed to load capital from LocalStorage:", err);
  }
  return fallback;
}`;

const loadNew = `export function loadStoredCapital(): AgentCapitalState {
  const todayIST = getCurrentISTDateString();
  const fallback: AgentCapitalState = {
    equity: 100000,
    cash: 100000,
    dailyRealizedPnl: 0,
    istDateString: todayIST,
  };

  try {
    const raw = localStorage.getItem(STORAGE_KEY_CAPITAL);
    if (raw) {
      const parsed = JSON.parse(raw);
      const savedDate = parsed.istDateString;
      
      return {
        equity: Number(parsed.equity) || fallback.equity,
        cash: Number(parsed.cash) || fallback.cash,
        // Reset daily PNL to 0 if it's a new day
        dailyRealizedPnl: savedDate === todayIST ? (Number(parsed.dailyRealizedPnl) || 0) : 0,
        istDateString: todayIST,
      };
    }
  } catch (err) {
    console.warn("Failed to load capital from LocalStorage:", err);
  }
  return fallback;
}`;

content = content.replace(loadOld, loadNew);

// 3. Modify saveStoredCapital
const saveOld = `export function saveStoredCapital(capital: AgentCapitalState): void {
  try {
    localStorage.setItem(STORAGE_KEY_CAPITAL, JSON.stringify(capital));
  } catch (err) {
    console.warn("Failed to save capital to LocalStorage:", err);
  }
}`;

const saveNew = `export function saveStoredCapital(capital: AgentCapitalState): void {
  try {
    const toSave = { ...capital, istDateString: getCurrentISTDateString() };
    localStorage.setItem(STORAGE_KEY_CAPITAL, JSON.stringify(toSave));
  } catch (err) {
    console.warn("Failed to save capital to LocalStorage:", err);
  }
}`;

content = content.replace(saveOld, saveNew);

fs.writeFileSync('src/services/storagePersistenceService.ts', content);
console.log('patched storage');
