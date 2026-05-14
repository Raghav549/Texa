import { MeiliSearch, Index, SearchParams } from 'meilisearch';
import { ModerationStatus, ProductStatus } from '@prisma/client';

export type SearchIndexName = 'users' | 'reels' | 'stores' | 'products' | 'hashtags';

type IndexableUser = {
  id: string;
  username?: string | null;
  fullName?: string | null;
  displayName?: string | null;
  name?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  image?: string | null;
  isVerified?: boolean | null;
  followers?: string[] | null;
  followersCount?: number | null;
  level?: string | null;
  levelTier?: string | null;
  xp?: number | null;
  role?: string | null;
  language?: string | null;
  location?: any;
  createdAt?: Date | string | null;
};

type IndexableReel = {
  id: string;
  caption?: string | null;
  title?: string | null;
  hashtags?: string[] | null;
  tags?: string[] | null;
  userId?: string | null;
  authorId?: string | null;
  authorUsername?: string | null;
  authorAvatarUrl?: string | null;
  category?: string | null;
  visibility?: string | null;
  moderationStatus?: string | null;
  isDraft?: boolean | null;
  flagged?: boolean | null;
  flaggedReason?: string | null;
  views?: number | null;
  viewCount?: number | null;
  likes?: string[] | null;
  likeCount?: number | null;
  comments?: unknown[] | null;
  commentCount?: number | null;
  shares?: number | null;
  shareCount?: number | null;
  saves?: number | null;
  saveCount?: number | null;
  completionRate?: number | null;
  avgCompletionRate?: number | null;
  trendingScore?: number | null;
  thumbnailUrl?: string | null;
  thumbnail?: string | null;
  videoUrl?: string | null;
  hlsUrl?: string | null;
  createdAt?: Date | string | null;
  publishedAt?: Date | string | null;
};

type IndexableStore = {
  id: string;
  ownerId?: string | null;
  userId?: string | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  isVerified?: boolean | null;
  verificationStatus?: string | null;
  trustScore?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  address?: any;
  city?: string | null;
  country?: string | null;
  tags?: string[] | null;
  categories?: string[] | null;
  status?: string | null;
  createdAt?: Date | string | null;
};

type IndexableProduct = {
  id: string;
  storeId?: string | null;
  storeName?: string | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  price?: number | string | null;
  compareAtPrice?: number | string | null;
  currency?: string | null;
  inventory?: number | null;
  stock?: number | null;
  primaryMediaUrl?: string | null;
  imageUrl?: string | null;
  mediaUrls?: string[] | null;
  images?: string[] | null;
  categoryIds?: string[] | null;
  category?: string | null;
  tags?: string[] | null;
  attributes?: any;
  isDigital?: boolean | null;
  status?: string | null;
  viewCount?: number | null;
  views?: number | null;
  salesCount?: number | null;
  soldCount?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  createdAt?: Date | string | null;
};

type GlobalSearchFilters = {
  userFilter?: string | string[];
  reelFilter?: string | string[];
  storeFilter?: string | string[];
  productFilter?: string | string[];
  limit?: number;
  offset?: number;
};

type HashtagType = 'reel' | 'product' | 'store' | 'general';

const host = process.env.MEILISEARCH_URL || process.env.MEILI_HOST || 'http://localhost:7700';
const apiKey = process.env.MEILISEARCH_API_KEY || process.env.MEILI_MASTER_KEY || 'master_key';

export const meili = new MeiliSearch({ host, apiKey });

const indexes: Record<SearchIndexName, string> = {
  users: process.env.MEILI_USERS_INDEX || 'users',
  reels: process.env.MEILI_REELS_INDEX || 'reels',
  stores: process.env.MEILI_STORES_INDEX || 'stores',
  products: process.env.MEILI_PRODUCTS_INDEX || 'products',
  hashtags: process.env.MEILI_HASHTAGS_INDEX || 'hashtags'
};

const safeDate = (value?: Date | string | null) => {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? date.toISOString() : null;
};

const timestamp = (value?: Date | string | null) => {
  if (!value) return 0;
  const date = value instanceof Date ? value : new Date(value);
  const time = date.getTime();
  return Number.isFinite(time) ? time : 0;
};

const cleanString = (value?: string | null) => {
  if (!value) return '';
  return String(value).trim();
};

const normalizeText = (value?: string | null) =>
  cleanString(value)
    .replace(/\s+/g, ' ')
    .trim();

const normalizeKeyword = (value?: string | null) =>
  normalizeText(value)
    .toLowerCase()
    .replace(/^#/, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_:-]/g, '')
    .slice(0, 80);

const cleanArray = (value?: any) => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(Boolean).map((item) => cleanString(String(item))).filter(Boolean))];
};

const cleanTagArray = (value?: any) =>
  cleanArray(value).map(normalizeKeyword).filter(Boolean);

const numberValue = (value: any, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const boolValue = (value: any, fallback = false) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return fallback;
};

const safeLimit = (value: any, fallback = 10, max = 100) => Math.min(Math.max(Number(value) || fallback, 1), max);

const normalizeStatus = (value?: string | null, fallback = 'active') => cleanString(value || fallback).toLowerCase();

const normalizeModerationStatus = (value?: string | null) => {
  const status = cleanString(value || ModerationStatus.SAFE);
  if (status === 'approved') return ModerationStatus.SAFE;
  if (status === 'blocked') return ModerationStatus.BLOCKED;
  if (status === 'review') return ModerationStatus.REVIEW;
  if (status === ModerationStatus.SAFE || status === ModerationStatus.REVIEW || status === ModerationStatus.BLOCKED) return status;
  return ModerationStatus.SAFE;
};

const normalizeVisibility = (value?: string | null) => {
  const visibility = cleanString(value || 'public').toLowerCase();
  if (visibility === 'public' || visibility === 'private' || visibility === 'followers') return visibility;
  return 'public';
};

const getAddressValue = (address: any, key: string) => {
  if (!address || typeof address !== 'object') return '';
  return cleanString(address[key]);
};

const getIndex = (name: SearchIndexName): Index => meili.index(indexes[name]);

const waitForTask = async (taskUid?: number) => {
  if (typeof taskUid !== 'number') return null;
  return meili.waitForTask(taskUid, {
    timeOutMs: Number(process.env.MEILI_TASK_TIMEOUT_MS || 30000),
    intervalMs: Number(process.env.MEILI_TASK_INTERVAL_MS || 250)
  });
};

const createIndexIfNeeded = async (name: SearchIndexName, primaryKey = 'id') => {
  try {
    await meili.getIndex(indexes[name]);
    return getIndex(name);
  } catch {
    const task = await meili.createIndex(indexes[name], { primaryKey });
    await waitForTask(task.taskUid);
    return getIndex(name);
  }
};

const addDocuments = async (indexName: SearchIndexName, docs: any[], primaryKey = 'id') => {
  const cleanDocs = docs.filter((doc) => doc?.id);
  if (!cleanDocs.length) return null;
  await createIndexIfNeeded(indexName, primaryKey);
  const task = await getIndex(indexName).addDocuments(cleanDocs, { primaryKey });
  await waitForTask(task.taskUid);
  return cleanDocs;
};

const deleteDocuments = async (indexName: SearchIndexName, ids: string[]) => {
  const cleanIds = [...new Set(ids.map(cleanString).filter(Boolean))];
  if (!cleanIds.length) return null;
  await createIndexIfNeeded(indexName);
  const task = await getIndex(indexName).deleteDocuments(cleanIds);
  return waitForTask(task.taskUid);
};

const mergeParams = (base: SearchParams, params: SearchParams = {}) => ({
  ...base,
  ...params,
  filter: params.filter ?? base.filter,
  sort: params.sort ?? base.sort,
  limit: params.limit ?? base.limit,
  offset: params.offset ?? base.offset
});

const productActiveStatus = () => {
  try {
    return ProductStatus.ACTIVE;
  } catch {
    return 'ACTIVE';
  }
};

const buildUserDoc = (user: IndexableUser) => {
  const location = user.location && typeof user.location === 'object' ? user.location : {};
  const username = cleanString(user.username).toLowerCase();
  const displayName = normalizeText(user.displayName || user.fullName || user.name || username);

  return {
    id: user.id,
    username,
    fullName: normalizeText(user.fullName || user.name || displayName),
    displayName,
    bio: normalizeText(user.bio),
    avatarUrl: user.avatarUrl || user.image || null,
    isVerified: boolValue(user.isVerified),
    followersCount: numberValue(user.followersCount ?? user.followers?.length),
    level: cleanString(user.level || user.levelTier) || null,
    xp: numberValue(user.xp),
    role: cleanString(user.role) || null,
    language: cleanString(user.language) || null,
    city: cleanString(location.city),
    country: cleanString(location.country),
    createdAt: safeDate(user.createdAt),
    createdAtTimestamp: timestamp(user.createdAt)
  };
};

const buildReelDoc = (reel: IndexableReel) => {
  const hashtags = cleanTagArray(reel.hashtags || reel.tags);
  const likesCount = Array.isArray(reel.likes) ? reel.likes.length : numberValue(reel.likeCount);
  const commentsCount = Array.isArray(reel.comments) ? reel.comments.length : numberValue(reel.commentCount);
  const shares = numberValue(reel.shares ?? reel.shareCount);
  const saves = numberValue(reel.saves ?? reel.saveCount);
  const views = numberValue(reel.views ?? reel.viewCount);
  const completionRate = numberValue(reel.completionRate ?? reel.avgCompletionRate);
  const trendingScore = numberValue(reel.trendingScore);
  const engagementScore = views + likesCount * 4 + commentsCount * 6 + shares * 8 + saves * 5 + completionRate * 100 + trendingScore;
  const authorId = cleanString(reel.authorId || reel.userId);

  return {
    id: reel.id,
    caption: normalizeText(reel.caption || reel.title),
    hashtags,
    authorId: authorId || null,
    userId: authorId || null,
    authorUsername: cleanString(reel.authorUsername).toLowerCase(),
    authorAvatarUrl: reel.authorAvatarUrl || null,
    category: normalizeKeyword(reel.category) || null,
    visibility: normalizeVisibility(reel.visibility),
    moderationStatus: normalizeModerationStatus(reel.moderationStatus),
    isDraft: boolValue(reel.isDraft),
    flagged: boolValue(reel.flagged),
    flaggedReason: cleanString(reel.flaggedReason) || null,
    views,
    likesCount,
    commentsCount,
    shares,
    saves,
    completionRate,
    trendingScore,
    engagementScore,
    thumbnailUrl: reel.thumbnailUrl || reel.thumbnail || null,
    videoUrl: reel.videoUrl || null,
    hlsUrl: reel.hlsUrl || null,
    createdAt: safeDate(reel.createdAt),
    createdAtTimestamp: timestamp(reel.createdAt),
    publishedAt: safeDate(reel.publishedAt || reel.createdAt),
    publishedAtTimestamp: timestamp(reel.publishedAt || reel.createdAt)
  };
};

const buildStoreDoc = (store: IndexableStore) => {
  const address = store.address || {};
  const city = cleanString(store.city || getAddressValue(address, 'city'));
  const country = cleanString(store.country || getAddressValue(address, 'country'));

  return {
    id: store.id,
    ownerId: store.ownerId || store.userId || null,
    name: normalizeText(store.name),
    slug: normalizeKeyword(store.slug || store.name),
    description: normalizeText(store.description),
    logoUrl: store.logoUrl || null,
    bannerUrl: store.bannerUrl || null,
    isVerified: boolValue(store.isVerified),
    verificationStatus: cleanString(store.verificationStatus) || null,
    trustScore: numberValue(store.trustScore),
    rating: numberValue(store.rating),
    ratingCount: numberValue(store.ratingCount),
    city,
    country,
    tags: cleanTagArray(store.tags),
    categories: cleanTagArray(store.categories),
    status: normalizeStatus(store.status, 'active'),
    createdAt: safeDate(store.createdAt),
    createdAtTimestamp: timestamp(store.createdAt)
  };
};

const buildProductDoc = (product: IndexableProduct) => {
  const attributes = product.attributes && typeof product.attributes === 'object' ? product.attributes : {};
  const attributeText = Object.values(attributes).flatMap((value: any) => Array.isArray(value) ? value : [value]).filter(Boolean).map(String).join(' ');
  const inventory = numberValue(product.inventory ?? product.stock);
  const mediaUrls = cleanArray(product.mediaUrls || product.images);
  const categoryIds = cleanTagArray(product.categoryIds || (product.category ? [product.category] : []));
  const status = cleanString(product.status || productActiveStatus());

  return {
    id: product.id,
    storeId: product.storeId || null,
    storeName: normalizeText(product.storeName),
    name: normalizeText(product.name),
    slug: normalizeKeyword(product.slug || product.name),
    description: normalizeText(product.description),
    price: numberValue(product.price),
    compareAtPrice: product.compareAtPrice == null ? null : numberValue(product.compareAtPrice),
    currency: cleanString(product.currency || 'INR').toUpperCase(),
    inventory,
    inStock: inventory > 0,
    primaryMediaUrl: product.primaryMediaUrl || product.imageUrl || mediaUrls[0] || null,
    mediaUrls,
    categoryIds,
    tags: cleanTagArray(product.tags),
    attributeText,
    isDigital: boolValue(product.isDigital),
    status,
    statusLower: status.toLowerCase(),
    viewCount: numberValue(product.viewCount ?? product.views),
    salesCount: numberValue(product.salesCount ?? product.soldCount),
    rating: numberValue(product.rating),
    ratingCount: numberValue(product.ratingCount),
    createdAt: safeDate(product.createdAt),
    createdAtTimestamp: timestamp(product.createdAt)
  };
};

export async function configureSearchIndexes() {
  const config: Record<SearchIndexName, any> = {
    users: {
      searchableAttributes: ['username', 'fullName', 'displayName', 'bio', 'city', 'country'],
      filterableAttributes: ['isVerified', 'level', 'role', 'language', 'city', 'country', 'followersCount', 'createdAtTimestamp'],
      sortableAttributes: ['followersCount', 'xp', 'createdAtTimestamp'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    reels: {
      searchableAttributes: ['caption', 'hashtags', 'authorUsername', 'category'],
      filterableAttributes: ['authorId', 'userId', 'hashtags', 'category', 'visibility', 'moderationStatus', 'isDraft', 'flagged', 'createdAtTimestamp', 'publishedAtTimestamp'],
      sortableAttributes: ['views', 'likesCount', 'commentsCount', 'shares', 'saves', 'completionRate', 'trendingScore', 'createdAtTimestamp', 'publishedAtTimestamp', 'engagementScore'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    stores: {
      searchableAttributes: ['name', 'slug', 'description', 'tags', 'categories', 'city', 'country'],
      filterableAttributes: ['ownerId', 'isVerified', 'verificationStatus', 'trustScore', 'rating', 'status', 'city', 'country', 'createdAtTimestamp'],
      sortableAttributes: ['trustScore', 'rating', 'ratingCount', 'createdAtTimestamp'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    products: {
      searchableAttributes: ['name', 'slug', 'description', 'storeName', 'tags', 'categoryIds', 'attributeText'],
      filterableAttributes: ['storeId', 'categoryIds', 'tags', 'isDigital', 'status', 'statusLower', 'currency', 'inStock', 'price', 'rating', 'createdAtTimestamp'],
      sortableAttributes: ['price', 'rating', 'ratingCount', 'viewCount', 'salesCount', 'createdAtTimestamp'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    hashtags: {
      searchableAttributes: ['tag', 'normalizedTag'],
      filterableAttributes: ['type', 'count', 'lastUsedAtTimestamp'],
      sortableAttributes: ['count', 'lastUsedAtTimestamp'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    }
  };

  for (const name of Object.keys(config) as SearchIndexName[]) {
    await createIndexIfNeeded(name);
  }

  const tasks: Promise<any>[] = [];

  for (const [name, settings] of Object.entries(config) as [SearchIndexName, any][]) {
    const index = getIndex(name);
    tasks.push(index.updateSearchableAttributes(settings.searchableAttributes).then((task) => waitForTask(task.taskUid)));
    tasks.push(index.updateFilterableAttributes(settings.filterableAttributes).then((task) => waitForTask(task.taskUid)));
    tasks.push(index.updateSortableAttributes(settings.sortableAttributes).then((task) => waitForTask(task.taskUid)));
    tasks.push(index.updateRankingRules(settings.rankingRules).then((task) => waitForTask(task.taskUid)));
  }

  await Promise.all(tasks);

  return { success: true, indexes };
}

export async function indexUser(user: IndexableUser) {
  const doc = buildUserDoc(user);
  await addDocuments('users', [doc]);
  return doc;
}

export async function indexUsers(users: IndexableUser[]) {
  const docs = users.map(buildUserDoc);
  await addDocuments('users', docs);
  return docs;
}

export async function indexReel(reel: IndexableReel) {
  const doc = buildReelDoc(reel);
  await addDocuments('reels', [doc]);
  await upsertHashtags(doc.hashtags, 'reel');
  return doc;
}

export async function indexReels(reels: IndexableReel[]) {
  const docs = reels.map(buildReelDoc);
  await addDocuments('reels', docs);
  await upsertHashtags([...new Set(docs.flatMap((doc) => doc.hashtags))], 'reel');
  return docs;
}

export async function indexStore(store: IndexableStore) {
  const doc = buildStoreDoc(store);
  await addDocuments('stores', [doc]);
  await upsertHashtags([...doc.tags, ...doc.categories], 'store');
  return doc;
}

export async function indexStores(stores: IndexableStore[]) {
  const docs = stores.map(buildStoreDoc);
  await addDocuments('stores', docs);
  await upsertHashtags([...new Set(docs.flatMap((doc) => [...doc.tags, ...doc.categories]))], 'store');
  return docs;
}

export async function indexProduct(product: IndexableProduct) {
  const doc = buildProductDoc(product);
  await addDocuments('products', [doc]);
  await upsertHashtags([...doc.tags, ...doc.categoryIds], 'product');
  return doc;
}

export async function indexProducts(products: IndexableProduct[]) {
  const docs = products.map(buildProductDoc);
  await addDocuments('products', docs);
  await upsertHashtags([...new Set(docs.flatMap((doc) => [...doc.tags, ...doc.categoryIds]))], 'product');
  return docs;
}

export async function removeFromSearch(indexName: SearchIndexName, id: string) {
  return deleteDocuments(indexName, [id]);
}

export async function removeManyFromSearch(indexName: SearchIndexName, ids: string[]) {
  return deleteDocuments(indexName, ids);
}

export async function searchUsers(query: string, params: SearchParams = {}) {
  await createIndexIfNeeded('users');

  return getIndex('users').search(query, mergeParams({
    limit: 10,
    attributesToSearchOn: ['username', 'fullName', 'displayName', 'bio'],
    attributesToHighlight: ['username', 'fullName', 'displayName'],
    sort: ['isVerified:desc', 'followersCount:desc']
  }, params));
}

export async function searchReels(query: string, params: SearchParams = {}) {
  await createIndexIfNeeded('reels');

  return getIndex('reels').search(query, mergeParams({
    limit: 10,
    attributesToSearchOn: ['caption', 'hashtags', 'authorUsername', 'category'],
    filter: [`visibility = public`, `moderationStatus = ${ModerationStatus.SAFE}`, `isDraft = false`],
    sort: ['engagementScore:desc', 'publishedAtTimestamp:desc'],
    attributesToHighlight: ['caption', 'hashtags']
  }, params));
}

export async function searchStores(query: string, params: SearchParams = {}) {
  await createIndexIfNeeded('stores');

  return getIndex('stores').search(query, mergeParams({
    limit: 10,
    attributesToSearchOn: ['name', 'slug', 'description', 'tags', 'categories', 'city', 'country'],
    filter: ['status != disabled'],
    sort: ['trustScore:desc', 'rating:desc'],
    attributesToHighlight: ['name', 'description']
  }, params));
}

export async function searchProducts(query: string, params: SearchParams = {}) {
  await createIndexIfNeeded('products');

  return getIndex('products').search(query, mergeParams({
    limit: 10,
    attributesToSearchOn: ['name', 'slug', 'description', 'storeName', 'tags', 'categoryIds', 'attributeText'],
    filter: [`status = ${productActiveStatus()}`],
    sort: ['salesCount:desc', 'rating:desc'],
    attributesToHighlight: ['name', 'description', 'storeName']
  }, params));
}

export async function searchGlobal(query: string, filters: GlobalSearchFilters = {}) {
  const cleanQuery = cleanString(query);
  const limit = safeLimit(filters.limit, 10, 50);
  const offset = Math.max(Number(filters.offset || 0), 0);

  const [users, reels, stores, products] = await Promise.all([
    searchUsers(cleanQuery, { limit, offset, filter: filters.userFilter }),
    searchReels(cleanQuery, { limit, offset, filter: filters.reelFilter || [`visibility = public`, `moderationStatus = ${ModerationStatus.SAFE}`, `isDraft = false`] }),
    searchStores(cleanQuery, { limit, offset, filter: filters.storeFilter || ['status != disabled'] }),
    searchProducts(cleanQuery, { limit, offset, filter: filters.productFilter || [`status = ${productActiveStatus()}`] })
  ]);

  return {
    query: cleanQuery,
    users: users.hits,
    reels: reels.hits,
    stores: stores.hits,
    products: products.hits,
    estimatedTotalHits: {
      users: users.estimatedTotalHits || 0,
      reels: reels.estimatedTotalHits || 0,
      stores: stores.estimatedTotalHits || 0,
      products: products.estimatedTotalHits || 0
    },
    processingTimeMs: {
      users: users.processingTimeMs,
      reels: reels.processingTimeMs,
      stores: stores.processingTimeMs,
      products: products.processingTimeMs
    }
  };
}

export async function searchAutocomplete(query: string, limit = 6) {
  const cleanQuery = cleanString(query);
  const finalLimit = safeLimit(limit, 6, 20);

  if (!cleanQuery) return { users: [], hashtags: [], stores: [], products: [] };

  await Promise.all([
    createIndexIfNeeded('users'),
    createIndexIfNeeded('hashtags'),
    createIndexIfNeeded('stores'),
    createIndexIfNeeded('products')
  ]);

  const [users, hashtags, stores, products] = await Promise.all([
    getIndex('users').search(cleanQuery, {
      limit: finalLimit,
      attributesToSearchOn: ['username', 'fullName', 'displayName'],
      attributesToRetrieve: ['id', 'username', 'fullName', 'displayName', 'avatarUrl', 'isVerified'],
      sort: ['isVerified:desc', 'followersCount:desc']
    }),
    getIndex('hashtags').search(cleanQuery.replace(/^#/, ''), {
      limit: finalLimit,
      attributesToRetrieve: ['id', 'tag', 'normalizedTag', 'count', 'type'],
      sort: ['count:desc', 'lastUsedAtTimestamp:desc']
    }),
    getIndex('stores').search(cleanQuery, {
      limit: finalLimit,
      attributesToSearchOn: ['name', 'slug'],
      attributesToRetrieve: ['id', 'name', 'slug', 'logoUrl', 'isVerified', 'trustScore'],
      filter: ['status != disabled'],
      sort: ['trustScore:desc']
    }),
    getIndex('products').search(cleanQuery, {
      limit: finalLimit,
      attributesToSearchOn: ['name', 'slug', 'storeName'],
      attributesToRetrieve: ['id', 'name', 'slug', 'primaryMediaUrl', 'price', 'currency', 'storeName'],
      filter: [`status = ${productActiveStatus()}`],
      sort: ['salesCount:desc']
    })
  ]);

  return {
    users: users.hits,
    hashtags: hashtags.hits,
    stores: stores.hits,
    products: products.hits
  };
}

export async function upsertHashtags(tags: string[], type: HashtagType = 'reel') {
  const normalized = [...new Set(cleanTagArray(tags))];
  if (!normalized.length) return null;

  await createIndexIfNeeded('hashtags');

  const existing = await getIndex('hashtags').getDocuments({
    filter: normalized.map((tag) => `id = ${type}_${tag}`),
    limit: normalized.length
  }).catch(() => null as any);

  const existingMap = new Map<string, any>();

  for (const doc of existing?.results || []) {
    if (doc?.normalizedTag) existingMap.set(doc.normalizedTag, doc);
  }

  const docs = normalized.map((tag) => {
    const old = existingMap.get(tag);
    const count = numberValue(old?.count) + 1;

    return {
      id: `${type}_${tag}`,
      tag: `#${tag}`,
      normalizedTag: tag,
      type,
      count,
      lastUsedAt: new Date().toISOString(),
      lastUsedAtTimestamp: Date.now()
    };
  });

  await addDocuments('hashtags', docs);
  return docs;
}

export async function getTrendingKeywords(limit = 20) {
  await createIndexIfNeeded('hashtags');

  const result = await getIndex('hashtags').search('', {
    limit: safeLimit(limit, 20, 100),
    sort: ['count:desc', 'lastUsedAtTimestamp:desc'],
    attributesToRetrieve: ['tag', 'normalizedTag', 'type', 'count', 'lastUsedAt']
  });

  return result.hits;
}

export async function getTrendingReels(limit = 20) {
  await createIndexIfNeeded('reels');

  const result = await getIndex('reels').search('', {
    limit: safeLimit(limit, 20, 100),
    filter: [`visibility = public`, `moderationStatus = ${ModerationStatus.SAFE}`, `isDraft = false`],
    sort: ['engagementScore:desc', 'publishedAtTimestamp:desc']
  });

  return result.hits;
}

export async function getPopularStores(limit = 20) {
  await createIndexIfNeeded('stores');

  const result = await getIndex('stores').search('', {
    limit: safeLimit(limit, 20, 100),
    filter: ['status != disabled'],
    sort: ['trustScore:desc', 'rating:desc', 'ratingCount:desc']
  });

  return result.hits;
}

export async function getPopularProducts(limit = 20) {
  await createIndexIfNeeded('products');

  const result = await getIndex('products').search('', {
    limit: safeLimit(limit, 20, 100),
    filter: [`status = ${productActiveStatus()}`],
    sort: ['salesCount:desc', 'rating:desc', 'viewCount:desc']
  });

  return result.hits;
}

export async function clearSearchIndex(indexName: SearchIndexName) {
  await createIndexIfNeeded(indexName);
  const task = await getIndex(indexName).deleteAllDocuments();
  return waitForTask(task.taskUid);
}

export async function healthCheckSearch() {
  const health = await meili.health();
  const version = await meili.getVersion().catch(() => null);

  return {
    status: health.status,
    version,
    host,
    indexes
  };
}

export async function multiSearch(queries: { indexUid: SearchIndexName; q: string; params?: SearchParams }[]) {
  const searchQueries = queries.map((query) => ({
    indexUid: indexes[query.indexUid],
    q: query.q,
    ...query.params
  }));

  return meili.multiSearch({ queries: searchQueries });
}

export async function rebuildSearchIndex(input: {
  users?: IndexableUser[];
  reels?: IndexableReel[];
  stores?: IndexableStore[];
  products?: IndexableProduct[];
}) {
  await configureSearchIndexes();

  const result: Record<string, number> = {};

  if (input.users?.length) {
    const docs = await indexUsers(input.users);
    result.users = docs.length;
  }

  if (input.reels?.length) {
    const docs = await indexReels(input.reels);
    result.reels = docs.length;
  }

  if (input.stores?.length) {
    const docs = await indexStores(input.stores);
    result.stores = docs.length;
  }

  if (input.products?.length) {
    const docs = await indexProducts(input.products);
    result.products = docs.length;
  }

  return {
    success: true,
    indexed: result
  };
}

export async function getSearchIndexStats() {
  const entries = await Promise.all(
    (Object.keys(indexes) as SearchIndexName[]).map(async (name) => {
      try {
        await createIndexIfNeeded(name);
        const stats = await getIndex(name).getStats();
        return [name, stats] as const;
      } catch {
        return [name, null] as const;
      }
    })
  );

  return Object.fromEntries(entries);
}
