import { describe, expect, it } from "vitest";

import { InteractionModel } from "../src/interaction-model";

describe("interaction model", () => {
  it("supports pan/zoom gesture transactions and emits commands", () => {
    const model = new InteractionModel("sess_00000001", "cli_00000001", {
      centerX: 100,
      centerY: 200,
      zoom: 1,
      zIndex: 0,
      tIndex: 0,
      selectedChannels: [0],
    });
    model.beginGesture("gesture-1");
    model.pan(10, -20);
    model.zoom(2, 300, 400);
    model.endGesture();

    expect(model.state().centerX).toBe(110);
    expect(model.state().centerY).toBe(180);
    expect(model.state().zoom).toBe(2);

    const commands = model.drainCommands();
    expect(commands).toHaveLength(2);
    expect(commands[0]?.op).toBe("view.pan");
    expect(commands[1]?.op).toBe("view.zoom");
  });

  it("supports z/t/channel updates as canonical view commands", () => {
    const model = new InteractionModel("sess_00000001", "cli_00000001", {
      centerX: 0,
      centerY: 0,
      zoom: 1,
      zIndex: 0,
      tIndex: 0,
      selectedChannels: [0],
    });
    model.setZ(3);
    model.setT(5);
    model.setChannels([1, 2]);

    const commands = model.drainCommands();
    expect(commands.map((command) => command.op)).toEqual([
      "view.set_z",
      "view.set_t",
      "view.set_channels",
    ]);
    expect(model.state().selectedChannels).toEqual([1, 2]);
  });

  it("reconciles to authoritative updates without jitter for tiny drifts", () => {
    const model = new InteractionModel("sess_00000001", "cli_00000001", {
      centerX: 10,
      centerY: 10,
      zoom: 2,
      zIndex: 0,
      tIndex: 0,
      selectedChannels: [0],
    });
    model.reconcileAuthoritative({
      centerX: 10.0005,
      centerY: 10.0002,
      zoom: 2.0004,
      zIndex: 4,
      tIndex: 2,
      selectedChannels: [0, 1],
    });

    expect(model.state().centerX).toBe(10);
    expect(model.state().zoom).toBe(2);
    expect(model.state().zIndex).toBe(4);
    expect(model.state().selectedChannels).toEqual([0, 1]);
  });

  it("requires an active gesture for pan/zoom", () => {
    const model = new InteractionModel("sess_00000001", "cli_00000001", {
      centerX: 0,
      centerY: 0,
      zoom: 1,
      zIndex: 0,
      tIndex: 0,
      selectedChannels: [0],
    });
    expect(() => model.pan(1, 1)).toThrow("gesture must be active");
    expect(() => model.zoom(2, 0, 0)).toThrow("gesture must be active");
  });
});
