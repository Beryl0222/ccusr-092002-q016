/** 全部日期为 YYYY-MM-DD，按字典序即可正确比较。 */

export function today(clock = () => new Date()) {
  return clock().toISOString().slice(0, 10);
}

export function isValidDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function isWithin(date, validFrom, validUntil) {
  if (!isValidDate(date)) return false;
  if (validFrom && date < validFrom) return false;
  if (validUntil && date > validUntil) return false;
  return true;
}

export function shiftDays(date, days) {
  const ms = new Date(`${date}T00:00:00.000Z`).getTime() + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isExpired(validUntil, nowDate) {
  return Boolean(validUntil) && validUntil < nowDate;
}
