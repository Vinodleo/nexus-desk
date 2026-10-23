import React, { useEffect, useState } from 'react';
import { useAuth } from './context/AuthContext';
import { LookOnlyContext } from './context/LookOnly';
import { LoginScreen } from './components/LoginScreen';
import { LoadingScreen } from './components/LoadingScreen';
import { apiFetch, setLookOnly } from './services/apiClient';
import { isOwner } from './shared/owner';

type Access = 'owner' | 'viewer' | 'not-ready' | 'denied';

// The owner's account gets past this; so does an account the owner lets look
// (the server's VIEWER_EMAILS, asked at /api/me), in look-only mode. Anyone
// else sees the login screen. The opening screen stays over the page until
// its ending has played: what comes next starts loading underneath as soon as
// sign-in is known.
export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { currentUser, loading } = useAuth();
  const [opened, setOpened] = useState(false);
  const [access, setAccess] = useState<Access | null>(null);

  useEffect(() => {
    if (loading || !currentUser) {
      setAccess(null);
      setLookOnly(false);
      return;
    }
    if (isOwner(currentUser.email)) {
      setLookOnly(false);
      setAccess('owner');
      return;
    }
    let cancelled = false;
    setAccess(null);
    apiFetch('/api/me')
      .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
      .catch(() => ({ status: 0, body: null }))
      .then(({ body }) => {
        if (cancelled) return;
        const viewer = body?.role === 'viewer';
        setLookOnly(viewer);
        setAccess(viewer ? 'viewer' : body?.code === 'NO_DESK' ? 'not-ready' : 'denied');
      });
    return () => {
      cancelled = true;
    };
  }, [loading, currentUser]);

  const checking = !loading && !!currentUser && access === null;
  const page =
    loading || checking ? null : access === 'owner' || access === 'viewer' ? (
      <LookOnlyContext.Provider value={access === 'viewer'}>{children}</LookOnlyContext.Provider>
    ) : (
      <LoginScreen notReady={access === 'not-ready'} />
    );
  return (
    <>
      {page}
      {!opened && <LoadingScreen ready={!loading && !checking} onDone={() => setOpened(true)} />}
    </>
  );
};
