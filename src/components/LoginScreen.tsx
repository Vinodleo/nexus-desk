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

/** Where the faint dots sit (percent of the screen), their size, tone and strength. */
const LOGIN_DOTS = [
  { x: 11, y: 11, size: 8, tone: "bg-accent", opacity: 0.25 },
  { x: 85, y: 8, size: 6, tone: "bg-gain", opacity: 0.3 },
  { x: 77, y: 19, size: 10, tone: "bg-accent", opacity: 0.18 },
  { x: 18, y: 25, size: 6, tone: "bg-loss", opacity: 0.25 },
  { x: 90, y: 36, size: 8, tone: "bg-accent", opacity: 0.22 },
  { x: 9, y: 43, size: 10, tone: "bg-gain", opacity: 0.2 },
  { x: 88, y: 60, size: 6, tone: "bg-accent", opacity: 0.25 },
  { x: 14, y: 66, size: 8, tone: "bg-accent", opacity: 0.15 },
];

// Sign-in: the opening screen's N tile, floating, with the Google button at
// the bottom where a thumb reaches it. `notReady`: a look-only account whose
// owner hasn't opened the desk since the server learned to show it.
export const LoginScreen: React.FC<{ notReady?: boolean }> = ({ notReady = false }) => {
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
    <div className="relative min-h-screen bg-canvas text-ink font-ui flex flex-col items-center px-4 pb-8 overflow-hidden">
      {/* A few of the opening screen's dots, still scattered. */}
      <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
        {LOGIN_DOTS.map((d, i) => (
          <span
            key={i}
            className={`absolute rounded-full ${d.tone}`}
            style={{ left: `${d.x}%`, top: `${d.y}%`, width: d.size, height: d.size, opacity: d.opacity }}
          />
        ))}
      </div>

      <main className="relative flex-1 w-full max-w-sm flex flex-col items-center justify-center gap-5 py-10">
        <div
          data-testid="login-tile"
          className="nx-float relative w-[132px] h-[132px] rounded-[40px] bg-accent overflow-hidden flex items-center justify-center shadow-[0_18px_40px_color-mix(in_srgb,var(--nx-accent)_32%,transparent)]"
        >
          <span className="nx-shine absolute -top-10 -bottom-10 w-12" aria-hidden="true" />
          <span aria-hidden="true" className="font-display text-[84px] leading-none font-semibold text-on-accent">
            N
          </span>
        </div>
        <div className="text-center">
          <h1 className="m-0 font-display text-[34px] leading-tight font-semibold">Nexus Desk</h1>
          <p className="m-0 mt-1.5 text-[15px] text-muted">Your private trading desk</p>
        </div>
      </main>

      <section className="relative w-full max-w-sm flex flex-col gap-3">
        {wrongAccount ? (
          <div className="bg-surface border border-line rounded-2xl p-4 flex flex-col gap-3">
            <div className="flex gap-2.5 text-sm">
              <ShieldAlert className="w-5 h-5 shrink-0 text-loss" strokeWidth={1.8} />
              {notReady ? (
                <span>
                  <strong>{currentUser.email}</strong> can look at this desk once its owner has opened it again. Try again later.
                </span>
              ) : (
                <span>
                  <strong>{currentUser.email}</strong> doesn't have access to this desk.
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void logout()}
              className="min-h-12 rounded-full border border-line bg-surface font-semibold cursor-pointer"
            >
              Use a different account
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={signIn}
              disabled={signingIn}
              className="min-h-[54px] rounded-full bg-surface border border-line font-semibold text-[15px] flex items-center justify-center gap-2.5 cursor-pointer shadow-[0_4px_14px_-6px_color-mix(in_srgb,var(--nx-scrim)_30%,transparent)] hover:bg-inset disabled:opacity-70"
            >
              {signingIn ? <Loader2 className="w-[18px] h-[18px] animate-spin" /> : <GoogleMark />}
              {signingIn ? "Signing in…" : "Continue with Google"}
            </button>
            {error && <p className="m-0 text-[13px] text-loss text-center">{error}</p>}
            <p className="m-0 text-xs text-muted leading-relaxed text-center">
              Only the owner's account, and accounts the owner lets look, open the desk. Google's two-step check guards it.
            </p>
          </>
        )}
      </section>
    </div>
  );
};
