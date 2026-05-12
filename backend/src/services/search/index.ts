import { MeiliSearch, Index, SearchParams, SearchResponse } from 'meilisearch';

type SearchIndexName = 'users' | 'reels' | 'stores' | 'products' | 'hashtags';

type IndexableUser = {
  id: string;
  username?: string | null;
  fullName?: string | null;
  displayName?: string | null;
  bio?: string | null;
  avatarUrl?: string | null;
  isVerified?: boolean | null;
  followers?: string[] | null;
  followersCount?: number | null;
  level?: string | null;
  xp?: number | null;
  createdAt?: Date | string | null;
};

type IndexableReel = {
  id: string;
  caption?: string | null;
  hashtags?: string[] | null;
  userId?: string | null;
  authorId?: string | null;
  authorUsername?: string | null;
  authorAvatarUrl?: string | null;
  category?: string | null;
  visibility?: string | null;
  moderationStatus?: string | null;
  isDraft?: boolean | null;
  views?: number | null;
  likes?: string[] | null;
  comments?: unknown[] | null;
  shares?: number | null;
  completionRate?: number | null;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  hlsUrl?: string | null;
  createdAt?: Date | string | null;
  publishedAt?: Date | string | null;
};

type IndexableStore = {
  id: string;
  ownerId?: string | null;
  name?: string | null;
  slug?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  bannerUrl?: string | null;
  isVerified?: boolean | null;
  trustScore?: number | null;
  rating?: number | null;
  ratingCount?: number | null;
  address?: any;
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
  price?: number | null;
  compareAtPrice?: number | null;
  currency?: string | null;
  inventory?: number | null;
  primaryMediaUrl?: string | null;
  mediaUrls?: string[] | null;
  categoryIds?: string[] | null;
  tags?: string[] | null;
  attributes?: any;
  isDigital?: boolean | null;
  status?: string | null;
  viewCount?: number | null;
  salesCount?: number | null;
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

const host = process.env.MEILISEARCH_URL || process.env.MEILI_HOST || 'http://localhost:7700';
const apiKey = process.env.MEILISEARCH_API_KEY || process.env.MEILI_MASTER_KEY || 'master_key';

export const meili = new MeiliSearch({ host, apiKey });

const indexes: Record<SearchIndexName, string> = {
  users: 'users',
  reels: 'reels',
  stores: 'stores',
  products: 'products',
  hashtags: 'hashtags'
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

const cleanArray = (value?: any) => {
  if (!Array.isArray(value)) return [];
  return value.filter(Boolean).map((item) => String(item).trim()).filter(Boolean);
};

const numberValue = (value: any, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const boolValue = (value: any, fallback = false) => {
  return typeof value === 'boolean' ? value : fallback;
};

const getIndex = (name: SearchIndexName): Index => meili.index(indexes[name]);

const waitForTask = async (taskUid?: number) => {
  if (typeof taskUid !== 'number') return null;
  return meili.waitForTask(taskUid, { timeOutMs: 30000, intervalMs: 250 });
};

const addDocuments = async (indexName: SearchIndexName, docs: any[], primaryKey = 'id') => {
  if (!docs.length) return null;
  const task = await getIndex(indexName).addDocuments(docs, { primaryKey });
  return waitForTask(task.taskUid);
};

const deleteDocuments = async (indexName: SearchIndexName, ids: string[]) => {
  const cleanIds = ids.filter(Boolean);
  if (!cleanIds.length) return null;
  const task = await getIndex(indexName).deleteDocuments(cleanIds);
  return waitForTask(task.taskUid);
};

export async function configureSearchIndexes() {
  const config: Record<SearchIndexName, any> = {
    users: {
      searchableAttributes: ['username', 'fullName', 'displayName', 'bio'],
      filterableAttributes: ['isVerified', 'level', 'followersCount', 'createdAtTimestamp'],
      sortableAttributes: ['followersCount', 'xp', 'createdAtTimestamp'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    reels: {
      searchableAttributes: ['caption', 'hashtags', 'authorUsername', 'category'],
      filterableAttributes: ['authorId', 'hashtags', 'category', 'visibility', 'moderationStatus', 'isDraft', 'createdAtTimestamp', 'publishedAtTimestamp'],
      sortableAttributes: ['views', 'likesCount', 'commentsCount', 'shares', 'completionRate', 'createdAtTimestamp', 'publishedAtTimestamp', 'engagementScore'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    stores: {
      searchableAttributes: ['name', 'slug', 'description', 'tags', 'categories', 'city', 'country'],
      filterableAttributes: ['ownerId', 'isVerified', 'trustScore', 'rating', 'status', 'city', 'country', 'createdAtTimestamp'],
      sortableAttributes: ['trustScore', 'rating', 'ratingCount', 'createdAtTimestamp'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness']
    },
    products: {
      searchableAttributes: ['name', 'slug', 'description', 'storeName', 'tags', 'categoryIds', 'attributeText'],
      filterableAttributes: ['storeId', 'categoryIds', 'tags', 'isDigital', 'status', 'currency', 'inStock', 'price', 'rating', 'createdAtTimestamp'],
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

  const tasks: Promise<any>[] = [];

  for (const [name, settings] of Object.entries(config) as [SearchIndexName, any][]) {
    const index = getIndex(name);
    tasks.push(index.updateSearchableAttributes(settings.searchableAttributes).then((task) => waitForTask(task.taskUid)));
    tasks.push(index.updateFilterableAttributes(settings.filterableAttributes).then((task) => waitForTask(task.taskUid)));
    tasks.push(index.updateSortableAttributes(settings.sortableAttributes).then((task) => waitForTask(task.taskUid)));
    tasks.push(index.updateRankingRules(settings.rankingRules).then((task) => waitForTask(task.taskUid)));
  }

  await Promise.all(tasks);
  return { success: true };
}

export async function indexUser(user: IndexableUser) {
  const doc = {
    id: user.id,
    username: cleanString(user.username).toLowerCase(),
    fullName: cleanString(user.fullName),
    displayName: cleanString(user.displayName),
    bio: cleanString(user.bio),
    avatarUrl: user.avatarUrl || null,
    isVerified: boolValue(user.isVerified),
    followersCount: numberValue(user.followersCount ?? user.followers?.length),
    level: user.level || null,
    xp: numberValue(user.xp),
    createdAt: safeDate(user.createdAt),
    createdAtTimestamp: timestamp(user.createdAt)
  };

  return addDocuments('users', [doc]);
}

export async function indexUsers(users: IndexableUser[]) {
  return addDocuments('users', users.map((user) => ({
    id: user.id,
    username: cleanString(user.username).toLowerCase(),
    fullName: cleanString(user.fullName),
    displayName: cleanString(user.displayName),
    bio: cleanString(user.bio),
    avatarUrl: user.avatarUrl || null,
    isVerified: boolValue(user.isVerified),
    followersCount: numberValue(user.followersCount ?? user.followers?.length),
    level: user.level || null,
    xp: numberValue(user.xp),
    createdAt: safeDate(user.createdAt),
    createdAtTimestamp: timestamp(user.createdAt)
  })));
}

export async function indexReel(reel: IndexableReel) {
  const hashtags = cleanArray(reel.hashtags).map((tag) => tag.replace(/^#/, '').toLowerCase());
  const likesCount = Array.isArray(reel.likes) ? reel.likes.length : 0;
  const commentsCount = Array.isArray(reel.comments) ? reel.comments.length : 0;
  const shares = numberValue(reel.shares);
  const views = numberValue(reel.views);
  const completionRate = numberValue(reel.completionRate);
  const engagementScore = views + likesCount * 4 + commentsCount * 6 + shares * 8 + completionRate * 100;

  const doc = {
    id: reel.id,
    caption: cleanString(reel.caption),
    hashtags,
    authorId: reel.authorId || reel.userId || null,
    authorUsername: cleanString(reel.authorUsername).toLowerCase(),
    authorAvatarUrl: reel.authorAvatarUrl || null,
    category: reel.category || null,
    visibility: reel.visibility || 'public',
    moderationStatus: reel.moderationStatus || 'approved',
    isDraft: boolValue(reel.isDraft),
    views,
    likesCount,
    commentsCount,
    shares,
    completionRate,
    engagementScore,
    thumbnailUrl: reel.thumbnailUrl || null,
    videoUrl: reel.videoUrl || null,
    hlsUrl: reel.hlsUrl || null,
    createdAt: safeDate(reel.createdAt),
    createdAtTimestamp: timestamp(reel.createdAt),
    publishedAt: safeDate(reel.publishedAt || reel.createdAt),
    publishedAtTimestamp: timestamp(reel.publishedAt || reel.createdAt)
  };

  await addDocuments('reels', [doc]);
  await upsertHashtags(hashtags, 'reel');
  return doc;
}

export async function indexReels(reels: IndexableReel[]) {
  const docs = reels.map((reel) => {
    const hashtags = cleanArray(reel.hashtags).map((tag) => tag.replace(/^#/, '').toLowerCase());
    const likesCount = Array.isArray(reel.likes) ? reel.likes.length : 0;
    const commentsCount = Array.isArray(reel.comments) ? reel.comments.length : 0;
    const shares = numberValue(reel.shares);
    const views = numberValue(reel.views);
    const completionRate = numberValue(reel.completionRate);
    const engagementScore = views + likesCount * 4 + commentsCount * 6 + shares * 8 + completionRate * 100;

    return {
      id: reel.id,
      caption: cleanString(reel.caption),
      hashtags,
      authorId: reel.authorId || reel.userId || null,
      authorUsername: cleanString(reel.authorUsername).toLowerCase(),
      authorAvatarUrl: reel.authorAvatarUrl || null,
      category: reel.category || null,
      visibility: reel.visibility || 'public',
      moderationStatus: reel.moderationStatus || 'approved',
      isDraft: boolValue(reel.isDraft),
      views,
      likesCount,
      commentsCount,
      shares,
      completionRate,
      engagementScore,
      thumbnailUrl: reel.thumbnailUrl || null,
      videoUrl: reel.videoUrl || null,
      hlsUrl: reel.hlsUrl || null,
      createdAt: safeDate(reel.createdAt),
      createdAtTimestamp: timestamp(reel.createdAt),
      publishedAt: safeDate(reel.publishedAt || reel.createdAt),
      publishedAtTimestamp: timestamp(reel.publishedAt || reel.createdAt)
    };
  });

  await addDocuments('reels', docs);
  await upsertHashtags([...new Set(docs.flatMap((doc) => doc.hashtags))], 'reel');
  return docs;
}

export async function indexStore(store: IndexableStore) {
  const address = store.address || {};
  const doc = {
    id: store.id,
    ownerId: store.ownerId || null,
    name: cleanString(store.name),
    slug: cleanString(store.slug).toLowerCase(),
    description: cleanString(store.description),
    logoUrl: store.logoUrl || null,
    bannerUrl: store.bannerUrl || null,
    isVerified: boolValue(store.isVerified),
    trustScore: numberValue(store.trustScore),
    rating: numberValue(store.rating),
    ratingCount: numberValue(store.ratingCount),
    city: cleanString(address.city),
    country: cleanString(address.country),
    tags: cleanArray(store.tags),
    categories: cleanArray(store.categories),
    status: store.status || 'active',
    createdAt: safeDate(store.createdAt),
    createdAtTimestamp: timestamp(store.createdAt)
  };

  return addDocuments('stores', [doc]);
}

export async function indexProduct(product: IndexableProduct) {
  const attributes = product.attributes && typeof product.attributes === 'object' ? product.attributes : {};
  const attributeText = Object.values(attributes).flatMap((value: any) => Array.isArray(value) ? value : [value]).filter(Boolean).join(' ');
  const inventory = numberValue(product.inventory);
  const doc = {
    id: product.id,
    storeId: product.storeId || null,
    storeName: cleanString(product.storeName),
    name: cleanString(product.name),
    slug: cleanString(product.slug).toLowerCase(),
    description: cleanString(product.description),
    price: numberValue(product.price),
    compareAtPrice: product.compareAtPrice == null ? null : numberValue(product.compareAtPrice),
    currency: product.currency || 'USD',
    inventory,
    inStock: inventory > 0,
    primaryMediaUrl: product.primaryMediaUrl || null,
    mediaUrls: cleanArray(product.mediaUrls),
    categoryIds: cleanArray(product.categoryIds),
    tags: cleanArray(product.tags),
    attributeText,
    isDigital: boolValue(product.isDigital),
    status: product.status || 'draft',
    viewCount: numberValue(product.viewCount),
    salesCount: numberValue(product.salesCount),
    rating: numberValue(product.rating),
    ratingCount: numberValue(product.ratingCount),
    createdAt: safeDate(product.createdAt),
    createdAtTimestamp: timestamp(product.createdAt)
  };

  return addDocuments('products', [doc]);
}

export async function removeFromSearch(indexName: SearchIndexName, id: string) {
  return deleteDocuments(indexName, [id]);
}

export async function removeManyFromSearch(indexName: SearchIndexName, ids: string[]) {
  return deleteDocuments(indexName, ids);
}

export async function searchUsers(query: string, params: SearchParams = {}) {
  return getIndex('users').search(query, {
    limit: 10,
    attributesToSearchOn: ['username', 'fullName', 'displayName', 'bio'],
    attributesToHighlight: ['username', 'fullName', 'displayName'],
    sort: ['isVerified:desc', 'followersCount:desc'],
    ...params
  });
}

export async function searchReels(query: string, params: SearchParams = {}) {
  return getIndex('reels').search(query, {
    limit: 10,
    attributesToSearchOn: ['caption', 'hashtags', 'authorUsername', 'category'],
    filter: ['visibility = public', 'moderationStatus = approved', 'isDraft = false'],
    sort: ['engagementScore:desc', 'publishedAtTimestamp:desc'],
    attributesToHighlight: ['caption', 'hashtags'],
    ...params
  });
}

export async function searchStores(query: string, params: SearchParams = {}) {
  return getIndex('stores').search(query, {
    limit: 10,
    attributesToSearchOn: ['name', 'slug', 'description', 'tags', 'categories', 'city', 'country'],
    filter: ['status != disabled'],
    sort: ['trustScore:desc', 'rating:desc'],
    attributesToHighlight: ['name', 'description'],
    ...params
  });
}

export async function searchProducts(query: string, params: SearchParams = {}) {
  return getIndex('products').search(query, {
    limit: 10,
    attributesToSearchOn: ['name', 'slug', 'description', 'storeName', 'tags', 'categoryIds', 'attributeText'],
    filter: ['status = active'],
    sort: ['salesCount:desc', 'rating:desc'],
    attributesToHighlight: ['name', 'description', 'storeName'],
    ...params
  });
}

export async function searchGlobal(query: string, filters: GlobalSearchFilters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit || 10), 1), 50);
  const offset = Math.max(Number(filters.offset || 0), 0);

  const [users, reels, stores, products] = await Promise.all([
    searchUsers(query, { limit, offset, filter: filters.userFilter }),
    searchReels(query, { limit, offset, filter: filters.reelFilter || ['visibility = public', 'moderationStatus = approved', 'isDraft = false'] }),
    searchStores(query, { limit, offset, filter: filters.storeFilter || ['status != disabled'] }),
    searchProducts(query, { limit, offset, filter: filters.productFilter || ['status = active'] })
  ]);

  return {
    query,
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
  if (!cleanQuery) return { users: [], hashtags: [], stores: [], products: [] };

  const [users, hashtags, stores, products] = await Promise.all([
    getIndex('users').search(cleanQuery, {
      limit,
      attributesToSearchOn: ['username', 'fullName', 'displayName'],
      attributesToRetrieve: ['id', 'username', 'fullName', 'displayName', 'avatarUrl', 'isVerified'],
      sort: ['isVerified:desc', 'followersCount:desc']
    }),
    getIndex('hashtags').search(cleanQuery.replace(/^#/, ''), {
      limit,
      attributesToRetrieve: ['id', 'tag', 'count', 'type'],
      sort: ['count:desc', 'lastUsedAtTimestamp:desc']
    }),
    getIndex('stores').search(cleanQuery, {
      limit,
      attributesToSearchOn: ['name', 'slug'],
      attributesToRetrieve: ['id', 'name', 'slug', 'logoUrl', 'isVerified', 'trustScore'],
      filter: ['status != disabled'],
      sort: ['trustScore:desc']
    }),
    getIndex('products').search(cleanQuery, {
      limit,
      attributesToSearchOn: ['name', 'slug', 'storeName'],
      attributesToRetrieve: ['id', 'name', 'slug', 'primaryMediaUrl', 'price', 'currency', 'storeName'],
      filter: ['status = active'],
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

export async function upsertHashtags(tags: string[], type = 'reel') {
  const normalized = [...new Set(cleanArray(tags).map((tag) => tag.replace(/^#/, '').toLowerCase()))];
  if (!normalized.length) return null;

  const docs = normalized.map((tag) => ({
    id: `${type}_${tag}`,
    tag: `#${tag}`,
    normalizedTag: tag,
    type,
    count: 1,
    lastUsedAt: new Date().toISOString(),
    lastUsedAtTimestamp: Date.now()
  }));

  return addDocuments('hashtags', docs);
}

export async function getTrendingKeywords(limit = 20) {
  const result = await getIndex('hashtags').search('', {
    limit,
    sort: ['count:desc', 'lastUsedAtTimestamp:desc'],
    attributesToRetrieve: ['tag', 'normalizedTag', 'type', 'count', 'lastUsedAt']
  });

  return result.hits;
}

export async function getTrendingReels(limit = 20) {
  const result = await getIndex('reels').search('', {
    limit,
    filter: ['visibility = public', 'moderationStatus = approved', 'isDraft = false'],
    sort: ['engagementScore:desc', 'publishedAtTimestamp:desc']
  });

  return result.hits;
}

export async function getPopularStores(limit = 20) {
  const result = await getIndex('stores').search('', {
    limit,
    filter: ['status != disabled'],
    sort: ['trustScore:desc', 'rating:desc', 'ratingCount:desc']
  });

  return result.hits;
}

export async function getPopularProducts(limit = 20) {
  const result = await getIndex('products').search('', {
    limit,
    filter: ['status = active'],
    sort: ['salesCount:desc', 'rating:desc', 'viewCount:desc']
  });

  return result.hits;
}

export async function clearSearchIndex(indexName: SearchIndexName) {
  const task = await getIndex(indexName).deleteAllDocuments();
  return waitForTask(task.taskUid);
}

export async function healthCheckSearch() {
  const health = await meili.health();
  const version = await meili.getVersion().catch(() => null);
  return {
    status: health.status,
    version,
    host
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
