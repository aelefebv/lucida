import { HeadphonesIcon } from "@phosphor-icons/react";
import { useEffect, useId, useRef } from "react";
import { ToggleButton } from "react-aria-components";
import {
  applyChannelToggle,
  channelShortcutTarget,
  isChannelShown,
} from "../../components/channels.ts";
import { rampGradient } from "../../components/colormapSwatch.ts";
import type { LayerInfo } from "../../components/LayerPanel.tsx";
import { watchLongPress } from "../../ui/longPress.ts";
import "./ChannelChips.css";

export interface ChannelChipsProps {
  layers: readonly LayerInfo[];
  selectedLayerId: string | null;
  /** The channel shown alone, or `null` for the composite. */
  soloChannel: number | null;
  onChannelSetVisible: (id: string, channel: number, visible: boolean) => void;
  /** Solo a channel, or return to the composite when it is already soloed. */
  onSoloChannel: (channel: number) => void;
  onShowAllChannels: () => void;
}

/**
 * A chip per channel of the layer the channel keys act on: a tap shows or
 * hides the channel, a long press or an Alt-click solos it, as the layer
 * panel's eye and its Solo item do. Nothing shows for a single channel.
 */
export function ChannelChips(props: ChannelChipsProps) {
  const { layers, selectedLayerId, soloChannel } = props;
  const hintId = useId();
  const layer = channelShortcutTarget(layers, selectedLayerId);
  if (!layer) return null;
  const visible = layer.channels.map((channel) => channel.visible);
  return (
    <div className="lc-channel-chips" role="group" aria-label={`${layer.name} channels`}>
      {layer.channels.map((channel, i) => (
        <ChannelChip
          key={i}
          name={channel.name}
          colormap={channel.colormap}
          shown={isChannelShown(visible, soloChannel, i)}
          solo={soloChannel === i}
          describedBy={hintId}
          onToggle={() => applyChannelToggle(layer, soloChannel, i, props)}
          onSolo={() => props.onSoloChannel(i)}
        />
      ))}
      <span id={hintId} hidden>
        Long-press to solo
      </span>
    </div>
  );
}

interface ChannelChipProps {
  name: string;
  colormap: string;
  shown: boolean;
  solo: boolean;
  describedBy: string;
  onToggle: () => void;
  onSolo: () => void;
}

function ChannelChip({ name, colormap, shown, solo, describedBy, onToggle, onSolo }: ChannelChipProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const onSoloRef = useRef(onSolo);
  useEffect(() => {
    onSoloRef.current = onSolo;
  });
  // The long press cancels the tap it began as, so it never also toggles.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    return watchLongPress(element, () => onSoloRef.current(), () => {});
  }, []);

  return (
    <ToggleButton
      ref={ref}
      className="lc-channel-chip"
      isSelected={shown}
      data-solo={solo || undefined}
      aria-label={solo ? `${name}, soloed` : name}
      aria-describedby={describedBy}
      onPress={(event) => (event.altKey ? onSolo() : onToggle())}
    >
      <span className="lc-channel-chip-swatch" style={{ background: rampGradient(colormap, 96) }} aria-hidden />
      <span className="lc-channel-chip-name">{name}</span>
      {solo && <HeadphonesIcon className="lc-channel-chip-solo" size={14} aria-hidden />}
    </ToggleButton>
  );
}
