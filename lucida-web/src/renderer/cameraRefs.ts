/**
 * Each view's camera reference per member, in entity-local [0, 1] space, which
 * eviction measures a resident chunk's distance from. Its revision moves with
 * every change, so an order measured from the references can tell it is out
 * of date without comparing them.
 */
export class CameraRefs<T extends readonly number[]> {
  private readonly byView = new Map<number, Map<string, T>>();
  private changes = 0;

  /** Moves whenever any reference is set to another value or forgotten. */
  get revision(): number {
    return this.changes;
  }

  get(view: number, memberId: string): T | undefined {
    return this.byView.get(view)?.get(memberId);
  }

  set(view: number, memberId: string, ref: T): void {
    let byMember = this.byView.get(view);
    if (!byMember) {
      byMember = new Map();
      this.byView.set(view, byMember);
    }
    const held = byMember.get(memberId);
    // A view redraws every frame with the camera standing still, which must
    // not count as a move.
    if (held && held.length === ref.length && held.every((value, i) => value === ref[i])) return;
    byMember.set(memberId, ref);
    this.changes++;
  }

  /** Forget a member's reference in `view`, or in every view. */
  forget(memberId: string, view?: number): void {
    const maps = view === undefined ? this.byView.values() : [this.byView.get(view)];
    for (const byMember of maps) {
      if (byMember?.delete(memberId)) this.changes++;
    }
  }

  clear(): void {
    if (this.byView.size > 0) this.changes++;
    this.byView.clear();
  }
}
