/**
 * Run one message at a time, in arrival order.
 *
 * A bare `onmessage` starts the next handler while an `async` one is
 * suspended, so the second can finish first. The main thread's recorder
 * stamps a chunk resident when it posts the render behind it, which assumes
 * the worker writes every earlier chunk before it draws. The frame handlers
 * await their pipelines, so that order needs this queue.
 *
 * A message that throws is handed to `onError`, and the ones behind it still run.
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
