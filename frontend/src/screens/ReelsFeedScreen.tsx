import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Image,
  Animated,
  Share,
  Alert,
  Pressable,
  ActivityIndicator,
  Platform,
  StatusBar,
  NativeSyntheticEvent,
  NativeScrollEvent
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import { Ionicons, Feather, MaterialCommunityIcons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { useAuth } from '../store/auth';
import { theme } from '../theme';
import { formatNumber, formatTimeAgo } from '../utils/format';

const { height: SCREEN_HEIGHT, width: SCREEN_WIDTH } = Dimensions.get('window');
const REEL_HEIGHT = SCREEN_HEIGHT;
const PROGRESS_FLUSH_MS = 3500;

interface ReelAuthor {
  id: string;
  username: string;
  avatarUrl?: string;
  isVerified: boolean;
  followers?: string[];
  isFollowing?: boolean;
}

interface ReelMusic {
  title: string;
  artist: string;
}

interface ReelCdnUrls {
  hls?: string;
  dash?: string;
  mp4_720?: string;
  mp4_1080?: string;
}

interface Reel {
  id: string;
  videoUrl: string;
  thumbnailUrl?: string;
  cdnUrls?: ReelCdnUrls;
  duration: number;
  caption?: string;
  hashtags?: string[];
  music?: ReelMusic;
  author: ReelAuthor;
  likes?: string[];
  comments?: any[];
  shares: number;
  views: number;
  saves?: string[];
  isLiked: boolean;
  isSaved: boolean;
  watchProgress?: number;
  trendingScore?: number;
  createdAt: string;
}

interface ReelCardProps {
  reel: Reel;
  isActive: boolean;
  index: number;
  userId?: string;
  navigation: any;
  videoRefs: React.MutableRefObject<Map<string, Video>>;
  onLike: (reel: Reel) => void;
  onSave: (reel: Reel) => void;
  onShare: (reel: Reel) => void;
  onFollow: (reel: Reel) => void;
  onProgress: (reel: Reel, status: AVPlaybackStatus) => void;
  onOpenComments: (reel: Reel) => void;
}

function IconButton({
  icon,
  family = 'Ionicons',
  active,
  count,
  label,
  onPress,
  disabled
}: {
  icon: string;
  family?: 'Ionicons' | 'Feather' | 'MaterialCommunityIcons';
  active?: boolean;
  count?: number | string;
  label?: string;
  onPress?: () => void;
  disabled?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const press = () => {
    Animated.sequence([
      Animated.spring(scale, { toValue: 0.86, useNativeDriver: true, speed: 28, bounciness: 8 }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 10 })
    ]).start();
    onPress?.();
  };

  const IconPack = family === 'Feather' ? Feather : family === 'MaterialCommunityIcons' ? MaterialCommunityIcons : Ionicons;

  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <TouchableOpacity activeOpacity={0.78} disabled={disabled} onPress={press} style={styles.actionButton}>
        <BlurView intensity={28} tint="dark" style={[styles.actionCircle, active && styles.actionCircleActive]}>
          <IconPack name={icon as any} size={24} color={active ? theme.colors.gold : '#FFFFFF'} />
        </BlurView>
        {typeof count !== 'undefined' && <Text style={styles.actionCount}>{typeof count === 'number' ? formatNumber(count) : count}</Text>}
        {!!label && <Text style={styles.actionLabel}>{label}</Text>}
      </TouchableOpacity>
    </Animated.View>
  );
}

function ReelCard({
  reel,
  isActive,
  index,
  userId,
  navigation,
  videoRefs,
  onLike,
  onSave,
  onShare,
  onFollow,
  onProgress,
  onOpenComments
}: ReelCardProps) {
  const fade = useRef(new Animated.Value(0)).current;
  const captionOpacity = useRef(new Animated.Value(0)).current;
  const [paused, setPaused] = useState(false);
  const [buffering, setBuffering] = useState(false);
  const [muted, setMuted] = useState(false);
  const [showPause, setShowPause] = useState(false);

  const videoSource = useMemo(() => {
    return reel.cdnUrls?.mp4_1080 || reel.cdnUrls?.mp4_720 || reel.videoUrl;
  }, [reel]);

  const likeCount = reel.likes?.length || 0;
  const commentCount = reel.comments?.length || 0;
  const saveCount = reel.saves?.length || 0;
  const followerCount = reel.author.followers?.length || 0;
  const hashtags = reel.hashtags?.slice(0, 4).map(tag => `#${tag}`).join(' ') || '';

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.timing(captionOpacity, { toValue: 1, duration: 520, delay: 120, useNativeDriver: true })
    ]).start();
  }, [fade, captionOpacity]);

  useEffect(() => {
    const video = videoRefs.current.get(reel.id);
    if (!video) return;
    if (isActive && !paused) {
      video.playAsync().catch(() => {});
    } else {
      video.pauseAsync().catch(() => {});
    }
  }, [isActive, paused, reel.id, videoRefs]);

  const togglePlay = async () => {
    const nextPaused = !paused;
    setPaused(nextPaused);
    setShowPause(true);
    setTimeout(() => setShowPause(false), 650);
    const video = videoRefs.current.get(reel.id);
    if (!video) return;
    if (nextPaused) await video.pauseAsync().catch(() => {});
    else await video.playAsync().catch(() => {});
  };

  return (
    <View style={styles.reelContainer}>
      <Pressable style={styles.videoTouch} onPress={togglePlay}>
        <Video
          ref={(ref) => {
            if (ref) videoRefs.current.set(reel.id, ref);
          }}
          source={{ uri: videoSource }}
          style={styles.video}
          resizeMode={ResizeMode.COVER}
          shouldPlay={isActive && !paused}
          isLooping
          isMuted={muted}
          useNativeControls={false}
          posterSource={reel.thumbnailUrl ? { uri: reel.thumbnailUrl } : undefined}
          usePoster={!!reel.thumbnailUrl}
          posterStyle={styles.video}
          onPlaybackStatusUpdate={(status) => {
            if ('isLoaded' in status && status.isLoaded) {
              setBuffering(!!status.isBuffering);
            }
            onProgress(reel, status);
          }}
        />

        <LinearGradient colors={['rgba(0,0,0,0.34)', 'rgba(0,0,0,0.02)', 'rgba(0,0,0,0.82)']} locations={[0, 0.45, 1]} style={styles.gradient} />

        {buffering && isActive && (
          <View style={styles.loaderWrap}>
            <ActivityIndicator size="large" color={theme.colors.gold} />
          </View>
        )}

        {showPause && (
          <View style={styles.pauseOverlay}>
            <BlurView intensity={36} tint="dark" style={styles.pauseCircle}>
              <Ionicons name={paused ? 'play' : 'pause'} size={38} color="#FFFFFF" />
            </BlurView>
          </View>
        )}
      </Pressable>

      <Animated.View style={[styles.topBar, { opacity: fade }]}>
        <BlurView intensity={22} tint="dark" style={styles.feedPill}>
          <Text style={styles.feedTitle}>For You</Text>
        </BlurView>
        <View style={styles.topActions}>
          <TouchableOpacity activeOpacity={0.8} onPress={() => setMuted(prev => !prev)} style={styles.topIconButton}>
            <Ionicons name={muted ? 'volume-mute' : 'volume-high'} size={20} color="#FFFFFF" />
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('ReelsSearch')} style={styles.topIconButton}>
            <Ionicons name="search" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
      </Animated.View>

      <Animated.View style={[styles.sideRail, { opacity: fade }]}>
        <TouchableOpacity activeOpacity={0.85} onPress={() => navigation.navigate('UserProfile', { userId: reel.author.id })} style={styles.avatarShell}>
          <Image source={{ uri: reel.author.avatarUrl || 'https://ui-avatars.com/api/?name=User&background=111827&color=fff' }} style={styles.sideAvatar} />
          {reel.author.isVerified && (
            <View style={styles.verifiedBadge}>
              <Ionicons name="checkmark" size={10} color="#07111F" />
            </View>
          )}
        </TouchableOpacity>

        <IconButton icon={reel.isLiked ? 'heart' : 'heart-outline'} active={reel.isLiked} count={likeCount} onPress={() => onLike(reel)} />
        <IconButton icon="message-circle" family="Feather" count={commentCount} onPress={() => onOpenComments(reel)} />
        <IconButton icon="send" family="Feather" count={reel.shares || 0} onPress={() => onShare(reel)} />
        <IconButton icon={reel.isSaved ? 'bookmark' : 'bookmark-outline'} active={reel.isSaved} count={saveCount || undefined} onPress={() => onSave(reel)} />
        <IconButton icon="more-horizontal" family="Feather" onPress={() => navigation.navigate('ReelOptions', { reelId: reel.id })} />

        {reel.music && (
          <TouchableOpacity activeOpacity={0.8} onPress={() => navigation.navigate('MusicReels', { music: reel.music })} style={styles.musicDisc}>
            <MaterialCommunityIcons name="music-note" size={20} color="#FFFFFF" />
          </TouchableOpacity>
        )}
      </Animated.View>

      <Animated.View style={[styles.infoPanel, { opacity: captionOpacity, transform: [{ translateY: captionOpacity.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }]}>
        <TouchableOpacity activeOpacity={0.86} onPress={() => navigation.navigate('UserProfile', { userId: reel.author.id })} style={styles.authorRow}>
          <Image source={{ uri: reel.author.avatarUrl || 'https://ui-avatars.com/api/?name=User&background=111827&color=fff' }} style={styles.avatar} />
          <View style={styles.authorTextBlock}>
            <View style={styles.usernameRow}>
              <Text style={styles.username}>@{reel.author.username}</Text>
              {reel.author.isVerified && <Ionicons name="checkmark-circle" size={15} color={theme.colors.neon} style={styles.usernameVerify} />}
            </View>
            <Text style={styles.metaText}>{formatNumber(followerCount)} followers · {formatTimeAgo(reel.createdAt)}</Text>
          </View>
          {reel.author.id !== userId && (
            <TouchableOpacity activeOpacity={0.82} onPress={() => onFollow(reel)} style={[styles.followBtn, reel.author.isFollowing && styles.followingBtn]}>
              <Text style={[styles.followText, reel.author.isFollowing && styles.followingText]}>{reel.author.isFollowing ? 'Following' : 'Follow'}</Text>
            </TouchableOpacity>
          )}
        </TouchableOpacity>

        {!!reel.caption && <Text style={styles.caption} numberOfLines={3}>{reel.caption}</Text>}
        {!!hashtags && <Text style={styles.hashtags} numberOfLines={2}>{hashtags}</Text>}

        <View style={styles.bottomMetaRow}>
          {reel.music && (
            <TouchableOpacity activeOpacity={0.82} onPress={() => navigation.navigate('MusicReels', { music: reel.music })} style={styles.musicRow}>
              <MaterialCommunityIcons name="music-note-eighth" size={16} color="#FFFFFF" />
              <Text style={styles.musicText} numberOfLines={1}>{reel.music.title} · {reel.music.artist}</Text>
            </TouchableOpacity>
          )}

          <View style={styles.viewsPill}>
            <Feather name="eye" size={13} color="#FFFFFF" />
            <Text style={styles.viewsText}>{formatNumber(reel.views || 0)}</Text>
          </View>
        </View>

        <View style={styles.progressBar}>
          <Animated.View style={[styles.progressFill, { width: `${Math.max(0, Math.min(1, reel.watchProgress || 0)) * 100}%` }]} />
        </View>
      </Animated.View>
    </View>
  );
}

export default function ReelsFeedScreen({ navigation }: any) {
  const { user } = useAuth();
  const [reels, setReels] = useState<Reel[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [activeReelId, setActiveReelId] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);

  const videoRefs = useRef<Map<string, Video>>(new Map());
  const socketRef = useRef<any>(null);
  const flatListRef = useRef<FlatList<Reel>>(null);
  const progressCache = useRef<Record<string, { progress: number; position: number; completed: boolean; duration: number; lastSentAt: number }>>({});
  const activeReelIdRef = useRef<string | null>(null);
  const loadingRef = useRef(false);

  const normalizeReel = useCallback((reel: Reel): Reel => {
    return {
      ...reel,
      likes: reel.likes || [],
      comments: reel.comments || [],
      shares: reel.shares || 0,
      views: reel.views || 0,
      saves: reel.saves || [],
      hashtags: reel.hashtags || [],
      watchProgress: reel.watchProgress || 0,
      author: {
        ...reel.author,
        followers: reel.author.followers || []
      }
    };
  }, []);

  const loadFeed = useCallback(async (nextCursor?: string | null, replace = false) => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);

    try {
      const { data } = await api.get('/reels/feed', {
        params: {
          cursor: nextCursor || undefined,
          limit: 7,
          forYou: true
        }
      });

      const incoming = (data?.reels || []).map(normalizeReel);

      setReels(prev => {
        const merged = replace || !nextCursor ? incoming : [...prev, ...incoming];
        const seen = new Set<string>();
        return merged.filter(reel => {
          if (seen.has(reel.id)) return false;
          seen.add(reel.id);
          return true;
        });
      });

      setCursor(data?.nextCursor || null);
      setHasMore(!!data?.hasMore);
    } catch (err) {
      Alert.alert('Reels unavailable', 'Feed load nahi ho paya. Network ya server check karo.');
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [normalizeReel]);

  const flushProgress = useCallback(async (reelId: string, force = false) => {
    const item = progressCache.current[reelId];
    if (!item) return;

    const now = Date.now();
    if (!force && now - item.lastSentAt < PROGRESS_FLUSH_MS) return;

    progressCache.current[reelId] = { ...item, lastSentAt: now };

    socketRef.current?.emit?.('reel:watching', {
      reelId,
      position: item.position,
      duration: item.duration,
      progress: item.progress,
      completed: item.completed,
      sessionId: `${user?.id || 'guest'}:${reelId}`
    });

    api.post(`/reels/${reelId}/watch`, {
      progress: item.progress,
      position: item.position,
      completed: item.completed
    }).catch(() => {});
  }, [user?.id]);

  const pauseAllExcept = useCallback(async (reelId?: string | null) => {
    const tasks: Promise<any>[] = [];
    videoRefs.current.forEach((video, id) => {
      if (id !== reelId) tasks.push(video.pauseAsync().catch(() => {}));
    });
    await Promise.all(tasks);
  }, []);

  const onViewableItemsChanged = useRef(({ viewableItems }: any) => {
    const visible = viewableItems?.find((item: any) => item.isViewable)?.item as Reel | undefined;
    if (!visible) return;

    const previousId = activeReelIdRef.current;
    if (previousId && previousId !== visible.id) {
      flushProgress(previousId, true);
      socketRef.current?.emit?.('reel:leave', { reelId: previousId });
    }

    activeReelIdRef.current = visible.id;
    setActiveReelId(visible.id);

    const nextIndex = reels.findIndex(item => item.id === visible.id);
    if (nextIndex >= 0) setActiveIndex(nextIndex);

    pauseAllExcept(visible.id);
    socketRef.current?.emit?.('reel:join', { reelId: visible.id });
    socketRef.current?.emit?.('reel:heartbeat', { reelId: visible.id });

    const video = videoRefs.current.get(visible.id);
    video?.playAsync?.().catch(() => {});
  }).current;

  useFocusEffect(
    useCallback(() => {
      let mounted = true;

      loadFeed(null, true);

      (async () => {
        const socket = await ws();
        if (!mounted) return;

        socketRef.current = socket;

        socket.on('feed:new_reel', ({ reel }: { reel: Reel; reason?: string }) => {
          setReels(prev => {
            const normalized = normalizeReel(reel);
            if (prev.some(item => item.id === normalized.id)) return prev;
            return [normalized, ...prev];
          });
        });

        socket.on('reel:like_update', ({ reelId, count }: { reelId: string; count: number }) => {
          setReels(prev => prev.map(reel => reel.id === reelId ? { ...reel, likes: Array(Math.max(0, count)).fill('remote') } : reel));
        });

        socket.on('reel:stats', ({ reelId, stats }: { reelId: string; stats: any }) => {
          setReels(prev => prev.map(reel => {
            if (reel.id !== reelId) return reel;
            return {
              ...reel,
              views: stats?.views ?? reel.views,
              shares: stats?.shares ?? reel.shares,
              likes: typeof stats?.likes === 'number' ? Array(stats.likes).fill('remote') : reel.likes,
              comments: typeof stats?.comments === 'number' ? Array(stats.comments).fill({}) : reel.comments,
              saves: typeof stats?.saves === 'number' ? Array(stats.saves).fill('remote') : reel.saves
            };
          }));
        });
      })();

      return () => {
        mounted = false;
        const current = activeReelIdRef.current;
        if (current) flushProgress(current, true);
        videoRefs.current.forEach(video => video.pauseAsync?.().catch(() => {}));
        socketRef.current?.emit?.('reel:leave', { reelId: current });
        socketRef.current?.off?.('feed:new_reel');
        socketRef.current?.off?.('reel:like_update');
        socketRef.current?.off?.('reel:stats');
      };
    }, [flushProgress, loadFeed, normalizeReel])
  );

  useEffect(() => {
    const timer = setInterval(() => {
      const current = activeReelIdRef.current;
      if (current) {
        flushProgress(current);
        socketRef.current?.emit?.('reel:heartbeat', { reelId: current });
      }
    }, PROGRESS_FLUSH_MS);

    return () => clearInterval(timer);
  }, [flushProgress]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    setCursor(null);
    setHasMore(true);
    loadFeed(null, true);
  }, [loadFeed]);

  const toggleLike = useCallback(async (reel: Reel) => {
    const nextLiked = !reel.isLiked;

    setReels(prev => prev.map(item => {
      if (item.id !== reel.id) return item;
      const likes = item.likes || [];
      return {
        ...item,
        isLiked: nextLiked,
        likes: nextLiked ? [...likes, user?.id || 'local'] : likes.filter(id => id !== user?.id && id !== 'local')
      };
    }));

    socketRef.current?.emit?.('reel:engage', { reelId: reel.id, action: nextLiked ? 'like' : 'unlike' });

    try {
      await api.post(`/reels/${reel.id}/like`, { remove: reel.isLiked });
    } catch {
      setReels(prev => prev.map(item => item.id === reel.id ? reel : item));
    }
  }, [user?.id]);

  const toggleSave = useCallback(async (reel: Reel) => {
    const nextSaved = !reel.isSaved;

    setReels(prev => prev.map(item => {
      if (item.id !== reel.id) return item;
      const saves = item.saves || [];
      return {
        ...item,
        isSaved: nextSaved,
        saves: nextSaved ? [...saves, user?.id || 'local'] : saves.filter(id => id !== user?.id && id !== 'local')
      };
    }));

    socketRef.current?.emit?.('reel:engage', { reelId: reel.id, action: nextSaved ? 'save' : 'unsave' });

    try {
      await api.post(`/reels/${reel.id}/save`, { remove: reel.isSaved });
    } catch {
      setReels(prev => prev.map(item => item.id === reel.id ? reel : item));
    }
  }, [user?.id]);

  const handleShare = useCallback(async (reel: Reel) => {
    try {
      await Share.share({
        message: `Watch this reel by @${reel.author.username}`,
        url: reel.videoUrl,
        title: reel.caption || 'Reel'
      });

      setReels(prev => prev.map(item => item.id === reel.id ? { ...item, shares: (item.shares || 0) + 1 } : item));
      socketRef.current?.emit?.('reel:engage', { reelId: reel.id, action: 'share' });
      await api.post(`/reels/${reel.id}/share`, { platform: Platform.OS });
    } catch {}
  }, []);

  const handleFollow = useCallback(async (reel: Reel) => {
    const nextFollowing = !reel.author.isFollowing;

    setReels(prev => prev.map(item => {
      if (item.author.id !== reel.author.id) return item;
      return {
        ...item,
        author: {
          ...item.author,
          isFollowing: nextFollowing,
          followers: nextFollowing ? [...(item.author.followers || []), user?.id || 'local'] : (item.author.followers || []).filter(id => id !== user?.id && id !== 'local')
        }
      };
    }));

    try {
      await api.post(`/users/${reel.author.id}/follow`, { remove: reel.author.isFollowing });
    } catch {
      setReels(prev => prev.map(item => item.id === reel.id ? reel : item));
    }
  }, [user?.id]);

  const handleProgress = useCallback((reel: Reel, status: AVPlaybackStatus) => {
    if (!('isLoaded' in status) || !status.isLoaded || activeReelIdRef.current !== reel.id) return;

    const duration = Math.max(1, (status.durationMillis || reel.duration * 1000 || 1) / 1000);
    const position = Math.max(0, (status.positionMillis || 0) / 1000);
    const progress = Math.max(0, Math.min(1, position / duration));
    const completed = progress >= 0.92 || !!status.didJustFinish;

    progressCache.current[reel.id] = {
      progress,
      position,
      completed,
      duration,
      lastSentAt: progressCache.current[reel.id]?.lastSentAt || 0
    };

    setReels(prev => prev.map(item => item.id === reel.id ? { ...item, watchProgress: progress } : item));

    if (completed) flushProgress(reel.id, true);
  }, [flushProgress]);

  const openComments = useCallback((reel: Reel) => {
    navigation.navigate('ReelComments', { reelId: reel.id });
  }, [navigation]);

  const onMomentumScrollEnd = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const index = Math.round(event.nativeEvent.contentOffset.y / REEL_HEIGHT);
    setActiveIndex(index);
  }, []);

  const getItemLayout = useCallback((_: ArrayLike<Reel> | null | undefined, index: number) => ({
    length: REEL_HEIGHT,
    offset: REEL_HEIGHT * index,
    index
  }), []);

  const renderReel = useCallback(({ item, index }: { item: Reel; index: number }) => (
    <ReelCard
      reel={item}
      index={index}
      isActive={activeReelId === item.id || (!activeReelId && index === 0)}
      userId={user?.id}
      navigation={navigation}
      videoRefs={videoRefs}
      onLike={toggleLike}
      onSave={toggleSave}
      onShare={handleShare}
      onFollow={handleFollow}
      onProgress={handleProgress}
      onOpenComments={openComments}
    />
  ), [activeReelId, handleFollow, handleProgress, handleShare, navigation, openComments, toggleLike, toggleSave, user?.id]);

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#000000" />

      <FlatList
        ref={flatListRef}
        data={reels}
        keyExtractor={item => item.id}
        renderItem={renderReel}
        pagingEnabled
        snapToInterval={REEL_HEIGHT}
        snapToAlignment="start"
        decelerationRate="fast"
        showsVerticalScrollIndicator={false}
        onViewableItemsChanged={onViewableItemsChanged}
        viewabilityConfig={{ itemVisiblePercentThreshold: 72 }}
        onMomentumScrollEnd={onMomentumScrollEnd}
        onEndReached={() => hasMore && !loading && loadFeed(cursor)}
        onEndReachedThreshold={0.65}
        getItemLayout={getItemLayout}
        refreshing={refreshing}
        onRefresh={onRefresh}
        removeClippedSubviews
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={5}
        ListEmptyComponent={
          !loading ? (
            <View style={styles.emptyState}>
              <MaterialCommunityIcons name="movie-open-play-outline" size={54} color="rgba(255,255,255,0.7)" />
              <Text style={styles.emptyTitle}>No reels yet</Text>
              <Text style={styles.emptyText}>Fresh content yahan appear hoga.</Text>
            </View>
          ) : null
        }
        ListFooterComponent={
          loading && reels.length > 0 ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator color={theme.colors.gold} />
            </View>
          ) : null
        }
      />

      {loading && reels.length === 0 && (
        <View style={styles.initialLoader}>
          <ActivityIndicator size="large" color={theme.colors.gold} />
          <Text style={styles.initialLoaderText}>Loading premium feed</Text>
        </View>
      )}

      <TouchableOpacity activeOpacity={0.86} style={styles.createBtn} onPress={() => navigation.navigate('ReelCreator')}>
        <LinearGradient colors={[theme.colors.neon, theme.colors.gold]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.createGradient}>
          <Feather name="plus" size={28} color="#07111F" />
        </LinearGradient>
      </TouchableOpacity>

      <View style={styles.indexPill}>
        <Text style={styles.indexText}>{reels.length ? activeIndex + 1 : 0}/{reels.length}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000000'
  },
  reelContainer: {
    width: SCREEN_WIDTH,
    height: REEL_HEIGHT,
    backgroundColor: '#000000',
    overflow: 'hidden'
  },
  videoTouch: {
    width: '100%',
    height: '100%'
  },
  video: {
    width: '100%',
    height: '100%'
  },
  gradient: {
    ...StyleSheet.absoluteFillObject
  },
  loaderWrap: {
    position: 'absolute',
    top: '47%',
    alignSelf: 'center'
  },
  pauseOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center'
  },
  pauseCircle: {
    width: 86,
    height: 86,
    borderRadius: 43,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)'
  },
  topBar: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 58 : 34,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  feedPill: {
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 999,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)'
  },
  feedTitle: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: 0.2
  },
  topActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  topIconButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.34)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  sideRail: {
    position: 'absolute',
    right: 12,
    bottom: 128,
    alignItems: 'center',
    gap: 16
  },
  avatarShell: {
    width: 52,
    height: 52,
    borderRadius: 26,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)'
  },
  sideAvatar: {
    width: 46,
    height: 46,
    borderRadius: 23,
    backgroundColor: '#111827'
  },
  verifiedBadge: {
    position: 'absolute',
    right: -2,
    bottom: 0,
    width: 17,
    height: 17,
    borderRadius: 9,
    backgroundColor: theme.colors.neon,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2,
    borderColor: '#07111F'
  },
  actionButton: {
    alignItems: 'center',
    minWidth: 54
  },
  actionCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    overflow: 'hidden',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    backgroundColor: 'rgba(0,0,0,0.22)'
  },
  actionCircleActive: {
    borderColor: theme.colors.gold,
    backgroundColor: 'rgba(255,214,102,0.16)'
  },
  actionCount: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    marginTop: 5,
    textShadowColor: 'rgba(0,0,0,0.65)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3
  },
  actionLabel: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 10,
    marginTop: 2
  },
  musicDisc: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    justifyContent: 'center',
    alignItems: 'center'
  },
  infoPanel: {
    position: 'absolute',
    left: 14,
    right: 78,
    bottom: 34
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    marginRight: 10,
    backgroundColor: '#111827'
  },
  authorTextBlock: {
    flex: 1
  },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  username: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '900',
    letterSpacing: 0.1
  },
  usernameVerify: {
    marginLeft: 5
  },
  metaText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    marginTop: 2
  },
  followBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: theme.colors.gold,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)'
  },
  followingBtn: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderColor: 'rgba(255,255,255,0.22)'
  },
  followText: {
    color: '#07111F',
    fontSize: 12,
    fontWeight: '900'
  },
  followingText: {
    color: '#FFFFFF'
  },
  caption: {
    color: '#FFFFFF',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    textShadowColor: 'rgba(0,0,0,0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4
  },
  hashtags: {
    color: theme.colors.neon,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: '800',
    marginTop: 5
  },
  bottomMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 12,
    gap: 10
  },
  musicRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)'
  },
  musicText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '700',
    marginLeft: 6,
    flex: 1
  },
  viewsPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)'
  },
  viewsText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800',
    marginLeft: 5
  },
  progressBar: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderRadius: 99,
    overflow: 'hidden',
    marginTop: 14
  },
  progressFill: {
    height: '100%',
    backgroundColor: theme.colors.neon,
    borderRadius: 99
  },
  createBtn: {
    position: 'absolute',
    right: 18,
    bottom: Platform.OS === 'ios' ? 32 : 24,
    width: 58,
    height: 58,
    borderRadius: 29,
    overflow: 'hidden',
    elevation: 8,
    shadowColor: '#000',
    shadowOpacity: 0.32,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 }
  },
  createGradient: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center'
  },
  indexPill: {
    position: 'absolute',
    left: 16,
    top: Platform.OS === 'ios' ? 112 : 88,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.28)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)'
  },
  indexText: {
    color: 'rgba(255,255,255,0.84)',
    fontSize: 11,
    fontWeight: '800'
  },
  footerLoader: {
    height: 80,
    justifyContent: 'center',
    alignItems: 'center'
  },
  initialLoader: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#000000',
    justifyContent: 'center',
    alignItems: 'center'
  },
  initialLoaderText: {
    color: 'rgba(255,255,255,0.76)',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 12
  },
  emptyState: {
    width: SCREEN_WIDTH,
    height: REEL_HEIGHT,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 32
  },
  emptyTitle: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '900',
    marginTop: 14
  },
  emptyText: {
    color: 'rgba(255,255,255,0.64)',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6
  }
});
