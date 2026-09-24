import React from 'react';
import { useAuth } from './context/AuthContext';
import { LoginScreen } from './components/LoginScreen';
import { LoadingScreen } from './components/LoadingScreen';
import { isOwner } from './shared/owner';

// Only the owner's account gets past this; anyone else sees the login screen.
export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser, loading } = useAuth();

  if (loading) return <LoadingScreen />;
  if (!currentUser || !isOwner(currentUser.email)) return <LoginScreen />;
  return <>{children}</>;
};
