/**
 * Identity strings are interned rather than stored per record. Dataset,
 * entity and image ids are low-cardinality — a workspace has hundreds, not
 * thousands — so the pool stops growing early in a run. Chunk coordinates are
 * *not* interned: they are already integers on the objects the emit sites
 * hold, and interning a per-chunk string would be the one unbounded
 * allocation in the recorder.
 */
export class StringPool {
  private readonly ids = new Map<string, number>();
  private readonly values: string[] = [];

  intern(value: string): number {
    const existing = this.ids.get(value);
    if (existing !== undefined) return existing;
    const id = this.values.length;
    this.values.push(value);
    this.ids.set(value, id);
    return id;
  }

  get(id: number): string {
    return this.values[id] ?? "";
  }

  get size(): number {
    return this.values.length;
  }
}
