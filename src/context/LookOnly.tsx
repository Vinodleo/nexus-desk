import { createContext, useContext } from "react";

// A look-only account (server/auth.ts, VIEWER_EMAILS): it sees the owner's
// desk and changes nothing. The sign-in guard says which; screens hide what
// would change something.

export const LookOnlyContext = createContext(false);

export const useLookOnly = () => useContext(LookOnlyContext);
