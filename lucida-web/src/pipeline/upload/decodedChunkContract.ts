import type { ReadyChunkDelivery } from "../fetch/index.ts";
import type { ManifestEntry } from "./delivery/manifestIndex.ts";
import {
  assertChunkBufferLength,
  chunkContractForLevel,
  chunkContractsEqual,
  type ChunkContract,
} from "../../chunkContract.ts";

export interface DecodedChunkContract extends ChunkContract {
  bytes: ArrayBuffer;
}

/**
 * Revalidate the carried contract at the manifest→GPU boundary.
 *
 * No dtype is inferred here: the request's admitted contract is the single
 * interpretation used by decode/cache/upload/worker.  This check only proves
 * that a stale or forged delivery cannot cross into a different manifest.
 */
export function decodedChunkContract(
  delivery: ReadyChunkDelivery,
  meta: ManifestEntry,
): DecodedChunkContract {
  const level = meta.levels[delivery.level];
  if (!level) throw new Error(`Missing level ${delivery.level} for ${delivery.imageId}`);
  if (delivery.datasetId !== delivery.contract.datasetId ||
      delivery.datasetId !== meta.datasetId) {
    throw new Error("Decoded chunk dataset does not match its carried contract and manifest");
  }
  if (delivery.imageId !== delivery.contract.imageId ||
      delivery.imageId !== meta.image.image_id) {
    throw new Error("Decoded chunk image does not match its carried contract and manifest");
  }
  if (delivery.c !== delivery.contract.channel) {
    throw new Error("Decoded chunk channel does not match its carried contract");
  }
  const expected = chunkContractForLevel({
    datasetId: meta.datasetId,
    image: meta.image,
    level,
    channel: delivery.c,
    role: meta.isLabel ? "label" : "intensity",
  });
  if (!chunkContractsEqual(delivery.contract, expected)) {
    throw new Error(
      `Decoded chunk contract drift for ${delivery.datasetId}/${delivery.imageId}/ch${delivery.c}`,
    );
  }
  assertChunkBufferLength(delivery.data, delivery.contract, "decoded");
  return { ...delivery.contract, bytes: delivery.data };
}
