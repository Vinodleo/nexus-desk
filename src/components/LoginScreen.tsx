import React, { useState } from "react";
import { ShieldAlert, Loader2 } from "lucide-react";
import { useAuth } from "../context/AuthContext";
import { isOwner } from "../shared/owner";
import { LoadingScreen } from "./LoadingScreen";

const GoogleMark = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
    <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
    <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
    <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
  </svg>
);

export const LoginScreen: React.FC = () => {
  const { signInWithGoogle, logout, loading, currentUser } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);

  const signIn = async () => {
    setSigningIn(true);
    setError(null);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      const code = err?.code || "";
      setError(
        code === "auth/popup-blocked"
          ? "The sign-in window was blocked. Allow pop-ups for this site and try again."
          : code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request"
          ? "Sign-in was cancelled."
          : err?.message || "Couldn't sign in. Try again."
      );
      setSigningIn(false);
    }
  };

  if (loading) return <LoadingScreen />;

  const wrongAccount = currentUser && !isOwner(currentUser.email);

  return (
    <div className="min-h-screen bg-canvas text-ink font-ui flex items-center justify-center p-5">
      <main className="w-full max-w-sm flex flex-col gap-6">
        <div>
          <h1 className="m-0 font-display text-[40px] leading-tight font-semibold">Nexus Desk</h1>
          <p className="m-0 mt-1.5 text-[15px] text-muted">Your private trading desk. Sign in to continue.</p>
        </div>

        {wrongAccount ? (
          <section className="bg-surface border border-line rounded-2xl p-4 flex flex-col gap-3">
            <div className="flex gap-2.5 text-sm">
              <ShieldAlert className="w-5 h-5 shrink-0 text-loss" strokeWidth={1.8} />
              <span>
                <strong>{currentUser.email}</strong> doesn't have access to this desk.
              </span>
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="min-h-12 rounded-full border border-line bg-surface font-semibold cursor-pointer"
            >
              Use a different account
            </button>
          </section>
        ) : (
          <section className="flex flex-col gap-3">
            <button
              type="button"
              onClick={signIn}
              disabled={signingIn}
              className="min-h-[52px] rounded-full bg-surface border border-line font-semibold text-[15px] flex items-center justify-center gap-2.5 cursor-pointer hover:bg-inset disabled:opacity-70"
            >
              {signingIn ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <GoogleMark />}
              {signingIn ? "Signing in…" : "Continue with Google"}
            </button>
            {error && <p className="m-0 text-[13px] text-loss">{error}</p>}
            <p className="m-0 text-xs text-muted leading-relaxed">
              Sign-in uses your Google account, including its two-step verification. Only the owner's account can open
              the desk.
            </p>
          </section>
        )}
      </main>
    </div>
  );
};
