import fs from "fs";
import path from "path";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  writeBatch,
  type Firestore,
} from "firebase/firestore";

// Every write here is shaped like one the app really makes (AuthContext,
// syncToFirebase, logSecurityAudit), plus the attacks the rules must block.

let env: RulesTestEnvironment;
// rules-unit-testing hands back the compat Firestore type; the modular
// functions accept it at runtime.
const db = (ctx: RulesTestContext) => ctx.firestore() as unknown as Firestore;
let alice: Firestore;
let bob: Firestore;

const now = () => new Date().toISOString();
const profile = (uid: string, email: string | null) => ({
  uid,
  email,
  displayName: "Desk Operator",
  role: "commander",
  createdAt: now(),
  lastLoginAt: now(),
});
const syncPayload = () => ({
  selfApprovedCount: 18,
  selfApprovedWins: 12,
  selfApprovedLosses: 6,
  lastUpdated: now(),
  equity: 101234.5,
  cash: 99000,
  dailyRealizedPnl: -12.5,
  allTimeRealizedPnl: 1234.5,
  istDateString: "2026-09-23",
  accuracyPct: 61.2,
  promotedLabModel: null,
  dailyTelemetry: { selectedCount: 3 },
});

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-nexus-rules",
    firestore: {
      rules: fs.readFileSync(path.resolve(process.cwd(), "firestore.rules"), "utf8"),
      host: "127.0.0.1",
      port: 8080,
    },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

beforeEach(async () => {
  await env.clearFirestore();
  alice = db(env.authenticatedContext("alice", { email: "alice@x.com", email_verified: true }));
  bob = db(env.authenticatedContext("bob", { email: "bob@x.com" }));
});

async function seedAlice() {
  await assertSucceeds(setDoc(doc(alice, "users/alice"), profile("alice", "alice@x.com")));
}

describe("users/{uid} create", () => {
  it("allows the owner, including anonymous users with no email", async () => {
    await seedAlice();
    const anon = db(env.authenticatedContext("anon1", {}));
    await assertSucceeds(setDoc(doc(anon, "users/anon1"), profile("anon1", null)));
  });

  it("blocks another uid, a borrowed email, and unknown keys", async () => {
    await assertFails(setDoc(doc(bob, "users/alice"), profile("alice", "bob@x.com")));
    await assertFails(setDoc(doc(bob, "users/bob"), profile("bob", "alice@x.com")));
    await assertFails(setDoc(doc(bob, "users/bob"), { ...profile("bob", "bob@x.com"), isAdmin: true }));
  });
});

describe("users/{uid} read", () => {
  it("is owner-only", async () => {
    await seedAlice();
    await assertSucceeds(getDoc(doc(alice, "users/alice")));
    await assertFails(getDoc(doc(bob, "users/alice")));
    await assertFails(getDocs(collection(bob, "users")));
    await assertFails(getDoc(doc(db(env.unauthenticatedContext()), "users/alice")));
  });
});

describe("users/{uid} update", () => {
  beforeEach(seedAlice);

  it("allows cloud sync and role switches", async () => {
    await assertSucceeds(setDoc(doc(alice, "users/alice"), syncPayload(), { merge: true }));
    await assertSucceeds(setDoc(doc(alice, "users/alice"), { role: "auditor" }, { merge: true }));
  });

  it("keeps uid, email and createdAt fixed", async () => {
    await assertFails(setDoc(doc(alice, "users/alice"), { email: "evil@x.com", equity: 5 }, { merge: true }));
    await assertFails(setDoc(doc(alice, "users/alice"), { uid: "bob", equity: 6 }, { merge: true }));
    await assertFails(setDoc(doc(alice, "users/alice"), { createdAt: now() }, { merge: true }));
  });

  it("rejects unknown keys, wrong types, bad roles, other users and deletes", async () => {
    await assertFails(setDoc(doc(alice, "users/alice"), { isAdmin: true }, { merge: true }));
    await assertFails(setDoc(doc(alice, "users/alice"), { equity: "lots" }, { merge: true }));
    await assertFails(setDoc(doc(alice, "users/alice"), { role: "superadmin" }, { merge: true }));
    await assertFails(setDoc(doc(bob, "users/alice"), { equity: 0 }, { merge: true }));
    await assertFails(deleteDoc(doc(alice, "users/alice")));
  });

  it("still allows updates on a legacy profile holding an extra field", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(db(ctx), "users/legacy"), { uid: "legacy", email: "l@x.com", createdAt: now(), oldField: 1 });
    });
    const legacy = db(env.authenticatedContext("legacy", { email: "l@x.com" }));
    await assertSucceeds(setDoc(doc(legacy, "users/legacy"), syncPayload(), { merge: true }));
  });
});

describe.each(["experiences", "closedTrades"])("users/{uid}/%s", (col) => {
  const push = () => {
    const b = writeBatch(alice);
    b.set(doc(alice, `users/alice/${col}/x1`), { id: "x1", userId: "alice", pnl: 5 });
    b.set(doc(alice, `users/alice/${col}/x2`), { id: "x2", userId: "alice" });
    return b.commit();
  };

  it("allows repeated sync batches (re-saving existing ids)", async () => {
    await assertSucceeds(push());
    await assertSucceeds(push());
  });

  it("blocks a foreign userId and cross-user reads", async () => {
    await assertFails(setDoc(doc(alice, `users/alice/${col}/x3`), { userId: "bob" }));
    await assertFails(getDocs(collection(bob, `users/alice/${col}`)));
  });
});

describe("users/{uid}/activePositions", () => {
  const pos = {
    id: "pos-1", userId: "alice", symbol: "BTC/INR", direction: "LONG", entryPrice: 1000, currentPrice: 1001,
    stopLoss: 990, takeProfit: 1100, quantity: 1, moneyPlaced: 1000, trailActive: false, trailMode: "DYNAMIC_RATIO",
    highestPrice: 1001, lowestPrice: 1000, openTime: now(), setupName: "x",
  };
  const ref = (id: string) => doc(alice, `users/alice/activePositions/${id}`);

  it("allows upserts and deletes shaped like syncToFirebase", async () => {
    await assertSucceeds(setDoc(ref("pos-1"), pos));
    await assertSucceeds(setDoc(ref("pos-1"), { ...pos, currentPrice: 1005 }));
    await assertSucceeds(deleteDoc(ref("pos-1")));
  });

  it("rejects bad direction, mismatched id and extra keys", async () => {
    await assertFails(setDoc(ref("pos-2"), { ...pos, id: "pos-2", direction: "UP" }));
    await assertFails(setDoc(ref("pos-3"), pos));
    await assertFails(setDoc(ref("pos-1"), { ...pos, isLiveOrder: true }));
  });
});

describe("users/{uid}/credentials", () => {
  it("never accepts keys from clients but lets the owner read and delete the legacy copy", async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(db(ctx), "users/alice/credentials/exchangeKeys"), { coindcx: { apiKey: "k", apiSecret: "s" } });
    });
    const keys = (db: Firestore) => doc(db, "users/alice/credentials/exchangeKeys");
    await assertFails(getDoc(keys(bob)));
    await assertSucceeds(getDoc(keys(alice)));
    await assertFails(setDoc(keys(alice), { a: 1 }));
    await assertSucceeds(deleteDoc(keys(alice)));
  });
});

describe("auditLogs", () => {
  const audit = (uid: string) => ({
    id: "audit-1", action: "ROLE_SWITCH", details: "x", userId: uid,
    userEmail: "alice@x.com", timestamp: "10:00:00", createdAt: serverTimestamp(),
  });

  it("accepts the app's own audit entries", async () => {
    await assertSucceeds(addDoc(collection(alice, "auditLogs"), audit("alice")));
  });

  it("rejects entries for another user, client timestamps and extra keys", async () => {
    await assertFails(addDoc(collection(alice, "auditLogs"), audit("bob")));
    await assertFails(addDoc(collection(alice, "auditLogs"), { ...audit("alice"), createdAt: now() }));
    await assertFails(addDoc(collection(alice, "auditLogs"), { ...audit("alice"), role: "x" }));
  });
});
