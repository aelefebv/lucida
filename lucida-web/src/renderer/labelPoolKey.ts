/**
 * Label image ids are only unique inside one dataset. Keep their GPU pools in
 * the same identity domain as chunk requests so two open datasets can legally
 * reuse an image id without replacing or sampling one another's mask.
 */
export function labelPoolKey(datasetId: string, imageId: string): string {
  return `${datasetId.length}:${datasetId}${imageId}`;
}
