import dotenv from "dotenv";
import { startErrorReports } from "./errorReports";

// Loaded first by server.ts, before any other module: the .env file (local
// runs), then the error reports, which must start before the rest is loaded.

dotenv.config();
startErrorReports();
