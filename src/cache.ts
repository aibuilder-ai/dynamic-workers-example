export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const QUERY_CACHE_TTL = 60;
const queryCache = (caches as unknown as { default: Cache }).default;

export async function intentCacheKey(query: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(query.trim().toLowerCase()));
  return `intent:${toHex(digest)}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  const res = await queryCache.match(new Request(`https://cache.internal/${key}`));
  return res ? ((await res.json()) as T) : null;
}

export function cachePut(ctx: ExecutionContext, key: string, value: unknown): void {
  const res = new Response(JSON.stringify(value), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": `max-age=${QUERY_CACHE_TTL}`,
    },
  });
  ctx.waitUntil(queryCache.put(new Request(`https://cache.internal/${key}`), res));
}
