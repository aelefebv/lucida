import { XIcon } from "@phosphor-icons/react";
import { Button as AriaButton } from "react-aria-components";
import type { ClientId, PresenceState } from "../bridge.ts";
import { peerColor } from "../peerColor.ts";
import { usePeerState, type PeerStore } from "../peerStore.ts";
import { Avatar } from "../ui/Avatar.tsx";
import { Button } from "../ui/Button.tsx";
import { Menu, MenuItem } from "../ui/Menu.tsx";
import { UnstyledButton } from "../ui/UnstyledButton.tsx";
import "./PresenceAvatars.css";

/** Avatars shown before the rest collapse into a "+N" menu. */
const MAX_SHOWN = 5;

export interface PresenceAvatarsProps {
  /** Everyone else in the workspace, and whom this client follows. */
  peerStore: PeerStore;
  /** Follow a peer, or stop following with null. */
  onFollow: (peer: ClientId | null) => void;
}

interface Peer {
  id: ClientId;
  name: string;
  pictureUrl: string | undefined;
  color: string;
  /** A peer who follows someone else can't be followed in turn. */
  followable: boolean;
  following: boolean;
}

function toPeer(state: PresenceState, followTarget: ClientId | null): Peer {
  const name = state.identity?.display_name?.trim() || `Client ${state.client_id}`;
  return {
    id: state.client_id,
    name,
    pictureUrl: state.identity?.picture_url ?? undefined,
    color: peerColor(state.client_id),
    followable: state.following === null || state.following === undefined,
    following: followTarget === state.client_id,
  };
}

function actionLabel(peer: Peer): string {
  if (peer.following) return `Stop following ${peer.name}`;
  if (peer.followable) return `Follow ${peer.name}`;
  return `${peer.name} is following someone`;
}

/** Avatars a compact indicator shows before a count stands for the rest. */
const COMPACT_SHOWN = 2;

/**
 * Who else is here, in the room a phone's top bar has: a couple of small
 * avatars and a count, as one button that opens a menu to follow someone or
 * stop. The person followed comes first and carries the follow ring.
 */
export function CompactPresence({ peerStore, onFollow }: PresenceAvatarsProps) {
  const { peers, followTarget } = usePeerState(peerStore);
  if (peers.size === 0) return null;
  const all = [...peers.values()].map((p) => toPeer(p, followTarget));
  const followed = all.find((p) => p.following) ?? null;
  const ordered = followed ? [followed, ...all.filter((p) => p !== followed)] : all;
  const shown = ordered.slice(0, COMPACT_SHOWN);
  const here = `${all.length} other ${all.length === 1 ? "person" : "people"} here`;
  const press = (peer: Peer) => {
    if (peer.following) onFollow(null);
    else if (peer.followable) onFollow(peer.id);
  };

  return (
    <Menu
      label="Everyone here"
      placement="bottom end"
      trigger={
        <AriaButton
          className="lc-presence-compact"
          aria-label={followed ? `Following ${followed.name}, ${here}` : here}
          data-following={followed ? "" : undefined}
        >
          <span className="lc-presence-stack" aria-hidden="true">
            {shown.map((peer) => (
              <Avatar key={peer.id} name={peer.name} src={peer.pictureUrl} color={peer.color} size="sm" />
            ))}
          </span>
          {all.length > shown.length && (
            <span className="lc-presence-compact-more" aria-hidden="true">{`+${all.length - shown.length}`}</span>
          )}
        </AriaButton>
      }
    >
      {ordered.map((peer) => (
        <MenuItem key={peer.id} onAction={() => press(peer)} isDisabled={!peer.followable && !peer.following}>
          {actionLabel(peer)}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** Who else is here. Click an avatar to follow that person's view. */
export function PresenceAvatars({ peerStore, onFollow }: PresenceAvatarsProps) {
  const { peers, followTarget } = usePeerState(peerStore);
  if (peers.size === 0) return null;
  const all = [...peers.values()].map((p) => toPeer(p, followTarget));
  const shown = all.length > MAX_SHOWN ? all.slice(0, MAX_SHOWN - 1) : all;
  const rest = all.slice(shown.length);
  const followed = all.find((p) => p.following) ?? null;
  const press = (peer: Peer) => {
    if (peer.following) onFollow(null);
    else if (peer.followable) onFollow(peer.id);
  };

  return (
    <div className="lc-presence" role="group" aria-label={`${all.length} other ${all.length === 1 ? "person" : "people"} here`}>
      {followed && (
        <Button size="sm" variant="ghost" icon={XIcon} onPress={() => onFollow(null)}>
          {`Following ${followed.name}`}
        </Button>
      )}
      <div className="lc-presence-stack">
        {shown.map((peer) => (
          <UnstyledButton
            key={peer.id}
            className="lc-presence-peer"
            aria-label={actionLabel(peer)}
            aria-pressed={peer.following}
            isDisabled={!peer.followable && !peer.following}
            data-following={peer.following || undefined}
            onPress={() => press(peer)}
          >
            <Avatar name={peer.name} src={peer.pictureUrl} color={peer.color} />
          </UnstyledButton>
        ))}
        {rest.length > 0 && (
          <Menu label="Everyone here" placement="bottom end" trigger={<Button size="sm" variant="ghost">{`+${rest.length}`}</Button>}>
            {rest.map((peer) => (
              <MenuItem
                key={peer.id}
                onAction={() => press(peer)}
                isDisabled={!peer.followable && !peer.following}
              >
                {actionLabel(peer)}
              </MenuItem>
            ))}
          </Menu>
        )}
      </div>
    </div>
  );
}
