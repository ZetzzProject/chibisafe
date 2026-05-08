/**
 * HuggingFace Buckets API Client (TypeScript)
 *
 * Covers all bucket management operations based on:
 * - HuggingFace Hub Python Library v1.12.1
 * - hf_xet / repomix source code analysis
 *
 * Base URL: https://huggingface.co
 */

export interface BucketInfo {
  id: string;
  private: boolean;
  created_at: string; 
  size: number;       // bytes
  total_files: number;
}

export interface BucketFile {
  type: "file";
  path: string;
  size: number;
  xet_hash: string;
  mtime: string; 
}

export interface BucketFolder {
  type: "directory";
  path: string;
}

export type BucketTreeItem = BucketFile | BucketFolder;

export interface BucketUrl {
  url: string;
  bucket_id: string;
  handle: string; // hf://buckets/{bucket_id}
}

export interface BucketFileMetadata {
  size: number;
  xetHash: string | null;
  xetEndpoint: string | null;
  contentType: string | null;
}

export class HfApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
    public readonly url: string
  ) {
    super(`HF API Error ${status} (${statusText}) at ${url}: ${body}`);
    this.name = "HfApiError";
  }

  get isBucketNotFound(): boolean {
    return this.status === 404;
  }

  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isForbidden(): boolean {
    return this.status === 403;
  }

  get isConflict(): boolean {
    return this.status === 409;
  }
}

export interface AddFileOperation {
  type: "addFile";
  path: string;
  xetHash: string;
  mtime?: number; // Unix timestamp
  contentType?: string;
}

export interface CopyFileOperation {
  type: "copyFile";
  path: string;
  xetHash: string;
  sourceRepoType: "bucket" | "model" | "dataset" | "space";
  sourceRepoId: string;
}

export interface DeleteFileOperation {
  type: "deleteFile";
  path: string;
}

export type BatchOperation = AddFileOperation | CopyFileOperation | DeleteFileOperation;

export interface BatchBucketFilesOptions {
  add?: Array<{ xetHash: string; path: string; mtime?: number; contentType?: string }>;
  copy?: Array<{ sourceRepoType: "bucket" | "model" | "dataset" | "space"; sourceRepoId: string; xetHash: string; path: string }>;
  delete?: string[];
}

function parseBucketUrl(url: string): BucketUrl {
  const urlObj = new URL(url);
  const pathParts = urlObj.pathname.replace(/^\/buckets\//, "").split("/");
  const bucket_id = `${pathParts[0]}/${pathParts[1]}`;
  return {
    url,
    bucket_id,
    handle: `hf://buckets/${bucket_id}`,
  };
}

function parseCursorFromLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<[^>]+[?&]cursor=([^&>]+)[^>]*>;\s*rel="next"/);
  if (!match) return null;
  return decodeURIComponent(match[1] ?? '');
}

export class HuggingFaceBucketsClient {
  private readonly endpoint: string;
  private readonly token: string;

  constructor(token: string, endpoint = "https://huggingface.co") {
    this.token = token;
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
    };
  }

  private async request<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      params?: Record<string, string>;
      rawBody?: string;
      contentType?: string;
    } = {}
  ): Promise<T> {
    const url = new URL(`${this.endpoint}${path}`);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
    };

    let body: string | undefined;
    if (options.rawBody !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/x-ndjson";
      body = options.rawBody;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.body);
    }

    const response = await fetch(url.toString(), {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new HfApiError(response.status, response.statusText, errorText, path);
    }

    const text = await response.text();
    if (!text) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async paginatedGet<T>(path: string, params: Record<string, string> = {}): Promise<T[]> {
    const results: T[] =[];
    let cursor: string | null = null;

    do {
      const query: Record<string, string> = { ...params };
      if (cursor) query["cursor"] = cursor;

      const response = await fetch(
        `${this.endpoint}${path}?${new URLSearchParams(query)}`,
        { headers: this.headers }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new HfApiError(response.status, response.statusText, errorText, path);
      }

      const data: T[] = await response.json();
      results.push(...data);

      const linkHeader = response.headers.get("Link");
      cursor = parseCursorFromLink(linkHeader);
    } while (cursor);

    return results;
  }

  private _parseId(id: string) {
    if (id.startsWith('hf://buckets/')) id = id.slice(15);
    if (!id.includes('/')) return { ns: 'me', name: id, full: `me/${id}` };
    const [ns, name] = id.split('/');
    return { ns: ns!, name: name!, full: `${ns}/${name}` };
  }
  
  async createBucket(
    bucketId: string,
    options: { private?: boolean; resourceGroupId?: string; existOk?: boolean } = {}
  ): Promise<BucketUrl> {
    let namespace: string;
    let name: string;

    if (!bucketId.includes("/")) {
      namespace = "me";
      name = bucketId;
    } else {
      const parts = bucketId.split("/");
      if (parts.length !== 2) throw new Error(`Invalid bucket ID: ${bucketId}`);
      namespace = parts[0] as string;
      name = parts[1] as string;
    }

    const payload: Record<string, unknown> = {};
    if (options.private !== undefined) payload["private"] = options.private;
    if (options.resourceGroupId) payload["resourceGroupId"] = options.resourceGroupId;

    try {
      const data = await this.request<{ url: string }>(
        "POST",
        `/api/buckets/${namespace}/${name}`,
        { body: payload }
      );
      return parseBucketUrl(data.url);
    } catch (err) {
      if (err instanceof HfApiError && options.existOk && err.status === 409) {
        return parseBucketUrl(`${this.endpoint}/buckets/${namespace}/${name}`);
      }
      throw err;
    }
  }

  async bucketInfo(bucketId: string): Promise<BucketInfo> {
    return this.request<BucketInfo>("GET", `/api/buckets/${bucketId}`);
  }

  async listBuckets(namespace = "me", search?: string): Promise<BucketInfo[]> {
    const params: Record<string, string> = {};
    if (search) params["search"] = search;
    return this.paginatedGet<BucketInfo>(`/api/buckets/${namespace}`, params);
  }

  async deleteBucket(bucketId: string, missingOk = false): Promise<void> {
    try {
      await this.request<void>("DELETE", `/api/buckets/${bucketId}`);
    } catch (err) {
      if (err instanceof HfApiError && missingOk && err.status === 404) return;
      throw err;
    }
  }

  async moveBucket(fromId: string, toId: string): Promise<void> {
    if (fromId.split("/").length !== 2) throw new Error(`Invalid fromId: ${fromId}`);
    if (toId.split("/").length !== 2) throw new Error(`Invalid toId: ${toId}`);

    await this.request<void>("POST", "/api/repos/move", {
      body: { fromRepo: fromId, toRepo: toId, type: "bucket" },
    });
  }

  async listBucketTree(
    bucketId: string,
    options: { prefix?: string; recursive?: boolean } = {}
  ): Promise<BucketTreeItem[]> {
    const encodedPrefix = options.prefix
      ? "/" + encodeURIComponent(options.prefix).replace(/%2F/g, "%2F")
      : "";
    const params: Record<string, string> = {};
    if (options.recursive !== undefined) params["recursive"] = String(options.recursive);

    return this.paginatedGet<BucketTreeItem>(
      `/api/buckets/${bucketId}/tree${encodedPrefix}`,
      params
    );
  }

  async getPathsInfo(bucketId: string, paths: string[]): Promise<BucketFile[]> {
    const { full } = this._parseId(bucketId);
    const BATCH_SIZE = 1000;
    const results: BucketFile[] =[];

    for (let i = 0; i < paths.length; i += BATCH_SIZE) {
      const batch = paths.slice(i, i + BATCH_SIZE);
      const data = await this.request<BucketFile[]>(
        "POST",
        `/api/buckets/${full}/paths-info`,
        { body: { paths: batch } }
      );
      results.push(...data);
    }

    return results;
  }

  private _ndjson(ops: any[]) {
    return ops.map(o => JSON.stringify(o)).join('\n');
  }

  async deleteFiles(id: string, paths: string[]) {
    if (!paths?.length) return null;
    const { full } = this._parseId(id);
    const ops = paths.map(p => ({ type: 'deleteFile', path: p }));
    return this.request<void>('POST', `/api/buckets/${full}/batch`, {
      contentType: 'application/x-ndjson',
      rawBody: this._ndjson(ops) + '\n'
    });
  }

  async copyFiles(id: string, copies: { destination: string; sourceRepoId: string; sourceRepoType: 'bucket' | 'model' | 'dataset' | 'space'; xetHash: string }[]) {
    if (!copies?.length) return null;
    const { full } = this._parseId(id);
    const ops = copies.map(({ sourceRepoType, sourceRepoId, xetHash, destination }) => ({
      type: 'copyFile',
      path: destination,
      xetHash,
      sourceRepoType,
      sourceRepoId
    }));
    return this.request<void>('POST', `/api/buckets/${full}/batch`, {
      contentType: 'application/x-ndjson',
      rawBody: this._ndjson(ops) + '\n'
    });
  }

  async getFileMetadata(bucketId: string, remotePath: string): Promise<BucketFileMetadata> {
    const encodedPath = encodeURIComponent(remotePath).replace(/%2F/gi, "%2F");
    const url = `${this.endpoint}/buckets/${bucketId}/resolve/${encodedPath}`;

    const response = await fetch(url, {
      method: "HEAD",
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new HfApiError(response.status, response.statusText, "", url);
    }

    return {
      size: Number(response.headers.get("Content-Length") ?? 0),
      xetHash: response.headers.get("X-Xet-Hash"),
      xetEndpoint: response.headers.get("X-Xet-Endpoint"),
      contentType: response.headers.get("Content-Type"),
    };
  }

  async downloadFile(bucketId: string, remotePath: string): Promise<Blob> {
    const encodedPath = encodeURIComponent(remotePath).replace(/%2F/gi, "%2F");
    const url = `${this.endpoint}/buckets/${bucketId}/resolve/${encodedPath}`;

    const response = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${this.token}` },
      redirect: "follow",
    });

    if (!response.ok) {
      throw new HfApiError(response.status, response.statusText, "", url);
    }

    return response.blob();
  }

  async downloadFileAsText(bucketId: string, remotePath: string): Promise<string> {
    const blob = await this.downloadFile(bucketId, remotePath);
    return blob.text();
  }

  async downloadFileAsArrayBuffer(bucketId: string, remotePath: string): Promise<ArrayBuffer> {
    const blob = await this.downloadFile(bucketId, remotePath);
    return blob.arrayBuffer();
  }
}
