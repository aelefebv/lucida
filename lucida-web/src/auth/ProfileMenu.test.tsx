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
  is_admin: false,
};

let session: {
  principal: AuthPrincipal;
  refresh: () => Promise<void>;
  signOut: (() => Promise<void>) | null;
} = {
  principal: PRINCIPAL,
  refresh: async () => {},
  signOut: async () => {},
};

const fetchDevAuthStatus = vi.fn(async () => ({
  enabled: false,
  default_principal: PRINCIPAL,
}));
const postDevLogin = vi.fn(async (_body: unknown) => PRINCIPAL);

vi.mock("./AuthSession.ts", () => ({
  useAuthSession: () => session,
}));

vi.mock("./whoami.ts", () => ({
  fetchDevAuthStatus: () => fetchDevAuthStatus(),
  postDevLogin: (body: unknown) => postDevLogin(body),
}));

afterEach(() => {
  cleanup();
  session = { principal: PRINCIPAL, refresh: async () => {}, signOut: async () => {} };
  fetchDevAuthStatus.mockClear();
  fetchDevAuthStatus.mockResolvedValue({
    enabled: false,
    default_principal: PRINCIPAL,
  });
  postDevLogin.mockClear();
  postDevLogin.mockResolvedValue(PRINCIPAL);
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
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut };
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
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut };
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

  it("leaves Sign out out of the menu when the mode declares no sign-out URL", () => {
    // Absent, not present-and-inert.
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut: null };
    render(<ProfileMenu />);
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));

    expect(screen.getByText("dev@local")).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /sign out/i })).toBeNull();
  });

  it("renders an <img> avatar when picture_url is set", () => {
    session = {
      principal: { ...PRINCIPAL, picture_url: "https://example.com/me.png" },
      refresh: async () => {},
      signOut: async () => {},
    };
    const { container } = render(<ProfileMenu />);
    const img = container.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://example.com/me.png");
  });

  it("falls back to the initial when the picture fails to load", () => {
    session = {
      principal: { ...PRINCIPAL, picture_url: "https://example.com/gone.png" },
      refresh: async () => {},
      signOut: async () => {},
    };
    const { container } = render(<ProfileMenu />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);

    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("L")).toBeTruthy();
  });

  it("retries the image when the picture URL changes after a failure", () => {
    session = {
      principal: { ...PRINCIPAL, picture_url: "https://example.com/gone.png" },
      refresh: async () => {},
      signOut: async () => {},
    };
    const { container, rerender } = render(<ProfileMenu />);
    fireEvent.error(container.querySelector("img") as HTMLImageElement);
    expect(container.querySelector("img")).toBeNull();

    session = {
      ...session,
      principal: { ...PRINCIPAL, picture_url: "https://example.com/new.png" },
    };
    rerender(<ProfileMenu />);

    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      "https://example.com/new.png",
    );
  });

  it("switches the local dev user when dev auth is enabled", async () => {
    fetchDevAuthStatus.mockResolvedValueOnce({
      enabled: true,
      default_principal: PRINCIPAL,
    });
    const refresh = vi.fn(async () => {});
    session = { principal: PRINCIPAL, refresh, signOut: async () => {} };

    await act(async () => {
      render(<ProfileMenu />);
    });
    fireEvent.click(screen.getByRole("button", { name: /account menu/i }));
    fireEvent.change(screen.getByLabelText(/dev user email/i), {
      target: { value: "viewer@example.com" },
    });
    fireEvent.change(screen.getByLabelText(/dev display name/i), {
      target: { value: "Viewer" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /switch dev user/i }));
    });

    expect(postDevLogin).toHaveBeenCalledWith({
      email: "viewer@example.com",
      display_name: "Viewer",
      is_admin: false,
    });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
