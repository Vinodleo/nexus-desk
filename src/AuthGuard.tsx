import React, { useEffect, useState } from 'react';
import { useAuth } from './context/AuthContext';
import { LookOnlyContext } from './context/LookOnly';
import { LoginScreen } from './components/LoginScreen';
import { LoadingScreen } from './components/LoadingScreen';
import { apiFetch, setLookOnly } from './services/apiClient';
import { isOwner } from './shared/owner';

type Access = 'owner' | 'viewer' | 'not-ready' | 'unreachable' | 'denied';

/** How long to wait before asking the server again when it gave no answer. */
export const RETRY_MS = 5_000;

/**
 * What the server's answer to /api/me means for an account other than the
 * owner's. Only the server's refusal (403) or its saying the account isn't a
 * viewer turns it away: no answer (offline, the server restarting for an
 * update, a token that couldn't be fetched) is asked again.
 */
export function accessFrom(status: number, body: { role?: string; code?: string } | null): Access {
  if (body?.role === 'viewer') return 'viewer';
  if (body?.code === 'NO_DESK') return 'not-ready';
  if (status === 403 || (status >= 200 && status < 300)) return 'denied';
  return 'unreachable';
}

// The owner's account gets past this; so does an account the owner lets look
// (the server's VIEWER_EMAILS and Settings → Desk: Read access, asked at /api/me),
// in look-only mode. Anyone else sees the login screen. Each is asked about
// again when the app comes back on screen: one not let in may have been added
// since, and a viewer taken off the list is shut out (a viewer let in stays in
// through a blip: only the server's refusal shuts it out). The opening screen
// stays over the page until its ending has played: what comes next starts
// loading underneath as soon as sign-in is known.
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
    let asking = false;
    let now: Access | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const ask = () => {
      if (asking) return;
      asking = true;
      clearTimeout(retry);
      apiFetch('/api/me')
        .then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))
        .catch(() => ({ status: 0, body: null }))
        .then(({ status, body }) => {
          asking = false;
          if (cancelled) return;
          const next = accessFrom(status, body);
          if (now === 'viewer' && next !== 'denied') return;
          now = next;
          setLookOnly(next === 'viewer');
          setAccess(next);
          if (next === 'unreachable') retry = setTimeout(ask, RETRY_MS);
        });
    };
    const onShow = () => {
      if (document.visibilityState === 'visible') ask();
    };
    setAccess(null);
    ask();
    document.addEventListener('visibilitychange', onShow);
    return () => {
      cancelled = true;
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', onShow);
    };
  }, [loading, currentUser]);

  const checking = !loading && !!currentUser && access === null;
  const page =
    loading || checking ? null : access === 'owner' || access === 'viewer' ? (
      <LookOnlyContext.Provider value={access === 'viewer'}>{children}</LookOnlyContext.Provider>
    ) : (
      <LoginScreen notReady={access === 'not-ready'} unreachable={access === 'unreachable'} />
    );
  return (
    <>
      {page}
      {!opened && <LoadingScreen ready={!loading && !checking} onDone={() => setOpened(true)} />}
    </>
  );
};
