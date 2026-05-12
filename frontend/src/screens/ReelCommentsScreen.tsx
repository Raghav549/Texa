import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  Easing,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  RefreshControl,
  Share,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import Svg, { Circle, Defs, G, LinearGradient as SvgLinearGradient, Path, Rect, Stop } from 'react-native-svg';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { useAuth } from '../store/auth';
import { theme } from '../theme';

type IconName =
  | 'back'
  | 'send'
  | 'image'
  | 'heart'
  | 'heartFill'
  | 'reply'
  | 'more'
  | 'close'
  | 'verified'
  | 'creator'
  | 'share'
  | 'delete'
  | 'pin'
  | 'spark'
  | 'sort'
  | 'empty'
  | 'shield';

interface CommentUser {
  id: string;
  username: string;
  avatarUrl?: string;
  isVerified?: boolean;
}

interface CommentCount {
  replies?: number;
  likes?: number;
}

interface Comment {
  id: string;
  reelId?: string;
  content: string;
  mediaUrl?: string;
  user: CommentUser;
  likes?: string[];
  replies?: Comment[];
  createdAt: string;
  isCreatorReply?: boolean;
  isPinned?: boolean;
  isLiked?: boolean;
  _count?: CommentCount;
}

const palette = {
  bg: '#070A12',
  panel: '#0E1424',
  panel2: '#121A2D',
  card: '#111827',
  card2: '#172033',
  text: '#F8FAFC',
  muted: '#94A3B8',
  soft: '#CBD5E1',
  line: 'rgba(255,255,255,0.09)',
  danger: '#FF4D6D',
  success: '#2EF2A4',
  gold: theme?.colors?.gold || '#F8C65A',
  neon: theme?.colors?.neon || '#39FFB6',
  blue: '#58A6FF',
  purple: '#B56CFF',
  black: '#020617'
};

function Icon({ name, size = 22, color = palette.text, accent = palette.neon }: { name: IconName; size?: number; color?: string; accent?: string }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none' as const };
  if (name === 'back') {
    return (
      <Svg {...common}>
        <Path d="M15.4 5.2 8.6 12l6.8 6.8" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (name === 'send') {
    return (
      <Svg {...common}>
        <Defs>
          <SvgLinearGradient id="sendGrad" x1="3" y1="21" x2="21" y2="3">
            <Stop offset="0" stopColor={accent} />
            <Stop offset="1" stopColor={palette.blue} />
          </SvgLinearGradient>
        </Defs>
        <Path d="M20.6 3.8 4.2 10.7c-1.1.5-1 2.1.2 2.4l6.1 1.4 1.4 6.1c.3 1.2 1.9 1.3 2.4.2l6.9-16.4c.3-.7-.4-1.4-1.1-1.1Z" fill="url(#sendGrad)" />
        <Path d="m10.7 14.3 4.1-4.1" stroke="#04111F" strokeWidth={1.8} strokeLinecap="round" />
      </Svg>
    );
  }
  if (name === 'image') {
    return (
      <Svg {...common}>
        <Rect x="3" y="4" width="18" height="16" rx="4" stroke={color} strokeWidth={1.8} />
        <Circle cx="8.4" cy="9" r="1.7" fill={accent} />
        <Path d="m5.8 17 4.1-4.3c.6-.6 1.5-.6 2.1 0l1.4 1.4 1.9-2.1c.6-.7 1.7-.7 2.3.1L20 15.2" stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (name === 'heart') {
    return (
      <Svg {...common}>
        <Path d="M12 20.2s-7.6-4.4-9.2-9.1C1.6 7.5 3.7 4.7 7 4.7c1.9 0 3.3 1 4.1 2.3.8-1.3 2.2-2.3 4.1-2.3 3.3 0 5.4 2.8 4.2 6.4-1.7 4.7-9.4 9.1-9.4 9.1Z" stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (name === 'heartFill') {
    return (
      <Svg {...common}>
        <Defs>
          <SvgLinearGradient id="heartGrad" x1="4" y1="20" x2="20" y2="4">
            <Stop offset="0" stopColor="#FF3B7A" />
            <Stop offset="1" stopColor="#FF8A3D" />
          </SvgLinearGradient>
        </Defs>
        <Path d="M12 20.4s-7.8-4.5-9.5-9.4C1.3 7.2 3.5 4.3 7 4.3c2 0 3.4 1.1 4.2 2.4.8-1.3 2.3-2.4 4.3-2.4 3.5 0 5.7 2.9 4.4 6.7-1.8 4.9-9.9 9.4-9.9 9.4Z" fill="url(#heartGrad)" />
      </Svg>
    );
  }
  if (name === 'reply') {
    return (
      <Svg {...common}>
        <Path d="M10.2 7.2 5.4 12l4.8 4.8" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round" />
        <Path d="M6 12h7.8c3 0 5.2 2 5.2 5v.8" stroke={accent} strokeWidth={2.1} strokeLinecap="round" />
      </Svg>
    );
  }
  if (name === 'more') {
    return (
      <Svg {...common}>
        <Circle cx="5" cy="12" r="2" fill={color} />
        <Circle cx="12" cy="12" r="2" fill={color} />
        <Circle cx="19" cy="12" r="2" fill={color} />
      </Svg>
    );
  }
  if (name === 'close') {
    return (
      <Svg {...common}>
        <Path d="m6.5 6.5 11 11M17.5 6.5l-11 11" stroke={color} strokeWidth={2.2} strokeLinecap="round" />
      </Svg>
    );
  }
  if (name === 'verified') {
    return (
      <Svg {...common}>
        <Defs>
          <SvgLinearGradient id="verGrad" x1="3" y1="21" x2="21" y2="3">
            <Stop offset="0" stopColor={palette.neon} />
            <Stop offset="1" stopColor={palette.blue} />
          </SvgLinearGradient>
        </Defs>
        <Path d="M12 2.8 14.2 5l3.1-.3 1.1 2.9 2.7 1.6-1.2 2.8 1.2 2.8-2.7 1.6-1.1 2.9-3.1-.3L12 21.2 9.8 19l-3.1.3-1.1-2.9-2.7-1.6L4.1 12 2.9 9.2l2.7-1.6 1.1-2.9 3.1.3L12 2.8Z" fill="url(#verGrad)" />
        <Path d="m8.4 12.1 2.2 2.1 4.8-5" stroke="#06111F" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (name === 'creator') {
    return (
      <Svg {...common}>
        <Path d="M12 3.2 14.7 8l5.3 1.1-3.7 4  .6 5.5L12 16.3 7.1 18.6l.6-5.5-3.7-4L9.3 8 12 3.2Z" fill={accent} />
      </Svg>
    );
  }
  if (name === 'share') {
    return (
      <Svg {...common}>
        <Path d="M8.8 12.8 15.2 16M15.2 8 8.8 11.2" stroke={color} strokeWidth={1.8} strokeLinecap="round" />
        <Circle cx="6.5" cy="12" r="3" stroke={accent} strokeWidth={1.8} />
        <Circle cx="17.5" cy="6.8" r="3" stroke={color} strokeWidth={1.8} />
        <Circle cx="17.5" cy="17.2" r="3" stroke={color} strokeWidth={1.8} />
      </Svg>
    );
  }
  if (name === 'delete') {
    return (
      <Svg {...common}>
        <Path d="M5 7h14M9 7V5.6c0-.9.7-1.6 1.6-1.6h2.8c.9 0 1.6.7 1.6 1.6V7M8 10v8.2c0 1 .8 1.8 1.8 1.8h4.4c1 0 1.8-.8 1.8-1.8V10" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      </Svg>
    );
  }
  if (name === 'pin') {
    return (
      <Svg {...common}>
        <Path d="M14.4 3.8 20.2 9.6l-2.5 1.1-3.5 3.5.4 4.1-1.3 1.3-4.1-4.8-4.8-4.1 1.3-1.3 4.1.4 3.5-3.5 1.1-2.5Z" stroke={color} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    );
  }
  if (name === 'spark') {
    return (
      <Svg {...common}>
        <Path d="M12 2.8 13.8 9l6.2 3-6.2 3L12 21.2 10.2 15 4 12l6.2-3L12 2.8Z" fill={accent} />
        <Path d="M19 3.5v4M21 5.5h-4M5 17v3M6.5 18.5h-3" stroke={color} strokeWidth={1.6} strokeLinecap="round" />
      </Svg>
    );
  }
  if (name === 'sort') {
    return (
      <Svg {...common}>
        <Path d="M5 7h14M8 12h8M11 17h2" stroke={color} strokeWidth={2} strokeLinecap="round" />
      </Svg>
    );
  }
  if (name === 'empty') {
    return (
      <Svg {...common}>
        <Rect x="4" y="5" width="16" height="14" rx="4" stroke={color} strokeWidth={1.7} />
        <Path d="M8 10h8M8 14h5" stroke={accent} strokeWidth={1.7} strokeLinecap="round" />
      </Svg>
    );
  }
  return (
    <Svg {...common}>
      <Path d="M12 3 19 6v5.4c0 4.2-2.9 7.8-7 9.6-4.1-1.8-7-5.4-7-9.6V6l7-3Z" stroke={color} strokeWidth={1.8} />
      <Path d="m8.7 12.1 2.1 2.1 4.5-4.7" stroke={accent} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function timeAgo(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  const diff = Math.max(0, Date.now() - date.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  const week = Math.floor(day / 7);
  if (week < 5) return `${week}w`;
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function compactNumber(value?: number) {
  const n = Number(value || 0);
  if (n < 1000) return `${n}`;
  if (n < 1000000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K`;
  return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
}

function initials(name?: string) {
  const safe = (name || 'U').replace('@', '').trim();
  return safe.slice(0, 2).toUpperCase();
}

function normalizeComment(raw: any): Comment {
  return {
    id: String(raw?.id || `${Date.now()}_${Math.random()}`),
    reelId: raw?.reelId,
    content: String(raw?.content || ''),
    mediaUrl: raw?.mediaUrl || raw?.media?.url || undefined,
    user: {
      id: String(raw?.user?.id || raw?.userId || ''),
      username: String(raw?.user?.username || 'user'),
      avatarUrl: raw?.user?.avatarUrl || undefined,
      isVerified: !!raw?.user?.isVerified
    },
    likes: Array.isArray(raw?.likes) ? raw.likes : [],
    replies: Array.isArray(raw?.replies) ? raw.replies.map(normalizeComment) : [],
    createdAt: raw?.createdAt || new Date().toISOString(),
    isCreatorReply: !!raw?.isCreatorReply,
    isPinned: !!raw?.isPinned,
    isLiked: !!raw?.isLiked,
    _count: raw?._count || { replies: Array.isArray(raw?.replies) ? raw.replies.length : 0, likes: Array.isArray(raw?.likes) ? raw.likes.length : 0 }
  };
}

function Avatar({ user, size = 42 }: { user: CommentUser; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (user.avatarUrl && !failed) {
    return <Image source={{ uri: user.avatarUrl }} onError={() => setFailed(true)} style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: palette.card2 }} />;
  }
  return (
    <LinearGradient colors={[palette.neon, palette.blue, palette.purple]} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>
      <Text style={{ color: palette.black, fontWeight: '900', fontSize: size * 0.34 }}>{initials(user.username)}</Text>
    </LinearGradient>
  );
}

export default function ReelCommentsScreen({ route, navigation }: any) {
  const reelId = route?.params?.reelId;
  const { user } = useAuth();
  const [comments, setComments] = useState<Comment[]>([]);
  const [input, setInput] = useState('');
  const [replyingTo, setReplyingTo] = useState<Comment | null>(null);
  const [selectedMedia, setSelectedMedia] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'recent' | 'top'>('recent');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [posting, setPosting] = useState(false);
  const [activeMenu, setActiveMenu] = useState<Comment | null>(null);
  const socketRef = useRef<any>(null);
  const inputRef = useRef<TextInput>(null);
  const pulse = useRef(new Animated.Value(0)).current;
  const mounted = useRef(true);

  const totalComments = useMemo(() => comments.reduce((sum, c) => sum + 1 + (c._count?.replies || c.replies?.length || 0), 0), [comments]);
  const canPost = useMemo(() => input.trim().length > 0 || !!selectedMedia, [input, selectedMedia]);

  useEffect(() => {
    mounted.current = true;
    Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1800,
        easing: Easing.inOut(Easing.quad),
        useNativeDriver: true
      })
    ).start();
    return () => {
      mounted.current = false;
    };
  }, [pulse]);

  const loadComments = useCallback(
    async (nextCursor?: string, mode: 'initial' | 'refresh' | 'more' = 'initial') => {
      if (!reelId) return;
      if (mode === 'more') setLoadingMore(true);
      else if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      try {
        const { data } = await api.get(`/reels/${reelId}/comments`, {
          params: { cursor: nextCursor || undefined, limit: 20, sortBy }
        });
        const list = Array.isArray(data?.comments) ? data.comments.map(normalizeComment) : [];
        if (!mounted.current) return;
        setComments(prev => (nextCursor ? [...prev, ...list] : list));
        setCursor(data?.nextCursor || null);
        setHasMore(!!data?.nextCursor || !!data?.hasMore);
      } catch (err: any) {
        if (mounted.current) Alert.alert('Comments unavailable', err?.response?.data?.error || 'Please try again.');
      } finally {
        if (!mounted.current) return;
        setLoading(false);
        setLoadingMore(false);
        setRefreshing(false);
      }
    },
    [reelId, sortBy]
  );

  useEffect(() => {
    loadComments(undefined, 'initial');
  }, [loadComments]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const socket = await ws();
        if (!active) return;
        socketRef.current = socket;
        socket.emit('reel:join', { reelId });
        socket.on('comment:new', (raw: any) => {
          const comment = normalizeComment(raw);
          if (comment.reelId && comment.reelId !== reelId) return;
          setComments(prev => {
            if (prev.some(c => c.id === comment.id)) return prev;
            if (comment?.replies?.length === 0 && raw?.replyToId) {
              return prev.map(c => (c.id === raw.replyToId ? { ...c, replies: [comment, ...(c.replies || [])], _count: { ...(c._count || {}), replies: (c._count?.replies || c.replies?.length || 0) + 1 } } : c));
            }
            return [comment, ...prev];
          });
        });
        socket.on('comment:like_update', ({ commentId, count, likedByUser }: any) => {
          setComments(prev =>
            prev.map(c => {
              if (c.id === commentId) {
                const currentLikes = c.likes || [];
                return { ...c, likes: Array(Math.max(0, Number(count || 0))).fill('stub'), isLiked: typeof likedByUser === 'boolean' ? likedByUser : c.isLiked };
              }
              return {
                ...c,
                replies: (c.replies || []).map(r => (r.id === commentId ? { ...r, likes: Array(Math.max(0, Number(count || 0))).fill('stub'), isLiked: typeof likedByUser === 'boolean' ? likedByUser : r.isLiked } : r))
              };
            })
          );
        });
        socket.on('comment:deleted', ({ commentId }: any) => {
          setComments(prev => prev.filter(c => c.id !== commentId).map(c => ({ ...c, replies: (c.replies || []).filter(r => r.id !== commentId) })));
        });
      } catch {}
    })();
    return () => {
      active = false;
      socketRef.current?.emit?.('reel:leave', { reelId });
      socketRef.current?.off?.('comment:new');
      socketRef.current?.off?.('comment:like_update');
      socketRef.current?.off?.('comment:deleted');
    };
  }, [reelId]);

  const postComment = useCallback(async () => {
    if (!canPost || posting || !reelId) return;
    const tempId = `temp_${Date.now()}`;
    const optimistic: Comment = {
      id: tempId,
      reelId,
      content: input.trim(),
      mediaUrl: selectedMedia || undefined,
      user: {
        id: user?.id || 'me',
        username: user?.username || 'me',
        avatarUrl: user?.avatarUrl,
        isVerified: !!user?.isVerified
      },
      likes: [],
      replies: [],
      createdAt: new Date().toISOString(),
      isCreatorReply: false,
      isLiked: false,
      _count: { replies: 0, likes: 0 }
    };
    const replyTarget = replyingTo;
    const text = input.trim();
    const media = selectedMedia;
    setInput('');
    setSelectedMedia(null);
    setReplyingTo(null);
    setPosting(true);
    setComments(prev => (replyTarget ? prev.map(c => (c.id === replyTarget.id ? { ...c, replies: [optimistic, ...(c.replies || [])], _count: { ...(c._count || {}), replies: (c._count?.replies || c.replies?.length || 0) + 1 } } : c)) : [optimistic, ...prev]));
    try {
      let response;
      if (media) {
        const fd = new FormData();
        fd.append('content', text);
        if (replyTarget?.id) fd.append('replyToId', replyTarget.id);
        fd.append('media', {
          uri: media,
          name: `comment_${Date.now()}.jpg`,
          type: 'image/jpeg'
        } as any);
        response = await api.post(`/reels/${reelId}/comments`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      } else {
        response = await api.post(`/reels/${reelId}/comments`, { content: text, replyToId: replyTarget?.id });
      }
      const saved = normalizeComment(response.data);
      setComments(prev =>
        prev.map(c => {
          if (c.id === tempId) return saved;
          return { ...c, replies: (c.replies || []).map(r => (r.id === tempId ? saved : r)) };
        })
      );
    } catch (err: any) {
      setComments(prev => prev.filter(c => c.id !== tempId).map(c => ({ ...c, replies: (c.replies || []).filter(r => r.id !== tempId) })));
      Alert.alert('Comment failed', err?.response?.data?.error || 'Please try again.');
    } finally {
      setPosting(false);
    }
  }, [canPost, posting, reelId, input, selectedMedia, replyingTo, user]);

  const toggleLike = useCallback(
    async (comment: Comment) => {
      const wasLiked = !!comment.isLiked || (comment.likes || []).includes(user?.id || '');
      const nextCount = Math.max(0, (comment.likes?.length || comment._count?.likes || 0) + (wasLiked ? -1 : 1));
      setComments(prev =>
        prev.map(c => {
          if (c.id === comment.id) return { ...c, isLiked: !wasLiked, likes: Array(nextCount).fill('stub'), _count: { ...(c._count || {}), likes: nextCount } };
          return {
            ...c,
            replies: (c.replies || []).map(r => (r.id === comment.id ? { ...r, isLiked: !wasLiked, likes: Array(nextCount).fill('stub'), _count: { ...(r._count || {}), likes: nextCount } } : r))
          };
        })
      );
      try {
        await api.post(`/reels/${reelId}/comments/${comment.id}/like`, { remove: wasLiked });
      } catch {
        setComments(prev =>
          prev.map(c => {
            if (c.id === comment.id) return { ...c, isLiked: wasLiked, likes: Array(comment.likes?.length || 0).fill('stub'), _count: { ...(c._count || {}), likes: comment.likes?.length || 0 } };
            return {
              ...c,
              replies: (c.replies || []).map(r => (r.id === comment.id ? { ...r, isLiked: wasLiked, likes: Array(comment.likes?.length || 0).fill('stub'), _count: { ...(r._count || {}), likes: comment.likes?.length || 0 } } : r))
            };
          })
        );
      }
    },
    [reelId, user?.id]
  );

  const pickMedia = useCallback(async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow gallery access to attach an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.82,
      allowsEditing: true,
      aspect: [1, 1]
    });
    if (!result.canceled && result.assets?.[0]?.uri) setSelectedMedia(result.assets[0].uri);
  }, []);

  const shareComment = useCallback(async (comment: Comment) => {
    try {
      await Share.share({ message: `@${comment.user.username}: ${comment.content}` });
    } catch {}
  }, []);

  const deleteComment = useCallback(
    (comment: Comment) => {
      Alert.alert('Delete comment', 'Remove this comment permanently?', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            setActiveMenu(null);
            const old = comments;
            setComments(prev => prev.filter(c => c.id !== comment.id).map(c => ({ ...c, replies: (c.replies || []).filter(r => r.id !== comment.id) })));
            try {
              await api.delete(`/reels/${reelId}/comments/${comment.id}`);
            } catch {
              setComments(old);
              Alert.alert('Delete failed', 'Please try again.');
            }
          }
        }
      ]);
    },
    [comments, reelId]
  );

  const pinComment = useCallback(
    async (comment: Comment) => {
      setActiveMenu(null);
      setComments(prev => prev.map(c => ({ ...c, isPinned: c.id === comment.id ? !c.isPinned : c.isPinned })));
      try {
        await api.post(`/reels/${reelId}/comments/${comment.id}/pin`, { remove: !!comment.isPinned });
      } catch {}
    },
    [reelId]
  );

  const openReply = useCallback((comment: Comment) => {
    setReplyingTo(comment);
    setTimeout(() => inputRef.current?.focus(), 120);
  }, []);

  const renderReply = useCallback(
    (reply: Comment) => (
      <View key={reply.id} style={styles.replyItem}>
        <Avatar user={reply.user} size={28} />
        <View style={styles.replyBody}>
          <View style={styles.nameLine}>
            <Text style={styles.replyName}>@{reply.user.username}</Text>
            {reply.user.isVerified ? <Icon name="verified" size={14} /> : null}
            {reply.isCreatorReply ? <Text style={styles.creatorMini}>Creator</Text> : null}
          </View>
          <Text style={styles.replyContent}>{reply.content}</Text>
          <View style={styles.replyActions}>
            <TouchableOpacity onPress={() => toggleLike(reply)} style={styles.miniAction}>
              <Icon name={reply.isLiked ? 'heartFill' : 'heart'} size={15} color={palette.muted} />
              <Text style={styles.miniActionText}>{compactNumber(reply.likes?.length || reply._count?.likes || 0)}</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => openReply(reply)} style={styles.miniAction}>
              <Text style={styles.miniActionText}>Reply</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    ),
    [openReply, toggleLike]
  );

  const renderComment = useCallback(
    ({ item: comment }: { item: Comment }) => {
      const likeCount = comment.likes?.length || comment._count?.likes || 0;
      const replyCount = comment._count?.replies || comment.replies?.length || 0;
      return (
        <Pressable onLongPress={() => setActiveMenu(comment)} style={[styles.commentCard, comment.isPinned && styles.pinnedCard]}>
          <View style={styles.commentGlow} />
          <Avatar user={comment.user} size={44} />
          <View style={styles.commentBody}>
            <View style={styles.commentTop}>
              <View style={styles.nameBlock}>
                <View style={styles.nameLine}>
                  <Text style={styles.username}>@{comment.user.username}</Text>
                  {comment.user.isVerified ? <Icon name="verified" size={15} /> : null}
                  {comment.isCreatorReply ? (
                    <View style={styles.creatorBadge}>
                      <Icon name="creator" size={12} color={palette.black} accent={palette.gold} />
                      <Text style={styles.creatorText}>Creator</Text>
                    </View>
                  ) : null}
                  {comment.isPinned ? (
                    <View style={styles.pinBadge}>
                      <Icon name="pin" size={12} color={palette.gold} />
                      <Text style={styles.pinText}>Pinned</Text>
                    </View>
                  ) : null}
                </View>
                <Text style={styles.time}>{timeAgo(comment.createdAt)}</Text>
              </View>
              <TouchableOpacity onPress={() => setActiveMenu(comment)} hitSlop={10} style={styles.moreBtn}>
                <Icon name="more" size={20} color={palette.muted} />
              </TouchableOpacity>
            </View>
            <Text style={styles.commentText}>{comment.content}</Text>
            {comment.mediaUrl ? <Image source={{ uri: comment.mediaUrl }} style={styles.media} /> : null}
            <View style={styles.actions}>
              <TouchableOpacity onPress={() => toggleLike(comment)} style={[styles.actionPill, comment.isLiked && styles.actionPillActive]}>
                <Icon name={comment.isLiked ? 'heartFill' : 'heart'} size={17} color={comment.isLiked ? palette.danger : palette.soft} />
                <Text style={[styles.actionText, comment.isLiked && styles.actionTextActive]}>{compactNumber(likeCount)}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => openReply(comment)} style={styles.actionPill}>
                <Icon name="reply" size={17} color={palette.soft} />
                <Text style={styles.actionText}>Reply</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => shareComment(comment)} style={styles.actionPill}>
                <Icon name="share" size={17} color={palette.soft} />
                <Text style={styles.actionText}>Share</Text>
              </TouchableOpacity>
            </View>
            {comment.replies?.length ? (
              <View style={styles.replies}>
                {comment.replies.slice(0, 3).map(renderReply)}
                {replyCount > 3 ? (
                  <TouchableOpacity style={styles.moreReplies} onPress={() => navigation.navigate('CommentThread', { reelId, commentId: comment.id })}>
                    <View style={styles.replyLine} />
                    <Text style={styles.moreRepliesText}>View {replyCount - 3} more replies</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            ) : null}
          </View>
        </Pressable>
      );
    },
    [navigation, openReply, reelId, renderReply, shareComment, toggleLike]
  );

  const ListEmpty = useCallback(() => {
    if (loading) {
      return (
        <View style={styles.loadingBox}>
          <ActivityIndicator color={palette.neon} />
          <Text style={styles.loadingText}>Loading comments</Text>
        </View>
      );
    }
    return (
      <View style={styles.emptyBox}>
        <LinearGradient colors={['rgba(57,255,182,0.22)', 'rgba(88,166,255,0.14)']} style={styles.emptyIcon}>
          <Icon name="empty" size={34} color={palette.text} accent={palette.neon} />
        </LinearGradient>
        <Text style={styles.emptyTitle}>No comments yet</Text>
        <Text style={styles.emptyText}>Start the conversation with something sharp.</Text>
      </View>
    );
  }, [loading]);

  const switchSort = useCallback(() => {
    setSortBy(prev => (prev === 'recent' ? 'top' : 'recent'));
    setCursor(null);
  }, []);

  useEffect(() => {
    loadComments(undefined, 'initial');
  }, [sortBy]);

  const animatedScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const animatedOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.95] });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <LinearGradient colors={[palette.bg, '#0A1020', palette.bg]} style={StyleSheet.absoluteFillObject} />
      <View style={styles.topBar}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.roundBtn}>
          <Icon name="back" size={23} />
        </TouchableOpacity>
        <View style={styles.titleWrap}>
          <Text style={styles.title}>Comments</Text>
          <Text style={styles.subtitle}>{compactNumber(totalComments)} total responses</Text>
        </View>
        <TouchableOpacity onPress={switchSort} style={styles.sortBtn}>
          <Icon name="sort" size={18} color={palette.black} />
          <Text style={styles.sortText}>{sortBy === 'recent' ? 'Recent' : 'Top'}</Text>
        </TouchableOpacity>
      </View>
      <FlatList
        data={comments}
        keyExtractor={item => item.id}
        renderItem={renderComment}
        contentContainerStyle={styles.list}
        ListEmptyComponent={ListEmpty}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => loadComments(undefined, 'refresh')} tintColor={palette.neon} />}
        onEndReached={() => hasMore && !loadingMore && cursor && loadComments(cursor, 'more')}
        onEndReachedThreshold={0.35}
        ListFooterComponent={
          loadingMore ? (
            <View style={styles.footerLoader}>
              <ActivityIndicator color={palette.neon} />
            </View>
          ) : null
        }
        keyboardShouldPersistTaps="handled"
      />
      {replyingTo ? (
        <View style={styles.replyBar}>
          <View style={styles.replyAccent} />
          <View style={{ flex: 1 }}>
            <Text style={styles.replyLabel}>Replying to @{replyingTo.user.username}</Text>
            <Text style={styles.replyPreview} numberOfLines={1}>
              {replyingTo.content}
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyingTo(null)} style={styles.closeBtn}>
            <Icon name="close" size={18} color={palette.muted} />
          </TouchableOpacity>
        </View>
      ) : null}
      {selectedMedia ? (
        <View style={styles.mediaPreviewBar}>
          <Image source={{ uri: selectedMedia }} style={styles.mediaPreview} />
          <View style={{ flex: 1 }}>
            <Text style={styles.mediaTitle}>Image attached</Text>
            <Text style={styles.mediaSub}>Tap X to remove before posting</Text>
          </View>
          <TouchableOpacity onPress={() => setSelectedMedia(null)} style={styles.closeBtn}>
            <Icon name="close" size={18} color={palette.muted} />
          </TouchableOpacity>
        </View>
      ) : null}
      <View style={styles.inputShell}>
        <TouchableOpacity onPress={pickMedia} style={styles.attachBtn}>
          <Icon name="image" size={21} color={palette.text} accent={palette.gold} />
        </TouchableOpacity>
        <View style={styles.inputBox}>
          <TextInput
            ref={inputRef}
            style={styles.input}
            value={input}
            onChangeText={setInput}
            placeholder={replyingTo ? 'Write a reply...' : 'Add a comment...'}
            placeholderTextColor={palette.muted}
            multiline
            maxLength={600}
          />
          <Text style={styles.charCount}>{input.length}/600</Text>
        </View>
        <TouchableOpacity onPress={postComment} disabled={!canPost || posting} style={[styles.sendBtn, (!canPost || posting) && styles.sendDisabled]}>
          {posting ? (
            <ActivityIndicator color={palette.black} size="small" />
          ) : (
            <>
              <Animated.View style={[styles.sendPulse, { transform: [{ scale: animatedScale }], opacity: animatedOpacity }]} />
              <Icon name="send" size={22} color={palette.black} accent={palette.neon} />
            </>
          )}
        </TouchableOpacity>
      </View>
      <Modal transparent visible={!!activeMenu} animationType="fade" onRequestClose={() => setActiveMenu(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setActiveMenu(null)}>
          <Pressable style={styles.menuCard}>
            <View style={styles.menuHandle} />
            <Text style={styles.menuTitle}>Comment actions</Text>
            <TouchableOpacity style={styles.menuItem} onPress={() => activeMenu && openReply(activeMenu)}>
              <Icon name="reply" size={20} color={palette.neon} />
              <Text style={styles.menuText}>Reply</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => activeMenu && shareComment(activeMenu)}>
              <Icon name="share" size={20} color={palette.blue} />
              <Text style={styles.menuText}>Share</Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.menuItem} onPress={() => activeMenu && pinComment(activeMenu)}>
              <Icon name="pin" size={20} color={palette.gold} />
              <Text style={styles.menuText}>{activeMenu?.isPinned ? 'Unpin comment' : 'Pin comment'}</Text>
            </TouchableOpacity>
            {(activeMenu?.user?.id === user?.id || route?.params?.isOwner) ? (
              <TouchableOpacity style={styles.menuItem} onPress={() => activeMenu && deleteComment(activeMenu)}>
                <Icon name="delete" size={20} color={palette.danger} />
                <Text style={[styles.menuText, { color: palette.danger }]}>Delete</Text>
              </TouchableOpacity>
            ) : null}
            <View style={styles.menuSafety}>
              <Icon name="shield" size={16} color={palette.muted} />
              <Text style={styles.menuSafetyText}>Protected by moderation and anti-spam checks</Text>
            </View>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: palette.bg },
  topBar: {
    paddingTop: Platform.OS === 'ios' ? 54 : 22,
    paddingHorizontal: 16,
    paddingBottom: 14,
    flexDirection: 'row',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: palette.line
  },
  roundBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.line
  },
  titleWrap: { flex: 1, alignItems: 'center' },
  title: { color: palette.text, fontSize: 18, fontWeight: '900', letterSpacing: 0.2 },
  subtitle: { color: palette.muted, fontSize: 12, marginTop: 2, fontWeight: '600' },
  sortBtn: {
    minWidth: 86,
    height: 38,
    borderRadius: 19,
    backgroundColor: palette.neon,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10
  },
  sortText: { color: palette.black, fontWeight: '900', fontSize: 12, marginLeft: 5 },
  list: { padding: 14, paddingBottom: 24 },
  commentCard: {
    flexDirection: 'row',
    padding: 13,
    borderRadius: 24,
    backgroundColor: 'rgba(17,24,39,0.86)',
    borderWidth: 1,
    borderColor: palette.line,
    marginBottom: 12,
    overflow: 'hidden'
  },
  pinnedCard: { borderColor: 'rgba(248,198,90,0.55)', backgroundColor: 'rgba(30,28,18,0.78)' },
  commentGlow: {
    position: 'absolute',
    right: -34,
    top: -34,
    width: 90,
    height: 90,
    borderRadius: 45,
    backgroundColor: 'rgba(57,255,182,0.08)'
  },
  commentBody: { flex: 1, marginLeft: 11 },
  commentTop: { flexDirection: 'row', alignItems: 'flex-start' },
  nameBlock: { flex: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap' },
  username: { color: palette.text, fontSize: 14, fontWeight: '900', marginRight: 5 },
  time: { color: palette.muted, fontSize: 11, marginTop: 3, fontWeight: '600' },
  moreBtn: {
    width: 32,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.04)'
  },
  creatorBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(248,198,90,0.18)',
    borderColor: 'rgba(248,198,90,0.32)',
    borderWidth: 1,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    marginLeft: 5
  },
  creatorText: { color: palette.gold, fontSize: 10, fontWeight: '900', marginLeft: 3 },
  creatorMini: {
    color: palette.gold,
    fontSize: 10,
    fontWeight: '900',
    marginLeft: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999,
    backgroundColor: 'rgba(248,198,90,0.12)'
  },
  pinBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(248,198,90,0.11)',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    marginLeft: 5
  },
  pinText: { color: palette.gold, fontSize: 10, fontWeight: '900', marginLeft: 3 },
  commentText: { color: palette.soft, fontSize: 14.5, lineHeight: 21, marginTop: 8, fontWeight: '500' },
  media: { width: 168, height: 168, borderRadius: 18, marginTop: 10, backgroundColor: palette.card2 },
  actions: { flexDirection: 'row', alignItems: 'center', marginTop: 11, flexWrap: 'wrap' },
  actionPill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.06)',
    marginRight: 8,
    marginBottom: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)'
  },
  actionPillActive: { backgroundColor: 'rgba(255,77,109,0.13)', borderColor: 'rgba(255,77,109,0.22)' },
  actionText: { color: palette.soft, fontSize: 12, fontWeight: '800', marginLeft: 5 },
  actionTextActive: { color: '#FFB4C5' },
  replies: { marginTop: 12, paddingLeft: 2 },
  replyItem: { flexDirection: 'row', marginTop: 10 },
  replyBody: {
    flex: 1,
    marginLeft: 9,
    padding: 10,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.045)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.055)'
  },
  replyName: { color: palette.text, fontSize: 12.5, fontWeight: '900', marginRight: 4 },
  replyContent: { color: palette.soft, fontSize: 13, lineHeight: 18, marginTop: 4 },
  replyActions: { flexDirection: 'row', marginTop: 8, alignItems: 'center' },
  miniAction: { flexDirection: 'row', alignItems: 'center', marginRight: 14 },
  miniActionText: { color: palette.muted, fontSize: 11, fontWeight: '800', marginLeft: 4 },
  moreReplies: { flexDirection: 'row', alignItems: 'center', marginTop: 10, paddingVertical: 4 },
  replyLine: { width: 24, height: 1, backgroundColor: 'rgba(255,255,255,0.18)', marginRight: 8 },
  moreRepliesText: { color: palette.neon, fontSize: 12, fontWeight: '900' },
  loadingBox: { alignItems: 'center', justifyContent: 'center', paddingTop: 70 },
  loadingText: { color: palette.muted, marginTop: 10, fontWeight: '800' },
  emptyBox: { alignItems: 'center', justifyContent: 'center', paddingTop: 88, paddingHorizontal: 26 },
  emptyIcon: { width: 74, height: 74, borderRadius: 26, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  emptyTitle: { color: palette.text, fontSize: 19, fontWeight: '900' },
  emptyText: { color: palette.muted, fontSize: 13, textAlign: 'center', marginTop: 7, lineHeight: 19 },
  footerLoader: { paddingVertical: 18 },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: palette.line
  },
  replyAccent: { width: 4, height: 34, borderRadius: 2, backgroundColor: palette.neon, marginRight: 10 },
  replyLabel: { color: palette.text, fontSize: 12.5, fontWeight: '900' },
  replyPreview: { color: palette.muted, fontSize: 12, marginTop: 2 },
  closeBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.06)' },
  mediaPreviewBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 10,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.07)',
    borderWidth: 1,
    borderColor: palette.line
  },
  mediaPreview: { width: 46, height: 46, borderRadius: 14, marginRight: 10, backgroundColor: palette.card2 },
  mediaTitle: { color: palette.text, fontSize: 13, fontWeight: '900' },
  mediaSub: { color: palette.muted, fontSize: 11.5, marginTop: 2 },
  inputShell: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 24 : 12,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    backgroundColor: 'rgba(7,10,18,0.96)'
  },
  attachBtn: {
    width: 44,
    height: 44,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: palette.line,
    marginRight: 8
  },
  inputBox: {
    flex: 1,
    minHeight: 44,
    maxHeight: 116,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: palette.line,
    paddingHorizontal: 13,
    paddingTop: 7,
    paddingBottom: 5
  },
  input: { color: palette.text, fontSize: 14.5, lineHeight: 20, maxHeight: 82, padding: 0 },
  charCount: { alignSelf: 'flex-end', color: palette.muted, fontSize: 10, fontWeight: '800', marginTop: 2 },
  sendBtn: {
    width: 46,
    height: 46,
    borderRadius: 18,
    marginLeft: 8,
    backgroundColor: palette.neon,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  sendPulse: { position: 'absolute', width: 38, height: 38, borderRadius: 19, backgroundColor: 'rgba(255,255,255,0.35)' },
  sendDisabled: { opacity: 0.45 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.62)', justifyContent: 'flex-end' },
  menuCard: {
    backgroundColor: palette.panel,
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'ios' ? 34 : 20,
    borderWidth: 1,
    borderColor: palette.line
  },
  menuHandle: { alignSelf: 'center', width: 42, height: 5, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.22)', marginBottom: 14 },
  menuTitle: { color: palette.text, fontSize: 16, fontWeight: '900', marginBottom: 8 },
  menuItem: { flexDirection: 'row', alignItems: 'center', paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  menuText: { color: palette.text, fontSize: 15, fontWeight: '800', marginLeft: 12 },
  menuSafety: { flexDirection: 'row', alignItems: 'center', marginTop: 14, padding: 12, borderRadius: 16, backgroundColor: 'rgba(255,255,255,0.05)' },
  menuSafetyText: { color: palette.muted, fontSize: 12, fontWeight: '700', marginLeft: 8, flex: 1 }
});
