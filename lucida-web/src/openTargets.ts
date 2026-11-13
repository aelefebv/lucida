/**
 * Opens that name the view they land in. A view showing every dataset gets
 * any open, but one that lists its own, such as the empty second view of a
 * split, gets only the opens that name it.
 *
 * The open goes out as any other. Two things then have to arrive, in either
 * order: the server's word that the open completed, which pairs the URL with
 * the dataset it became, and the dataset itself in the scene. Only then does
 * the dataset join its view, since a view's list may drop an id the scene
 * doesn't hold.
 */
export interface OpenTargets {
  /** The next open of `url`, in canonical form, lands in `view`. */
  expect(url: string, view: number): void;
  /** The open of `url` completed as `datasetId`. */
  completed(url: string, datasetId: string): void;
  /** The scene now holds `datasetId`. */
  opened(datasetId: string): void;
  /** The open of `url` failed, so no view waits for it. */
  failed(url: string): void;
}

export interface OpenTargetDeps {
  /** Show `datasetId` in `view` as well as what it shows. */
  addToView(view: number, datasetId: string): void;
  /** Whether the scene holds `datasetId` yet. */
  holds(datasetId: string): boolean;
}

export function openTargets({ addToView, holds }: OpenTargetDeps): OpenTargets {
  // Several opens of one URL can be in flight, each naming its own view;
  // the server answers each, in the order they went out.
  const byUrl = new Map<string, number[]>();
  const byDataset = new Map<string, number[]>();

  const take = <K>(map: Map<K, number[]>, key: K): number | undefined => {
    const views = map.get(key);
    const view = views?.shift();
    if (views && views.length === 0) map.delete(key);
    return view;
  };
  const push = <K>(map: Map<K, number[]>, key: K, view: number) => {
    map.set(key, [...(map.get(key) ?? []), view]);
  };

  return {
    expect(url, view) {
      push(byUrl, url, view);
    },
    completed(url, datasetId) {
      const view = take(byUrl, url);
      if (view === undefined) return;
      if (holds(datasetId)) addToView(view, datasetId);
      else push(byDataset, datasetId, view);
    },
    opened(datasetId) {
      for (let view = take(byDataset, datasetId); view !== undefined; view = take(byDataset, datasetId)) {
        addToView(view, datasetId);
      }
    },
    failed(url) {
      take(byUrl, url);
    },
  };
}
