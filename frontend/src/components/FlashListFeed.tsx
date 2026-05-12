import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  TouchableOpacity,
  AppState,
  AppStateStatus,
  NativeScrollEvent,
  NativeSyntheticEvent,
} from 'react-native';
import { FlashList, ListRenderItemInfo } from '@shopify/flash-list';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { api } from '../api/client';
import { ws } from '../api/ws';
import ReelCard from './ReelCard';
import { theme } from '../theme';

type Reel = {
  id: string;
  userId?: string;
  videoUrl?: string;
  hlsUrl?: string;
  thumbnailUrl?: string;
  caption?: string;
  likes?: string[];
  comments?: any[];
  shares?: number;
  views?: number;
  createdAt?: string;
  updatedAt?: string;
  [key: string]: any;
};

type FeedResponse = {
  reels?: Reel[];
  data?: Reel[];
  nextCursor?: string | null;
  cursor?: string | null;
  hasMore?: boolean;
};

type Props = {
  limit?: number;
  endpoint?: string;
  params?: Record<string, any>;
  feedKey?: string;
  autoPlay?: boolean;
  estimatedItemSize?: number;
  onReelPress?: (reel: Reel) => void;
  onReelVisible?: (reel: Reel, index: number) => void;
  ListHeaderComponent?: React.ReactElement | null;
};

const DEFAULT_LIMIT = 10;
const VIEWABILITY_CONFIG = {
  itemVisiblePercentThreshold: 75,
  minimumViewTime: 180,
};

const FeedSkeleton = memo(() => {
  return (
    <View style={styles.skeletonWrap}>
      {[0, 1, 2].map(i => (
        <View key={i} style={styles.skeletonCard}>
          <View style={styles.skeletonMedia} />
          <View style={styles.skeletonLineLarge} />
          <View style={styles.skeletonLineSmall} />
        </View>
      ))}
    </View>
  );
});

const EmptyState = memo(({ loading, error, onRetry }: { loading: boolean; error: string | null; onRetry: () => void }) => {
  if (loading) {
    return (
      <View style={styles.centerBox}>
        <ActivityIndicator size="large" color={theme.colors?.gold || '#D4A857'} />
        <Text style={styles.centerTitle}>Loading fresh reels</Text>
        <Text style={styles.centerSub}>Preparing your feed...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View style={styles.centerBox}>
        <View style={styles.iconBadge}>
          <Text style={styles.iconText}>⚡</Text>
        </View>
        <Text style={styles.centerTitle}>Feed refresh failed</Text>
        <Text style={styles.centerSub}>{error}</Text>
        <TouchableOpacity activeOpacity={0.85} style={styles.retryBtn} onPress={onRetry}>
          <Text style={styles.retryText}>TRY AGAIN</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.centerBox}>
      <View style={styles.iconBadge}>
        <Text style={styles.iconText}>✦</Text>
      </View>
      <Text style={styles.centerTitle}>No reels yet</Text>
      <Text style={styles.centerSub}>Follow creators or post your first reel to light up the feed.</Text>
      <TouchableOpacity activeOpacity={0.85} style={styles.retryBtn} onPress={onRetry}>
        <Text style={styles.retryText}>REFRESH</Text>
      </TouchableOpacity>
    </View>
  );
});

const FooterLoader = memo(({ loadingMore, hasMore }: { loadingMore: boolean; hasMore: boolean }) => {
  if (loadingMore) {
    return (
      <View style={styles.footer}>
        <ActivityIndicator size="small" color={theme.colors?.neon || '#00E0FF'} />
        <Text style={styles.footerText}>Loading more...</Text>
      </View>
    );
  }

  if (!hasMore) {
    return (
      <View style={styles.footer}>
        <Text style={styles.footerEnd}>You are all caught up</Text>
      </View>
    );
  }

  return <View style={styles.footerSpacer} />;
});

function normalizeResponse(payload: FeedResponse | any): { reels: Reel[]; nextCursor: string | null; hasMore: boolean } {
  const reels = Array.isArray(payload?.reels) ? payload.reels : Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const nextCursor = payload?.nextCursor ?? payload?.cursor ?? null;
  const hasMore = typeof payload?.hasMore === 'boolean' ? payload.hasMore : Boolean(nextCursor) || reels.length > 0;
  return { reels, nextCursor, hasMore };
}

function mergeUniqueReels(prev: Reel[], next: Reel[]) {
  const map = new Map<string, Reel>();
  for (const item of prev) {
    if (item?.id) map.set(item.id, item);
  }
  for (const item of next) {
    if (item?.id) map.set(item.id, { ...(map.get(item.id) || {}), ...item });
  }
  return Array.from(map.values());
}

function removeReelById(prev: Reel[], reelId: string) {
  return prev.filter(item => item.id !== reelId);
}

function patchReel(prev: Reel[], reelId: string, patch: Partial<Reel>) {
  return prev.map(item => (item.id === reelId ? { ...item, ...patch } : item));
}

const FlashListFeed = memo(function FlashListFeed({
  limit = DEFAULT_LIMIT,
  endpoint = '/reels/feed',
  params = {},
  feedKey = 'main',
  autoPlay = true,
  estimatedItemSize = 640,
  onReelPress,
  onReelVisible,
  ListHeaderComponent = null,
}: Props) {
  const isFocused = useIsFocused();
  const listRef = useRef<FlashList<Reel>>(null);
  const socketRef = useRef<any>(null);
  const mountedRef = useRef(true);
  const loadingRef = useRef(false);
  const cursorRef = useRef<string | null>(null);
  const hasMoreRef = useRef(true);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const lastFetchAtRef = useRef(0);
  const visibleReelIdRef = useRef<string | null>(null);
  const scrollOffsetRef = useRef(0);

  const [data, setData] = useState<Reel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleReelId, setVisibleReelId] = useState<string | null>(null);

  const requestParams = useMemo(() => ({ ...params, limit, feedKey }), [params, limit, feedKey]);

  const fetchFeed = useCallback(
    async ({ refresh = false, silent = false }: { refresh?: boolean; silent?: boolean } = {}) => {
      if (loadingRef.current) return;
      if (!refresh && !hasMoreRef.current) return;

      const now = Date.now();
      if (!refresh && now - lastFetchAtRef.current < 500) return;

      loadingRef.current = true;
      lastFetchAtRef.current = now;

      if (refresh) {
        cursorRef.current = null;
        hasMoreRef.current = true;
        setHasMore(true);
        if (!silent) setRefreshing(true);
      } else if (data.length > 0) {
        setLoadingMore(true);
      } else if (!silent) {
        setLoading(true);
      }

      try {
        const res = await api.get(endpoint, {
          params: {
            ...requestParams,
            cursor: refresh ? undefined : cursorRef.current || undefined,
          },
        });

        const normalized = normalizeResponse(res.data);
        cursorRef.current = normalized.nextCursor;
        hasMoreRef.current = normalized.hasMore && normalized.reels.length >= 0;

        if (!mountedRef.current) return;

        setData(prev => (refresh ? mergeUniqueReels([], normalized.reels) : mergeUniqueReels(prev, normalized.reels)));
        setHasMore(hasMoreRef.current);
        setError(null);
      } catch (err: any) {
        if (!mountedRef.current) return;
        const message = err?.response?.data?.error || err?.message || 'Please check your connection and try again.';
        setError(message);
      } finally {
        loadingRef.current = false;
        if (!mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [endpoint, requestParams, data.length],
  );

  const refreshFeed = useCallback(() => fetchFeed({ refresh: true }), [fetchFeed]);

  const loadMore = useCallback(() => {
    if (!loadingRef.current && hasMoreRef.current && data.length > 0) {
      fetchFeed({ refresh: false, silent: true });
    }
  }, [fetchFeed, data.length]);

  const handleScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffsetRef.current = event.nativeEvent.contentOffset.y;
  }, []);

  const handleViewableItemsChanged = useRef(({ viewableItems }: any) => {
    const first = viewableItems?.find((v: any) => v?.isViewable && v?.item?.id);
    if (!first?.item?.id) return;

    const reelId = first.item.id;
    visibleReelIdRef.current = reelId;
    setVisibleReelId(reelId);
    onReelVisible?.(first.item, first.index ?? 0);

    socketRef.current?.emit?.('reel:viewing', {
      reelId,
      index: first.index ?? 0,
      feedKey,
      timestamp: Date.now(),
    });
  }).current;

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<Reel>) => {
      return (
        <ReelCard
          reel={item}
          index={index}
          isActive={autoPlay && isFocused && visibleReelId === item.id && appStateRef.current === 'active'}
          onPress={() => onReelPress?.(item)}
        />
      );
    },
    [autoPlay, isFocused, visibleReelId, onReelPress],
  );

  const keyExtractor = useCallback((item: Reel) => item.id, []);

  const getItemType = useCallback((item: Reel) => {
    if (item?.isAd) return 'ad';
    if (item?.mediaType === 'image') return 'image';
    return 'video';
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    fetchFeed({ refresh: true });

    return () => {
      mountedRef.current = false;
    };
  }, [fetchFeed]);

  useFocusEffect(
    useCallback(() => {
      if (data.length === 0 && !loadingRef.current) {
        fetchFeed({ refresh: true, silent: true });
      }

      socketRef.current?.emit?.('feed:active', {
        feedKey,
        visibleReelId: visibleReelIdRef.current,
        timestamp: Date.now(),
      });

      return () => {
        socketRef.current?.emit?.('feed:inactive', {
          feedKey,
          visibleReelId: visibleReelIdRef.current,
          timestamp: Date.now(),
        });
      };
    }, [data.length, fetchFeed, feedKey]),
  );

  useEffect(() => {
    let cleanup = false;

    (async () => {
      try {
        const socket = await ws();
        if (cleanup) return;

        socketRef.current = socket;

        socket.emit('feed:join', { feedKey });

        socket.on('reel:new', (reel: Reel) => {
          if (!reel?.id) return;
          setData(prev => mergeUniqueReels([reel], prev));
        });

        socket.on('reel:updated', ({ reelId, updates }: { reelId: string; updates: Partial<Reel> }) => {
          if (!reelId) return;
          setData(prev => patchReel(prev, reelId, updates || {}));
        });

        socket.on('reel:deleted', ({ reelId }: { reelId: string }) => {
          if (!reelId) return;
          setData(prev => removeReelById(prev, reelId));
        });

        socket.on('reel:engagement', ({ reelId, likes, comments, shares, views }: any) => {
          if (!reelId) return;
          setData(prev => patchReel(prev, reelId, { likes, comments, shares, views }));
        });

        socket.on('feed:refresh', () => {
          fetchFeed({ refresh: true, silent: true });
        });
      } catch {}
    })();

    return () => {
      cleanup = true;
      const socket = socketRef.current;
      socket?.emit?.('feed:leave', { feedKey });
      socket?.off?.('reel:new');
      socket?.off?.('reel:updated');
      socket?.off?.('reel:deleted');
      socket?.off?.('reel:engagement');
      socket?.off?.('feed:refresh');
      socketRef.current = null;
    };
  }, [feedKey, fetchFeed]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', nextState => {
      const prev = appStateRef.current;
      appStateRef.current = nextState;

      if (prev !== 'active' && nextState === 'active') {
        socketRef.current?.emit?.('feed:resume', {
          feedKey,
          visibleReelId: visibleReelIdRef.current,
          offset: scrollOffsetRef.current,
          timestamp: Date.now(),
        });
      }

      if (nextState !== 'active') {
        socketRef.current?.emit?.('feed:pause', {
          feedKey,
          visibleReelId: visibleReelIdRef.current,
          offset: scrollOffsetRef.current,
          timestamp: Date.now(),
        });
      }
    });

    return () => sub.remove();
  }, [feedKey]);

  const listEmpty = useMemo(() => {
    if (loading && data.length === 0) return <FeedSkeleton />;
    return <EmptyState loading={loading} error={error} onRetry={refreshFeed} />;
  }, [loading, data.length, error, refreshFeed]);

  return (
    <View style={styles.container}>
      <FlashList
        ref={listRef}
        data={data}
        extraData={visibleReelId}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        estimatedItemSize={estimatedItemSize}
        getItemType={getItemType}
        onEndReached={loadMore}
        onEndReachedThreshold={0.7}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        viewabilityConfig={VIEWABILITY_CONFIG}
        onViewableItemsChanged={handleViewableItemsChanged}
        showsVerticalScrollIndicator={false}
        removeClippedSubviews
        contentContainerStyle={styles.content}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={refreshFeed}
            tintColor={theme.colors?.gold || '#D4A857'}
            colors={[theme.colors?.gold || '#D4A857', theme.colors?.neon || '#00E0FF']}
            progressBackgroundColor="#111"
          />
        }
        ListHeaderComponent={ListHeaderComponent}
        ListEmptyComponent={listEmpty}
        ListFooterComponent={<FooterLoader loadingMore={loadingMore} hasMore={hasMore && data.length > 0} />}
      />
    </View>
  );
});

export default FlashListFeed;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#050505',
  },
  content: {
    paddingBottom: 28,
  },
  centerBox: {
    minHeight: 420,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  centerTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
    marginTop: 12,
    textAlign: 'center',
  },
  centerSub: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 13,
    fontWeight: '500',
    marginTop: 6,
    lineHeight: 19,
    textAlign: 'center',
  },
  iconBadge: {
    width: 58,
    height: 58,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,168,87,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.45)',
  },
  iconText: {
    fontSize: 28,
    color: '#D4A857',
    fontWeight: '900',
  },
  retryBtn: {
    marginTop: 18,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: theme.colors?.gold || '#D4A857',
    shadowColor: '#000',
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 4,
  },
  retryText: {
    color: '#050505',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.7,
  },
  footer: {
    paddingVertical: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  footerText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    fontWeight: '600',
    marginTop: 8,
  },
  footerEnd: {
    color: 'rgba(255,255,255,0.42)',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  footerSpacer: {
    height: 24,
  },
  skeletonWrap: {
    padding: 14,
  },
  skeletonCard: {
    height: 610,
    borderRadius: 24,
    backgroundColor: '#111',
    marginBottom: 18,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)',
  },
  skeletonMedia: {
    flex: 1,
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  skeletonLineLarge: {
    width: '72%',
    height: 14,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.08)',
    marginTop: 14,
    marginLeft: 14,
  },
  skeletonLineSmall: {
    width: '44%',
    height: 11,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginTop: 10,
    marginLeft: 14,
    marginBottom: 16,
  },
});
