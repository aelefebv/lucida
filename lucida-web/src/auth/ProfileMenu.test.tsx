// @vitest-environment happy-dom
//
// Component test for ProfileMenu. Mocks the `useAuthSession` hook so
// we can drive the principal + signOut from the test without standing
// up the whole AuthGate provider tree (and the whoami fetch on mount
// that comes with it).

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileMenu, ProfilePanel } from "./ProfileMenu.tsx";
import type { AuthPrincipal } from "./types.ts";
import { restoreLastViewPreference } from "../lastViewPreference.ts";
import { __resetPreferencesForTesting, getPreference } from "../theme/preferences.ts";

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

beforeEach(() => {
  localStorage.clear();
  __resetPreferencesForTesting();
});

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

const trigger = () => screen.getByRole("button", { name: /account menu/i });

describe("ProfileMenu", () => {
  it("names the person on the trigger button", () => {
    render(<ProfileMenu />);
    expect(trigger().getAttribute("title")).toBe("Local Dev");
  });

  it("falls back to initials when picture_url is null", () => {
    render(<ProfileMenu />);
    expect(screen.getByText("LD")).toBeTruthy();
  });

  it("opens, moves, and closes from the keyboard, returning focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<ProfileMenu />);
    trigger().focus();

    await user.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu");
    const restore = screen.getByRole("menuitemcheckbox", { name: /restore my last view/i });
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    // A browser focuses the first item as the menu opens; happy-dom never
    // moves focus into it, so start there by hand.
    act(() => restore.focus());

    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(signOut);
    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(restore);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(menu.isConnected).toBe(false));
    expect(document.activeElement).toBe(trigger());
  });

  it("opens the menu and shows who is signed in and Sign out when the trigger is clicked", async () => {
    const user = userEvent.setup();
    render(<ProfileMenu />);
    await user.click(trigger());
    expect(screen.getByText("dev@local")).toBeTruthy();
    // The identity names the section that holds the setting.
    expect(screen.getByRole("group", { name: /local dev/i })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /sign out/i })).toBeTruthy();
  });

  it("toggles Restore my last view in place, leaving the menu open", async () => {
    const user = userEvent.setup();
    render(<ProfileMenu />);
    await user.click(trigger());
    const restore = screen.getByRole("menuitemcheckbox", { name: /restore my last view/i });
    expect(restore.getAttribute("aria-checked")).toBe("true");

    await user.click(restore);

    expect(getPreference(restoreLastViewPreference)).toBe(false);
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(restore.getAttribute("aria-checked")).toBe("false");
  });

  it("calls signOut when Sign out is chosen", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn(async () => {});
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut };
    render(<ProfileMenu />);

    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: /sign out/i }));

    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("disables Sign out while the call is in flight", async () => {
    const user = userEvent.setup();
    let resolveSignOut!: () => void;
    const signOut = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSignOut = resolve;
        }),
    );
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut };
    render(<ProfileMenu />);

    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: /sign out/i }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    await user.click(trigger());
    const pending = screen.getByRole("menuitem", { name: /signing out/i });
    expect(pending.getAttribute("aria-disabled")).toBe("true");

    await act(async () => {
      resolveSignOut();
    });
  });

  it("leaves Sign out out of the menu when the mode declares no sign-out URL", async () => {
    // Absent, not present-and-inert.
    const user = userEvent.setup();
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut: null };
    render(<ProfileMenu />);
    await user.click(trigger());

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
    expect(screen.getByText("LD")).toBeTruthy();
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

  it("switches the local dev user from a dialog when dev auth is enabled", async () => {
    const user = userEvent.setup();
    fetchDevAuthStatus.mockResolvedValueOnce({
      enabled: true,
      default_principal: PRINCIPAL,
    });
    const refresh = vi.fn(async () => {});
    session = { principal: PRINCIPAL, refresh, signOut: async () => {} };

    await act(async () => {
      render(<ProfileMenu />);
    });
    await user.click(trigger());
    await user.click(screen.getByRole("menuitem", { name: /switch dev user/i }));
    const dialog = await screen.findByRole("dialog", { name: /switch dev user/i });
    // Admin comes from the server's configuration, so the switch offers none.
    expect(dialog.textContent).not.toMatch(/admin/i);

    const email = screen.getByRole("textbox", { name: "Email" });
    await user.clear(email);
    await user.type(email, "viewer@example.com");
    const name = screen.getByRole("textbox", { name: "Display name" });
    await user.clear(name);
    await user.type(name, "Viewer");

    await user.click(screen.getByRole("button", { name: /switch dev user/i }));

    expect(postDevLogin).toHaveBeenCalledWith({
      email: "viewer@example.com",
      display_name: "Viewer",
    });
    expect(refresh).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("ProfilePanel", () => {
  it("holds the same setting and Sign out, laid out for a dialog", async () => {
    const user = userEvent.setup();
    const signOut = vi.fn(async () => {});
    const onDone = vi.fn();
    session = { principal: PRINCIPAL, refresh: async () => {}, signOut };
    render(<ProfilePanel devAuthEnabled={false} onDone={onDone} />);

    expect(screen.getByText("dev@local")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: /restore my last view/i }));
    expect(getPreference(restoreLastViewPreference)).toBe(false);

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});
