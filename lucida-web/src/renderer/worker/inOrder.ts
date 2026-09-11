/**
 * Run one message at a time, in arrival order.
 *
 * A bare `onmessage` starts the next handler while an `async` one is
 * suspended, so two can be live at once and the second can finish first.
 * The main thread's recorder assumes the opposite. It stamps a chunk
 * resident when it posts the render behind it, because the worker writes
 * every chunk posted before a render before it draws that render. Every
 * handler was synchronous until the frame handlers began to await their
 * pipelines (#1101), so the order held on its own before that.
 *
 * `inOrder` runs each message only after the one before it settled, whether
 * it returned, awaited, or threw. A message that throws is handed to
 * `onError`, and the ones behind it still run.
 */
export function inOrder<T>(
  handle: (msg: T) => Promise<void> | void,
  onError: (err: unknown) => void = () => {},
): (msg: T) => void {
  let tail: Promise<void> = Promise.resolve();
  return (msg: T) => {
    tail = tail.then(() => handle(msg)).catch(onError);
  };
}
