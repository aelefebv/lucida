// @vitest-environment happy-dom
//
// The first inbound @-mention must count live even with no dataset selected.
// `selectedDatasetId` stays null until a selection, so the resolver falls back
// to the first annotated dataset. Drives the real resolver, a real WasmScene,
// and the real <MentionsOfMe>.

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useMemo, useState } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import initWasm, { WasmScene } from "lucida-core";
import { MentionsOfMe } from "./MentionsOfMe.tsx";
import {
  currentDatasetAnnotations,
  type AnnotationScene,
} from "./currentDatasetAnnotations.ts";
import { deriveHandle } from "./annotationParticipants.ts";

beforeAll(async () => {
  // wasm-bindgen web target: init with the built .wasm bytes (cwd is lucida-web).
  const bytes = readFileSync(
    resolve(process.cwd(), "../lucida-core/pkg/lucida_core_bg.wasm"),
  );
  await initWasm({ module_or_path: bytes });
});

afterEach(() => cleanup());

const MY_ID = "author-me-stable-identity";
const MY_HANDLE = deriveHandle(MY_ID); // what a peer's @-mention of me carries.
const DATASET = "wds-1";

/** A scene with the dataset's manifest absent (the peer opened/created the pin
 * before this client opened the dataset) but a pin+comment mentioning me already
 * applied. Mirrors the inbound `add_annotation` + `add_comment` sequence. */
function sceneWithMention(): WasmScene {
  const s = new WasmScene(800, 600);
  s.load_document(JSON.stringify({ manifests: {}, annotations: {} }));
  s.apply_command(
    JSON.stringify({
      type: "add_annotation",
      dataset_id: DATASET,
      id: "pin-1",
      position: [0, 0],
      author: "peer-1",
      kind: "point",
    }),
  );
  s.apply_command(
    JSON.stringify({
      type: "add_comment",
      dataset_id: DATASET,
      annotation_id: "pin-1",
      id: "c-1",
      author: "peer-1",
      text: `great spot @${MY_HANDLE}`,
    }),
  );
  return s;
}

function badgeText(): string {
  return (
    document.querySelector('[data-testid="mentions-of-me-badge"]')?.textContent ??
    ""
  );
}

describe("#802 resolver: currentDatasetAnnotations with no dataset selected", () => {
  it("returns the annotated dataset's pins when selectedDatasetId is null", () => {
    const scene = sceneWithMention();
    // Sanity: the scene really has the annotation, just no manifest/selection.
    expect(JSON.parse((scene as AnnotationScene).annotation_dataset_ids())).toEqual([
      DATASET,
    ]);

    const resolved = currentDatasetAnnotations(scene as AnnotationScene, null);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].comments?.[0]?.text).toContain(`@${MY_HANDLE}`);
  });

  it("a truthy selectedDatasetId still wins (scoped, unchanged behavior)", () => {
    const scene = sceneWithMention();
    // Selecting a different, empty dataset shows that dataset's annotations.
    expect(currentDatasetAnnotations(scene as AnnotationScene, "other-ds")).toEqual(
      [],
    );
    expect(currentDatasetAnnotations(scene as AnnotationScene, DATASET)).toHaveLength(
      1,
    );
  });

  it("no scene / no annotations degrades to [] (no false count)", () => {
    expect(currentDatasetAnnotations(null, null)).toEqual([]);
    const empty = new WasmScene(800, 600);
    empty.load_document(JSON.stringify({ manifests: {}, annotations: {} }));
    expect(currentDatasetAnnotations(empty as AnnotationScene, null)).toEqual([]);
  });
});

describe("#802 badge: MentionsOfMe reflects a first mention with no selection", () => {
  it("shows the first mention's count even when selectedDatasetId is null", () => {
    const scene = sceneWithMention();
    const annotations = currentDatasetAnnotations(scene as AnnotationScene, null);

    render(
      <MentionsOfMe
        annotations={annotations}
        currentUserId={MY_ID}
        currentUserEmail="me@example.com"
        members={[]}
        onNavigate={() => {}}
      />,
    );
    expect(badgeText()).toContain("1");
  });

  it("updates LIVE on the first mention via a document-version bump (no refresh)", () => {
    // Mirrors App: a version counter bumped per inbound command, annotations
    // resolved with no dataset selected.
    const scene = new WasmScene(800, 600);
    scene.load_document(JSON.stringify({ manifests: {}, annotations: {} }));

    function Harness() {
      const [version, setVersion] = useState(0);
      // App bumps this from the session controller's onCommand handler.
      bumpRef.current = () => setVersion((v) => v + 1);
      const annotations = useMemo(
        () => currentDatasetAnnotations(scene as AnnotationScene, null),
        // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the doc tick (mirrors App's currentAnnotations deps).
        [version],
      );
      return (
        <MentionsOfMe
          annotations={annotations}
          currentUserId={MY_ID}
          currentUserEmail="me@example.com"
          members={[]}
          onNavigate={() => {}}
        />
      );
    }
    const bumpRef: { current: (() => void) | null } = { current: null };

    render(<Harness />);
    expect(badgeText()).toContain("0"); // nothing yet

    // A peer creates a pin, then the first mention, with no dataset selected.
    act(() => {
      scene.apply_command(
        JSON.stringify({
          type: "add_annotation",
          dataset_id: DATASET,
          id: "pin-1",
          position: [0, 0],
          author: "peer-1",
          kind: "point",
        }),
      );
      bumpRef.current!();
    });
    act(() => {
      scene.apply_command(
        JSON.stringify({
          type: "add_comment",
          dataset_id: DATASET,
          annotation_id: "pin-1",
          id: "c-1",
          author: "peer-1",
          text: `ping @${MY_HANDLE}`,
        }),
      );
      bumpRef.current!();
    });

    expect(badgeText()).toContain("1");

    // A later mention also updates live.
    act(() => {
      scene.apply_command(
        JSON.stringify({
          type: "add_comment",
          dataset_id: DATASET,
          annotation_id: "pin-1",
          id: "c-2",
          author: "peer-1",
          text: `again @${MY_HANDLE}`,
        }),
      );
      bumpRef.current!();
    });
    expect(badgeText()).toContain("2");
  });
});
