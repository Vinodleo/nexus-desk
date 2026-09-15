import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { Shield, ShieldAlert, Fingerprint, Lock, Server } from 'lucide-react';

export const LoginScreen: React.FC = () => {
  const { signInWithGoogle, loading, currentUser } = useAuth();
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  const handleLogin = async () => {
    setIsAuthenticating(true);
    setAuthError(null);
    try {
      await signInWithGoogle();
      // Auth context will handle state change
    } catch (err: any) {
      setAuthError(err.message || "Failed to authenticate.");
      setIsAuthenticating(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-emerald-500 font-mono">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs tracking-widest uppercase">Initializing Secure Terminal...</p>
        </div>
      </div>
    );
  }

  const isUnauthorized = currentUser && currentUser.email !== "vinoduppar007@gmail.com";

  return (
    <div className="min-h-screen bg-[#09090b] flex items-center justify-center font-sans text-stone-200 p-4">
      <div className="absolute inset-0 z-0 opacity-20 pointer-events-none overflow-hidden flex items-center justify-center">
        <div className="w-[800px] h-[800px] border border-[#2a2a35] rounded-full absolute mix-blend-screen opacity-10" />
        <div className="w-[600px] h-[600px] border border-emerald-900/40 rounded-full absolute mix-blend-screen opacity-20" />
      </div>

      <div className="relative z-10 w-full max-w-md bg-[#0a0a0f] border border-[#262635] rounded-xl shadow-2xl overflow-hidden backdrop-blur-sm">
        <div className="p-8 flex flex-col items-center text-center">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-stone-800 to-stone-900 border border-[#3a3a45] shadow-inner flex items-center justify-center mb-6">
            <Fingerprint className="w-8 h-8 text-emerald-400" />
          </div>
          
          <h1 className="text-2xl font-bold tracking-tight text-white mb-2">Nexus Command</h1>
          <p className="text-sm text-stone-400 font-mono mb-8">
            Level 5 Administrative Clearance Required
          </p>

          {isUnauthorized ? (
            <div className="w-full bg-rose-500/10 border border-rose-500/30 rounded-lg p-4 mb-6 flex flex-col items-center">
              <ShieldAlert className="w-6 h-6 text-rose-500 mb-2" />
              <p className="text-xs text-rose-400 text-center font-mono uppercase tracking-wider">
                Access Denied
              </p>
              <p className="text-[10px] text-rose-400/80 text-center mt-1">
                Account {currentUser.email} is not authorized for Admin access.
              </p>
            </div>
          ) : (
            <div className="w-full space-y-4">
              <div className="flex items-center gap-3 text-xs text-stone-400 font-mono mb-6 bg-[#12121a] p-3 rounded-lg border border-[#262635]">
                <Lock className="w-4 h-4 text-emerald-500" />
                <span className="text-left leading-relaxed">
                  Authentication is secured via Google 2FA (TOTP/SMS). Proceed to verify identity.
                </span>
              </div>

              {authError && (
                <p className="text-xs text-rose-500 font-mono bg-rose-500/10 p-2 rounded">{authError}</p>
              )}

              <button
                onClick={handleLogin}
                disabled={isAuthenticating}
                className={`w-full py-3 rounded-lg font-mono text-sm tracking-wide flex items-center justify-center gap-2 transition-all ${
                  isAuthenticating 
                    ? "bg-[#1a1a24] text-stone-500 border border-[#2a2a35]"
                    : "bg-stone-100 hover:bg-white text-stone-900 border border-stone-200 cursor-pointer"
                }`}
              >
                {isAuthenticating ? (
                  <>
                    <div className="w-4 h-4 border-2 border-stone-500 border-t-transparent rounded-full animate-spin" />
                    Verifying...
                  </>
                ) : (
                  <>
                    <Shield className="w-4 h-4" />
                    Authenticate via Google (2FA)
                  </>
                )}
              </button>
            </div>
          )}

          <div className="mt-8 flex items-center justify-center gap-4 text-[9px] text-stone-500 font-mono uppercase tracking-wider">
            <span className="flex items-center gap-1"><Server className="w-3 h-3" /> Encrypted connection</span>
            <span>|</span>
            <span>Strict Zero-Trust Mode</span>
          </div>
        </div>
      </div>
    </div>
  );
};
