// @vitest-environment happy-dom
//
// Peer identity rendering. The label pill, avatar, and initial chip render from
// JSX for every peer (the RAF tick only positions them), so a null scene ref and
// a stub canvas are enough, with no WebGPU. The pill's color comes from the
// wasm module's peer palette, so the module is initialized.

import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import initWasm, { peer_palette } from "lucida-core";
import { PeerCursors, type CursorLabel } from "./PeerCursors.tsx";
import type { ClientId, PeerIdentity, PresenceState } from "../bridge.ts";

beforeAll(async () => {
  await initWasm({ module_or_path: readFileSync(resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm")) });
});

function makePeer(
  clientId: ClientId,
  identity?: PeerIdentity | null,
): PresenceState {
  return {
    client_id: clientId,
    camera: null,
    view: { z_range: { start: 0, end: 1 }, t: 0 },
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

    // No crash; the numeric-id label is used.
    expect(screen.getByTestId("peer-cursor-name").textContent).toBe("42");
    expect(screen.getByTestId("peer-cursor-initial").textContent).toBe("?");
    expect(screen.queryByTestId("peer-cursor-avatar")).toBeNull();
  });

  it("uses the server-sent initial when the display name is blank", () => {
    // The raw email never reaches the client; the server sends a one-char
    // `initial`, and the chip falls back to it when the name is blank.
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

  it("colors a peer's pill from the palette its GPU cursor is drawn in", () => {
    const palette = peer_palette();
    const id = palette.length + 3;
    renderPeers(new Map([[id, makePeer(id, { display_name: "Wrapped" })]]));
    const cursor = screen.getByText("Wrapped").closest<HTMLElement>(".lc-peer-cursor")!;
    expect(cursor.style.getPropertyValue("--peer-color")).toBe(palette[3]);
  });
});
