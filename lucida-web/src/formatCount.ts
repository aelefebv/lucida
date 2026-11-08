/**
 * A count with the locale's digit grouping, as `toLocaleString()` writes it.
 *
 * Through one kept formatter, because current V8 builds a new one on every
 * `Number.prototype.toLocaleString` call, at about thirty times the cost of
 * formatting with a kept one. The surfaces that read a run while it is open
 * format counts on every poll, under a cost contract.
 */
const grouped = new Intl.NumberFormat();

export function formatCount(n: number): string {
  return grouped.format(n);
}
