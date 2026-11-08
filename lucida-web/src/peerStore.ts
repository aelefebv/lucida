/**
 * Who else is in the workspace, as React reads it: the peers, this
 * connection's id, and whom it follows.
 *
 * Held outside React state because peer messages arrive many times a second
 * while anyone pans or moves a cursor. Only the components that show peers
 * subscribe, so a peer message never re-renders the viewer around them.
 */
import { useSyncExternalStore } from "react";
import type { ClientId, PresenceState } from "./bridge.ts";

export interface PeerState {
  /** Everyone else here, by client id. A new map on every change. */
  readonly peers: ReadonlyMap<ClientId, PresenceState>;
  /** This connection's server-assigned id. */
  readonly myId: ClientId;
  /** The peer this client follows, or null. */
  readonly followTarget: ClientId | null;
}

const NO_PEERS: PeerState = { peers: new Map(), myId: 0, followTarget: null };

export class PeerStore {
  private state: PeerState = NO_PEERS;
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** One snapshot whose identity changes only when a value in it does. */
  getState = (): PeerState => this.state;

  setPeers(peers: ReadonlyMap<ClientId, PresenceState>): void {
    this.update({ peers });
  }

  setMyId(myId: ClientId): void {
    this.update({ myId });
  }

  setFollowTarget(followTarget: ClientId | null): void {
    this.update({ followTarget });
  }

  /** Forget the connection's peers, id and follow. */
  reset(): void {
    this.update(NO_PEERS);
  }

  private update(patch: Partial<PeerState>): void {
    const next = { ...this.state, ...patch };
    const prev = this.state;
    if (next.peers === prev.peers && next.myId === prev.myId && next.followTarget === prev.followTarget) {
      return;
    }
    this.state = next;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The peer state, re-rendering on every peer message. */
export function usePeerState(store: PeerStore): PeerState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}
