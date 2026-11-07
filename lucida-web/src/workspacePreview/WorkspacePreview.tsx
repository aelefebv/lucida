import { StackIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { workspacePreviewUrl } from "./api.ts";
import "./WorkspacePreview.css";

interface Props {
  workspaceId: string;
  /** The listing's `preview_updated_at`; absent until a viewer uploads one. */
  updatedAt?: string | null;
}

/**
 * A dashboard card's image area: the workspace's preview once it has loaded,
 * and the placeholder until then, or for good when there is none or it
 * fails to load.
 */
export function WorkspacePreview({ workspaceId, updatedAt }: Props) {
  const src = updatedAt ? workspacePreviewUrl(workspaceId, updatedAt) : null;
  const [loaded, setLoaded] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const shown = src !== null && loaded === src;

  return (
    <div className="lc-ws-card-preview lc-ws-preview" data-shown={shown || undefined} aria-hidden="true">
      <StackIcon className="lc-ws-preview-placeholder" size={28} />
      {src && failed !== src && (
        <img
          key={src}
          className="lc-ws-preview-image"
          src={src}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onLoad={() => setLoaded(src)}
          onError={() => setFailed(src)}
        />
      )}
    </div>
  );
}
