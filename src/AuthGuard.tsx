import React from 'react';
import { useAuth } from './context/AuthContext';
import { LoginScreen } from './components/LoginScreen';

export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen bg-[#09090b] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 text-emerald-500 font-mono">
          <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-xs tracking-widest uppercase">Booting Nexus Kernel...</p>
        </div>
      </div>
    );
  }

  // Security Gate: Restrict to authorized admin
  // If there is no user, they MUST login
  if (!currentUser) {
    return <LoginScreen />;
  }
  
  // If there is a user, verify their email
  const isAuthorized = currentUser.email === "vinoduppar007@gmail.com";
  
  if (!isAuthorized) {
    return <LoginScreen />;
  }

  return <>{children}</>;
};
