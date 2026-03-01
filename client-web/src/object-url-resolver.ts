import { formatChunkKeyPath, type ChunkKey } from "./chunk-key";

export type ObjectUrlResolver = {
  resolveChunkUrl(key: ChunkKey): string;
};

type ResolverOptions = {
  cacheScope?: string;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export class EngineDataPlaneUrlResolver implements ObjectUrlResolver {
  private readonly baseUrl: string;
  private readonly dataPathPrefix: string;
  private readonly cacheScope: string | null;

  public constructor(baseUrl: string, options: ResolverOptions = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.dataPathPrefix = this.baseUrl.endsWith("/v1/data") ? "" : "/v1/data";
    this.cacheScope =
      typeof options.cacheScope === "string" && options.cacheScope.length > 0
        ? options.cacheScope
        : null;
  }

  public resolveChunkUrl(key: ChunkKey): string {
    const basePath = `${this.baseUrl}${this.dataPathPrefix}${formatChunkKeyPath(key)}`;
    if (this.cacheScope === null) {
      return basePath;
    }
    return `${basePath}?scope=${encodeURIComponent(this.cacheScope)}`;
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
