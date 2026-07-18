import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { chromium } from "playwright";

const baseUrl = process.env.LUCIDA_BASE_URL ?? "http://127.0.0.1:5173";
const fixture = process.env.LUCIDA_FIXTURE;
const executablePath = process.env.LUCIDA_BROWSER;
const evidencePath = resolve(
  process.env.LUCIDA_EVIDENCE ?? "/tmp/lucida-viewport-coordinator-two-client.json",
);
const timeoutMs = Number(process.env.LUCIDA_BROWSER_TIMEOUT_MS ?? 150_000);
const savedViewName = `Viewport coordinator proof ${Date.now()}`;

if (!fixture) {
  throw new Error("LUCIDA_FIXTURE must name a server-visible OME-Zarr dataset");
}
if (!executablePath) {
  throw new Error("LUCIDA_BROWSER must name the system Chrome/Chromium executable");
}

function parseFrame(payload) {
  try {
    const text = typeof payload === "string" ? payload : payload.toString("utf8");
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function camerasEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function requireProof(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForRenderedDataset(page) {
  await page.waitForFunction(
    () => {
      const state = window.__lucidaCaptureReady;
      return Boolean(
        state?.ready
        && state.frameCount > 0
        && state.datasetCount > 0
        && state.canvasWidth > 0
        && state.canvasHeight > 0,
      );
    },
    undefined,
    { timeout: timeoutMs },
  );
}

async function decodeCurrentView(page) {
  return page.evaluate(async () => {
    const hash = window.location.hash;
    if (!hash.startsWith("#view=")) {
      throw new Error(`Expected an inline saved-view URL, received ${hash || "an empty hash"}`);
    }
    const { decode } = await import("/src/savedView/encoder.ts");
    return decode(hash.slice("#view=".length));
  });
}

function watchPage(page, label, frames, messages) {
  page.on("console", async (message) => {
    const args = [];
    for (const argument of message.args()) {
      try {
        args.push(await argument.jsonValue());
      } catch {
        args.push("<unserializable>");
      }
    }
    messages.push({
      label,
      kind: `console:${message.type()}`,
      text: message.text(),
      location: message.location(),
      args,
    });
  });
  page.on("pageerror", (error) => {
    messages.push({ label, kind: "pageerror", text: error.message });
  });
  page.on("requestfailed", (request) => {
    messages.push({
      label,
      kind: "requestfailed",
      text: `${request.url()} ${request.failure()?.errorText ?? "unknown failure"}`,
    });
  });
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const value = parseFrame(payload);
      if (value) frames.sent.push({ at: Date.now(), value });
    });
    socket.on("framereceived", ({ payload }) => {
      const value = parseFrame(payload);
      if (value) frames.received.push({ at: Date.now(), value });
    });
  });
}

async function captureFailurePage(page, label, screenshotPath) {
  if (!page || page.isClosed()) return { label, available: false };
  const state = {
    label,
    available: true,
    url: page.url(),
    screenshot: null,
  };
  try {
    Object.assign(state, await page.evaluate(() => {
      const visible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== "none"
          && style.visibility !== "hidden"
          && rect.width > 0
          && rect.height > 0;
      };
      const canvas = document.querySelector("canvas[aria-label$='viewer']");
      return {
        title: document.title,
        readyState: document.readyState,
        captureReady: window.__lucidaCaptureReady ?? null,
        canvas: canvas
          ? {
              width: canvas.width,
              height: canvas.height,
              clientWidth: canvas.clientWidth,
              clientHeight: canvas.clientHeight,
            }
          : null,
        visibleAlerts: [...document.querySelectorAll("[role='alert'], [role='status']")]
          .filter(visible)
          .map((element) => element.textContent?.trim() ?? "")
          .filter(Boolean),
        bodyText: (document.body?.innerText ?? "").slice(0, 6_000),
      };
    }));
  } catch (error) {
    state.inspectError = error instanceof Error ? error.message : String(error);
  }
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
    state.screenshot = screenshotPath;
  } catch (error) {
    state.screenshotError = error instanceof Error ? error.message : String(error);
  }
  return state;
}

const messages = [];
const framesA = { sent: [], received: [] };
const framesB = { sent: [], received: [] };
let browser;
let pageA;
let pageB;
let stage = "initialize";
const screenshotBase = evidencePath.replace(/\.json$/i, "");
let evidence = {
  passed: false,
  baseUrl,
  fixture,
  evidencePath,
  savedViewName,
};

try {
  await mkdir(dirname(evidencePath), { recursive: true });
  stage = "launch_browser";
  browser = await chromium.launch({
    headless: true,
    executablePath,
    args: [
      "--enable-unsafe-webgpu",
      "--ignore-gpu-blocklist",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  stage = "create_clients";
  const contextOptions = {
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
  };
  const contextA = await browser.newContext(contextOptions);
  const contextB = await browser.newContext(contextOptions);
  await contextA.addInitScript(() => {
    window.__lucidaViewportProofHistory = [];
    const original = window.history.replaceState.bind(window.history);
    window.history.replaceState = (...args) => {
      window.__lucidaViewportProofHistory.push({
        at: performance.now(),
        url: args[2] == null ? null : String(args[2]),
      });
      return original(...args);
    };
  });

  pageA = await contextA.newPage();
  pageB = await contextB.newPage();
  watchPage(pageA, "client-a", framesA, messages);
  watchPage(pageB, "client-b", framesB, messages);

  stage = "open_dashboard";
  await pageA.goto(baseUrl, { waitUntil: "load", timeout: timeoutMs });
  stage = "create_workspace";
  const createInput = pageA.getByLabel("New workspace from dataset URL or path");
  await createInput.waitFor({ state: "visible", timeout: timeoutMs });
  await createInput.fill(fixture);
  await pageA.getByRole("button", { name: "Create from URL", exact: true }).click();
  await pageA.waitForURL((url) => url.pathname.startsWith("/w/"), { timeout: timeoutMs });
  stage = "wait_client_a_render";
  await waitForRenderedDataset(pageA);

  stage = "open_client_b";
  const workspaceUrl = new URL(pageA.url());
  workspaceUrl.hash = "";
  await pageB.goto(workspaceUrl.href, { waitUntil: "load", timeout: timeoutMs });
  stage = "wait_client_b_render";
  await waitForRenderedDataset(pageB);
  stage = "wait_for_peers";
  await pageA.getByText(/Peers \(1\):/).waitFor({ state: "visible", timeout: timeoutMs });
  await pageB.getByText(/Peers \(1\):/).waitFor({ state: "visible", timeout: timeoutMs });

  const dpr = await Promise.all([
    pageA.evaluate(() => window.devicePixelRatio),
    pageB.evaluate(() => window.devicePixelRatio),
  ]);
  requireProof(dpr.every((value) => value === 2), `Both clients must run at DPR2; received ${dpr}`);

  stage = "create_annotation";
  const canvasA = pageA.locator("canvas[aria-label$='viewer']").first();
  const canvasBox = await canvasA.boundingBox();
  requireProof(canvasBox !== null, "Client A viewer canvas has no layout box");
  const pinPoint = {
    x: canvasBox.x + canvasBox.width * 0.45,
    y: canvasBox.y + canvasBox.height * 0.45,
  };
  await pageA.keyboard.down("Shift");
  await pageA.mouse.click(pinPoint.x, pinPoint.y);
  await pageA.keyboard.up("Shift");

  const markerSelector = "[data-testid^='annot-pin-']:not([data-testid*='wrapper'])";
  const markerA = pageA.locator(markerSelector).first();
  await markerA.waitFor({ state: "visible", timeout: timeoutMs });
  await pageB.locator(markerSelector).first().waitFor({ state: "visible", timeout: timeoutMs });

  stage = "save_and_open_view";
  await pageA.getByRole("button", { name: "Save view", exact: true }).click();
  await pageA.getByTestId("saved-view-name-input").fill(savedViewName);
  await pageA.getByTestId("saved-view-save-confirm").click();
  const savedRow = pageA.getByTestId("saved-view-row").filter({ hasText: savedViewName }).first();
  await savedRow.waitFor({ state: "visible", timeout: timeoutMs });
  await savedRow.click();
  await pageA.waitForFunction(
    (name) => [...document.querySelectorAll("[data-testid='saved-view-row']")]
      .some((row) => row.textContent?.includes(name) && row.getAttribute("aria-current") === "true"),
    savedViewName,
    { timeout: timeoutMs },
  );
  await pageA.waitForFunction(() => window.location.hash.startsWith("#view="), undefined, {
    timeout: timeoutMs,
  });

  stage = "start_following";
  await pageA.getByRole("button", { name: "Follow", exact: true }).first().click();
  await pageA.getByRole("button", { name: "Stop Following", exact: true })
    .waitFor({ state: "visible", timeout: timeoutMs });

  // Give the followed client one deliberate viewport update. Besides proving
  // that follow is live, this yields the exact remote camera A has adopted;
  // A intentionally does not churn its share URL for every followed frame.
  const canvasB = pageB.locator("canvas[aria-label$='viewer']").first();
  const canvasBBox = await canvasB.boundingBox();
  requireProof(canvasBBox !== null, "Client B viewer canvas has no layout box");
  const bStart = {
    x: canvasBBox.x + canvasBBox.width * 0.6,
    y: canvasBBox.y + canvasBBox.height * 0.6,
  };
  await pageB.mouse.move(bStart.x, bStart.y);
  await pageB.mouse.down();
  await pageB.mouse.move(bStart.x + 16, bStart.y + 8);
  await pageB.mouse.up();
  await pageA.waitForFunction(
    () => document.body.textContent?.includes("(following)"),
    undefined,
    { timeout: timeoutMs },
  );
  const followPresenceDeadline = Date.now() + timeoutMs;
  while (
    !framesA.received.some(({ value }) => value.type === "presence_update")
    && Date.now() < followPresenceDeadline
  ) {
    await pageA.waitForTimeout(25);
  }

  // Let the saved-view restore, follow adoption, URL debounce, and transport
  // throttles settle. Evidence begins from a deliberately quiet boundary.
  await pageA.waitForTimeout(1_000);
  const beforeUrlView = await decodeCurrentView(pageA);
  // Follow deliberately does not rewrite A's share URL for every remote frame.
  // The live camera A has adopted is therefore B's latest presence, not the
  // (intentionally stale while following) camera encoded in A's URL.
  const followedPresence = framesA.received.findLast(
    ({ value }) => value.type === "presence_update",
  );
  requireProof(followedPresence?.value.camera, "Client A never received client B's follow camera");
  const beforeCamera = followedPresence.value.camera;
  const beforeFrame = await pageA.evaluate(() => window.__lucidaCaptureReady.frameCount);
  framesA.sent.length = 0;
  framesA.received.length = 0;
  framesB.sent.length = 0;
  framesB.received.length = 0;
  await pageA.evaluate(() => { window.__lucidaViewportProofHistory.length = 0; });

  stage = "pan_annotation";
  const markerBox = await markerA.boundingBox();
  requireProof(markerBox !== null, "Annotation marker has no layout box");
  const startX = markerBox.x + markerBox.width / 2;
  const startY = markerBox.y + markerBox.height / 2;
  const cssDeltaX = 32;
  await markerA.dispatchEvent("pointerdown", {
    pointerId: 41,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: startX,
    clientY: startY,
  });
  await markerA.dispatchEvent("pointermove", {
    pointerId: 41,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 1,
    clientX: startX + cssDeltaX,
    clientY: startY,
  });
  await markerA.dispatchEvent("pointerup", {
    pointerId: 41,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: 0,
    clientX: startX + cssDeltaX,
    clientY: startY,
  });

  await pageA.getByRole("button", { name: "Stop Following", exact: true })
    .waitFor({ state: "detached", timeout: timeoutMs });
  await pageA.waitForFunction(
    (name) => [...document.querySelectorAll("[data-testid='saved-view-row']")]
      .every((row) => !row.textContent?.includes(name) || row.getAttribute("aria-current") !== "true"),
    savedViewName,
    { timeout: timeoutMs },
  );
  await pageA.waitForFunction(
    (frame) => window.__lucidaCaptureReady.frameCount > frame,
    beforeFrame,
    { timeout: timeoutMs },
  );
  await pageA.waitForFunction(
    () => window.__lucidaViewportProofHistory.length > 0,
    undefined,
    { timeout: timeoutMs },
  );

  stage = "collect_exactly_once_effects";
  const relevantRemoteFrames = () => framesB.received.filter(({ value }) =>
    value.type === "presence_update" || value.type === "follow_changed");
  const remoteDeadline = Date.now() + timeoutMs;
  while (relevantRemoteFrames().length < 2 && Date.now() < remoteDeadline) {
    await pageB.waitForTimeout(25);
  }
  // Wait past every bridge/URL throttle after the first observation so a
  // duplicate trailing publication cannot arrive just after the assertion.
  await pageA.waitForTimeout(800);

  const afterView = await decodeCurrentView(pageA);
  const afterFrame = await pageA.evaluate(() => window.__lucidaCaptureReady.frameCount);
  const historyWrites = await pageA.evaluate(() => [...window.__lucidaViewportProofHistory]);
  const sentPresence = framesA.sent.filter(({ value }) => value.type === "presence");
  const sentFollowBreak = framesA.sent.filter(
    ({ value }) => value.type === "follow" && value.target === null,
  );
  const sentDatasetPresence = framesA.sent.filter(({ value }) => value.type === "dataset_presence");
  const remotePresence = framesB.received.filter(({ value }) => value.type === "presence_update");
  const remoteFollowBreak = framesB.received.filter(
    ({ value }) => value.type === "follow_changed" && value.target === null,
  );
  const relevantSendOrder = framesA.sent
    .filter(({ value }) => value.type === "follow" || value.type === "presence")
    .map(({ value }) => value.type);

  requireProof(sentFollowBreak.length === 1, `Expected one follow break, received ${sentFollowBreak.length}`);
  requireProof(sentPresence.length === 1, `Expected one presence publication, received ${sentPresence.length}`);
  requireProof(sentDatasetPresence.length === 0, `Annotation pan published ${sentDatasetPresence.length} dataset-presence frames`);
  requireProof(remotePresence.length === 1, `Peer received ${remotePresence.length} presence updates`);
  requireProof(remoteFollowBreak.length === 1, `Peer received ${remoteFollowBreak.length} follow-break updates`);
  requireProof(historyWrites.length === 1, `Expected one URL write, received ${historyWrites.length}`);
  requireProof(relevantSendOrder.join(",") === "follow,presence", `Unexpected effect order: ${relevantSendOrder}`);
  requireProof(afterFrame > beforeFrame, `Rendered frame did not advance (${beforeFrame} -> ${afterFrame})`);
  requireProof(camerasEqual(afterView.camera, sentPresence[0].value.camera), "URL camera differs from the published camera");
  requireProof(camerasEqual(afterView.camera, remotePresence[0].value.camera), "Peer camera differs from the URL camera");

  requireProof(beforeCamera.mode === "slice", "Proof requires the followed slice camera");
  requireProof(afterView.camera.mode === "slice", "Annotation pan unexpectedly changed camera mode");
  const expectedDeltaX = -(cssDeltaX * dpr[0]) / beforeCamera.zoom;
  const actualDeltaX = afterView.camera.center[0] - beforeCamera.center[0];
  const actualDeltaY = afterView.camera.center[1] - beforeCamera.center[1];
  requireProof(
    Math.abs(actualDeltaX - expectedDeltaX) < 1e-6 && Math.abs(actualDeltaY) < 1e-6,
    `Camera delta proves a missing/duplicate apply: expected [${expectedDeltaX}, 0], received [${actualDeltaX}, ${actualDeltaY}]`,
  );

  const activeAfter = await savedRow.getAttribute("aria-current");
  requireProof(activeAfter !== "true", "Active saved-view highlight survived a live annotation pan");

  stage = "capture_success";
  await pageA.screenshot({ path: `${screenshotBase}-client-a.png`, fullPage: true });
  await pageB.screenshot({ path: `${screenshotBase}-client-b.png`, fullPage: true });

  evidence = {
    ...evidence,
    passed: true,
    workspaceUrl: workspaceUrl.href,
    devicePixelRatios: dpr,
    mutation: {
      source: "annotation_pan",
      cssDelta: [cssDeltaX, 0],
      expectedCameraDelta: [expectedDeltaX, 0],
      actualCameraDelta: [actualDeltaX, actualDeltaY],
    },
    exactlyOnce: {
      followBreakFrames: sentFollowBreak.length,
      presenceFrames: sentPresence.length,
      datasetPresenceFrames: sentDatasetPresence.length,
      peerFollowBreakFrames: remoteFollowBreak.length,
      peerPresenceFrames: remotePresence.length,
      urlWrites: historyWrites.length,
      sendOrder: relevantSendOrder,
    },
    consistency: {
      urlMatchesPublishedCamera: camerasEqual(afterView.camera, sentPresence[0].value.camera),
      peerMatchesPublishedCamera: camerasEqual(afterView.camera, remotePresence[0].value.camera),
      savedViewHighlightInvalidated: activeAfter !== "true",
      frameCountBefore: beforeFrame,
      frameCountAfter: afterFrame,
    },
    urls: {
      beforeFollowUrl: beforeUrlView.camera,
      beforeLiveFollowCamera: beforeCamera,
      after: afterView.camera,
      committed: historyWrites[0]?.url ?? null,
    },
    screenshots: [`${screenshotBase}-client-a.png`, `${screenshotBase}-client-b.png`],
    messages,
  };
} catch (error) {
  const failureScreenshots = {
    clientA: `${screenshotBase}-failure-client-a.png`,
    clientB: `${screenshotBase}-failure-client-b.png`,
  };
  evidence = {
    ...evidence,
    stage,
    error: error instanceof Error ? error.stack ?? error.message : String(error),
    browserState: {
      clientA: await captureFailurePage(pageA, "client-a", failureScreenshots.clientA),
      clientB: await captureFailurePage(pageB, "client-b", failureScreenshots.clientB),
    },
    messages,
  };
  process.exitCode = 1;
} finally {
  await mkdir(dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  await browser?.close();
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
}
