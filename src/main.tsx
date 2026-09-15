import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { AuthProvider } from "./context/AuthContext";
import "./index.css";
import { ErrorBoundary } from "./ErrorBoundary";
import { AuthGuard } from "./AuthGuard";


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthProvider>
        <AuthGuard><App /></AuthGuard>
      </AuthProvider>
    </ErrorBoundary>
  </StrictMode>
);
