import { describe, expect, it } from "vitest";
import {
  channelDisplayName,
  channelRangeKey,
  channelShortcutTarget,
  isChannelShown,
  isLastShownChannel,
  parseChannelRangeKey,
  toggleChannel,
} from "./channels.ts";

describe("channel names", () => {
  it("prefers the override, then the metadata label, then Channel n from 1", () => {
    expect(channelDisplayName(0, "Mine", "Meta")).toBe("Mine");
    expect(channelDisplayName(0, "  ", "Meta")).toBe("Meta");
    expect(channelDisplayName(2, null, "")).toBe("Channel 3");
    expect(channelDisplayName(1)).toBe("Channel 2");
  });
});

describe("channel range keys", () => {
  it("round-trip, including ids that contain colons", () => {
    expect(parseChannelRangeKey(channelRangeKey("wds:a:b", 3))).toEqual({ datasetId: "wds:a:b", channel: 3 });
    expect(parseChannelRangeKey("img-0")).toBeNull();
  });
});

describe("toggleChannel", () => {
  it("flips one channel in the composite", () => {
    expect(toggleChannel([true, true, true], null, 1)).toEqual({
      visible: [true, false, true],
      leaveSolo: false,
    });
    expect(toggleChannel([true, false, true], null, 1)).toEqual({
      visible: [true, true, true],
      leaveSolo: false,
    });
  });

  it("keeps the last visible channel on", () => {
    expect(toggleChannel([false, true, false], null, 1)).toBeNull();
    expect(isLastShownChannel([false, true, false], null, 1)).toBe(true);
    expect(isLastShownChannel([false, true, false], 1, 1)).toBe(false);
  });

  it("leaves solo with the soloed and the shown channel", () => {
    expect(toggleChannel([true, true, true], 0, 2)).toEqual({
      visible: [true, false, true],
      leaveSolo: true,
    });
  });

  it("returns to the composite, flags untouched, from the soloed channel", () => {
    expect(toggleChannel([true, false, true], 0, 0)).toEqual({
      visible: [true, false, true],
      leaveSolo: true,
    });
  });

  it("ignores a channel the layer does not have", () => {
    expect(toggleChannel([true, true], null, 5)).toBeNull();
  });

  it("reads what is on screen from solo first", () => {
    expect(isChannelShown([true, true, true], 1, 0)).toBe(false);
    expect(isChannelShown([false, false, false], 1, 1)).toBe(true);
    expect(isChannelShown([true, false], null, 1)).toBe(false);
  });
});

describe("channelShortcutTarget", () => {
  const one = { id: "one", channels: [{}] };
  const three = { id: "three", channels: [{}, {}, {}] };
  const two = { id: "two", channels: [{}, {}] };

  it("is the selected layer when it has several channels", () => {
    expect(channelShortcutTarget([three, two], "two")?.id).toBe("two");
  });

  it("falls back to the first multichannel layer", () => {
    expect(channelShortcutTarget([one, three, two], "one")?.id).toBe("three");
    expect(channelShortcutTarget([one], "one")).toBeNull();
  });
});
