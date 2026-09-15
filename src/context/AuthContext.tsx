import React, { createContext, useContext, useEffect, useState } from "react";
import {
  User,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInAnonymously,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "firebase/auth";
import { doc, getDoc, setDoc, collection, addDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "../services/firebase";

export type UserRole = "commander" | "trader" | "auditor";

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
  role: UserRole;
  photoURL?: string | null;
  provider: "google" | "password" | "anonymous" | "demo";
  lastLoginAt: string;
}

export interface SecurityAuditEntry {
  id: string;
  action: string;
  details: string;
  userId: string;
  userEmail: string;
  timestamp: string;
}

interface AuthContextType {
  currentUser: User | null;
  userProfile: UserProfile | null;
  userRole: UserRole;
  loading: boolean;
  authModalOpen: boolean;
  openAuthModal: () => void;
  closeAuthModal: () => void;
  signInWithGoogle: () => Promise<void>;
  signInWithEmail: (email: string, pass: string) => Promise<void>;
  signUpWithEmail: (email: string, pass: string, name: string) => Promise<void>;
  signInDemoOperator: (role?: UserRole) => Promise<void>;
  switchUserRole: (role: UserRole) => Promise<void>;
  logout: () => Promise<void>;
  logSecurityAudit: (action: string, details: string) => Promise<void>;
  recentAudits: SecurityAuditEntry[];
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const ROLE_STORAGE_KEY = "nexus_trader_role_v1";

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [authModalOpen, setAuthModalOpen] = useState<boolean>(false);
  const [recentAudits, setRecentAudits] = useState<SecurityAuditEntry[]>(() => {
    try {
      const stored = localStorage.getItem("nexus_security_audits_v1");
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  });

  // Helper to persist audits locally and attempt Firestore sync
  const logSecurityAudit = async (action: string, details: string) => {
    const entry: SecurityAuditEntry = {
      id: `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      action,
      details,
      userId: currentUser?.uid || "unauthenticated",
      userEmail: currentUser?.email || (userProfile?.displayName || "Operator"),
      timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    };

    setRecentAudits((prev) => {
      const updated = [entry, ...prev.slice(0, 49)];
      try {
        localStorage.setItem("nexus_security_audits_v1", JSON.stringify(updated));
      } catch {
        // ignore
      }
      return updated;
    });

    // Write to Firestore if authenticated
    try {
      if (currentUser && db) {
        await addDoc(collection(db, "auditLogs"), {
          ...entry,
          createdAt: serverTimestamp(),
        });
      }
    } catch (err) {
      console.warn("Firestore audit log write:", err);
    }
  };

  // Sync profile from Firestore or local fallback
  const syncProfileForUser = async (user: User, preferredRole?: UserRole) => {
    let role: UserRole = preferredRole || "commander";
    const cachedRole = localStorage.getItem(ROLE_STORAGE_KEY) as UserRole | null;
    if (cachedRole && ["commander", "trader", "auditor"].includes(cachedRole)) {
      role = cachedRole;
    }

    try {
      if (db) {
        const userRef = doc(db, "users", user.uid);
        const snap = await getDoc(userRef);
        if (snap.exists()) {
          const data = snap.data();
          if (data.role) role = data.role as UserRole;
        } else {
          // Initialize document in Firestore
          await setDoc(userRef, {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || "Desk Operator",
            role,
            createdAt: new Date().toISOString(),
            lastLoginAt: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      console.warn("Firestore profile sync fallback:", err);
    }

    const provider = user.isAnonymous
      ? "anonymous"
      : user.providerData?.[0]?.providerId === "google.com"
      ? "google"
      : "password";

    const profile: UserProfile = {
      uid: user.uid,
      email: user.email,
      displayName: user.displayName || (user.isAnonymous ? "Anonymous Operator" : user.email?.split("@")[0] || "Operator"),
      role,
      photoURL: user.photoURL,
      provider,
      lastLoginAt: new Date().toLocaleTimeString(),
    };

    setUserProfile(profile);
    localStorage.setItem(ROLE_STORAGE_KEY, role);
    return profile;
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user);
      if (user) {
        await syncProfileForUser(user);
      } else {
        // Set default sandbox Commander operator if not signed in yet
        const defaultProfile: UserProfile = {
          uid: "demo-commander-nexus",
          email: "commander@nexus.terminal",
          displayName: "Nexus Commander",
          role: "commander",
          provider: "demo",
          lastLoginAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        };
        setUserProfile(defaultProfile);
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signInWithGoogle = async () => {
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const result = await signInWithPopup(auth, provider);
      await syncProfileForUser(result.user);
      await logSecurityAudit("GOOGLE_SIGN_IN", `Authenticated operator via Google: ${result.user.email}`);
      setAuthModalOpen(false);
    } catch (err: any) {
      console.error("Google Auth failed:", err);
      // If iframe popup blocked or failed, prompt or throw error
      throw err;
    }
  };

  const signInWithEmail = async (email: string, pass: string) => {
    const result = await signInWithEmailAndPassword(auth, email, pass);
    await syncProfileForUser(result.user);
    await logSecurityAudit("EMAIL_SIGN_IN", `Authenticated operator via Email: ${email}`);
    setAuthModalOpen(false);
  };

  const signUpWithEmail = async (email: string, pass: string, name: string) => {
    const result = await createUserWithEmailAndPassword(auth, email, pass);
    if (name && result.user) {
      await updateProfile(result.user, { displayName: name });
    }
    await syncProfileForUser(result.user);
    await logSecurityAudit("EMAIL_REGISTRATION", `Created new trader account: ${email}`);
    setAuthModalOpen(false);
  };

  const signInDemoOperator = async (role: UserRole = "commander") => {
    try {
      const res = await signInAnonymously(auth);
      await syncProfileForUser(res.user, role);
      await logSecurityAudit("DEMO_SIGN_IN", `Authenticated anonymous session with role: ${role.toUpperCase()}`);
    } catch (err) {
      // Fallback in case anonymous auth is not enabled in Firebase console
      const simulated: UserProfile = {
        uid: `demo-${role}-${Date.now().toString(36)}`,
        email: `${role}@nexus.desk`,
        displayName: `${role.charAt(0).toUpperCase() + role.slice(1)} Operator`,
        role,
        provider: "demo",
        lastLoginAt: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      };
      setUserProfile(simulated);
      localStorage.setItem(ROLE_STORAGE_KEY, role);
      await logSecurityAudit("DEMO_SIGN_IN", `Initialized secure session role: ${role.toUpperCase()}`);
    }
    setAuthModalOpen(false);
  };

  const switchUserRole = async (newRole: UserRole) => {
    if (userProfile) {
      const updated = { ...userProfile, role: newRole };
      setUserProfile(updated);
      localStorage.setItem(ROLE_STORAGE_KEY, newRole);

      if (currentUser && db) {
        try {
          await setDoc(doc(db, "users", currentUser.uid), { role: newRole }, { merge: true });
        } catch {
          // ignore
        }
      }

      await logSecurityAudit("ROLE_SWITCH", `Switched security clearance to: ${newRole.toUpperCase()}`);
    }
  };

  const logout = async () => {
    const priorEmail = currentUser?.email || userProfile?.displayName || "Operator";
    try {
      await signOut(auth);
    } catch {
      // ignore
    }
    setCurrentUser(null);
    const guestProfile: UserProfile = {
      uid: "guest-auditor",
      email: null,
      displayName: "Guest Observer",
      role: "auditor",
      provider: "demo",
      lastLoginAt: new Date().toLocaleTimeString(),
    };
    setUserProfile(guestProfile);
    localStorage.setItem(ROLE_STORAGE_KEY, "auditor");
    await logSecurityAudit("SIGN_OUT", `Operator signed out: ${priorEmail}`);
  };

  return (
    <AuthContext.Provider
      value={{
        currentUser,
        userProfile,
        userRole: userProfile?.role || "commander",
        loading,
        authModalOpen,
        openAuthModal: () => setAuthModalOpen(true),
        closeAuthModal: () => setAuthModalOpen(false),
        signInWithGoogle,
        signInWithEmail,
        signUpWithEmail,
        signInDemoOperator,
        switchUserRole,
        logout,
        logSecurityAudit,
        recentAudits,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
};
