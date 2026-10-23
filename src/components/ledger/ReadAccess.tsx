import React, { useState } from "react";
import { Plus, X } from "lucide-react";
import type { useViewers } from "../../hooks/useViewers";

// Settings → Desk: Read access (owner's ask, 23 Oct): the Google accounts that may
// look at the desk and change nothing, each with whether it has signed in.
// Add one by its email; remove one (asked once) and it's shut out at once.

export const ReadAccess: React.FC<{ list: ReturnType<typeof useViewers> }> = ({ list }) => {
  const [email, setEmail] = useState("");
  // The one whose remove was tapped, waiting for "Remove" or "Keep".
  const [removing, setRemoving] = useState<string | null>(null);
  const viewers = list.viewers ?? [];

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || list.busy) return;
    if (await list.add(email)) setEmail("");
  };

  return (
    <div className="flex flex-col">
      {list.viewers === undefined ? (
        <p className="m-0 py-3.5 text-sm text-muted">Checking…</p>
      ) : viewers.length === 0 ? (
        <p className="m-0 py-3.5 text-sm text-muted" data-testid="viewers-empty">
          No one else can look at your desk.
        </p>
      ) : (
        <ul className="m-0 p-0 list-none [&>*+*]:border-t [&>*+*]:border-line" aria-label="People with read access">
          {viewers.map((v) => (
            <li key={v.email} className="flex items-center gap-3 min-h-16 py-2.5" data-testid={`viewer-${v.email}`}>
              <span aria-hidden="true" className="w-10 h-10 shrink-0 rounded-full bg-accent-soft text-accent text-sm font-bold flex items-center justify-center uppercase">
                {v.email[0]}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-semibold truncate">{v.email}</span>
                <span className="block text-xs text-muted">{v.signedIn ? "Has signed in" : "Hasn't signed in yet"}</span>
              </span>
              {removing === v.email ? (
                <span className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={() => setRemoving(null)}
                    className="min-h-9 px-3 rounded-full border border-line text-[13px] font-semibold cursor-pointer"
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    disabled={list.busy}
                    onClick={async () => {
                      if (await list.remove(v.email)) setRemoving(null);
                    }}
                    className="min-h-9 px-3 rounded-full bg-loss text-on-accent text-[13px] font-semibold cursor-pointer disabled:opacity-60"
                  >
                    Remove
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Remove ${v.email}`}
                  onClick={() => setRemoving(v.email)}
                  className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-muted hover:bg-inset cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="flex items-center gap-2 py-3 border-t border-line">
        <input
          type="email"
          inputMode="email"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Their Google email"
          aria-label="Email to let look"
          className="flex-1 min-w-0 min-h-10 px-3.5 rounded-full border border-line bg-canvas text-sm text-ink placeholder:text-muted"
        />
        <button
          type="submit"
          disabled={list.busy || !email.trim()}
          className="min-h-10 px-4 shrink-0 rounded-full bg-accent text-on-accent text-[13px] font-bold cursor-pointer inline-flex items-center gap-1 disabled:opacity-60"
        >
          <Plus className="w-3.5 h-3.5" strokeWidth={2.6} />
          Add
        </button>
      </form>
      {list.note && (
        <p className="m-0 pb-2 text-xs text-loss" role="alert">
          {list.note}
        </p>
      )}
      <p className="m-0 pb-3.5 text-xs text-muted leading-relaxed">
        They sign in with Google using that email and see your desk without changing anything. The IPO alerts can go to them
        too. Removing someone shuts them out at once.
      </p>
    </div>
  );
};
