/**
 * A Storage whose writes throw, as a full quota's or a private window's do.
 * Stub it in for `localStorage` with `vi.stubGlobal` and reopen the preference
 * store, so the store writes into it.
 *
 * Spying on `Storage.prototype.setItem` does not work under happy-dom. Its
 * Storage copies each method onto the instance the first time it is read, so a
 * spy installed after that never sees a call, and a spy in place at that moment
 * stays on the instance, still throwing, after `vi.restoreAllMocks()`.
 */
export function failingStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: () => {
      throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
    },
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}
