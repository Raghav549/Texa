import { Image } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

type ImageCacheEntry = {
  uri: string;
  cachedAt: number;
  lastUsedAt: number;
  hits: number;
  failed?: boolean;
  failedAt?: number;
};

type PrefetchOptions = {
  limit?: number;
  concurrency?: number;
  ttlMs?: number;
  retryFailedAfterMs?: number;
  timeoutMs?: number;
  force?: boolean;
};

type PrefetchResult = {
  requested: number;
  skipped: number;
  attempted: number;
  success: number;
  failed: number;
  cached: string[];
  failedUris: string[];
};

const IMAGE_CACHE_KEY = 'texa:image_cache:v2';
const IMAGE_CACHE_MAX = 250;
const DEFAULT_LIMIT = 80;
const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const DEFAULT_RETRY_FAILED_AFTER_MS = 1000 * 60 * 30;
const DEFAULT_TIMEOUT_MS = 1000 * 12;

function now() {
  return Date.now();
}

function normalizeUri(uri: any) {
  if (typeof uri !== 'string') return null;
  const clean = uri.trim();
  if (!clean) return null;
  if (clean.startsWith('http://') || clean.startsWith('https://') || clean.startsWith('file://') || clean.startsWith('content://') || clean.startsWith('data:image/')) return clean;
  return null;
}

function uniqueUris(uris: string[]) {
  const set = new Set<string>();
  for (const uri of uris) {
    const clean = normalizeUri(uri);
    if (clean) set.add(clean);
  }
  return Array.from(set);
}

async function readCache(): Promise<ImageCacheEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(IMAGE_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.uri === 'string')
      .map(item => ({
        uri: item.uri,
        cachedAt: Number(item.cachedAt) || now(),
        lastUsedAt: Number(item.lastUsedAt) || Number(item.cachedAt) || now(),
        hits: Number(item.hits) || 0,
        failed: Boolean(item.failed),
        failedAt: item.failedAt ? Number(item.failedAt) : undefined,
      }));
  } catch {
    return [];
  }
}

async function writeCache(entries: ImageCacheEntry[]) {
  const deduped = new Map<string, ImageCacheEntry>();
  for (const entry of entries) {
    if (!entry?.uri) continue;
    const existing = deduped.get(entry.uri);
    if (!existing || entry.lastUsedAt >= existing.lastUsedAt) deduped.set(entry.uri, entry);
  }

  const sorted = Array.from(deduped.values())
    .sort((a, b) => {
      const af = a.failed ? 1 : 0;
      const bf = b.failed ? 1 : 0;
      if (af !== bf) return af - bf;
      if (b.hits !== a.hits) return b.hits - a.hits;
      return b.lastUsedAt - a.lastUsedAt;
    })
    .slice(0, IMAGE_CACHE_MAX);

  await AsyncStorage.setItem(IMAGE_CACHE_KEY, JSON.stringify(sorted));
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Image prefetch timeout')), timeoutMs);
    promise
      .then(value => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch(error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function runPool<T, R>(items: T[], concurrency: number, task: (item: T, index: number) => Promise<R>) {
  const results: R[] = [];
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const current = index++;
      results[current] = await task(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return results;
}

export async function prefetchImages(uris: string[], options: PrefetchOptions = {}): Promise<PrefetchResult> {
  const requested = uniqueUris(uris).slice(0, options.limit ?? DEFAULT_LIMIT);
  const timestamp = now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const retryFailedAfterMs = options.retryFailedAfterMs ?? DEFAULT_RETRY_FAILED_AFTER_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;

  const cache = await readCache();
  const cacheMap = new Map(cache.map(entry => [entry.uri, entry]));

  const cached: string[] = [];
  const toPrefetch: string[] = [];

  for (const uri of requested) {
    const entry = cacheMap.get(uri);
    const expired = !entry || timestamp - entry.cachedAt > ttlMs;
    const failedRecently = entry?.failed && entry.failedAt && timestamp - entry.failedAt < retryFailedAfterMs;

    if (!options.force && entry && !expired && !failedRecently && !entry.failed) {
      entry.hits += 1;
      entry.lastUsedAt = timestamp;
      cached.push(uri);
      continue;
    }

    if (!options.force && failedRecently) {
      cached.push(uri);
      continue;
    }

    toPrefetch.push(uri);
  }

  const successUris: string[] = [];
  const failedUris: string[] = [];

  await runPool(toPrefetch, concurrency, async uri => {
    try {
      const ok = await withTimeout(Image.prefetch(uri), timeoutMs);
      if (ok) {
        successUris.push(uri);
        cacheMap.set(uri, {
          uri,
          cachedAt: timestamp,
          lastUsedAt: timestamp,
          hits: (cacheMap.get(uri)?.hits || 0) + 1,
          failed: false,
        });
      } else {
        failedUris.push(uri);
        cacheMap.set(uri, {
          uri,
          cachedAt: cacheMap.get(uri)?.cachedAt || timestamp,
          lastUsedAt: timestamp,
          hits: cacheMap.get(uri)?.hits || 0,
          failed: true,
          failedAt: timestamp,
        });
      }
    } catch {
      failedUris.push(uri);
      cacheMap.set(uri, {
        uri,
        cachedAt: cacheMap.get(uri)?.cachedAt || timestamp,
        lastUsedAt: timestamp,
        hits: cacheMap.get(uri)?.hits || 0,
        failed: true,
        failedAt: timestamp,
      });
    }
  });

  await writeCache(Array.from(cacheMap.values()));

  return {
    requested: requested.length,
    skipped: cached.length,
    attempted: toPrefetch.length,
    success: successUris.length,
    failed: failedUris.length,
    cached: [...cached, ...successUris],
    failedUris,
  };
}

export async function prefetchReelImages(reels: any[], options: PrefetchOptions = {}) {
  const uris = reels.flatMap(reel => [
    reel?.thumbnailUrl,
    reel?.posterUrl,
    reel?.coverUrl,
    reel?.author?.avatarUrl,
    reel?.user?.avatarUrl,
    reel?.store?.logoUrl,
    reel?.store?.bannerUrl,
  ]);
  return prefetchImages(uris, options);
}

export async function prefetchStoreImages(stores: any[], options: PrefetchOptions = {}) {
  const uris = stores.flatMap(store => [
    store?.logoUrl,
    store?.bannerUrl,
    store?.coverUrl,
    ...(Array.isArray(store?.products) ? store.products.flatMap((p: any) => [p?.primaryMediaUrl, ...(p?.mediaUrls || [])]) : []),
  ]);
  return prefetchImages(uris, options);
}

export async function prefetchProductImages(products: any[], options: PrefetchOptions = {}) {
  const uris = products.flatMap(product => [
    product?.primaryMediaUrl,
    product?.thumbnailUrl,
    ...(Array.isArray(product?.mediaUrls) ? product.mediaUrls : []),
    product?.store?.logoUrl,
  ]);
  return prefetchImages(uris, options);
}

export async function markImageUsed(uri: string) {
  const clean = normalizeUri(uri);
  if (!clean) return;

  const cache = await readCache();
  const timestamp = now();
  const index = cache.findIndex(entry => entry.uri === clean);

  if (index >= 0) {
    cache[index].lastUsedAt = timestamp;
    cache[index].hits += 1;
    cache[index].failed = false;
    cache[index].failedAt = undefined;
  } else {
    cache.unshift({
      uri: clean,
      cachedAt: timestamp,
      lastUsedAt: timestamp,
      hits: 1,
      failed: false,
    });
  }

  await writeCache(cache);
}

export async function removeImageFromCache(uri: string) {
  const clean = normalizeUri(uri);
  if (!clean) return;
  const cache = await readCache();
  await writeCache(cache.filter(entry => entry.uri !== clean));
}

export async function getImageCacheStats() {
  const cache = await readCache();
  const timestamp = now();
  return {
    total: cache.length,
    healthy: cache.filter(entry => !entry.failed).length,
    failed: cache.filter(entry => entry.failed).length,
    recentlyUsed: cache.filter(entry => timestamp - entry.lastUsedAt < 1000 * 60 * 60 * 24).length,
    top: cache
      .filter(entry => !entry.failed)
      .sort((a, b) => b.hits - a.hits || b.lastUsedAt - a.lastUsedAt)
      .slice(0, 20),
  };
}

export async function clearImageCache() {
  await AsyncStorage.removeItem(IMAGE_CACHE_KEY);
}

export async function pruneImageCache(ttlMs = DEFAULT_TTL_MS) {
  const cache = await readCache();
  const timestamp = now();
  const fresh = cache.filter(entry => timestamp - entry.cachedAt <= ttlMs || timestamp - entry.lastUsedAt <= ttlMs / 2);
  await writeCache(fresh);
  return { removed: cache.length - fresh.length, remaining: fresh.length };
}
