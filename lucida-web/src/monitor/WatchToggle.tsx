/**
 * The watch stream's visible face (#1068): the action that turns it on, and
 * the notice that says it is on.
 *
 * Both live here because "off by default and visible while on" is one
 * promise. Nothing leaves the page unless somebody presses {@link
 * WatchToggle}, and while the stream is publishing {@link WatchStreamBanner}
 * says so from wherever the person is — the toggle sits on the monitor, and
 * the stream keeps going after they leave it.
 *
 * Neither owns the toggle. The stream is a per-session object with the socket
 * and the recorder behind it; these subscribe and reflect, and offer nothing
 * while there is no connection to publish over.
 */

import { useCallback, useSyncExternalStore } from "react";

import "./WatchToggle.css";
import { watchStream, type WatchStream, type WatchStreamState } from "../trace/watchStream.ts";

function useWatchStream(stream: WatchStream): WatchStreamState {
  const subscribe = useCallback((onChange: () => void) => stream.subscribe(onChange), [stream]);
  return useSyncExternalStore(subscribe, () => stream.state);
}

export function WatchToggle({ stream = watchStream }: { stream?: WatchStream }) {
  const state = useWatchStream(stream);
  return (
    <span className={state.on ? "monitor-watch monitor-watch-on" : "monitor-watch"}>
      <button
        type="button"
        aria-pressed={state.on}
        disabled={!state.on && !state.attached}
        onClick={() => (state.on ? stream.stop() : stream.start())}
        data-testid="monitor-watch-toggle"
      >
        {state.on ? "Stop the watch stream" : "Start a watch stream"}
      </button>
      <span role="status" className="monitor-watch-status" data-testid="monitor-watch-status">
        {watchStatus(state.on, state.attached)}
      </span>
    </span>
  );
}

/**
 * What a session that is streaming looks like from anywhere in the app.
 *
 * Mounted beside the routes rather than inside one, because the stream is per
 * session and outlives whichever surface started it. It renders nothing while
 * the stream is off, so a session that nobody is watching pays no pixels.
 */
export function WatchStreamBanner({ stream = watchStream }: { stream?: WatchStream }) {
  const state = useWatchStream(stream);
  if (!state.on) return null;
  return (
    <div className="watch-stream-banner" role="status" data-testid="watch-stream-banner">
      <span>Watch stream on. This session&rsquo;s aggregates are going to watchers.</span>
      <button type="button" onClick={() => stream.stop()} data-testid="watch-stream-banner-stop">
        Stop
      </button>
    </div>
  );
}

function watchStatus(on: boolean, attached: boolean): string {
  if (on) {
    return "Streaming this session's per-tick aggregates and run boundaries to watchers. No chunk records leave the page.";
  }
  return attached
    ? "Off. Turning it on streams this session's aggregates over the session socket until you stop it or the connection drops."
    : "Off. There is no session connection to stream over.";
}
