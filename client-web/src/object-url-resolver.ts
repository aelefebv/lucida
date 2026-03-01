import { formatChunkKeyPath, type ChunkKey } from "./chunk-key";

export interface ObjectUrlResolver {
  resolveChunkUrl(key: ChunkKey): string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class EngineDataPlaneUrlResolver implements ObjectUrlResolver {
  private readonly baseUrl: string;

  public constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  public resolveChunkUrl(key: ChunkKey): string {
    return `${this.baseUrl}${formatChunkKeyPath(key)}`;
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
