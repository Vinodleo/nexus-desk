import React, { useState } from "react";
import { useAuth, UserRole } from "../context/AuthContext";
import {
  Shield,
  ShieldCheck,
  Lock,
  Mail,
  Key,
  User,
  LogOut,
  Sparkles,
  AlertCircle,
  CheckCircle2,
  X,
  ExternalLink,
} from "lucide-react";

export const AuthModal: React.FC = () => {
  const {
    currentUser,
    userProfile,
    userRole,
    authModalOpen,
    closeAuthModal,
    signInWithGoogle,
    signInWithEmail,
    signUpWithEmail,
    signInDemoOperator,
    switchUserRole,
    logout,
  } = useAuth();

  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!authModalOpen) return null;

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      if (mode === "signin") {
        await signInWithEmail(email, password);
      } else {
        await signUpWithEmail(email, password, displayName);
      }
    } catch (err: any) {
      const code = err?.code || "";
      if (code === "auth/invalid-credential" || code === "auth/wrong-password") {
        setErrorMsg("Invalid email or password.");
      } else if (code === "auth/email-already-in-use") {
        setErrorMsg("An account with this email already exists.");
      } else if (code === "auth/weak-password") {
        setErrorMsg("Password must be at least 6 characters.");
      } else {
        setErrorMsg(err?.message || "Authentication error occurred.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setErrorMsg(null);
    setIsSubmitting(true);
    try {
      await signInWithGoogle();
    } catch (err: any) {
      if (err?.code === "auth/popup-blocked") {
        setErrorMsg("Popup was blocked by browser. Please allow popups or use Email / Demo login.");
      } else if (err?.code === "auth/cancelled-popup-request" || err?.code === "auth/popup-closed-by-user") {
        setErrorMsg("Sign-in popup was closed.");
      } else {
        setErrorMsg(err?.message || "Google Sign-In failed.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-sm animate-in fade-in select-none">
      <div className="w-full max-w-md bg-[#0d0d12] border border-[#23232f] rounded-2xl p-6 shadow-2xl space-y-5 text-stone-200 relative">
        {/* Close Button */}
        <button
          onClick={closeAuthModal}
          className="absolute top-4 right-4 text-stone-400 hover:text-stone-200 transition-colors p-1 rounded-lg hover:bg-white/5 cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Header */}
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-[#171722] border border-[#2b2b3d] text-emerald-400">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-sans font-semibold text-white flex items-center gap-2">
              <span>Terminal Security & Auth</span>
            </h3>
            <p className="text-xs text-stone-400 font-sans">
              Firebase Authentication & Role-Based Access Control
            </p>
          </div>
        </div>

        {/* Current User Card if Signed In */}
        {currentUser && (
          <div className="rounded-xl bg-[#13131b] border border-[#242433] p-3.5 space-y-2.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-emerald-950/80 border border-emerald-700/60 flex items-center justify-center text-emerald-300 font-mono text-xs font-bold uppercase">
                  {currentUser.displayName?.[0] || currentUser.email?.[0] || "U"}
                </div>
                <div>
                  <div className="text-xs font-medium text-white flex items-center gap-1.5">
                    <span>{currentUser.displayName || "Operator"}</span>
                    <span className="px-1.5 py-0.5 rounded text-[9px] font-mono bg-emerald-950/70 border border-emerald-800/60 text-emerald-300 uppercase">
                      Active
                    </span>
                  </div>
                  <div className="text-[11px] font-mono text-stone-400 truncate max-w-[200px]">
                    {currentUser.email || "Anonymous Operator"}
                  </div>
                </div>
              </div>

              <button
                onClick={logout}
                className="px-2.5 py-1 rounded-lg bg-rose-950/40 hover:bg-rose-900/60 border border-rose-800/40 text-[11px] font-mono text-rose-300 flex items-center gap-1 cursor-pointer transition-all"
              >
                <LogOut className="w-3 h-3" />
                <span>Disconnect</span>
              </button>
            </div>

            {/* Security Clearance Switcher */}
            <div className="pt-2 border-t border-[#1d1d28]">
              <div className="text-[10px] uppercase font-mono text-stone-400 mb-1.5 flex items-center justify-between">
                <span>Security Clearance (RBAC)</span>
                <span className="text-stone-300 font-medium capitalize">{userRole}</span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono">
                {(["commander", "trader", "auditor"] as UserRole[]).map((r) => (
                  <button
                    key={r}
                    onClick={() => switchUserRole(r)}
                    className={`py-1 rounded-lg text-center transition-all capitalize cursor-pointer ${
                      userRole === r
                        ? "bg-emerald-950 text-emerald-300 border border-emerald-700 font-semibold"
                        : "bg-[#181822] text-stone-400 hover:text-stone-200 border border-[#252533]"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Error Alert */}
        {errorMsg && (
          <div className="p-2.5 rounded-xl bg-rose-950/40 border border-rose-800/60 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Sign In Options */}
        {!currentUser && (
          <div className="space-y-4">
            {/* Google OAuth Button */}
            <button
              onClick={handleGoogleSignIn}
              disabled={isSubmitting}
              className="w-full py-2.5 px-4 rounded-xl bg-white hover:bg-stone-100 text-stone-900 text-xs font-medium font-sans flex items-center justify-center gap-2 shadow transition-all cursor-pointer disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24">
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Continue with Google (Firebase)</span>
            </button>

            <div className="flex items-center gap-2 text-[10px] font-mono text-stone-400">
              <div className="flex-1 h-px bg-[#20202c]" />
              <span>OR EMAIL CREDENTIALS</span>
              <div className="flex-1 h-px bg-[#20202c]" />
            </div>

            {/* Email Form */}
            <form onSubmit={handleEmailSubmit} className="space-y-2.5">
              {mode === "signup" && (
                <div>
                  <label className="text-[10px] font-mono uppercase text-stone-400 block mb-1">
                    Operator Call-sign / Name
                  </label>
                  <div className="relative">
                    <User className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-3" />
                    <input
                      type="text"
                      required
                      placeholder="e.g. Commander Sarah"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      className="w-full bg-[#13131a] border border-[#242432] rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-stone-500 font-sans"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="text-[10px] font-mono uppercase text-stone-400 block mb-1">
                  Email
                </label>
                <div className="relative">
                  <Mail className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="email"
                    required
                    placeholder="trader@firm.com"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full bg-[#13131a] border border-[#242432] rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-stone-500 font-sans"
                  />
                </div>
              </div>

              <div>
                <label className="text-[10px] font-mono uppercase text-stone-400 block mb-1">
                  Password
                </label>
                <div className="relative">
                  <Key className="w-3.5 h-3.5 text-stone-400 absolute left-3 top-3" />
                  <input
                    type="password"
                    required
                    placeholder="••••••••"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full bg-[#13131a] border border-[#242432] rounded-xl pl-9 pr-3 py-2 text-xs text-white focus:outline-none focus:border-stone-500 font-sans"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium font-sans transition-all cursor-pointer disabled:opacity-50 mt-1"
              >
                {isSubmitting
                  ? "Authenticating..."
                  : mode === "signin"
                  ? "Sign In with Email"
                  : "Create Operator Account"}
              </button>

              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg(null);
                    setMode(mode === "signin" ? "signup" : "signin");
                  }}
                  className="text-[11px] text-stone-400 hover:text-stone-200 underline cursor-pointer"
                >
                  {mode === "signin"
                    ? "Need an account? Register new operator"
                    : "Already registered? Return to Sign In"}
                </button>
              </div>
            </form>

            <div className="flex items-center gap-2 text-[10px] font-mono text-stone-400 pt-1">
              <div className="flex-1 h-px bg-[#20202c]" />
              <span>OR 1-CLICK INSTANT DEMO</span>
              <div className="flex-1 h-px bg-[#20202c]" />
            </div>

            {/* Quick Demo Access */}
            <div className="grid grid-cols-3 gap-2 text-center">
              <button
                type="button"
                onClick={() => signInDemoOperator("commander")}
                className="p-2 rounded-xl bg-[#14141c] hover:bg-[#1a1a24] border border-[#272736] text-[11px] font-mono text-stone-300 hover:text-white transition-all cursor-pointer"
              >
                <div className="font-semibold text-emerald-400">Commander</div>
                <div className="text-[9px] text-stone-400">Full Overrides</div>
              </button>
              <button
                type="button"
                onClick={() => signInDemoOperator("trader")}
                className="p-2 rounded-xl bg-[#14141c] hover:bg-[#1a1a24] border border-[#272736] text-[11px] font-mono text-stone-300 hover:text-white transition-all cursor-pointer"
              >
                <div className="font-semibold text-blue-400">Desk Trader</div>
                <div className="text-[9px] text-stone-400">Standard Orders</div>
              </button>
              <button
                type="button"
                onClick={() => signInDemoOperator("auditor")}
                className="p-2 rounded-xl bg-[#14141c] hover:bg-[#1a1a24] border border-[#272736] text-[11px] font-mono text-stone-300 hover:text-white transition-all cursor-pointer"
              >
                <div className="font-semibold text-amber-400">Auditor</div>
                <div className="text-[9px] text-stone-400">Read-Only Logs</div>
              </button>
            </div>
          </div>
        )}

        {/* Security Credentials & Audit Badge Footer */}
        <div className="pt-3 border-t border-[#1d1d26] text-[10px] font-mono text-stone-400 flex items-center justify-between">
          <span className="flex items-center gap-1.5 text-stone-400">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Firebase Auth • SHA-256 JWT Tokenized</span>
          </span>
          <span className="text-stone-400">Project: sustained-glyph</span>
        </div>
      </div>
    </div>
  );
};
