import { useEffect, useState } from "react";
import { CheckIcon, LinkIcon } from "@phosphor-icons/react";
import { Button } from "../ui/Button.tsx";
import type { WebGpuUnavailableReason } from "../renderer/gpuContext.ts";
import "./WebGpuUnavailable.css";

const COPIED_MS = 2000;

/**
 * What the viewer shows instead of a canvas when the browser can't draw it.
 * The rest of the workspace still works, so the top bar stays and the message
 * says how to get the view, with the link to carry to another browser.
 */
export function WebGpuUnavailable({ reason }: { reason: WebGpuUnavailableReason }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);

  const copyLink = () => {
    navigator.clipboard?.writeText(window.location.href).then(
      () => setCopied(true),
      () => {},
    );
  };

  return (
    <div className="lc-webgpu-unavailable" role="alert" data-reason={reason}>
      <p className="lc-webgpu-unavailable-title">This browser can&rsquo;t show the viewer</p>
      {reason === "missing" ? (
        <p>lucida draws with WebGPU, and this browser doesn&rsquo;t offer it.</p>
      ) : (
        <p>This browser has WebGPU but couldn&rsquo;t reach the graphics hardware to use it.</p>
      )}
      <p className="lc-webgpu-unavailable-hint">
        {reason === "missing"
          ? "Open this link in a current version of Chrome, Edge, or Safari. On a phone or tablet, update the system first."
          : "Turn on hardware acceleration in the browser’s settings, update the graphics driver, or open this link in another browser."}
      </p>
      <Button icon={copied ? CheckIcon : LinkIcon} onPress={copyLink}>
        {copied ? "Link copied" : "Copy link"}
      </Button>
    </div>
  );
}
