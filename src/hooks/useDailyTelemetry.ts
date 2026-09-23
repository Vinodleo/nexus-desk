import { useEffect, useState } from "react";
import {
  getCurrentISTDateString,
  getInitialDailyTelemetry,
  loadDailySampleTelemetry,
  saveDailySampleTelemetry,
  type DailySampleTelemetry,
} from "../services/storagePersistenceService";

// What the agents analysed, selected and rejected today. Scoped to the IST
// day: at midnight IST the counters reset and onRollover fires (App uses it
// to reset daily realized P&L).
export function useDailyTelemetry(onRollover: () => void) {
  const [sampleTelemetry, setSampleTelemetry] = useState<DailySampleTelemetry>(() => loadDailySampleTelemetry());

  useEffect(() => {
    saveDailySampleTelemetry(sampleTelemetry);
  }, [sampleTelemetry]);

  useEffect(() => {
    const checkRollover = () => {
      const today = getCurrentISTDateString();
      setSampleTelemetry((prev) => {
        if (prev.istDateString === today) return prev;
        const reset = getInitialDailyTelemetry(today);
        saveDailySampleTelemetry(reset);
        onRollover();
        return reset;
      });
    };
    checkRollover();
    const interval = setInterval(checkRollover, 10000);
    return () => clearInterval(interval);
  }, [onRollover]);

  return [sampleTelemetry, setSampleTelemetry] as const;
}
