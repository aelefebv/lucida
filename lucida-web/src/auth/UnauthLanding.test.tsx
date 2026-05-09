// @vitest-environment happy-dom
//
// Tests for the slice-4 UnauthLanding component (issue #460).
// The component bounces an unauthed SPA-mounted tree to /auth/start
// with the captured `pathname + search` and (de-leading-`#`) hash.

import { describe, it, expect, vi, afterEach } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { UnauthLanding, buildSignInUrl } from "./UnauthLanding.tsx";

afterEach(cleanup);

describe("buildSignInUrl", () => {
  it("encodes pathname+search and hash separately", () => {
    const url = buildSignInUrl({
      pathname: "/dataset/foo",
      search: "?layout=grid",
      hash: "#view=encoded-blob",
    });
    expect(url).toContain("/auth/start?");
    // pathname+search live in the path param, URL-encoded
    expect(url).toContain("path=%2Fdataset%2Ffoo%3Flayout%3Dgrid");
    // hash is the bare value (leading '#' stripped) so the server
    // reattaches exactly one '#' on the redirect target
    expect(url).toContain("hash=view%3Dencoded-blob");
    // never include the leading '#'
    expect(url).not.toContain("hash=%23");
  });

  it("treats empty path as '/'", () => {
    const url = buildSignInUrl({ pathname: "", search: "", hash: "" });
    expect(url).toContain("path=%2F");
    expect(url).toContain("hash=");
  });

  it("handles a hash without the leading marker", () => {
    const url = buildSignInUrl({ pathname: "/", search: "", hash: "b=42" });
    expect(url).toContain("hash=b%3D42");
  });
});

describe("UnauthLanding", () => {
  it("invokes navigate exactly once with the built URL", async () => {
    const navigate = vi.fn();
    await act(async () => {
      render(
        <UnauthLanding
          navigate={navigate}
          location={{ pathname: "/x", search: "", hash: "#h=1" }}
        />,
      );
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = navigate.mock.calls[0][0] as string;
    expect(url).toContain("/auth/start?path=%2Fx&hash=h%3D1");
  });

  it("renders a small status string for the brief render-then-redirect window", async () => {
    const navigate = vi.fn();
    let container: HTMLElement = document.createElement("div");
    await act(async () => {
      const r = render(
        <UnauthLanding
          navigate={navigate}
          location={{ pathname: "/", search: "", hash: "" }}
        />,
      );
      container = r.container;
    });
    expect(container.textContent).toMatch(/Redirecting/i);
  });

  it("renders the signed-out card and skips auto-bounce when signedOut is true", async () => {
    const navigate = vi.fn();
    await act(async () => {
      render(
        <UnauthLanding
          navigate={navigate}
          location={{ pathname: "/x", search: "", hash: "#h=1" }}
          signedOut
        />,
      );
    });
    // Crucially, no automatic navigation — the user has to click.
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: /Signed out/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Sign in again/i })).toBeTruthy();
  });

  it("signed-out card's button initiates the sign-in bounce on click", async () => {
    const navigate = vi.fn();
    await act(async () => {
      render(
        <UnauthLanding
          navigate={navigate}
          location={{ pathname: "/x", search: "", hash: "#h=1" }}
          signedOut
        />,
      );
    });
    await act(async () => {
      screen.getByRole("button", { name: /Sign in again/i }).click();
    });
    expect(navigate).toHaveBeenCalledTimes(1);
    const url = navigate.mock.calls[0][0] as string;
    expect(url).toContain("/auth/start?path=%2Fx&hash=h%3D1");
  });
});
