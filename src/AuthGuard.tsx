import React, { useState } from 'react';
import { useAuth } from './context/AuthContext';
import { LoginScreen } from './components/LoginScreen';
import { LoadingScreen } from './components/LoadingScreen';
import { isOwner } from './shared/owner';

// Only the owner's account gets past this; anyone else sees the login screen.
// The opening screen stays over the page until its ending has played: what
// comes next starts loading underneath as soon as sign-in is known.
export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser, loading } = useAuth();
  const [opened, setOpened] = useState(false);

  const page = loading ? null : !currentUser || !isOwner(currentUser.email) ? <LoginScreen /> : <>{children}</>;
  return (
    <>
      {page}
      {!opened && <LoadingScreen ready={!loading} onDone={() => setOpened(true)} />}
    </>
  );
};
