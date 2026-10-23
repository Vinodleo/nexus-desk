import dotenv from "dotenv";
import { startErrorReports } from "./errorReports";
import { startServerLog } from "./serverLog";

// Loaded first by server.ts, before any other module: the .env file (local
// runs), then the error reports, which must start before the rest is loaded,
// and the log kept for Settings (server/serverLog.ts).

dotenv.config();
startErrorReports();
startServerLog();
