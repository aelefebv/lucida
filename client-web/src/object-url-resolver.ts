import { formatChunkKeyPath, type ChunkKey } from "./chunk-key";

export type ObjectUrlResolver = {
  resolveChunkUrl(key: ChunkKey): string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class EngineDataPlaneUrlResolver implements ObjectUrlResolver {
  private readonly baseUrl: string;
  private readonly dataPathPrefix: string;

  public constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.dataPathPrefix = this.baseUrl.endsWith("/v1/data") ? "" : "/v1/data";
  }

  public resolveChunkUrl(key: ChunkKey): string {
    return `${this.baseUrl}${this.dataPathPrefix}${formatChunkKeyPath(key)}`;
  }
}

export class StaticObjectUrlResolver implements ObjectUrlResolver {
  private readonly baseUrl: string;
  private readonly pathPrefix: string;

  public constructor(baseUrl: string, pathPrefix: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.pathPrefix = pathPrefix.replace(/^\/+|\/+$/g, "");
  }

  public resolveChunkUrl(key: ChunkKey): string {
    const path = formatChunkKeyPath(key).replace(/^\/+/, "");
    if (this.pathPrefix.length === 0) {
      return `${this.baseUrl}/${path}`;
    }
    return `${this.baseUrl}/${this.pathPrefix}/${path}`;
  }
}
