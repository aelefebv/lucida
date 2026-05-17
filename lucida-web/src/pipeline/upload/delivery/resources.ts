/**
 * Tracks worker member ids that have received upload resources.
 *
 * This is wire-resource lifecycle state, not delivery state: it exists
 * so dataset removal and multi-channel transitions can ask the worker
 * to drop stale layer resources without peeking into CpuCache internals.
 */

export class WorkerResourceTracker {
  private readonly memberIds = new Set<string>();

  recordMember(memberId: string): void {
    this.memberIds.add(memberId);
  }

  clearMember(memberId: string): void {
    this.memberIds.delete(memberId);
  }

  clearDataset(datasetId: string): void {
    const prefix = `${datasetId}:`;
    for (const memberId of this.memberIds) {
      if (memberId === datasetId || memberId.startsWith(prefix)) {
        this.memberIds.delete(memberId);
      }
    }
  }

  trackedMemberIds(): string[] {
    return [...this.memberIds];
  }

  reset(): void {
    this.memberIds.clear();
  }
}
