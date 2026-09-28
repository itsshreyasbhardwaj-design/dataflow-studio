/**
 * A cron parser and evaluator with explicit timezone support.
 *
 * Written rather than borrowed for two reasons: schedule semantics are the part of
 * an orchestrator users complain about most (DST, ambiguous hours, day-of-week vs
 * day-of-month), so they deserve tests we own; and the worker's dependency
 * surface stays small. Timezone arithmetic goes through Intl rather than a tz
 * database copy, so it tracks the platform's zone data.
 */

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

export interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when day-of-month was restricted (affects OR semantics with day-of-week). */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const MACROS: Record<string, string> = {
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
};

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(
  raw: string,
  min: number,
  max: number,
  names: readonly string[] = [],
  fieldName = "field",
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = true;

  for (const part of raw.split(",")) {
    const token = part.trim().toLowerCase();
    if (!token) throw new CronParseError(`Empty ${fieldName} in cron expression`);

    const [rangePart, stepPart] = token.split("/");
    if (stepPart !== undefined && !/^\d+$/.test(stepPart)) {
      throw new CronParseError(`Invalid step "${stepPart}" in ${fieldName}`);
    }
    const step = stepPart ? Number(stepPart) : 1;
    if (step < 1) throw new CronParseError(`Step must be at least 1 in ${fieldName}`);

    let from: number;
    let to: number;
    const resolve = (value: string): number => {
      const index = names.indexOf(value);
      if (index >= 0) return index + min;
      if (!/^\d+$/.test(value)) throw new CronParseError(`Invalid value "${value}" in ${fieldName}`);
      return Number(value);
    };

    if (rangePart === "*" || rangePart === "?") {
      from = min;
      to = max;
      if (!stepPart) restricted = false;
    } else if (rangePart!.includes("-")) {
      const [start, end] = rangePart!.split("-") as [string, string];
      from = resolve(start);
      to = resolve(end);
    } else {
      from = resolve(rangePart!);
      to = from;
    }

    if (from < min || to > max || from > to) {
      throw new CronParseError(`Range ${from}-${to} is out of bounds for ${fieldName} (${min}-${max})`);
    }
    for (let value = from; value <= to; value += step) values.add(value);
  }
  if (!values.size) throw new CronParseError(`${fieldName} matched no values`);
  return { values, restricted };
}

export function parseCron(expression: string): CronFields {
  const trimmed = expression.trim().toLowerCase();
  const normalized = MACROS[trimmed] ?? trimmed;
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `Expected 5 cron fields (minute hour day-of-month month day-of-week), got ${parts.length}: "${expression}"`,
    );
  }
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts as [string, string, string, string, string];

  const minutes = parseField(minute, 0, 59, [], "minute");
  const hours = parseField(hour, 0, 23, [], "hour");
  const days = parseField(dayOfMonth, 1, 31, [], "day-of-month");
  const months = parseField(month, 1, 12, MONTH_NAMES, "month");
  const weekdays = parseField(dayOfWeek.replace(/\b7\b/g, "0"), 0, 6, DAY_NAMES, "day-of-week");

  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: days.values,
    months: months.values,
    daysOfWeek: weekdays.values,
    dayOfMonthRestricted: days.restricted,
    dayOfWeekRestricted: weekdays.restricted,
  };
}

export function isValidCron(expression: string): boolean {
  try {
    parseCron(expression);
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

/** Wall-clock fields for an instant in a given zone. */
export function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const weekdayIndex = DAY_NAMES.indexOf(get("weekday").slice(0, 3).toLowerCase());
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // Intl renders midnight as 24 in some locales/zones.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: weekdayIndex < 0 ? 0 : weekdayIndex,
  };
}

export function matchesCron(fields: CronFields, date: Date, timezone: string): boolean {
  const parts = zonedParts(date, timezone);
  if (!fields.minutes.has(parts.minute)) return false;
  if (!fields.hours.has(parts.hour)) return false;
  if (!fields.months.has(parts.month)) return false;

  // Vixie cron: when both day fields are restricted, either may match.
  const dayMatches = fields.daysOfMonth.has(parts.day);
  const weekdayMatches = fields.daysOfWeek.has(parts.weekday);
  if (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted) return dayMatches || weekdayMatches;
  if (fields.dayOfMonthRestricted) return dayMatches;
  if (fields.dayOfWeekRestricted) return weekdayMatches;
  return true;
}

const MINUTE_MS = 60_000;
/** Four years of minutes: enough for `0 0 29 2 *` (the leap-day case). */
const MAX_SEARCH_MINUTES = 4 * 366 * 24 * 60;

/**
 * Next firing strictly after `after`.
 *
 * The search walks minute by minute in UTC and tests the local wall clock, which
 * gives correct DST behaviour for free: a 02:30 daily schedule simply does not
 * fire on a spring-forward day, and fires twice on a fall-back day unless the
 * caller deduplicates (the scheduler does, via the unique index on
 * (schedule_id, logical_date)).
 */
export function nextCronOccurrence(
  expression: string | CronFields,
  after: Date,
  timezone = "UTC",
): Date | null {
  const fields = typeof expression === "string" ? parseCron(expression) : expression;
  if (!isValidTimezone(timezone)) throw new CronParseError(`Unknown timezone "${timezone}"`);

  // Start at the next whole minute.
  let cursor = new Date(Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
  for (let step = 0; step < MAX_SEARCH_MINUTES; step++) {
    if (matchesCron(fields, cursor, timezone)) return cursor;

    // Skip a whole day when the date can never match, instead of 1440 checks.
    const parts = zonedParts(cursor, timezone);
    const dayCanMatch =
      fields.months.has(parts.month) &&
      (fields.dayOfMonthRestricted && fields.dayOfWeekRestricted
        ? fields.daysOfMonth.has(parts.day) || fields.daysOfWeek.has(parts.weekday)
        : fields.dayOfMonthRestricted
          ? fields.daysOfMonth.has(parts.day)
          : fields.dayOfWeekRestricted
            ? fields.daysOfWeek.has(parts.weekday)
            : true);
    if (!dayCanMatch) {
      const minutesLeftInDay = (23 - parts.hour) * 60 + (60 - parts.minute);
      cursor = new Date(cursor.getTime() + minutesLeftInDay * MINUTE_MS);
      step += minutesLeftInDay - 1;
      continue;
    }
    if (!fields.hours.has(parts.hour)) {
      const minutesLeftInHour = 60 - parts.minute;
      cursor = new Date(cursor.getTime() + minutesLeftInHour * MINUTE_MS);
      step += minutesLeftInHour - 1;
      continue;
    }
    cursor = new Date(cursor.getTime() + MINUTE_MS);
  }
  return null;
}

/** The next `count` firings, for the "when will this run?" preview in the UI. */
export function nextCronOccurrences(
  expression: string,
  after: Date,
  timezone = "UTC",
  count = 5,
): Date[] {
  const fields = parseCron(expression);
  const out: Date[] = [];
  let cursor = after;
  for (let i = 0; i < count; i++) {
    const next = nextCronOccurrence(fields, cursor, timezone);
    if (!next) break;
    out.push(next);
    cursor = next;
  }
  return out;
}

/** Plain-English rendering for the schedule list. */
export function describeCron(expression: string, timezone = "UTC"): string {
  const trimmed = expression.trim().toLowerCase();
  const normalized = MACROS[trimmed] ?? trimmed;
  const fields = parseCron(normalized);
  const [minute, hour, dayOfMonth, month, dayOfWeek] = normalized.split(/\s+/) as [string, string, string, string, string];
  const zone = timezone === "UTC" ? "UTC" : timezone;

  const time = (): string => {
    const h = [...fields.hours][0]!;
    const m = [...fields.minutes][0]!;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  };

  if (minute.startsWith("*/") && hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return `Every ${minute.slice(2)} minutes`;
  }
  if (minute === "*" && hour === "*") return "Every minute";
  if (fields.minutes.size === 1 && hour === "*") return `Hourly at ${String([...fields.minutes][0]).padStart(2, "0")} past`;
  if (fields.minutes.size === 1 && fields.hours.size === 1) {
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `Every day at ${time()} ${zone}`;
    if (dayOfWeek !== "*" && dayOfMonth === "*") {
      const names = [...fields.daysOfWeek].map((d) => ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d]).join(", ");
      return `Every ${names} at ${time()} ${zone}`;
    }
    if (dayOfMonth !== "*") return `Day ${[...fields.daysOfMonth].join(", ")} of the month at ${time()} ${zone}`;
  }
  return `cron(${normalized}) in ${zone}`;
}
