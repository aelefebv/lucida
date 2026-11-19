/**
 * Order two ids by their UTF-16 code units. The request and delivery orders
 * break ties by id so that they never depend on the order things were found
 * in, which needs a fixed order, not a reader's. `localeCompare` would build
 * the page's collator on its first call, and that call has held a cold
 * open's first plan for tens of milliseconds.
 */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
