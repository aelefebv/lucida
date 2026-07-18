/** Format an ISO timestamp for the saved-view list without a date library. */
export function relativeTimeFromIso(iso: string, now: Date = new Date()): string {
  const timestamp = Date.parse(iso);
  if (Number.isNaN(timestamp)) return "";
  const seconds = Math.round((timestamp - now.getTime()) / 1000);
  const absolute = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (absolute < 60) return formatter.format(seconds, "second");
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
  if (absolute < 86400 * 30) return formatter.format(Math.round(seconds / 86400), "day");
  if (absolute < 86400 * 365) {
    return formatter.format(Math.round(seconds / 86400 / 30), "month");
  }
  return formatter.format(Math.round(seconds / 86400 / 365), "year");
}
