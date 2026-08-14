/**
 * Strict RFC 3339 parser: `YYYY-MM-DDTHH:mm:ss(.sss)?(Z|±HH:MM)`.
 * Deliberately narrower than `Date.parse`: no space separator, no missing
 * offset, no out-of-range fields, no leap-second `60`. Values failing this
 * parser fail closed at the decode boundary.
 */

const RFC3339_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/

/** True when `value` is a strict RFC 3339 instant with an explicit offset. */
export function isRfc3339Offset(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return RFC3339_RE.test(value)
}

/**
 * Parse a strict RFC 3339 instant into epoch milliseconds.
 * @param value - the instant text; must already satisfy {@link isRfc3339Offset}.
 * @returns epoch milliseconds.
 * @throws when a field is out of range (the regex only checks shape).
 */
export function parseRfc3339Offset(value: string): number {
  const match = RFC3339_RE.exec(value)
  if (match === null) throw new Error(`invalid RFC 3339 instant: ${JSON.stringify(value)}`)
  const [, year, month, day, hour, minute, second, fraction, offset] = match
  const millisecond = (fraction ?? '').padEnd(3, '0')
  const dateParts = [year, month, day, hour, minute, second, millisecond]
  const numbers = dateParts.map(part => Number(part))
  /* v8 ignore next 6 -- `?? 0` is defensive: the regex always captures 7 fixed groups, so these items are never undefined */
  const y = numbers[0] ?? 0
  const mo = numbers[1] ?? 0
  const d = numbers[2] ?? 0
  const h = numbers[3] ?? 0
  const mi = numbers[4] ?? 0
  const s = numbers[5] ?? 0
  // `Date.UTC` maps years 0-99 to 1900+n, which would silently misparse them.
  if (y < 1000) throw new Error(`year out of range in ${JSON.stringify(value)}`)
  if (mo < 1 || mo > 12) throw new Error(`invalid month in ${JSON.stringify(value)}`)
  if (d < 1 || d > daysInMonth(y, mo)) throw new Error(`invalid day in ${JSON.stringify(value)}`)
  if (h > 23 || mi > 59 || s > 59) throw new Error(`invalid time in ${JSON.stringify(value)}`)
  const utc = Date.UTC(y, mo - 1, d, h, mi, s, Number(millisecond))
  /* v8 ignore next -- defensive: a 4-digit year can never produce a non-finite Date.UTC */
  if (!Number.isFinite(utc)) throw new Error(`out-of-range instant: ${JSON.stringify(value)}`)
  /* v8 ignore next -- the regex requires an explicit offset, so `offset` is never undefined */
  const offsetMinutes = parseOffsetMinutes(offset ?? 'Z')
  return utc - offsetMinutes * 60_000
}

function parseOffsetMinutes(offset: string): number {
  if (offset === 'Z') return 0
  const sign = offset[0] === '-' ? -1 : 1
  const hours = Number(offset.slice(1, 3))
  const minutes = Number(offset.slice(4, 6))
  if (hours > 23) throw new Error(`invalid offset: ${offset}`)
  if (minutes > 59) throw new Error(`invalid offset: ${offset}`)
  return sign * (hours * 60 + minutes)
}

function daysInMonth(year: number, month: number): number {
  switch (month) {
    case 2:
      return isLeapYear(year) ? 29 : 28
    case 4:
    case 6:
    case 9:
    case 11:
      return 30
    default:
      return 31
  }
}

function isLeapYear(year: number): boolean {
  if (year % 4 !== 0) return false
  if (year % 100 !== 0) return true
  return year % 400 === 0
}

/** Render epoch milliseconds as a strict RFC 3339 UTC instant. */
export function formatRfc3339Utc(atMs: number): string {
  if (!Number.isSafeInteger(atMs)) throw new Error(`cannot format non-safe-integer epoch: ${atMs}`)
  const date = new Date(atMs)
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}Z`
}
