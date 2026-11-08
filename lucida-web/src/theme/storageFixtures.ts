/**
 * Storages to stub in for `localStorage` with `vi.stubGlobal`. Reopen the
 * preference store after stubbing, so the store reads and writes the stub.
 *
 * Spying on `Storage.prototype` does not work under happy-dom. Its Storage
 * copies each method onto the instance the first time it is read, so a spy
 * installed after that never sees a call, and a spy in place at that moment
 * stays on the instance after `vi.restoreAllMocks()`.
 */

/** A Storage whose writes throw, as a full quota's or a private window's do. */
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

/** A Storage that counts its reads: `getItem`, `key` and `length`. */
export function countingStorage(): Storage & { readonly reads: number } {
  const values = new Map<string, string>();
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    get length() {
      reads++;
      return values.size;
    },
    key: (index: number) => {
      reads++;
      return [...values.keys()][index] ?? null;
    },
    getItem: (key: string) => {
      reads++;
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => void values.set(key, String(value)),
    removeItem: (key: string) => void values.delete(key),
    clear: () => values.clear(),
  };
}
