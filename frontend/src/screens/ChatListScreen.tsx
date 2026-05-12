import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Keyboard,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  View
} from "react-native";
import { useFocusEffect } from "@react-navigation/native";
import { api } from "../api/client";
import { ws } from "../api/ws";
import { useAuth } from "../store/auth";
import { theme } from "../theme";
import { formatTimeAgo } from "../utils/time";

type UserLite = {
  id: string;
  username: string;
  fullName?: string;
  avatarUrl?: string | null;
  isVerified?: boolean;
  isOnline?: boolean;
  lastSeen?: string | null;
};

type LastMessage = {
  id: string;
  conversationId: string;
  senderId: string;
  content?: string | null;
  mediaUrl?: string | null;
  media?: any;
  payment?: any;
  poll?: any;
  sender: {
    id?: string;
    username: string;
    avatarUrl?: string | null;
  };
  createdAt: string;
  status?: "SENT" | "DELIVERED" | "SEEN" | "FAILED" | "sent" | "delivered" | "seen" | "failed";
};

type ConversationParticipant = {
  userId?: string;
  user: UserLite;
  isMuted?: boolean;
  isArchived?: boolean;
  customNickname?: string | null;
  lastReadMessageId?: string | null;
};

interface Conversation {
  id: string;
  type: "direct" | "group";
  name?: string | null;
  avatarUrl?: string | null;
  lastMessage?: LastMessage | null;
  participants: ConversationParticipant[];
  unreadCount?: number;
  updatedAt: string;
  isPinned?: boolean;
  isOnline?: boolean;
}

type TypingState = Record<string, string[]>;

const AVATAR_FALLBACK =
  "https://ui-avatars.com/api/?background=00F5D4&color=111827&bold=true&name=";

const getConversationTitle = (conversation: Conversation, currentUserId?: string) => {
  if (conversation.type === "group") return conversation.name || "Group";
  const other = conversation.participants.find(p => p.user?.id !== currentUserId);
  return other?.customNickname || other?.user?.fullName || other?.user?.username || "User";
};

const getConversationAvatar = (conversation: Conversation, currentUserId?: string) => {
  if (conversation.type === "group") return conversation.avatarUrl || null;
  const other = conversation.participants.find(p => p.user?.id !== currentUserId);
  return other?.user?.avatarUrl || null;
};

const getOtherParticipant = (conversation: Conversation, currentUserId?: string) => {
  return conversation.participants.find(p => p.user?.id !== currentUserId);
};

const normalizeStatus = (status?: string) => String(status || "").toLowerCase();

const getMessagePreview = (conversation: Conversation, currentUserId?: string, typing?: string[]) => {
  if (typing && typing.length > 0) {
    const visible = typing.slice(0, 2).join(", ");
    const extra = typing.length > 2 ? ` +${typing.length - 2}` : "";
    return `${visible}${extra} typing...`;
  }

  const message = conversation.lastMessage;
  if (!message) return "No messages yet";

  const prefix = message.senderId === currentUserId ? "You: " : conversation.type === "group" ? `${message.sender?.username || "User"}: ` : "";

  if (message.payment) {
    const amount = message.payment?.amount;
    return `${prefix}${amount ? `${amount} coins` : "Payment"}`;
  }

  if (message.poll) return `${prefix}Poll`;
  if (message.media || message.mediaUrl) return `${prefix}Media`;
  if (message.content?.trim()) return `${prefix}${message.content.trim()}`;

  return `${prefix}Message`;
};

const sortConversations = (items: Conversation[]) => {
  return [...items].sort((a, b) => {
    if (a.isPinned && !b.isPinned) return -1;
    if (!a.isPinned && b.isPinned) return 1;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
};

const upsertConversationWithMessage = (items: Conversation[], message: LastMessage, currentUserId?: string) => {
  const index = items.findIndex(c => c.id === message.conversationId);
  if (index === -1) return items;

  const next = [...items];
  const old = next[index];

  next[index] = {
    ...old,
    lastMessage: message,
    updatedAt: message.createdAt || new Date().toISOString(),
    unreadCount: message.senderId !== currentUserId ? (old.unreadCount || 0) + 1 : old.unreadCount || 0
  };

  return sortConversations(next);
};

const ConversationRow = memo(
  ({
    item,
    currentUserId,
    currentUsername,
    typingUsers,
    onPress,
    onLongPress
  }: {
    item: Conversation;
    currentUserId?: string;
    currentUsername?: string;
    typingUsers: string[];
    onPress: (conversation: Conversation) => void;
    onLongPress: (conversation: Conversation) => void;
  }) => {
    const scale = useRef(new Animated.Value(1)).current;
    const otherParticipant = getOtherParticipant(item, currentUserId);
    const title = getConversationTitle(item, currentUserId);
    const avatar = getConversationAvatar(item, currentUserId);
    const muted = Boolean(item.participants.find(p => p.user?.id === currentUserId)?.isMuted);
    const unread = item.unreadCount || 0;
    const typing = typingUsers.filter(Boolean).filter(name => name !== currentUsername);
    const preview = getMessagePreview(item, currentUserId, typing);
    const isTyping = typing.length > 0;
    const online = item.type === "direct" ? Boolean(otherParticipant?.user?.isOnline || item.isOnline) : false;
    const status = normalizeStatus(item.lastMessage?.status);

    const pressIn = () => {
      Animated.spring(scale, {
        toValue: 0.985,
        useNativeDriver: true,
        speed: 35,
        bounciness: 4
      }).start();
    };

    const pressOut = () => {
      Animated.spring(scale, {
        toValue: 1,
        useNativeDriver: true,
        speed: 35,
        bounciness: 5
      }).start();
    };

    return (
      <Animated.View style={{ transform: [{ scale }] }}>
        <Pressable
          onPress={() => onPress(item)}
          onLongPress={() => onLongPress(item)}
          onPressIn={pressIn}
          onPressOut={pressOut}
          style={({ pressed }) => [styles.row, unread > 0 && styles.unreadRow, muted && styles.mutedRow, pressed && styles.pressedRow]}
        >
          <View style={styles.avatarWrap}>
            <Image
              source={{ uri: avatar || `${AVATAR_FALLBACK}${encodeURIComponent(title)}` }}
              style={styles.avatar}
            />
            {online && <View style={styles.onlineDot} />}
            {item.type === "group" && (
              <View style={styles.groupBadge}>
                <Text style={styles.groupBadgeText}>G</Text>
              </View>
            )}
          </View>

          <View style={styles.content}>
            <View style={styles.header}>
              <View style={styles.nameWrap}>
                <Text numberOfLines={1} style={[styles.name, unread > 0 && styles.unreadName]}>
                  {title}
                </Text>
                {otherParticipant?.user?.isVerified && <Text style={styles.verified}>✓</Text>}
                {muted && <Text style={styles.mutedIcon}>⌁</Text>}
              </View>
              <Text style={[styles.time, unread > 0 && styles.unreadTime]}>{formatTimeAgo(item.updatedAt)}</Text>
            </View>

            <View style={styles.messageRow}>
              <Text numberOfLines={1} style={[styles.lastMessage, isTyping && styles.typingText, unread > 0 && styles.unreadMessage]}>
                {preview}
              </Text>

              {item.lastMessage?.senderId === currentUserId && status ? (
                <Text style={[styles.status, status === "seen" && styles.statusSeen, status === "failed" && styles.statusFailed]}>
                  {status === "seen" ? "✓✓" : status === "failed" ? "!" : "✓"}
                </Text>
              ) : null}

              {unread > 0 && (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text>
                </View>
              )}
            </View>
          </View>
        </Pressable>
      </Animated.View>
    );
  }
);

export default function ChatListScreen({ navigation }: any) {
  const { user } = useAuth();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [initialLoading, setInitialLoading] = useState(true);
  const [typingUsers, setTypingUsers] = useState<TypingState>({});
  const [error, setError] = useState<string | null>(null);
  const socketRef = useRef<any>(null);
  const mountedRef = useRef(true);

  const fetchConversations = useCallback(async (silent = false) => {
    try {
      if (!silent) setError(null);
      const response = await api.get("/dm/conversations", { params: { limit: 60, includeArchived: false } });
      const payload = Array.isArray(response.data) ? response.data : response.data?.conversations || [];
      if (!mountedRef.current) return;
      setConversations(sortConversations(payload));
    } catch {
      if (!mountedRef.current) return;
      setError("Conversations load nahi ho paayi");
    } finally {
      if (!mountedRef.current) return;
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, []);

  const connectSocket = useCallback(async () => {
    const socket = await ws();
    socketRef.current = socket;

    socket.off?.("message:new");
    socket.off?.("typing:indicator");
    socket.off?.("message:seen");
    socket.off?.("conversation:new");
    socket.off?.("conversation:archived");
    socket.off?.("conversation:muted");
    socket.off?.("presence:update");
    socket.off?.("connect");
    socket.off?.("disconnect");

    socket.on("connect", () => {
      socket.emit?.("presence:update", { isOnline: true });
    });

    socket.on("message:new", (message: LastMessage) => {
      if (!message?.conversationId) return;
      setConversations(prev => upsertConversationWithMessage(prev, message, user?.id));
    });

    socket.on("typing:indicator", ({ conversationId, isTyping, username }: any) => {
      if (!conversationId || !username) return;
      setTypingUsers(prev => {
        const current = prev[conversationId] || [];
        const updated = isTyping ? [...new Set([...current, username])] : current.filter(name => name !== username);
        return { ...prev, [conversationId]: updated };
      });
    });

    socket.on("message:seen", ({ conversationId }: any) => {
      if (!conversationId) return;
      setConversations(prev =>
        prev.map(item =>
          item.id === conversationId
            ? {
                ...item,
                unreadCount: 0,
                lastMessage: item.lastMessage ? { ...item.lastMessage, status: "SEEN" } : item.lastMessage
              }
            : item
        )
      );
    });

    socket.on("conversation:new", (conversation: Conversation) => {
      if (!conversation?.id) return;
      setConversations(prev => sortConversations([conversation, ...prev.filter(item => item.id !== conversation.id)]));
    });

    socket.on("conversation:archived", ({ conversationId, archived }: any) => {
      if (!conversationId || !archived) return;
      setConversations(prev => prev.filter(item => item.id !== conversationId));
    });

    socket.on("conversation:muted", ({ conversationId }: any) => {
      if (!conversationId) return;
      setConversations(prev =>
        prev.map(item =>
          item.id === conversationId
            ? {
                ...item,
                participants: item.participants.map(participant =>
                  participant.user?.id === user?.id ? { ...participant, isMuted: true } : participant
                )
              }
            : item
        )
      );
    });

    socket.on("presence:update", ({ userId, isOnline, lastSeen }: any) => {
      setConversations(prev =>
        prev.map(conversation => ({
          ...conversation,
          participants: conversation.participants.map(participant =>
            participant.user?.id === userId
              ? { ...participant, user: { ...participant.user, isOnline, lastSeen } }
              : participant
          )
        }))
      );
    });
  }, [user?.id]);

  useFocusEffect(
    useCallback(() => {
      mountedRef.current = true;
      fetchConversations();
      connectSocket();

      return () => {
        mountedRef.current = false;
        socketRef.current?.off?.("message:new");
        socketRef.current?.off?.("typing:indicator");
        socketRef.current?.off?.("message:seen");
        socketRef.current?.off?.("conversation:new");
        socketRef.current?.off?.("conversation:archived");
        socketRef.current?.off?.("conversation:muted");
        socketRef.current?.off?.("presence:update");
      };
    }, [fetchConversations, connectSocket])
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await fetchConversations(true);
  }, [fetchConversations]);

  const filteredConversations = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return conversations;

    return conversations.filter(conversation => {
      const title = getConversationTitle(conversation, user?.id).toLowerCase();
      const username = getOtherParticipant(conversation, user?.id)?.user?.username?.toLowerCase() || "";
      const message = conversation.lastMessage?.content?.toLowerCase() || "";
      return title.includes(q) || username.includes(q) || message.includes(q);
    });
  }, [conversations, searchQuery, user?.id]);

  const openConversation = useCallback(
    (conversation: Conversation) => {
      const otherParticipant = getOtherParticipant(conversation, user?.id);
      const title = getConversationTitle(conversation, user?.id);
      Keyboard.dismiss();
      setConversations(prev => prev.map(item => (item.id === conversation.id ? { ...item, unreadCount: 0 } : item)));
      navigation.navigate("Chat", {
        conversationId: conversation.id,
        title,
        participant: otherParticipant?.user,
        type: conversation.type
      });
    },
    [navigation, user?.id]
  );

  const onLongPressConversation = useCallback((conversation: Conversation) => {
    navigation.navigate("ChatOptions", { conversationId: conversation.id });
  }, [navigation]);

  const renderConversation = useCallback(
    ({ item }: { item: Conversation }) => (
      <ConversationRow
        item={item}
        currentUserId={user?.id}
        currentUsername={user?.username}
        typingUsers={typingUsers[item.id] || []}
        onPress={openConversation}
        onLongPress={onLongPressConversation}
      />
    ),
    [user?.id, user?.username, typingUsers, openConversation, onLongPressConversation]
  );

  const listEmpty = useMemo(() => {
    if (initialLoading) {
      return (
        <View style={styles.empty}>
          <ActivityIndicator size="small" color={theme.colors.neonCyan || theme.colors.neon || "#00F5D4"} />
          <Text style={styles.emptyTitle}>Loading chats...</Text>
        </View>
      );
    }

    if (error) {
      return (
        <View style={styles.empty}>
          <Text style={styles.emptyIcon}>⚠</Text>
          <Text style={styles.emptyTitle}>{error}</Text>
          <Pressable style={styles.retryButton} onPress={() => fetchConversations()}>
            <Text style={styles.retryText}>Retry</Text>
          </Pressable>
        </View>
      );
    }

    return (
      <View style={styles.empty}>
        <Text style={styles.emptyIcon}>✦</Text>
        <Text style={styles.emptyTitle}>{searchQuery ? "No matching chats" : "No chats yet"}</Text>
        <Text style={styles.emptySubtitle}>{searchQuery ? "Search spelling check kar ya new chat start kar" : "New chat start kar aur realtime DM test kar"}</Text>
      </View>
    );
  }, [initialLoading, error, searchQuery, fetchConversations]);

  return (
    <View style={styles.container}>
      <View style={styles.topBar}>
        <View>
          <Text style={styles.title}>Chats</Text>
          <Text style={styles.subtitle}>{conversations.length} conversations</Text>
        </View>
        <Pressable style={styles.topButton} onPress={() => navigation.navigate("NewChat")}>
          <Text style={styles.topButtonText}>＋</Text>
        </Pressable>
      </View>

      <View style={styles.searchWrap}>
        <Text style={styles.searchIcon}>⌕</Text>
        <TextInput
          placeholder="Search conversations..."
          placeholderTextColor="#9CA3AF"
          value={searchQuery}
          onChangeText={setSearchQuery}
          style={styles.search}
          returnKeyType="search"
          autoCorrect={false}
        />
        {searchQuery.length > 0 && (
          <Pressable onPress={() => setSearchQuery("")} style={styles.clearSearch}>
            <Text style={styles.clearSearchText}>×</Text>
          </Pressable>
        )}
      </View>

      <FlatList
        data={filteredConversations}
        keyExtractor={item => item.id}
        renderItem={renderConversation}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.neonCyan || theme.colors.neon || "#00F5D4"}
            colors={[theme.colors.neonCyan || theme.colors.neon || "#00F5D4"]}
          />
        }
        ListEmptyComponent={listEmpty}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        initialNumToRender={12}
        maxToRenderPerBatch={12}
        windowSize={10}
        removeClippedSubviews={Platform.OS === "android"}
        contentContainerStyle={[styles.listContent, filteredConversations.length === 0 && styles.emptyListContent]}
      />

      <Pressable style={styles.fab} onPress={() => navigation.navigate("NewChat")}>
        <Text style={styles.fabText}>＋</Text>
      </Pressable>
    </View>
  );
}

const accent = theme.colors.neonCyan || theme.colors.neon || "#00F5D4";
const gold = theme.colors.premiumGold || theme.colors.gold || "#D4AF37";
const charcoal = theme.colors.deepCharcoal || "#111827";

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.softWhite || "#F8F9FC"
  },
  topBar: {
    paddingTop: Platform.OS === "ios" ? 58 : 34,
    paddingHorizontal: 18,
    paddingBottom: 14,
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(17,24,39,0.08)"
  },
  title: {
    fontSize: 30,
    fontWeight: "900",
    color: charcoal,
    letterSpacing: -0.8
  },
  subtitle: {
    marginTop: 2,
    fontSize: 13,
    fontWeight: "600",
    color: "#8E94A3"
  },
  topButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: accent,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 16,
    elevation: 5
  },
  topButtonText: {
    color: "#FFFFFF",
    fontSize: 25,
    fontWeight: "600",
    marginTop: -2
  },
  searchWrap: {
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 8,
    height: 48,
    borderRadius: 24,
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    borderWidth: 1,
    borderColor: "rgba(0,245,212,0.18)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.04,
    shadowRadius: 18,
    elevation: 2
  },
  searchIcon: {
    fontSize: 22,
    color: "#9CA3AF",
    marginRight: 8,
    marginTop: -1
  },
  search: {
    flex: 1,
    fontSize: 15,
    fontWeight: "600",
    color: charcoal,
    paddingVertical: 0
  },
  clearSearch: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#F1F3F9"
  },
  clearSearchText: {
    fontSize: 18,
    color: "#8E94A3",
    fontWeight: "700",
    marginTop: -1
  },
  listContent: {
    paddingTop: 4,
    paddingBottom: 96
  },
  emptyListContent: {
    flexGrow: 1
  },
  row: {
    marginHorizontal: 12,
    marginVertical: 5,
    padding: 12,
    borderRadius: 22,
    backgroundColor: "#FFFFFF",
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "rgba(17,24,39,0.06)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.035,
    shadowRadius: 16,
    elevation: 1
  },
  pressedRow: {
    backgroundColor: "#F9FAFB"
  },
  unreadRow: {
    borderColor: "rgba(0,245,212,0.32)",
    shadowColor: accent,
    shadowOpacity: 0.1,
    elevation: 3
  },
  mutedRow: {
    opacity: 0.72
  },
  avatarWrap: {
    width: 58,
    height: 58,
    borderRadius: 29
  },
  avatar: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: "#E5E7EB"
  },
  onlineDot: {
    position: "absolute",
    right: 2,
    bottom: 3,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#2ED573",
    borderWidth: 2,
    borderColor: "#FFFFFF"
  },
  groupBadge: {
    position: "absolute",
    left: -2,
    bottom: -1,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: gold,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#FFFFFF"
  },
  groupBadgeText: {
    color: "#FFFFFF",
    fontSize: 9,
    fontWeight: "900"
  },
  content: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  nameWrap: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    minWidth: 0
  },
  name: {
    flexShrink: 1,
    fontSize: 16,
    fontWeight: "800",
    color: charcoal,
    letterSpacing: -0.2
  },
  unreadName: {
    fontWeight: "900"
  },
  verified: {
    marginLeft: 5,
    color: accent,
    fontSize: 14,
    fontWeight: "900"
  },
  mutedIcon: {
    marginLeft: 5,
    color: "#9CA3AF",
    fontSize: 14,
    fontWeight: "900"
  },
  time: {
    fontSize: 12,
    fontWeight: "700",
    color: "#9CA3AF"
  },
  unreadTime: {
    color: accent
  },
  messageRow: {
    marginTop: 6,
    flexDirection: "row",
    alignItems: "center",
    minHeight: 22
  },
  lastMessage: {
    flex: 1,
    fontSize: 14,
    color: "#6B7280",
    fontWeight: "600"
  },
  unreadMessage: {
    color: "#374151",
    fontWeight: "800"
  },
  typingText: {
    color: accent,
    fontStyle: "italic",
    fontWeight: "800"
  },
  status: {
    marginLeft: 8,
    fontSize: 12,
    fontWeight: "900",
    color: "#9CA3AF"
  },
  statusSeen: {
    color: accent
  },
  statusFailed: {
    color: "#FF4757"
  },
  badge: {
    marginLeft: 8,
    minWidth: 22,
    height: 22,
    paddingHorizontal: 7,
    borderRadius: 11,
    backgroundColor: accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: accent,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 10,
    elevation: 3
  },
  badgeText: {
    color: "#FFFFFF",
    fontSize: 11,
    fontWeight: "900"
  },
  fab: {
    position: "absolute",
    right: 20,
    bottom: 24,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: accent,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.28,
    shadowRadius: 20,
    elevation: 8
  },
  fabText: {
    color: "#FFFFFF",
    fontSize: 30,
    fontWeight: "500",
    marginTop: -3
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 34,
    paddingBottom: 80
  },
  emptyIcon: {
    fontSize: 38,
    color: accent,
    marginBottom: 10
  },
  emptyTitle: {
    fontSize: 17,
    fontWeight: "900",
    color: charcoal,
    textAlign: "center"
  },
  emptySubtitle: {
    marginTop: 7,
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
    color: "#8E94A3",
    textAlign: "center"
  },
  retryButton: {
    marginTop: 16,
    height: 42,
    paddingHorizontal: 22,
    borderRadius: 21,
    backgroundColor: accent,
    alignItems: "center",
    justifyContent: "center"
  },
  retryText: {
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "900"
  }
});
