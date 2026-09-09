// @vitest-environment happy-dom

/**
 * The watch stream's visible action (#1068).
 *
 * Two promises to keep, and both are about what somebody can see: nothing
 * streams until this is pressed, and while it is streaming the control says
 * so. The stream's own behaviour is `watchStream.test.ts`; this is about the
 * control over a real one.
 */

import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { WatchStream } from "../trace/watchStream.ts";
import { WatchStreamBanner, WatchToggle } from "./WatchToggle.tsx";

afterEach(cleanup);

function connected() {
  const stream = new WatchStream();
  stream.attach({ send: () => {} });
  return stream;
}

const toggle = () => screen.getByTestId("monitor-watch-toggle") as HTMLButtonElement;
const status = () => screen.getByTestId("monitor-watch-status").textContent ?? "";

describe("the watch toggle", () => {
  it("offers to start and says the stream is off", () => {
    render(<WatchToggle stream={connected()} />);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(toggle().disabled).toBe(false);
    expect(status()).toMatch(/^Off\./);
  });

  it("shows the stream while it is on, and what it is sending", () => {
    render(<WatchToggle stream={connected()} />);
    fireEvent.click(toggle());

    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(toggle().textContent).toMatch(/stop/i);
    expect(status()).toMatch(/streaming/i);
    expect(status()).toMatch(/no chunk records leave the page/i);
  });

  it("turns the stream off again", () => {
    const stream = connected();
    render(<WatchToggle stream={stream} />);
    fireEvent.click(toggle());
    fireEvent.click(toggle());

    expect(stream.on).toBe(false);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
  });

  it("goes back to off when the connection is replaced", () => {
    const stream = connected();
    render(<WatchToggle stream={stream} />);
    fireEvent.click(toggle());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");

    act(() => {
      stream.detach();
      stream.attach({ send: () => {} });
    });

    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(status()).toMatch(/^Off\./);
  });

  it("does not offer to start with no session connection to stream over", () => {
    render(<WatchToggle stream={new WatchStream()} />);
    expect(toggle().disabled).toBe(true);
    expect(status()).toMatch(/no session connection/i);
  });
});

describe("the watch stream banner", () => {
  it("shows nothing while the stream is off", () => {
    render(<WatchStreamBanner stream={connected()} />);
    expect(screen.queryByTestId("watch-stream-banner")).toBeNull();
  });

  it("says the session is streaming, and offers to stop it from here", () => {
    const stream = connected();
    render(<WatchStreamBanner stream={stream} />);
    act(() => stream.start());

    expect(screen.getByTestId("watch-stream-banner").textContent).toMatch(/watch stream on/i);
    fireEvent.click(screen.getByTestId("watch-stream-banner-stop"));

    expect(stream.on).toBe(false);
    expect(screen.queryByTestId("watch-stream-banner")).toBeNull();
  });
});
