/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) in the
 * server's local time zone. Supports `*`, lists, ranges, steps and English
 * month/weekday names; day-of-month and day-of-week combine with OR when both
 * are restricted, as in Vixie cron. No dependency: the scheduler only needs
 * validation and "next fire after".
 */

interface CronField {
  values: Set<number>;
  restricted: boolean;
}

export interface ParsedCron {
  minute: CronField;
  hour: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseValue(raw: string, min: number, names?: string[], nameOffset = 0): number {
  const lower = raw.toLowerCase();
  if (names) {
    const index = names.indexOf(lower);
    if (index >= 0) return index + nameOffset;
  }
  if (!/^\d+$/.test(raw)) throw new Error(`"${raw}" is not a number`);
  const value = Number(raw);
  if (value < min) throw new Error(`${value} is below ${min}`);
  return value;
}

function parseField(source: string, min: number, max: number, label: string, names?: string[], nameOffset = 0): CronField {
  const values = new Set<number>();
  let restricted = false;
  for (const part of source.split(",")) {
    if (!part) throw new Error(`${label}: empty list item`);
    const [rangePart, stepPart, extra] = part.split("/");
    if (extra !== undefined) throw new Error(`${label}: "${part}" has more than one "/"`);
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart) || Number(stepPart) < 1) throw new Error(`${label}: step "${stepPart}" must be a positive number`);
      step = Number(stepPart);
    }
    let start: number;
    let end: number;
    if (rangePart === "*") {
      start = min;
      end = max;
      if (stepPart !== undefined) restricted = true;
    } else {
      restricted = true;
      const [a, b, more] = rangePart.split("-");
      if (more !== undefined) throw new Error(`${label}: "${rangePart}" is not a range`);
      start = parseValue(a, min, names, nameOffset);
      end = b === undefined ? (stepPart !== undefined ? max : start) : parseValue(b, min, names, nameOffset);
    }
    if (start > max || end > max) throw new Error(`${label}: values must be ${min}-${max}`);
    if (start > end) throw new Error(`${label}: range ${start}-${end} is reversed`);
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return { values, restricted };
}

export function parseCron(expression: string): ParsedCron {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("expected 5 fields: minute hour day-of-month month day-of-week, e.g. \"0 9 * * 1-5\"");
  }
  const dayOfWeek = parseField(fields[4], 0, 7, "day-of-week", DAY_NAMES);
  // 7 is Sunday too.
  if (dayOfWeek.values.delete(7)) dayOfWeek.values.add(0);
  return {
    minute: parseField(fields[0], 0, 59, "minute"),
    hour: parseField(fields[1], 0, 23, "hour"),
    dayOfMonth: parseField(fields[2], 1, 31, "day-of-month"),
    month: parseField(fields[3], 1, 12, "month", MONTH_NAMES, 1),
    dayOfWeek,
  };
}

/** An error message for an invalid expression, or null when it is valid and fires at least once. */
export function validateCron(expression: string): string | null {
  try {
    const parsed = parseCron(expression);
    return nextCronFire(parsed, new Date()) ? null : "the expression never fires";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function dayMatches(cron: ParsedCron, date: Date): boolean {
  const dom = cron.dayOfMonth.values.has(date.getDate());
  const dow = cron.dayOfWeek.values.has(date.getDay());
  if (cron.dayOfMonth.restricted && cron.dayOfWeek.restricted) return dom || dow;
  if (cron.dayOfMonth.restricted) return dom;
  if (cron.dayOfWeek.restricted) return dow;
  return true;
}

/** The first matching minute strictly after `after`, searching up to five years ahead. */
export function nextCronFire(cron: ParsedCron | string, after: Date): Date | null {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const date = new Date(after.getTime());
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  const limit = after.getTime() + 5 * 366 * 24 * 60 * 60 * 1000;
  while (date.getTime() <= limit) {
    if (!parsed.month.values.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!dayMatches(parsed, date)) {
      date.setDate(date.getDate() + 1);
      date.setHours(0, 0, 0, 0);
      continue;
    }
    if (!parsed.hour.values.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!parsed.minute.values.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1, 0, 0);
      continue;
    }
    return date;
  }
  return null;
}

export function nextCronFires(expression: string, count: number, after: Date): Date[] {
  const parsed = parseCron(expression);
  const fires: Date[] = [];
  let cursor = after;
  for (let index = 0; index < count; index += 1) {
    const next = nextCronFire(parsed, cursor);
    if (!next) break;
    fires.push(next);
    cursor = next;
  }
  return fires;
}
