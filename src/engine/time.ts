/**
 * Domino Sky — Absolute-Minute Time Utilities
 *
 * All simulation calculations operate in integer absolute minutes from 00:00 IST
 * on the operating day (0 .. 1439 for Day 0; >= 1440 for rollover past midnight).
 * This guarantees exact arithmetic without Date/timezone drift or wrap-around bugs.
 */

const HHMM_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const MINUTES_PER_DAY = 1440;

export function isValidHHMM(value: string): boolean {
  return HHMM_REGEX.test(value);
}

/**
 * Parses a 24-hour "HH:MM" string into absolute minutes since 00:00 IST.
 * Throws if the format is invalid.
 */
export function parseHHMMToMinutes(timeStr: string): number {
  const match = HHMM_REGEX.exec(timeStr);
  if (!match) {
    throw new Error(`Invalid 24-hour HH:MM time string: "${timeStr}"`);
  }
  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  return hours * 60 + minutes;
}

/**
 * Formats absolute minutes since 00:00 IST into readable 24-hour clock format.
 * Examples:
 *  - 480  -> "08:00"
 *  - 1475 -> "00:35 (+1d)"
 */
export function formatMinutesToClock(totalMinutes: number): string {
  const safeMin = Math.max(0, Math.round(totalMinutes));
  const dayOffset = Math.floor(safeMin / MINUTES_PER_DAY);
  const minuteOfDay = safeMin % MINUTES_PER_DAY;
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  const clock = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
  return dayOffset > 0 ? `${clock} (+${dayOffset}d)` : clock;
}

/**
 * Formats a minute duration cleanly (e.g. 95 -> "1h 35m", 45 -> "45m", 0 -> "0m").
 */
export function formatDurationMinutes(minutes: number): string {
  const sign = minutes < 0 ? '-' : '';
  const abs = Math.abs(Math.round(minutes));
  if (abs < 60) {
    return `${sign}${abs}m`;
  }
  const hrs = Math.floor(abs / 60);
  const mins = abs % 60;
  return mins === 0 ? `${sign}${hrs}h` : `${sign}${hrs}h ${mins}m`;
}
