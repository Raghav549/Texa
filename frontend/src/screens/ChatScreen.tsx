import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
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
} from "react-native";
import { useFocusEffect, useRoute } from "@react-navigation/native";
import * as ImagePicker from "expo-image-picker";
import { Audio } from "expo-av";
import { api } from "../api/client";
import { ws } from "../api/ws";
import { useAuth } from "../store/auth";
import { theme } from "../theme";
import { formatMessageTime, formatTimeAgo } from "../utils/time";

type MediaType = "image" | "video" | "voice" | "file" | "location";
type MessageStatus = "sent" | "delivered" | "seen" | "failed";

interface UserLite {
  id: string;
  username: string;
  avatarUrl?: string | null;
  isVerified?: boolean;
  isOnline?: boolean;
  lastSeen?: string | null;
}

interface Message {
  id: string;
  conversationId?: string;
  senderId?: string;
  sender: UserLite;
  content?: string | null;
  media?: { type: MediaType; url: string; metadata?: any } | null;
  mediaUrl?: string | null;
  replyTo?: { id: string; content?: string | null; sender: { username: string } } | null;
  reactions?: Record<string, number> | null;
  status: MessageStatus;
  createdAt: string;
  editedAt?: string | null;
  deletedAt?: string | null;
  hidden?: boolean;
  poll?: any;
  payment?: any;
}

interface RouteParams {
  conversationId: string;
  title?: string;
  participant?: UserLite;
}

const COLORS = {
  neon: theme?.colors?.neonCyan || theme?.colors?.neon || "#00F5D4",
  gold: theme?.colors?.premiumGold || theme?.colors?.gold || "#D4AF37",
  violet: theme?.colors?.electricViolet || "#7B61FF",
  charcoal: theme?.colors?.deepCharcoal || "#1A1A2E",
  softGray: theme?.colors?.softGray || "#8E94A3",
  white: theme?.colors?.pureWhite || "#FFFFFF",
  softWhite: theme?.colors?.softWhite || "#F8F9FC",
  iceWhite: theme?.colors?.iceWhite || "#F1F3F9",
  error: theme?.colors?.errorRed || "#FF4757",
  success: theme?.colors?.successGreen || "#2ED573"
};

const EMOJIS = ["❤️", "🔥", "😂", "😊", "😮", "😢", "👍", "👎"];

const avatarFallback = (name?: string | null) =>
  `https://api.dicebear.com/7.x/initials/png?seed=${encodeURIComponent(name || "Texa")}&backgroundColor=00F5D4,7B61FF,D4AF37&textColor=ffffff`;

const normalizeMessage = (message: any): Message => {
  const sender = message?.sender || {};
  const media =
    message?.media ||
    (message?.mediaUrl
      ? {
          type: message?.mediaType || "image",
          url: message.mediaUrl,
          metadata: message?.mediaMetadata || {}
        }
      : null);

  return {
    id: String(message.id),
    conversationId: message.conversationId,
    senderId: message.senderId || sender.id,
    sender: {
      id: sender.id || message.senderId || "",
      username: sender.username || "user",
      avatarUrl: sender.avatarUrl || null,
      isVerified: !!sender.isVerified,
      isOnline: !!sender.isOnline,
      lastSeen: sender.lastSeen || null
    },
    content: message.content || null,
    media,
    mediaUrl: message.mediaUrl || null,
    replyTo: message.replyTo || null,
    reactions: message.reactions || {},
    status: (String(message.status || "sent").toLowerCase() as MessageStatus) || "sent",
    createdAt: message.createdAt || new Date().toISOString(),
    editedAt: message.editedAt || null,
    deletedAt: message.deletedAt || null,
    hidden: !!message.hidden,
    poll: message.poll || null,
    payment: message.payment || null
  };
};

const uniqueById = (items: Message[]) => {
  const map = new Map<string, Message>();
  items.forEach(item => map.set(item.id, item));
  return Array.from(map.values()).sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
};

const MessageBubble = memo(
  ({
    item,
    currentUserId,
    onLongPress,
    onReactionPress,
    onPollVote
  }: {
    item: Message;
    currentUserId?: string;
    onLongPress: (message: Message, x: number, y: number) => void;
    onReactionPress: (message: Message) => void;
    onPollVote: (messageId: string, optionIndex: number) => void;
  }) => {
    if (item.hidden || item.deletedAt) return null;

    const isOwn = item.senderId === currentUserId || item.sender?.id === currentUserId;
    const activeReactions = Object.entries(item.reactions || {}).filter(([, count]) => Number(count) > 0);
    const bubbleStyle = isOwn ? styles.ownBubble : styles.otherBubble;
    const textStyle = isOwn ? styles.ownText : styles.otherText;
    const metaStyle = isOwn ? styles.ownMetaText : styles.otherMetaText;

    return (
      <Pressable
        onLongPress={e => onLongPress(item, e.nativeEvent.pageX, e.nativeEvent.pageY)}
        delayLongPress={250}
        style={[styles.messageRow, isOwn ? styles.ownRow : styles.otherRow]}
      >
        {!isOwn && <Image source={{ uri: item.sender.avatarUrl || avatarFallback(item.sender.username) }} style={styles.msgAvatar} />}
        <View style={[styles.bubble, bubbleStyle]}>
          {!isOwn && (
            <View style={styles.senderLine}>
              <Text style={styles.senderName}>@{item.sender.username}</Text>
              {item.sender.isVerified && <Text style={styles.senderVerified}>✓</Text>}
            </View>
          )}

          {item.replyTo && (
            <View style={[styles.replyPreview, isOwn ? styles.ownReplyPreview : styles.otherReplyPreview]}>
              <Text style={[styles.replyName, isOwn && styles.ownReplyName]}>@{item.replyTo.sender.username}</Text>
              <Text style={[styles.replyText, isOwn && styles.ownReplyText]} numberOfLines={1}>
                {item.replyTo.content || "Media"}
              </Text>
            </View>
          )}

          {!!item.content && (
            <Text style={[styles.msgText, textStyle]}>
              {item.content}
              {!!item.editedAt && <Text style={[styles.edited, isOwn && styles.ownEdited]}> edited</Text>}
            </Text>
          )}

          {!!item.media && (
            <View style={styles.mediaContainer}>
              {item.media.type === "image" && <Image source={{ uri: item.media.url }} style={styles.mediaImage} />}
              {item.media.type === "video" && (
                <TouchableOpacity activeOpacity={0.9} style={styles.videoBox}>
                  <Image source={{ uri: item.media.url }} style={styles.mediaImage} />
                  <View style={styles.playIcon}>
                    <Text style={styles.playText}>▶</Text>
                  </View>
                </TouchableOpacity>
              )}
              {item.media.type === "voice" && (
                <View style={[styles.voicePlayer, isOwn && styles.ownVoicePlayer]}>
                  <TouchableOpacity style={styles.voicePlay}>
                    <Text style={styles.voicePlayText}>▶</Text>
                  </TouchableOpacity>
                  <View style={styles.waveform}>
                    {Array.from({ length: 24 }).map((_, i) => (
                      <View key={i} style={[styles.waveBar, { height: 8 + ((i * 7) % 22) }]} />
                    ))}
                  </View>
                  <Text style={[styles.voiceTime, isOwn && styles.ownVoiceTime]}>{item.media.metadata?.duration || "0:15"}</Text>
                </View>
              )}
              {item.media.type === "file" && (
                <TouchableOpacity style={[styles.fileCard, isOwn && styles.ownFileCard]}>
                  <Text style={styles.fileIcon}>📎</Text>
                  <View style={styles.fileInfo}>
                    <Text style={[styles.fileName, isOwn && styles.ownFileName]} numberOfLines={1}>
                      {item.media.metadata?.name || "Attachment"}
                    </Text>
                    <Text style={[styles.fileSize, isOwn && styles.ownFileSize]}>{item.media.metadata?.size || "Tap to open"}</Text>
                  </View>
                </TouchableOpacity>
              )}
              {item.media.type === "location" && (
                <TouchableOpacity style={[styles.locationCard, isOwn && styles.ownLocationCard]}>
                  <Text style={styles.locationIcon}>📍</Text>
                  <View>
                    <Text style={[styles.locationTitle, isOwn && styles.ownLocationTitle]}>Location Shared</Text>
                    <Text style={[styles.locationName, isOwn && styles.ownLocationName]} numberOfLines={1}>
                      {item.media.metadata?.name || "Open map"}
                    </Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
          )}

          {!!item.poll && (
            <View style={[styles.pollCard, isOwn && styles.ownPollCard]}>
              <Text style={[styles.pollQuestion, isOwn && styles.ownPollQuestion]}>{item.poll.question}</Text>
              {(item.poll.options || []).map((opt: any, index: number) => {
                const votes = opt.votes?.length || 0;
                const total = Math.max(
                  1,
                  (item.poll.options || []).reduce((sum: number, option: any) => sum + (option.votes?.length || 0), 0)
                );
                const percent = Math.round((votes / total) * 100);
                return (
                  <TouchableOpacity key={`${item.id}-poll-${index}`} style={styles.pollOption} onPress={() => onPollVote(item.id, index)}>
                    <View style={[styles.pollFill, { width: `${percent}%` }]} />
                    <Text style={styles.pollText}>{opt.text}</Text>
                    <Text style={styles.pollVotes}>{votes}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>
          )}

          {!!item.payment && (
            <View style={[styles.paymentCard, isOwn && styles.ownPaymentCard]}>
              <Text style={styles.paymentAmount}>💰 {item.payment.amount} TEXA</Text>
              <Text style={styles.paymentStatus}>{item.payment.status === "completed" ? "Completed" : "Pending"}</Text>
            </View>
          )}

          {activeReactions.length > 0 && (
            <View style={[styles.reactions, isOwn ? styles.ownReactions : styles.otherReactions]}>
              {activeReactions.map(([emoji, count]) => (
                <TouchableOpacity key={`${item.id}-${emoji}`} style={styles.reaction} onPress={() => onReactionPress(item)}>
                  <Text style={styles.reactionEmoji}>{emoji}</Text>
                  <Text style={styles.reactionCount}>{count}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          <View style={styles.msgMeta}>
            <Text style={[styles.msgTime, metaStyle]}>{formatMessageTime(item.createdAt)}</Text>
            {isOwn && (
              <Text style={[styles.msgStatus, item.status === "seen" && styles.seenStatus]}>
                {item.status === "seen" ? "✓✓" : item.status === "delivered" ? "✓✓" : item.status === "failed" ? "!" : "✓"}
              </Text>
            )}
          </View>
        </View>
      </Pressable>
    );
  }
);

export default function ChatScreen({ navigation }: any) {
  const route = useRoute();
  const { conversationId, title, participant } = route.params as RouteParams;
  const { user } = useAuth();

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [showActions, setShowActions] = useState<{ message: Message; x: number; y: number } | null>(null);
  const [showReactions, setShowReactions] = useState<{ message: Message } | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [recordingStartedAt, setRecordingStartedAt] = useState<number | null>(null);
  const [typing, setTyping] = useState(false);
  const [remoteTyping, setRemoteTyping] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loadingInitial, setLoadingInitial] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [sending, setSending] = useState(false);

  const flatListRef = useRef<FlatList<Message>>(null);
  const typingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteTypingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const socketRef = useRef<any>(null);
  const mountedRef = useRef(true);

  const displayTitle = title || participant?.username || "Chat";
  const displayAvatar = participant?.avatarUrl || avatarFallback(displayTitle);

  const invertedMessages = useMemo(() => [...messages].reverse(), [messages]);

  const stopTyping = useCallback(() => {
    socketRef.current?.emit("typing:stop", { conversationId });
    setTyping(false);
  }, [conversationId]);

  const loadMessages = useCallback(
    async (cursor?: string) => {
      if (!conversationId) return;
      try {
        cursor ? setLoadingMore(true) : setLoadingInitial(true);
        const response = await api.get(`/dm/messages/${conversationId}`, {
          params: { limit: 30, before: cursor }
        });
        const payload = response?.data || {};
        const list = Array.isArray(payload.messages) ? payload.messages.map(normalizeMessage) : [];
        if (!mountedRef.current) return;
        setMessages(prev => uniqueById(cursor ? [...list, ...prev] : list));
        setHasMore(!!payload.hasMore);
      } catch {
        if (!cursor) Alert.alert("Messages", "Messages load nahi ho paaye. Dobara try karo.");
      } finally {
        if (mountedRef.current) {
          setLoadingInitial(false);
          setLoadingMore(false);
          setRefreshing(false);
        }
      }
    },
    [conversationId]
  );

  const markSeen = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      socketRef.current?.emit("message:seen", { messageIds: ids, conversationId });
    },
    [conversationId]
  );

  useFocusEffect(
    useCallback(() => {
      mountedRef.current = true;
      loadMessages();

      let active = true;

      (async () => {
        const socket = await ws();
        if (!active) return;
        socketRef.current = socket;
        socket.emit("conversation:join", { conversationId });

        const onNewMessage = (raw: any) => {
          const message = normalizeMessage(raw);
          if (message.conversationId && message.conversationId !== conversationId) return;
          setMessages(prev => uniqueById([...prev, message]));
          if ((message.senderId || message.sender?.id) !== user?.id) markSeen([message.id]);
        };

        const onEdited = ({ id, content, editedAt }: any) => {
          setMessages(prev => prev.map(m => (m.id === id ? { ...m, content, editedAt } : m)));
        };

        const onDeleted = ({ messageId, deletedForEveryone }: any) => {
          setMessages(prev => (deletedForEveryone ? prev.filter(m => m.id !== messageId) : prev.map(m => (m.id === messageId ? { ...m, hidden: true } : m))));
        };

        const onReaction = ({ messageId, emoji, remove }: any) => {
          setMessages(prev =>
            prev.map(m => {
              if (m.id !== messageId) return m;
              const reactions = { ...(m.reactions || {}) };
              reactions[emoji] = remove ? Math.max(0, (reactions[emoji] || 0) - 1) : (reactions[emoji] || 0) + 1;
              return { ...m, reactions };
            })
          );
        };

        const onTyping = ({ userId, isTyping, username }: any) => {
          if (userId === user?.id) return;
          setRemoteTyping(prev => {
            const next = isTyping ? Array.from(new Set([...prev, username || "Someone"])) : prev.filter(name => name !== username);
            return next;
          });
          if (remoteTypingTimeout.current) clearTimeout(remoteTypingTimeout.current);
          remoteTypingTimeout.current = setTimeout(() => setRemoteTyping([]), 3500);
        };

        const onSeen = ({ messageId }: any) => {
          setMessages(prev => prev.map(m => (m.id === messageId && (m.senderId === user?.id || m.sender?.id === user?.id) ? { ...m, status: "seen" } : m)));
        };

        const onPaymentCompleted = ({ messageId, amount }: any) => {
          setMessages(prev =>
            prev.map(m => (m.id === messageId ? { ...m, payment: { ...(m.payment || {}), status: "completed", amount: amount || m.payment?.amount } } : m))
          );
        };

        const onPollUpdated = ({ messageId, poll }: any) => {
          setMessages(prev => prev.map(m => (m.id === messageId ? { ...m, poll } : m)));
        };

        socket.on("message:new", onNewMessage);
        socket.on("message:edited", onEdited);
        socket.on("message:deleted", onDeleted);
        socket.on("message:reaction:broadcast", onReaction);
        socket.on("message:reaction", onReaction);
        socket.on("typing:indicator", onTyping);
        socket.on("message:seen", onSeen);
        socket.on("payment:completed", onPaymentCompleted);
        socket.on("poll:updated", onPollUpdated);
      })();

      return () => {
        active = false;
        mountedRef.current = false;
        if (typingTimeout.current) clearTimeout(typingTimeout.current);
        if (remoteTypingTimeout.current) clearTimeout(remoteTypingTimeout.current);
        socketRef.current?.emit("conversation:leave", { conversationId });
        socketRef.current?.off("message:new");
        socketRef.current?.off("message:edited");
        socketRef.current?.off("message:deleted");
        socketRef.current?.off("message:reaction:broadcast");
        socketRef.current?.off("message:reaction");
        socketRef.current?.off("typing:indicator");
        socketRef.current?.off("message:seen");
        socketRef.current?.off("payment:completed");
        socketRef.current?.off("poll:updated");
        stopTyping();
      };
    }, [conversationId, loadMessages, markSeen, stopTyping, user?.id])
  );

  useEffect(() => {
    if (!input.trim()) return;
    const timeout = setTimeout(() => {
      api.post("/dm/draft", { conversationId, content: input }).catch(() => {});
    }, 900);
    return () => clearTimeout(timeout);
  }, [input, conversationId]);

  const handleTyping = useCallback(
    (text: string) => {
      setInput(text);
      if (!typing) {
        socketRef.current?.emit("typing:start", { conversationId });
        setTyping(true);
      }
      socketRef.current?.emit("typing:activity", { conversationId });
      if (typingTimeout.current) clearTimeout(typingTimeout.current);
      typingTimeout.current = setTimeout(stopTyping, 1800);
    },
    [conversationId, stopTyping, typing]
  );

  const sendMessage = useCallback(async () => {
    const trimmed = input.trim();
    if (!trimmed || sending) return;
    const tempId = `temp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      conversationId,
      senderId: user?.id,
      sender: {
        id: user?.id || "",
        username: user?.username || "You",
        avatarUrl: user?.avatarUrl || null,
        isVerified: !!user?.isVerified
      },
      content: trimmed,
      replyTo: replyingTo
        ? {
            id: replyingTo.id,
            content: replyingTo.content || "Media",
            sender: { username: replyingTo.sender.username }
          }
        : null,
      reactions: {},
      status: "sent",
      createdAt: new Date().toISOString()
    };

    try {
      setSending(true);
      setInput("");
      setReplyingTo(null);
      setMessages(prev => uniqueById([...prev, optimistic]));
      stopTyping();
      const response = await api.post("/dm/send", {
        conversationId,
        content: trimmed,
        replyToId: replyingTo?.id
      });
      const saved = normalizeMessage(response?.data);
      setMessages(prev => uniqueById(prev.map(m => (m.id === tempId ? saved : m))));
      markSeen([saved.id]);
    } catch {
      setMessages(prev => prev.map(m => (m.id === tempId ? { ...m, status: "failed" } : m)));
      Alert.alert("Message failed", "Message send nahi hua. Internet ya server check karo.");
    } finally {
      setSending(false);
    }
  }, [conversationId, input, markSeen, replyingTo, sending, stopTyping, user]);

  const uploadMedia = useCallback(
    async (asset: any, type: MediaType) => {
      const tempId = `temp-media-${Date.now()}`;
      const uri = asset.uri;
      const mimeType = asset.mimeType || (type === "voice" ? "audio/mp4" : type === "video" ? "video/mp4" : "image/jpeg");
      const name = asset.fileName || `${type}_${Date.now()}.${String(uri).split(".").pop() || "jpg"}`;

      const optimistic: Message = {
        id: tempId,
        conversationId,
        senderId: user?.id,
        sender: {
          id: user?.id || "",
          username: user?.username || "You",
          avatarUrl: user?.avatarUrl || null,
          isVerified: !!user?.isVerified
        },
        content: null,
        media: { type, url: uri, metadata: asset.metadata || {} },
        replyTo: replyingTo
          ? {
              id: replyingTo.id,
              content: replyingTo.content || "Media",
              sender: { username: replyingTo.sender.username }
            }
          : null,
        reactions: {},
        status: "sent",
        createdAt: new Date().toISOString()
      };

      try {
        setMessages(prev => uniqueById([...prev, optimistic]));
        const fd = new FormData();
        fd.append("conversationId", conversationId);
        fd.append("mediaType", type);
        fd.append("media", { uri, name, type: mimeType } as any);
        if (replyingTo?.id) fd.append("replyToId", replyingTo.id);
        const response = await api.post("/dm/send", fd, {
          headers: { "Content-Type": "multipart/form-data" }
        });
        const saved = normalizeMessage(response?.data);
        setMessages(prev => uniqueById(prev.map(m => (m.id === tempId ? saved : m))));
        setReplyingTo(null);
      } catch {
        setMessages(prev => prev.map(m => (m.id === tempId ? { ...m, status: "failed" } : m)));
        Alert.alert("Upload failed", "Media send nahi hua.");
      }
    },
    [conversationId, replyingTo, user]
  );

  const pickMedia = useCallback(
    async (type: "image" | "video") => {
      const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!permission.granted) {
        Alert.alert("Permission required", "Gallery access allow karo.");
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: type === "image" ? ImagePicker.MediaTypeOptions.Images : ImagePicker.MediaTypeOptions.Videos,
        quality: 0.85,
        allowsEditing: false
      });
      if (!result.canceled && result.assets?.[0]) uploadMedia(result.assets[0], type);
    },
    [uploadMedia]
  );

  const startRecording = useCallback(async () => {
    try {
      const { granted } = await Audio.requestPermissionsAsync();
      if (!granted) {
        Alert.alert("Permission required", "Voice note ke liye microphone permission allow karo.");
        return;
      }
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false
      });
      const created = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
      setRecording(created.recording);
      setRecordingStartedAt(Date.now());
      setIsRecording(true);
    } catch {
      Alert.alert("Recording failed", "Voice recording start nahi ho paayi.");
    }
  }, []);

  const stopRecording = useCallback(async () => {
    if (!recording) return;
    try {
      setIsRecording(false);
      await recording.stopAndUnloadAsync();
      const uri = recording.getURI();
      const duration = recordingStartedAt ? Math.max(1, Math.round((Date.now() - recordingStartedAt) / 1000)) : 0;
      setRecording(null);
      setRecordingStartedAt(null);
      if (!uri) return;
      await uploadMedia({ uri, mimeType: "audio/mp4", fileName: `voice_${Date.now()}.m4a`, metadata: { duration: `0:${String(duration).padStart(2, "0")}` } }, "voice");
    } catch {
      setIsRecording(false);
      setRecording(null);
      Alert.alert("Recording failed", "Voice note send nahi hua.");
    }
  }, [recording, recordingStartedAt, uploadMedia]);

  const handleReaction = useCallback(async (messageId: string, emoji: string, remove = false) => {
    try {
      await api.post(`/dm/messages/${messageId}/react`, { emoji, remove });
      setShowReactions(null);
    } catch {
      Alert.alert("Reaction failed", "Reaction add nahi hua.");
    }
  }, []);

  const handleDelete = useCallback((messageId: string, forEveryone = false) => {
    Alert.alert("Delete Message", forEveryone ? "Delete for everyone?" : "Delete for you?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          try {
            await api.post(`/dm/messages/${messageId}/delete`, { deleteForEveryone: forEveryone });
            setMessages(prev => (forEveryone ? prev.filter(m => m.id !== messageId) : prev.map(m => (m.id === messageId ? { ...m, hidden: true } : m))));
            setShowActions(null);
          } catch {
            Alert.alert("Delete failed", "Message delete nahi hua.");
          }
        }
      }
    ]);
  }, []);

  const handleForward = useCallback(async (message: Message) => {
    try {
      navigation.navigate("ForwardMessage", { messageId: message.id, conversationId });
      setShowActions(null);
    } catch {
      Alert.alert("Forward", "Forward screen available nahi hai.");
    }
  }, [conversationId, navigation]);

  const handleShare = useCallback(async (message: Message) => {
    try {
      await Share.share({
        message: message.content || message.media?.url || "Check this message on Texa",
        title: `Message from @${message.sender.username}`
      });
      setShowActions(null);
    } catch {}
  }, []);

  const handleCopy = useCallback((message: Message) => {
    Alert.alert("Copied", message.content || "Media message");
    setShowActions(null);
  }, []);

  const handlePollVote = useCallback((messageId: string, optionIndex: number) => {
    socketRef.current?.emit("poll:vote", { messageId, optionIndex });
  }, []);

  const openActions = useCallback((message: Message, x: number, y: number) => {
    setShowActions({ message, x: Math.min(x, 210), y: Math.min(y, 520) });
  }, []);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadMessages();
  }, [loadMessages]);

  const onLoadMore = useCallback(() => {
    if (!hasMore || loadingMore || loadingInitial || messages.length === 0) return;
    loadMessages(messages[0]?.createdAt || messages[0]?.id);
  }, [hasMore, loadingInitial, loadingMore, loadMessages, messages]);

  const renderItem = useCallback(
    ({ item }: { item: Message }) => (
      <MessageBubble
        item={item}
        currentUserId={user?.id}
        onLongPress={openActions}
        onReactionPress={message => setShowReactions({ message })}
        onPollVote={handlePollVote}
      />
    ),
    [handlePollVote, openActions, user?.id]
  );

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => navigation.goBack()} style={styles.backBtn}>
          <Text style={styles.back}>‹</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerUser} onPress={() => participant?.id && navigation.navigate("UserProfile", { userId: participant.id })}>
          <View>
            <Image source={{ uri: displayAvatar }} style={styles.headerAvatar} />
            {!!participant?.isOnline && <View style={styles.onlineDot} />}
          </View>
          <View style={styles.headerTextBox}>
            <Text style={styles.headerName} numberOfLines={1}>
              {displayTitle} {participant?.isVerified ? "✓" : ""}
            </Text>
            <Text style={styles.headerStatus} numberOfLines={1}>
              {remoteTyping.length > 0 ? `${remoteTyping.join(", ")} typing...` : participant?.isOnline ? "Online" : participant?.lastSeen ? `Last seen ${formatTimeAgo(participant.lastSeen)}` : "Texa chat"}
            </Text>
          </View>
        </TouchableOpacity>
        <TouchableOpacity style={styles.headerIcon} onPress={() => navigation.navigate("ChatOptions", { conversationId, participant })}>
          <Text style={styles.more}>⋮</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        ref={flatListRef}
        data={invertedMessages}
        keyExtractor={item => item.id}
        renderItem={renderItem}
        inverted
        onEndReached={onLoadMore}
        onEndReachedThreshold={0.25}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={COLORS.neon} />}
        ListFooterComponent={loadingMore ? <Text style={styles.loading}>Loading older messages...</Text> : null}
        ListEmptyComponent={
          loadingInitial ? (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>💬</Text>
              <Text style={styles.emptyTitle}>Loading chat...</Text>
            </View>
          ) : (
            <View style={styles.emptyBox}>
              <Text style={styles.emptyIcon}>✨</Text>
              <Text style={styles.emptyTitle}>Start the conversation</Text>
              <Text style={styles.emptySub}>Send a message, media, voice note, poll, or coins.</Text>
            </View>
          )
        }
        contentContainerStyle={styles.messagesContent}
        keyboardShouldPersistTaps="handled"
        removeClippedSubviews={Platform.OS === "android"}
        initialNumToRender={18}
        maxToRenderPerBatch={14}
        windowSize={12}
      />

      <View style={styles.inputArea}>
        {!!replyingTo && (
          <View style={styles.replyBar}>
            <View style={styles.replyAccent} />
            <View style={styles.replyBarContent}>
              <Text style={styles.replyBarTitle}>Replying to @{replyingTo.sender.username}</Text>
              <Text style={styles.replyBarText} numberOfLines={1}>
                {replyingTo.content || "Media"}
              </Text>
            </View>
            <TouchableOpacity onPress={() => setReplyingTo(null)} style={styles.closeBtn}>
              <Text style={styles.close}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.inputRow}>
          <TouchableOpacity onPress={() => pickMedia("image")} style={styles.toolBtn}>
            <Text style={styles.toolIcon}>📷</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => pickMedia("video")} style={styles.toolBtn}>
            <Text style={styles.toolIcon}>🎬</Text>
          </TouchableOpacity>
          <TextInput
            style={styles.input}
            value={input}
            onChangeText={handleTyping}
            placeholder="Message..."
            placeholderTextColor={COLORS.softGray}
            multiline
            maxLength={4000}
          />
          {isRecording ? (
            <TouchableOpacity onPress={stopRecording} style={[styles.recordBtn, styles.recordingBtn]}>
              <Text style={styles.recordText}>■</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity onPress={startRecording} style={styles.recordBtn}>
              <Text style={styles.recordText}>🎤</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={sendMessage} disabled={!input.trim() || sending} style={[styles.sendBtn, (!input.trim() || sending) && styles.sendDisabled]}>
            <Text style={styles.sendText}>{input.trim() ? "Send" : "➤"}</Text>
          </TouchableOpacity>
        </View>
      </View>

      <Modal transparent visible={!!showActions} animationType="fade" onRequestClose={() => setShowActions(null)}>
        <Pressable style={styles.modalOverlay} onPress={() => setShowActions(null)}>
          {!!showActions && (
            <View style={[styles.actionsMenu, { top: showActions.y, left: showActions.x }]}>
              <TouchableOpacity
                onPress={() => {
                  setReplyingTo(showActions.message);
                  setShowActions(null);
                }}
                style={styles.actionItem}
              >
                <Text style={styles.actionText}>↩️ Reply</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => {
                  setShowReactions({ message: showActions.message });
                  setShowActions(null);
                }}
                style={styles.actionItem}
              >
                <Text style={styles.actionText}>😊 React</Text>
              </TouchableOpacity>
              {!!showActions.message.content && (
                <TouchableOpacity onPress={() => handleCopy(showActions.message)} style={styles.actionItem}>
                  <Text style={styles.actionText}>📋 Copy</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={() => handleForward(showActions.message)} style={styles.actionItem}>
                <Text style={styles.actionText}>↗️ Forward</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleShare(showActions.message)} style={styles.actionItem}>
                <Text style={styles.actionText}>📤 Share</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleDelete(showActions.message.id)} style={styles.actionItem}>
                <Text style={styles.actionDanger}>🗑️ Delete for me</Text>
              </TouchableOpacity>
              {(showActions.message.senderId === user?.id || showActions.message.sender?.id === user?.id) && (
                <TouchableOpacity onPress={() => handleDelete(showActions.message.id, true)} style={styles.actionItem}>
                  <Text style={styles.actionDanger}>🧨 Delete for everyone</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
        </Pressable>
      </Modal>

      <Modal transparent visible={!!showReactions} animationType="fade" onRequestClose={() => setShowReactions(null)}>
        <Pressable style={styles.modalOverlayCenter} onPress={() => setShowReactions(null)}>
          {!!showReactions && (
            <View style={styles.reactionPicker}>
              {EMOJIS.map(emoji => (
                <TouchableOpacity key={emoji} onPress={() => handleReaction(showReactions.message.id, emoji)} style={styles.reactionOption}>
                  <Text style={styles.reactionOptionText}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.white },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 10,
    paddingTop: Platform.OS === "ios" ? 52 : 14,
    paddingBottom: 10,
    backgroundColor: COLORS.white,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(26,26,46,0.08)"
  },
  backBtn: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  back: { fontSize: 36, color: COLORS.charcoal, marginTop: -3 },
  headerUser: { flex: 1, flexDirection: "row", alignItems: "center" },
  headerAvatar: { width: 42, height: 42, borderRadius: 21, backgroundColor: COLORS.iceWhite },
  onlineDot: {
    position: "absolute",
    right: 1,
    bottom: 1,
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: COLORS.success,
    borderWidth: 2,
    borderColor: COLORS.white
  },
  headerTextBox: { flex: 1, marginLeft: 10 },
  headerName: { fontWeight: "800", fontSize: 16, color: COLORS.charcoal },
  headerStatus: { fontSize: 12, color: COLORS.softGray, marginTop: 1 },
  headerIcon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  more: { fontSize: 25, color: COLORS.charcoal, marginTop: -3 },
  messagesContent: { paddingHorizontal: 10, paddingVertical: 12, flexGrow: 1 },
  loading: { textAlign: "center", color: COLORS.softGray, fontSize: 12, paddingVertical: 10 },
  emptyBox: { flex: 1, alignItems: "center", justifyContent: "center", paddingHorizontal: 28, paddingVertical: 80 },
  emptyIcon: { fontSize: 42, marginBottom: 12 },
  emptyTitle: { fontSize: 18, fontWeight: "800", color: COLORS.charcoal, textAlign: "center" },
  emptySub: { fontSize: 13, color: COLORS.softGray, textAlign: "center", marginTop: 6, lineHeight: 19 },
  messageRow: { flexDirection: "row", marginVertical: 4, maxWidth: "88%" },
  ownRow: { alignSelf: "flex-end", flexDirection: "row-reverse" },
  otherRow: { alignSelf: "flex-start" },
  msgAvatar: { width: 30, height: 30, borderRadius: 15, marginRight: 7, marginTop: 4, backgroundColor: COLORS.iceWhite },
  bubble: {
    paddingHorizontal: 11,
    paddingVertical: 8,
    borderRadius: 20,
    minWidth: 54,
    maxWidth: "100%",
    shadowColor: "#000",
    shadowOpacity: 0.05,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1
  },
  ownBubble: { backgroundColor: COLORS.neon, borderBottomRightRadius: 6 },
  otherBubble: { backgroundColor: COLORS.softWhite, borderBottomLeftRadius: 6 },
  senderLine: { flexDirection: "row", alignItems: "center", marginBottom: 3 },
  senderName: { fontSize: 11, fontWeight: "800", color: COLORS.violet },
  senderVerified: { fontSize: 11, color: COLORS.neon, marginLeft: 3, fontWeight: "900" },
  msgText: { fontSize: 15, lineHeight: 21 },
  ownText: { color: COLORS.white, fontWeight: "500" },
  otherText: { color: COLORS.charcoal },
  edited: { fontSize: 10, color: COLORS.softGray, fontStyle: "italic" },
  ownEdited: { color: "rgba(255,255,255,0.8)" },
  replyPreview: { borderLeftWidth: 3, paddingLeft: 8, paddingVertical: 5, paddingRight: 8, borderRadius: 10, marginBottom: 6 },
  ownReplyPreview: { backgroundColor: "rgba(255,255,255,0.18)", borderLeftColor: COLORS.white },
  otherReplyPreview: { backgroundColor: "rgba(0,245,212,0.08)", borderLeftColor: COLORS.neon },
  replyName: { fontSize: 11, fontWeight: "800", color: COLORS.violet },
  ownReplyName: { color: COLORS.white },
  replyText: { fontSize: 12, color: COLORS.softGray, marginTop: 1 },
  ownReplyText: { color: "rgba(255,255,255,0.82)" },
  mediaContainer: { marginTop: 6 },
  mediaImage: { width: 220, height: 220, borderRadius: 16, backgroundColor: COLORS.iceWhite },
  videoBox: { position: "relative" },
  playIcon: {
    position: "absolute",
    top: "50%",
    left: "50%",
    transform: [{ translateX: -22 }, { translateY: -22 }],
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.55)",
    alignItems: "center",
    justifyContent: "center"
  },
  playText: { color: COLORS.white, fontSize: 18, marginLeft: 2 },
  voicePlayer: { flexDirection: "row", alignItems: "center", backgroundColor: "rgba(26,26,46,0.06)", padding: 8, borderRadius: 18, minWidth: 210 },
  ownVoicePlayer: { backgroundColor: "rgba(255,255,255,0.2)" },
  voicePlay: { width: 28, height: 28, borderRadius: 14, backgroundColor: COLORS.white, alignItems: "center", justifyContent: "center" },
  voicePlayText: { color: COLORS.charcoal, fontSize: 12, marginLeft: 1 },
  waveform: { flex: 1, height: 34, marginHorizontal: 9, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  waveBar: { width: 3, borderRadius: 2, backgroundColor: "rgba(26,26,46,0.28)" },
  voiceTime: { fontSize: 11, color: COLORS.softGray, fontWeight: "700" },
  ownVoiceTime: { color: COLORS.white },
  fileCard: { flexDirection: "row", alignItems: "center", padding: 10, borderRadius: 14, backgroundColor: "rgba(26,26,46,0.06)", minWidth: 210 },
  ownFileCard: { backgroundColor: "rgba(255,255,255,0.18)" },
  fileIcon: { fontSize: 22, marginRight: 8 },
  fileInfo: { flex: 1 },
  fileName: { fontSize: 13, fontWeight: "800", color: COLORS.charcoal },
  ownFileName: { color: COLORS.white },
  fileSize: { fontSize: 11, color: COLORS.softGray, marginTop: 2 },
  ownFileSize: { color: "rgba(255,255,255,0.78)" },
  locationCard: { flexDirection: "row", alignItems: "center", padding: 11, borderRadius: 14, backgroundColor: "rgba(0,245,212,0.08)", minWidth: 210 },
  ownLocationCard: { backgroundColor: "rgba(255,255,255,0.18)" },
  locationIcon: { fontSize: 23, marginRight: 8 },
  locationTitle: { fontSize: 13, fontWeight: "800", color: COLORS.charcoal },
  ownLocationTitle: { color: COLORS.white },
  locationName: { fontSize: 11, color: COLORS.softGray, marginTop: 2 },
  ownLocationName: { color: "rgba(255,255,255,0.78)" },
  pollCard: { marginTop: 6, padding: 10, borderRadius: 14, backgroundColor: "rgba(255,255,255,0.72)", minWidth: 230 },
  ownPollCard: { backgroundColor: "rgba(255,255,255,0.2)" },
  pollQuestion: { fontWeight: "900", fontSize: 14, color: COLORS.charcoal, marginBottom: 8 },
  ownPollQuestion: { color: COLORS.white },
  pollOption: { minHeight: 36, borderRadius: 12, backgroundColor: "rgba(26,26,46,0.06)", marginTop: 6, overflow: "hidden", flexDirection: "row", alignItems: "center", paddingHorizontal: 10 },
  pollFill: { position: "absolute", left: 0, top: 0, bottom: 0, backgroundColor: "rgba(0,245,212,0.22)" },
  pollText: { flex: 1, fontSize: 13, color: COLORS.charcoal, fontWeight: "700" },
  pollVotes: { fontSize: 12, color: COLORS.softGray, fontWeight: "800" },
  paymentCard: { marginTop: 6, padding: 12, borderRadius: 14, backgroundColor: "rgba(212,175,55,0.12)", borderLeftWidth: 4, borderLeftColor: COLORS.gold },
  ownPaymentCard: { backgroundColor: "rgba(255,255,255,0.18)", borderLeftColor: COLORS.white },
  paymentAmount: { fontWeight: "900", fontSize: 16, color: COLORS.charcoal },
  paymentStatus: { fontSize: 12, color: COLORS.softGray, marginTop: 3, fontWeight: "700" },
  reactions: { flexDirection: "row", flexWrap: "wrap", marginTop: 5 },
  ownReactions: { justifyContent: "flex-end" },
  otherReactions: { justifyContent: "flex-start" },
  reaction: { flexDirection: "row", alignItems: "center", backgroundColor: COLORS.white, paddingHorizontal: 7, paddingVertical: 3, borderRadius: 14, marginRight: 4, marginTop: 3 },
  reactionEmoji: { fontSize: 12 },
  reactionCount: { fontSize: 10, color: COLORS.charcoal, marginLeft: 3, fontWeight: "800" },
  msgMeta: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", marginTop: 4 },
  msgTime: { fontSize: 10, fontWeight: "600" },
  ownMetaText: { color: "rgba(255,255,255,0.82)" },
  otherMetaText: { color: COLORS.softGray },
  msgStatus: { fontSize: 10, color: "rgba(255,255,255,0.9)", marginLeft: 5, fontWeight: "900" },
  seenStatus: { color: COLORS.violet },
  inputArea: {
    backgroundColor: COLORS.white,
    borderTopWidth: 1,
    borderTopColor: "rgba(26,26,46,0.08)",
    paddingBottom: Platform.OS === "ios" ? 20 : 8
  },
  replyBar: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 8, backgroundColor: COLORS.softWhite },
  replyAccent: { width: 4, height: 36, borderRadius: 2, backgroundColor: COLORS.neon, marginRight: 9 },
  replyBarContent: { flex: 1 },
  replyBarTitle: { fontSize: 12, fontWeight: "900", color: COLORS.charcoal },
  replyBarText: { fontSize: 12, color: COLORS.softGray, marginTop: 1 },
  closeBtn: { width: 30, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  close: { fontSize: 16, color: COLORS.softGray, fontWeight: "900" },
  inputRow: { flexDirection: "row", alignItems: "flex-end", paddingHorizontal: 8, paddingTop: 8 },
  toolBtn: { width: 36, height: 40, alignItems: "center", justifyContent: "center" },
  toolIcon: { fontSize: 21 },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 118,
    backgroundColor: COLORS.softWhite,
    borderRadius: 22,
    paddingHorizontal: 15,
    paddingVertical: Platform.OS === "ios" ? 11 : 8,
    fontSize: 15,
    color: COLORS.charcoal,
    borderWidth: 1,
    borderColor: "rgba(26,26,46,0.06)"
  },
  recordBtn: { width: 40, height: 40, borderRadius: 20, backgroundColor: COLORS.iceWhite, justifyContent: "center", alignItems: "center", marginLeft: 7 },
  recordingBtn: { backgroundColor: COLORS.error },
  recordText: { fontSize: 17, color: COLORS.white },
  sendBtn: {
    minWidth: 54,
    height: 40,
    borderRadius: 20,
    backgroundColor: COLORS.neon,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 7,
    paddingHorizontal: 12,
    shadowColor: COLORS.neon,
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3
  },
  sendDisabled: { opacity: 0.55 },
  sendText: { color: COLORS.white, fontWeight: "900", fontSize: 13 },
  modalOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.18)" },
  modalOverlayCenter: { flex: 1, backgroundColor: "rgba(0,0,0,0.18)", justifyContent: "center", alignItems: "center" },
  actionsMenu: {
    position: "absolute",
    backgroundColor: COLORS.white,
    borderRadius: 18,
    paddingVertical: 8,
    minWidth: 210,
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8
  },
  actionItem: { paddingVertical: 11, paddingHorizontal: 15 },
  actionText: { fontSize: 14, color: COLORS.charcoal, fontWeight: "700" },
  actionDanger: { fontSize: 14, color: COLORS.error, fontWeight: "800" },
  reactionPicker: {
    flexDirection: "row",
    backgroundColor: COLORS.white,
    borderRadius: 28,
    padding: 8,
    shadowColor: "#000",
    shadowOpacity: 0.22,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8
  },
  reactionOption: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  reactionOptionText: { fontSize: 24 }
});
