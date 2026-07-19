import { describe, it, expect } from "vitest";
import { computeScheduledSpends, applyScheduledDistribution, groupSpendsByToken } from "../ledger/schedule.js";
import type { Ledger, UserAccount } from "../types.js";

// UserSpend factory — tokenOut defaults to cirBTC (the historical single-token case).
const sp = (address: string, spend: number, tokenOut = "cirBTC") => ({ address, spend, tokenOut });

function mkUser(addr: string, over: Partial<UserAccount> = {}): UserAccount {
  return {
    address: addr,
    usdcBalance: "100.000000",
    cirBtcBalance: "0",
    totalDeposited: "100.000000",
    totalSwapped: "0",
    totalWithdrawnCirBtc: "0",
    totalWithdrawnUsdc: "0",
    firstSeen: "2026-01-01T00:00:00.000Z",
    lastActivity: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}
function mkLedger(users: UserAccount[]): Ledger {
  return {
    version: 1,
    lastScannedBlock: 0,
    users: Object.fromEntries(users.map((u) => [u.address, u])),
    deposits: [],
    distributions: [],
    withdrawals: [],
  } as unknown as Ledger;
}

const NOW = "2026-06-15T10:00:00.000Z"; // a Monday, 10:00 UTC (not a legacy slot hour)

describe("computeScheduledSpends — rich schedule", () => {
  it("manual users are never scheduled", () => {
    const l = mkLedger([mkUser("0xa", { dcaMode: "manual", dcaFrequency: "hours", dcaEveryHours: 1, dcaAmountPerRun: "1.000000", lastChargedAt: "2026-01-01T00:00:00.000Z" })]);
    expect(computeScheduledSpends(l, NOW).spends).toHaveLength(0);
  });

  it("paused users are never scheduled", () => {
    const l = mkLedger([mkUser("0xa", { dcaPaused: true, dcaFrequency: "hours", dcaEveryHours: 1, dcaAmountPerRun: "1.000000" })]);
    expect(computeScheduledSpends(l, NOW).spends).toHaveLength(0);
  });

  it("every-N-hours: due when elapsed ≥ interval, spends amountPerRun", () => {
    const l = mkLedger([mkUser("0xa", { dcaFrequency: "hours", dcaEveryHours: 6, dcaAmountPerRun: "2.500000", lastChargedAt: "2026-06-15T03:00:00.000Z" })]);
    const r = computeScheduledSpends(l, NOW); // 7h elapsed ≥ 6
    expect(r.spends).toEqual([{ address: "0xa", spend: 2.5, tokenOut: "cirBTC" }]);
  });

  it("every-N-hours: NOT due when elapsed < interval", () => {
    const l = mkLedger([mkUser("0xa", { dcaFrequency: "hours", dcaEveryHours: 6, dcaAmountPerRun: "2.5", lastChargedAt: "2026-06-15T07:00:00.000Z" })]);
    expect(computeScheduledSpends(l, NOW).spends).toHaveLength(0); // only 3h elapsed
  });

  it("weekly: runs only on chosen UTC weekday, once/day", () => {
    // NOW is Monday (getUTCDay()===1).
    const due = mkLedger([mkUser("0xa", { dcaFrequency: "weekly", dcaWeekdays: [1], dcaAmountPerRun: "5", lastChargedAt: "2026-06-08T10:00:00.000Z" })]);
    expect(computeScheduledSpends(due, NOW).spends).toHaveLength(1);
    const notToday = mkLedger([mkUser("0xb", { dcaFrequency: "weekly", dcaWeekdays: [3], dcaAmountPerRun: "5", lastChargedAt: "2026-06-08T10:00:00.000Z" })]);
    expect(computeScheduledSpends(notToday, NOW).spends).toHaveLength(0);
    const alreadyToday = mkLedger([mkUser("0xc", { dcaFrequency: "weekly", dcaWeekdays: [1], dcaAmountPerRun: "5", lastChargedAt: "2026-06-15T02:00:00.000Z" })]);
    expect(computeScheduledSpends(alreadyToday, NOW).spends).toHaveLength(0);
  });

  it("daily cap clamps the per-run amount", () => {
    const l = mkLedger([mkUser("0xa", {
      dcaFrequency: "hours", dcaEveryHours: 1, dcaAmountPerRun: "10", dcaDailyCapUsdc: "12",
      dcaSpentDayUsdc: "8", dcaSpentDayDate: "2026-06-15", lastChargedAt: "2026-06-15T08:00:00.000Z",
    })]);
    // remaining cap = 12 - 8 = 4 → spend clamped to 4
    expect(computeScheduledSpends(l, NOW).spends).toEqual([{ address: "0xa", spend: 4, tokenOut: "cirBTC" }]);
  });

  it("daily cap already reached → skipped", () => {
    const l = mkLedger([mkUser("0xa", {
      dcaFrequency: "hours", dcaEveryHours: 1, dcaAmountPerRun: "10", dcaDailyCapUsdc: "12",
      dcaSpentDayUsdc: "12", dcaSpentDayDate: "2026-06-15", lastChargedAt: "2026-06-15T08:00:00.000Z",
    })]);
    expect(computeScheduledSpends(l, NOW).spends).toHaveLength(0);
  });

  it("smart mode: gated on dip threshold", () => {
    const u = { dcaFrequency: "hours" as const, dcaEveryHours: 1, dcaAmountPerRun: "3", dcaMode: "smart" as const, dcaSmartMinDipPct: 5, lastChargedAt: "2026-06-15T08:00:00.000Z" };
    const l = mkLedger([mkUser("0xa", u)]);
    expect(computeScheduledSpends(l, NOW, { drawdownPct: 0.03 }).spends).toHaveLength(0); // 3% < 5%
    expect(computeScheduledSpends(l, NOW, { drawdownPct: 0.07 }).spends).toHaveLength(1); // 7% ≥ 5%
  });

  it("smart mode: gated on Fear & Greed below threshold", () => {
    const u = { dcaFrequency: "hours" as const, dcaEveryHours: 1, dcaAmountPerRun: "3", dcaMode: "smart" as const, dcaSmartFearBelow: 30, lastChargedAt: "2026-06-15T08:00:00.000Z" };
    const l = mkLedger([mkUser("0xa", u)]);
    expect(computeScheduledSpends(l, NOW, { fearGreedIndex: 45 }).spends).toHaveLength(0);
    expect(computeScheduledSpends(l, NOW, { fearGreedIndex: 20 }).spends).toHaveLength(1);
    expect(computeScheduledSpends(l, NOW, { fearGreedIndex: null }).spends).toHaveLength(0);
  });
});

describe("computeScheduledSpends — legacy model still works", () => {
  it("legacy rate/day only fires at 07/13/19 UTC slot hours", () => {
    const u = mkUser("0xa", { dcaRatePerDay: "3.000000", lastChargedAt: "2026-06-14T13:00:00.000Z" });
    const l = mkLedger([u]);
    // 10:00 is not a slot hour → nothing
    expect(computeScheduledSpends(l, "2026-06-15T10:00:00.000Z").spends).toHaveLength(0);
    // 13:00 is a slot hour → fires
    expect(computeScheduledSpends(l, "2026-06-15T13:00:00.000Z").spends).toHaveLength(1);
  });
});

describe("applyScheduledDistribution — pooled swap, pro-rata settlement", () => {
  it("splits the received cirBTC pro-rata by each user's contribution", () => {
    const l = mkLedger([mkUser("0xa"), mkUser("0xb")]);
    const rec = applyScheduledDistribution(
      l,
      [sp("0xa", 1), sp("0xb", 3)], // 25% / 75%
      "4.000000", "0.00000400", NOW,
    );
    expect(rec).not.toBeNull();
    const byAddr = Object.fromEntries(rec!.allocations.map((a) => [a.address, a]));
    expect(parseFloat(byAddr["0xa"]!.poolFraction)).toBeCloseTo(0.25, 8);
    expect(parseFloat(byAddr["0xb"]!.poolFraction)).toBeCloseTo(0.75, 8);
    expect(parseFloat(byAddr["0xa"]!.cirBtcShare)).toBeCloseTo(0.000001, 8);
    expect(parseFloat(byAddr["0xb"]!.cirBtcShare)).toBeCloseTo(0.000003, 8);
  });

  it("books close: shares sum to exactly what was executed and received", () => {
    // 1/3 splits force rounding — the remainder must not vanish or duplicate.
    const l = mkLedger([mkUser("0xa"), mkUser("0xb"), mkUser("0xc")]);
    const rec = applyScheduledDistribution(
      l,
      [sp("0xa", 1), sp("0xb", 1), sp("0xc", 1)],
      "1.000000", "0.00000001", NOW,
    );
    const sumUsdc = rec!.allocations.reduce((s, a) => s + parseFloat(a.usdcShare), 0);
    const sumBtc = rec!.allocations.reduce((s, a) => s + parseFloat(a.cirBtcShare), 0);
    expect(sumUsdc).toBeCloseTo(1.0, 6);
    expect(sumBtc).toBeCloseTo(0.00000001, 8);
  });

  it("scales every share down together when a guardrail capped the total", () => {
    const l = mkLedger([mkUser("0xa"), mkUser("0xb")]);
    // Schedule wanted 4 USDC; the guardrail only allowed 2 → everyone halves.
    const rec = applyScheduledDistribution(
      l,
      [sp("0xa", 1), sp("0xb", 3)],
      "2.000000", "0.00000400", NOW,
    );
    const byAddr = Object.fromEntries(rec!.allocations.map((a) => [a.address, a]));
    expect(parseFloat(byAddr["0xa"]!.usdcShare)).toBeCloseTo(0.5, 6);
    expect(parseFloat(byAddr["0xb"]!.usdcShare)).toBeCloseTo(1.5, 6);
    // cirBTC still splits by contribution — nobody subsidises anyone.
    expect(parseFloat(byAddr["0xb"]!.cirBtcShare) / parseFloat(byAddr["0xa"]!.cirBtcShare)).toBeCloseTo(3, 4);
  });

  it("debits USDC, credits cirBTC, and records the charge on each user", () => {
    const l = mkLedger([mkUser("0xa", { usdcBalance: "10.000000" })]);
    applyScheduledDistribution(l, [sp("0xa", 4)], "4.000000", "0.00000400", NOW);
    const u = l.users["0xa"]!;
    expect(parseFloat(u.usdcBalance)).toBeCloseTo(6, 6);
    expect(parseFloat(u.cirBtcBalance)).toBeCloseTo(0.000004, 8);
    expect(parseFloat(u.totalSwapped)).toBeCloseTo(4, 6);
    expect(u.lastChargedAt).toBe(NOW);
  });

  it("advances the rolling spend windows so daily/weekly caps stay honest", () => {
    const l = mkLedger([mkUser("0xa", { dcaSpentDayUsdc: "2.000000", dcaSpentDayDate: "2026-06-15" })]);
    applyScheduledDistribution(l, [sp("0xa", 3)], "3.000000", "0.00000300", NOW);
    const u = l.users["0xa"]!;
    expect(u.dcaSpentDayDate).toBe("2026-06-15");
    expect(parseFloat(u.dcaSpentDayUsdc!)).toBeCloseTo(5, 6); // 2 already spent + 3 now
    expect(u.dcaSpentWeekStart).toBe("2026-06-15"); // NOW is a Monday
  });

  it("returns null rather than corrupting the ledger on a failed swap", () => {
    const l = mkLedger([mkUser("0xa")]);
    expect(applyScheduledDistribution(l, [sp("0xa", 1)], "0", "0", NOW)).toBeNull();
    expect(applyScheduledDistribution(l, [], "1.000000", "0.00000100", NOW)).toBeNull();
    expect(parseFloat(l.users["0xa"]!.usdcBalance)).toBeCloseTo(100, 6); // untouched
  });
});

describe("multi-token DCA — per-user token, pooled per token", () => {
  it("each spend carries the user's chosen token; default is cirBTC", () => {
    const l = mkLedger([
      mkUser("0xa", { dcaFrequency: "hours", dcaEveryHours: 1, dcaAmountPerRun: "1", dcaTokenOut: "EURC", lastChargedAt: "2026-06-15T08:00:00.000Z" }),
      mkUser("0xb", { dcaFrequency: "hours", dcaEveryHours: 1, dcaAmountPerRun: "1", lastChargedAt: "2026-06-15T08:00:00.000Z" }),
    ]);
    const spends = computeScheduledSpends(l, NOW).spends;
    const byAddr = Object.fromEntries(spends.map((s) => [s.address, s.tokenOut]));
    expect(byAddr["0xa"]).toBe("EURC");
    expect(byAddr["0xb"]).toBe("cirBTC"); // absent dcaTokenOut → default
  });

  it("groupSpendsByToken separates users by their target token", () => {
    const groups = groupSpendsByToken([sp("0xa", 1, "EURC"), sp("0xb", 3, "cirBTC"), sp("0xc", 2, "EURC")]);
    expect([...groups.keys()].sort()).toEqual(["EURC", "cirBTC"]);
    expect(groups.get("EURC")!.map((s) => s.address)).toEqual(["0xa", "0xc"]);
    expect(groups.get("cirBTC")!.map((s) => s.address)).toEqual(["0xb"]);
  });

  it("distributes an EURC group with 6-decimal rounding and never touches cirBtcBalance", () => {
    const l = mkLedger([mkUser("0xa", { usdcBalance: "10.000000" }), mkUser("0xb", { usdcBalance: "10.000000" })]);
    // 1 : 3 split of 0.804606 EURC received for 4 USDC.
    applyScheduledDistribution(l, [sp("0xa", 1, "EURC"), sp("0xb", 3, "EURC")], "4.000000", "0.804606", NOW, "EURC", 6);
    const a = l.users["0xa"]!, b = l.users["0xb"]!;
    const ea = parseFloat(a.tokenBalances!["EURC"]!), eb = parseFloat(b.tokenBalances!["EURC"]!);
    expect(a.tokenBalances!["EURC"]).toBeDefined();
    expect(eb / ea).toBeCloseTo(3, 3);            // pro-rata: 75% / 25%
    expect(ea + eb).toBeCloseTo(0.804606, 6);     // books close on the received EURC
    // 6-decimal rounding — no share has more precision than the token allows.
    expect(a.tokenBalances!["EURC"]!.split(".")[1]!.length).toBeLessThanOrEqual(6);
    // EURC buyers hold zero cirBTC — the legacy field is left alone.
    expect(parseFloat(a.cirBtcBalance)).toBe(0);
    expect(parseFloat(b.cirBtcBalance)).toBe(0);
  });

  it("a cirBTC group mirrors into tokenBalances.cirBTC and keeps cirBtcBalance in sync", () => {
    const l = mkLedger([mkUser("0xa")]);
    applyScheduledDistribution(l, [sp("0xa", 4)], "4.000000", "0.00000400", NOW); // defaults cirBTC/8
    const u = l.users["0xa"]!;
    expect(parseFloat(u.cirBtcBalance)).toBeCloseTo(0.000004, 8);
    expect(u.tokenBalances!["cirBTC"]).toBe(u.cirBtcBalance);
  });

  it("mirrors run.ts: two tokens, a wallet clamp scales every group uniformly", () => {
    // 0xa DCAs 3 USDC into cirBTC, 0xb DCAs 1 USDC into EURC → scheduledTotal 4.
    // The wallet only allows 2 USDC executable this run → scale 0.5 for all.
    const l = mkLedger([mkUser("0xa", { usdcBalance: "50" }), mkUser("0xb", { usdcBalance: "50" })]);
    const spends = [sp("0xa", 3, "cirBTC"), sp("0xb", 1, "EURC")];
    const scheduledTotal = 4, executable = 2, scale = executable / scheduledTotal;

    const groups = groupSpendsByToken(spends);
    for (const token of [...groups.keys()].sort()) {
      const g = groups.get(token)!;
      const groupScheduled = g.reduce((s, x) => s + x.spend, 0);
      const groupExec = Number.parseFloat((groupScheduled * scale).toFixed(6));
      // Pretend the swap returned exactly groupExec-worth of the token (1:1 for the test).
      const decimals = token === "EURC" ? 6 : 8;
      applyScheduledDistribution(l, g, groupExec.toFixed(6), groupExec.toFixed(decimals), NOW, token, decimals);
    }

    const a = l.users["0xa"]!, b = l.users["0xb"]!;
    // cirBTC group executed 1.5 USDC (3 × 0.5); EURC group executed 0.5 (1 × 0.5).
    expect(parseFloat(a.usdcBalance)).toBeCloseTo(48.5, 6); // 50 − 1.5
    expect(parseFloat(b.usdcBalance)).toBeCloseTo(49.5, 6); // 50 − 0.5
    expect(parseFloat(a.cirBtcBalance)).toBeCloseTo(1.5, 8);
    expect(b.tokenBalances!["EURC"]).toBeDefined();
    expect(parseFloat(b.tokenBalances!["EURC"]!)).toBeCloseTo(0.5, 6);
    expect(parseFloat(b.cirBtcBalance)).toBe(0); // EURC buyer holds no cirBTC
  });
});
