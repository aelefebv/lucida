/**
 * Each view's camera reference per member, in entity-local [0, 1] space, which
 * eviction measures a resident chunk's distance from. Each view's revision
 * moves with every change to its references, so an order measured from them
 * can tell it is out of date without comparing them, and a camera move in one
 * view leaves the others' orders standing.
 */
export class CameraRefs<T extends readonly number[]> {
  private readonly byView = new Map<number, Map<string, T>>();
  /**
   * The count of changes at each view's last. One count across views keeps a
   * view's revision from coming back to a value it had, even across a clear.
   */
  private readonly revisions = new Map<number, number>();
  private changes = 0;

  /** Moves whenever one of `view`'s references is set to another value or forgotten. */
  revisionOf(view: number): number {
    return this.revisions.get(view) ?? 0;
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
    this.changed(view);
  }

  /** Forget a member's reference in `view`, or in every view. */
  forget(memberId: string, view?: number): void {
    const views = view === undefined ? [...this.byView.keys()] : [view];
    for (const v of views) {
      if (this.byView.get(v)?.delete(memberId)) this.changed(v);
    }
  }

  clear(): void {
    for (const view of this.byView.keys()) this.changed(view);
    this.byView.clear();
  }

  private changed(view: number): void {
    this.revisions.set(view, ++this.changes);
  }
}
