import { describe, it, expect } from "vitest";
import { outageStreak } from "../history/store.js";
import type { HistoryEntry } from "../types.js";

const entry = (date: string, status: HistoryEntry["status"]): HistoryEntry =>
  ({ date, timestamp: date + "T00:00:00.000Z", status } as HistoryEntry);
const fail = (date: string) => entry(date, "error_swap_failed");
const ok = (date: string) => entry(date, "success");

describe("outageStreak — days vs runs the agent must not conflate", () => {
  it("reports distinct days, not the failed-run count", () => {
    // The bug this guards: the agent wrote '30+ days' for a ~10-day outage because
    // it read the run tally (hourly cron) as a day tally.
    const dates = ["2026-07-08","2026-07-09","2026-07-10","2026-07-11","2026-07-12","2026-07-13","2026-07-14","2026-07-15","2026-07-16","2026-07-17"];
    const h = dates.flatMap((d) => [fail(d), fail(d), fail(d)]); // 30 failed runs
    const s = outageStreak(h);
    expect(s.consecutiveRuns).toBe(30);
    expect(s.days).toBe(10); // ten calendar days, not thirty
  });

  it("counts only the trailing streak since the last success", () => {
    const h = [fail("2026-07-05"), ok("2026-07-06"), fail("2026-07-07"), fail("2026-07-08")];
    const s = outageStreak(h);
    expect(s.consecutiveRuns).toBe(2); // the two after the success
    expect(s.days).toBe(2);
  });

  it("steps over non-swap statuses without counting or breaking the streak", () => {
    // A skip the agent chose and a config error are not route failures, but they
    // also don't end the outage.
    const h = [fail("2026-07-08"), entry("2026-07-08", "skipped_llm_declined"), entry("2026-07-09", "error_config"), fail("2026-07-09")];
    const s = outageStreak(h);
    expect(s.consecutiveRuns).toBe(2); // two error_swap_failed
    expect(s.days).toBe(2);            // 07-08 and 07-09
  });

  it("is zero when there is no outage", () => {
    expect(outageStreak([])).toEqual({ consecutiveRuns: 0, days: 0 });
    expect(outageStreak([ok("2026-07-08")])).toEqual({ consecutiveRuns: 0, days: 0 });
  });

  it("multiple failed runs on one day count as a single day", () => {
    const h = [fail("2026-07-09"), fail("2026-07-09"), fail("2026-07-09")];
    const s = outageStreak(h);
    expect(s.consecutiveRuns).toBe(3);
    expect(s.days).toBe(1);
  });
});
