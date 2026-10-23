import crypto from "crypto";

// The few S3 calls the backups need (upload, download, delete one object,
// list the backups),
// signed with AWS Signature Version 4, so no SDK is needed. Fly's object
// storage (Tigris) speaks S3: `fly storage create` makes a bucket and sets
// these secrets on the app itself, so no key passes through anyone's hands:
// AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT_URL_S3, AWS_REGION
// and BUCKET_NAME. Objects are addressed path-style: endpoint/bucket/key.

export interface S3Config {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

/** The settings a bucket needs (AWS_REGION is optional: "auto"). */
export const S3_SETTINGS = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_ENDPOINT_URL_S3", "BUCKET_NAME"] as const;

/** Which of them this server can't see (names only, never values): what Settings shows when backups are off. */
export const missingS3Settings = (env: NodeJS.ProcessEnv = process.env): string[] => S3_SETTINGS.filter((name) => !env[name]?.trim());

/** The bucket from the environment, or null until one is set up. */
export function s3ConfigFromEnv(env: NodeJS.ProcessEnv = process.env): S3Config | null {
  const endpoint = env.AWS_ENDPOINT_URL_S3?.trim();
  const bucket = env.BUCKET_NAME?.trim();
  const accessKeyId = env.AWS_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY?.trim();
  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
  return { endpoint: endpoint.replace(/\/+$/, ""), region: env.AWS_REGION?.trim() || "auto", bucket, accessKeyId, secretAccessKey };
}

const sha256Hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => crypto.createHmac("sha256", key).update(data).digest();

/** A key's path segments, each encoded as SigV4 wants (RFC 3986: only A–Z a–z 0–9 - _ . ~ left as they are). */
const encodePath = (key: string) =>
  key
    .split("/")
    .map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");

/** A query string as SigV4 wants it: sorted by name, each part encoded like a path segment. */
const canonicalQuery = (query: Record<string, string>) =>
  Object.keys(query)
    .sort()
    .map((name) => `${encodePath(name).replace(/\//g, "%2F")}=${encodePath(query[name]).replace(/\//g, "%2F")}`)
    .join("&");

/**
 * A signed request for one object (or, with no key, the bucket itself): its
 * URL and the headers to send (the Host header is signed but left to fetch,
 * which sets the same one).
 */
export function signObjectRequest(
  cfg: S3Config,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  body: Buffer | undefined,
  now: Date,
  extra: Record<string, string> = {},
  query: Record<string, string> = {}
): { url: string; headers: Record<string, string> } {
  const base = new URL(cfg.endpoint);
  const bucketPath = `${base.pathname.replace(/\/+$/, "")}/${encodePath(cfg.bucket)}`;
  const path = key ? `${bucketPath}/${encodePath(key)}` : bucketPath;
  const queryString = canonicalQuery(query);
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ?? "");
  const signed: Record<string, string> = { host: base.host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  for (const [name, value] of Object.entries(extra)) signed[name.toLowerCase()] = value;
  const names = Object.keys(signed).sort();
  const canonicalHeaders = names.map((n) => `${n}:${signed[n].trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [method, path, queryString, canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${cfg.region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, day), cfg.region), "s3"), "aws4_request");
  const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  const { host: _host, ...headers } = signed;
  return {
    url: `${base.origin}${path}${queryString ? `?${queryString}` : ""}`,
    headers: { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` },
  };
}

const TIMEOUT_MS = 60_000;

async function send(
  cfg: S3Config,
  method: "GET" | "PUT" | "DELETE",
  key: string,
  body?: Buffer,
  extra?: Record<string, string>,
  query?: Record<string, string>
): Promise<Response> {
  const { url, headers } = signObjectRequest(cfg, method, key, body, new Date(), extra, query);
  return fetch(url, { method, headers, body: body ? new Uint8Array(body) : undefined, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** S3's error text, short. */
async function why(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1];
  return `${res.status}${code ? ` ${code}` : ""}`;
}

export async function putObject(cfg: S3Config, key: string, body: Buffer, contentType = "application/octet-stream"): Promise<void> {
  const res = await send(cfg, "PUT", key, body, { "content-type": contentType });
  if (!res.ok) throw new Error(`Upload refused (${await why(res)})`);
}

/** An object's bytes, or null when there's no such object. */
export async function getObject(cfg: S3Config, key: string): Promise<Buffer | null> {
  const res = await send(cfg, "GET", key);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Download refused (${await why(res)})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Deletes an object; one that isn't there is fine. */
export async function deleteObject(cfg: S3Config, key: string): Promise<void> {
  const res = await send(cfg, "DELETE", key);
  if (!res.ok && res.status !== 404) throw new Error(`Delete refused (${await why(res)})`);
}

export interface StoredObject {
  key: string;
  bytes: number;
  /** When it was last written (ms). */
  at: number;
}

const unescapeXml = (text: string) =>
  text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

/** Every object whose key starts with `prefix` (S3's ListObjectsV2, a page at a time). */
export async function listObjects(cfg: S3Config, prefix: string): Promise<StoredObject[]> {
  const found: StoredObject[] = [];
  let token: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query: Record<string, string> = { "list-type": "2", prefix, ...(token ? { "continuation-token": token } : {}) };
    const res = await send(cfg, "GET", "", undefined, undefined, query);
    if (!res.ok) throw new Error(`Listing refused (${await why(res)})`);
    const xml = await res.text();
    for (const [, entry] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const key = tag(entry, "Key");
      if (key === undefined) continue;
      found.push({ key: unescapeXml(key), bytes: Number(tag(entry, "Size") ?? 0), at: Date.parse(tag(entry, "LastModified") ?? "") || 0 });
    }
    token = tag(xml, "IsTruncated") === "true" ? tag(xml, "NextContinuationToken") : undefined;
    if (!token) break;
    token = unescapeXml(token);
  }
  return found;
}
