// @vitest-environment happy-dom
//
// Component test for ProfileMenu. Mocks the `useAuthSession` hook so
// we can drive the principal + signOut from the test without standing
// up the whole AuthGate provider tree (and the whoami fetch on mount
// that comes with it).

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ProfileMenu } from "./ProfileMenu.tsx";
import type { AuthPrincipal } from "./types.ts";

const PRINCIPAL: AuthPrincipal = {
  email: "dev@local",
  display_name: "Local Dev",
  picture_url: null,
  is_admin: true,
};

let session: { principal: AuthPrincipal; signOut: () => Promise<void> } = {
  principal: PRINCIPAL,
  signOut: async () => {},
};

vi.mock("./AuthSession.ts", () => ({
  useAuthSession: () => session,
}));

afterEach(() => {
  cleanup();
  session = { principal: PRINCIPAL, signOut: async () => {} };
});

describe("ProfileMenu", () => {
  it("renders the display name on the trigger button", () => {
    render(<ProfileMenu />);
    const triggers = screen.getAllByText("Local Dev");
    expect(triggers.length).toBeGreaterThanOrEqual(1);
  });

  it("falls back to first-letter avatar when picture_url is null", () => {
    render(<ProfileMenu />);
    expect(screen.getByText("L")).toBeTruthy();
  });

  it("opens the dropdown and shows email + Sign out when the trigger is clicked", () => {
    render(<ProfileMenu />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    expect(screen.getByText("dev@local")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeTruthy();
  });

  it("calls signOut when Sign out is clicked", async () => {
    const signOut = vi.fn(async () => {});
    session = { principal: PRINCIPAL, signOut };
    render(<ProfileMenu />);

    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));
    });

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("disables Sign out while the call is in flight", async () => {
    let resolveSignOut!: () => void;
    const signOut = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSignOut = resolve;
        }),
    );
    session = { principal: PRINCIPAL, signOut };
    render(<ProfileMenu />);

    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));
    });

    const pending = screen.getByRole("menuitem", { name: /signing out/i }) as HTMLButtonElement;
    expect(pending.disabled).toBe(true);

    await act(async () => {
      resolveSignOut();
    });
  });

  it("renders an <img> avatar when picture_url is set", () => {
    session = {
      principal: { ...PRINCIPAL, picture_url: "https://example.com/me.png" },
      signOut: async () => {},
    };
    const { container } = render(<ProfileMenu />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://example.com/me.png");
  });
});
