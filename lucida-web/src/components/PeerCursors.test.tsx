// @vitest-environment happy-dom
//
// Component test for PeerCursors peer identity rendering (#540). The cursor
// label pill, avatar image, and initial-chip fallback are rendered straight
// from JSX for every peer (the RAF tick only positions/toggles them), so we
// can assert on them with a null scene ref and a stub canvas — no WebGPU.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PeerCursors, type CursorLabel } from "./PeerCursors.tsx";
import type { ClientId, PeerIdentity, PresenceState } from "../bridge.ts";

function makePeer(
  clientId: ClientId,
  identity?: PeerIdentity | null,
): PresenceState {
  return {
    client_id: clientId,
    camera: null,
    view: { z_range: { start: 0, end: 1 }, t: 0, c: 0 },
    display: { contrast_min: 0, contrast_max: 1, gamma: 1 },
    following: null,
    cursor: [10, 20],
    dataset_order: [],
    dataset_settings: {},
    ...(identity !== undefined ? { identity } : {}),
  };
}

function peersElement(peers: Map<ClientId, PresenceState>) {
  const cursorLabels: CursorLabel[] = Array.from(peers.keys()).map((id) => ({
    id,
    sx: 0,
    sy: 0,
  }));
  return (
    <PeerCursors
      peers={peers}
      myId={0}
      followTarget={null}
      wasmSceneRef={{ current: null }}
      canvas={document.createElement("canvas")}
      viewMode="2d"
      z={0}
      t={0}
      c={0}
      cursorLabels={cursorLabels}
    />
  );
}

function renderPeers(peers: Map<ClientId, PresenceState>) {
  return render(peersElement(peers));
}

afterEach(() => cleanup());

describe("PeerCursors identity", () => {
  it("renders a name pill and an avatar img for a peer with name + avatar", () => {
    const peers = new Map<ClientId, PresenceState>([
      [
        7,
        makePeer(7, {
          display_name: "Ada Lovelace",
          picture_url: "https://example.com/ada.png",
          initial: "A",
        }),
      ],
    ]);
    renderPeers(peers);

    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    const avatar = screen.getByTestId("peer-cursor-avatar") as HTMLImageElement;
    expect(avatar.tagName).toBe("IMG");
    expect(avatar.getAttribute("src")).toBe("https://example.com/ada.png");
    // No initial chip while the image is rendering.
    expect(screen.queryByTestId("peer-cursor-initial")).toBeNull();
  });

  it("falls back to an initial chip for a peer with a name but no avatar", () => {
    const peers = new Map<ClientId, PresenceState>([
      [3, makePeer(3, { display_name: "Grace Hopper", initial: "G" })],
    ]);
    renderPeers(peers);

    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    const chip = screen.getByTestId("peer-cursor-initial");
    expect(chip.textContent).toBe("G");
    expect(screen.queryByTestId("peer-cursor-avatar")).toBeNull();
  });

  it("degrades a broken avatar image to the initial chip (onError)", () => {
    const peers = new Map<ClientId, PresenceState>([
      [
        5,
        makePeer(5, {
          display_name: "Carol",
          picture_url: "https://example.com/broken.png",
        }),
      ],
    ]);
    renderPeers(peers);

    const avatar = screen.getByTestId("peer-cursor-avatar");
    fireEvent.error(avatar);

    // The image is gone; the chip with Carol's initial replaces it.
    expect(screen.queryByTestId("peer-cursor-avatar")).toBeNull();
    expect(screen.getByTestId("peer-cursor-initial").textContent).toBe("C");
    // The name pill still shows the name.
    expect(screen.getByText("Carol")).toBeTruthy();
  });

  it("retries the image when a peer's picture URL changes after a failure", () => {
    const withPicture = (url: string) =>
      new Map<ClientId, PresenceState>([
        [5, makePeer(5, { display_name: "Carol", picture_url: url })],
      ]);
    const { rerender } = renderPeers(withPicture("https://example.com/gone.png"));
    fireEvent.error(screen.getByTestId("peer-cursor-avatar"));
    expect(screen.queryByTestId("peer-cursor-avatar")).toBeNull();

    rerender(peersElement(withPicture("https://example.com/new.png")));

    const avatar = screen.getByTestId("peer-cursor-avatar") as HTMLImageElement;
    expect(avatar.getAttribute("src")).toBe("https://example.com/new.png");
    expect(screen.queryByTestId("peer-cursor-initial")).toBeNull();
  });

  it("falls back to the numeric id (and a '?' chip) for a peer with no identity", () => {
    const peers = new Map<ClientId, PresenceState>([[42, makePeer(42)]]);
    renderPeers(peers);

    // No crash; the historic numeric-id label is used.
    expect(screen.getByTestId("peer-cursor-name").textContent).toBe("42");
    expect(screen.getByTestId("peer-cursor-initial").textContent).toBe("?");
    expect(screen.queryByTestId("peer-cursor-avatar")).toBeNull();
  });

  it("uses the server-sent initial when the display name is blank", () => {
    // #540 privacy: the raw email is no longer on the wire — the server
    // precomputes a single-char `initial` (from display-name-or-email
    // server-side), and the chip falls back to it when the name is blank.
    const peers = new Map<ClientId, PresenceState>([
      [9, makePeer(9, { display_name: "   ", initial: "Z" })],
    ]);
    renderPeers(peers);

    // Blank name → label falls back to the numeric id…
    expect(screen.getByTestId("peer-cursor-name").textContent).toBe("9");
    // …and the chip initial comes from the server-precomputed glyph.
    expect(screen.getByTestId("peer-cursor-initial").textContent).toBe("Z");
  });

  it("does not render the local user's own cursor", () => {
    const peers = new Map<ClientId, PresenceState>([
      [0, makePeer(0, { display_name: "Me" })],
      [1, makePeer(1, { display_name: "Other" })],
    ]);
    renderPeers(peers);

    // myId is 0 → only the peer (id 1) renders.
    expect(screen.queryByText("Me")).toBeNull();
    expect(screen.getByText("Other")).toBeTruthy();
  });
});
