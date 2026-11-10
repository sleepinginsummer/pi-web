import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { nextCronFire, nextCronFires, parseCron, validateCron } = await jiti.import("./cron-schedule.ts");

const at = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);

test("validates field count, ranges, steps and names", () => {
  assert.equal(validateCron("*/15 9-17 * * mon-fri"), null);
  assert.equal(validateCron("0 9 1 jan,jul *"), null);
  assert.match(validateCron("0 9 * *"), /5 fields/);
  assert.match(validateCron("60 * * * *"), /minute/);
  assert.match(validateCron("0 25 * * *"), /hour/);
  assert.match(validateCron("0 9 * * 5-1"), /reversed/);
  assert.match(validateCron("0 0 30 2 *"), /never fires/);
});

test("next fire is strictly after the given time, on the minute", () => {
  assert.deepEqual(nextCronFire("0 9 * * *", at(2026, 11, 10, 8, 59)), at(2026, 11, 10, 9, 0));
  assert.deepEqual(nextCronFire("0 9 * * *", at(2026, 11, 10, 9, 0)), at(2026, 11, 11, 9, 0));
  assert.deepEqual(nextCronFire("*/30 * * * *", new Date(2026, 10, 10, 10, 5, 42)), at(2026, 11, 10, 10, 30));
});

test("weekdays, month rollover and Sunday as 7", () => {
  // 2026-11-14 is a Saturday.
  assert.deepEqual(nextCronFire("30 8 * * 1-5", at(2026, 11, 13, 9, 0)), at(2026, 11, 16, 8, 30));
  assert.deepEqual(nextCronFire("0 0 1 * *", at(2026, 11, 10)), at(2026, 12, 1));
  assert.deepEqual(nextCronFire("0 12 * * 7", at(2026, 11, 10)), at(2026, 11, 15, 12, 0));
  assert.deepEqual(parseCron("0 0 * * 7").dayOfWeek.values, new Set([0]));
});

test("day-of-month and day-of-week combine with OR when both are restricted", () => {
  // The 20th (a Friday) or any Monday, whichever comes first after Nov 10 (Tuesday).
  assert.deepEqual(nextCronFire("0 0 20 * 1", at(2026, 11, 10, 1)), at(2026, 11, 16));
});

test("lists several upcoming fires", () => {
  assert.deepEqual(nextCronFires("0 */6 * * *", 3, at(2026, 11, 10, 1)), [
    at(2026, 11, 10, 6), at(2026, 11, 10, 12), at(2026, 11, 10, 18),
  ]);
});
