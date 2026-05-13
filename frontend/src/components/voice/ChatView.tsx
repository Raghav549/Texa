import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Image,
  LayoutAnimation,
  UIManager,
  Pressable,
  ViewStyle,
  NativeSyntheticEvent,
  TextInputSubmitEditingEventData
} from 'react-native';
import { FlashList, ListRenderItemInfo } from '@shopify/flash-list';
import * as Haptics from 'expo-haptics';
import { theme } from '../../theme';
import { useRoomStore } from '../../store/voice/roomSlice';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type Sender = {
  id?: string;
  username?: string;
  fullName?: string;
  avatarUrl?: string;
  isVerified?: boolean;
  level?: string;
};

export interface VoiceChatMessage {
  id: string;
  senderId: string;
  content: string;
  mediaUrl?: string;
  replyToId?: string;
  replyTo?: Partial<VoiceChatMessage>;
  reactions?: Record<string, number>;
  myReactions?: string[];
  isPinned?: boolean;
  isSystem?: boolean;
  isDeleted?: boolean;
  isEdited?: boolean;
  timestamp: number;
  sender?: Sender | any;
  status?: 'sending' | 'sent' | 'failed';
  type?: 'text' | 'system' | 'gift' | 'notice';
}

type ChatViewProps = {
  messages?: VoiceChatMessage[];
  onReaction?: (id: string, emoji: string) => void;
  onSend?: (content: string, extra?: Record<string, any>) => boolean | void;
  onReply?: (message: VoiceChatMessage | null) => void;
  onLongPressMessage?: (message: VoiceChatMessage) => void;
  onRetry?: (message: VoiceChatMessage) => void;
  roomId?: string | null;
  currentUserId?: string | null;
  maxHeight?: number;
  placeholder?: string;
  disabled?: boolean;
  compact?: boolean;
  style?: ViewStyle;
};

const ProChatIcon = {
  send: '➤',
  reply: '↩',
  pin: '◆',
  verified: '✓',
  system: '✦',
  failed: '!',
  sending: '◌',
  emoji: '◇',
  spark: '✧',
  lock: '▰',
  close: '×',
  edit: '✎'
} as const;

const QUICK_REACTIONS = ['✧', '◆', '♡', '🔥', '👏', '😂'];

function formatTime(ts?: number) {
  if (!ts) return '';
  const date = new Date(ts);
  const h = date.getHours().toString().padStart(2, '0');
  const m = date.getMinutes().toString().padStart(2, '0');
  return `${h}:${m}`;
}

function safeName(sender?: Sender | any) {
  return sender?.username || sender?.fullName || 'user';
}

function initials(sender?: Sender | any) {
  const value = sender?.fullName || sender?.username || 'U';
  return String(value).slice(0, 1).toUpperCase();
}

function normalizeMessages(messages: VoiceChatMessage[]) {
  return [...(Array.isArray(messages) ? messages : [])].sort((a, b) => Number(a.timestamp || 0) - Number(b.timestamp || 0));
}

function createClientId() {
  return `chat_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

const Avatar = memo(({ sender, isSystem }: { sender?: Sender | any; isSystem?: boolean }) => {
  const uri = sender?.avatarUrl;

  if (isSystem) {
    return (
      <View style={[styles.avatar, styles.systemAvatar]}>
        <Text style={styles.systemAvatarText}>{ProChatIcon.system}</Text>
      </View>
    );
  }

  if (uri) {
    return <Image source={{ uri }} style={styles.avatar} />;
  }

  return (
    <View style={styles.avatarFallback}>
      <Text style={styles.avatarFallbackText}>{initials(sender)}</Text>
    </View>
  );
});

const ReactionBar = memo(
  ({
    message,
    onReaction
  }: {
    message: VoiceChatMessage;
    onReaction?: (id: string, emoji: string) => void;
  }) => {
    const reactions = Object.entries(message.reactions || {}).filter(([, count]) => Number(count) > 0);

    if (!reactions.length) return null;

    return (
      <View style={styles.reactions}>
        {reactions.slice(0, 5).map(([emoji, count]) => {
          const active = message.myReactions?.includes(emoji);

          return (
            <TouchableOpacity
              key={`${message.id}-${emoji}`}
              activeOpacity={0.75}
              onPress={() => onReaction?.(message.id, emoji)}
              style={[styles.reactBadge, active && styles.reactBadgeActive]}
            >
              <Text style={styles.reactEmoji}>{emoji}</Text>
              <Text style={[styles.reactCount, active && styles.reactCountActive]}>{count}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }
);

const QuickReactionRow = memo(
  ({
    messageId,
    onReaction
  }: {
    messageId: string;
    onReaction?: (id: string, emoji: string) => void;
  }) => {
    return (
      <View style={styles.quickReactionRow}>
        {QUICK_REACTIONS.map(emoji => (
          <TouchableOpacity
            key={`${messageId}-${emoji}`}
            activeOpacity={0.72}
            onPress={() => onReaction?.(messageId, emoji)}
            style={styles.quickReaction}
          >
            <Text style={styles.quickReactionText}>{emoji}</Text>
          </TouchableOpacity>
        ))}
      </View>
    );
  }
);

const MessageBubble = memo(
  ({
    item,
    isMine,
    compact,
    onReaction,
    onReply,
    onLongPressMessage,
    onRetry
  }: {
    item: VoiceChatMessage;
    isMine: boolean;
    compact: boolean;
    onReaction?: (id: string, emoji: string) => void;
    onReply?: (message: VoiceChatMessage | null) => void;
    onLongPressMessage?: (message: VoiceChatMessage) => void;
    onRetry?: (message: VoiceChatMessage) => void;
  }) => {
    const [showQuick, setShowQuick] = useState(false);
    const isSystem = item.isSystem || item.type === 'system' || item.senderId === 'system';
    const senderName = safeName(item.sender);

    const handleLongPress = useCallback(() => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setShowQuick(prev => !prev);
      onLongPressMessage?.(item);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => null);
    }, [item, onLongPressMessage]);

    if (isSystem) {
      return (
        <View style={styles.systemRow}>
          <View style={styles.systemPill}>
            <Text style={styles.systemText}>{item.content}</Text>
          </View>
        </View>
      );
    }

    return (
      <Pressable onLongPress={handleLongPress} style={[styles.msgRow, isMine && styles.msgRowMine]}>
        {!isMine && <Avatar sender={item.sender} />}
        <View style={[styles.bubbleWrap, isMine && styles.bubbleWrapMine]}>
          {item.isPinned && (
            <View style={styles.pinStrip}>
              <Text style={styles.pinIcon}>{ProChatIcon.pin}</Text>
              <Text style={styles.pinText}>Pinned message</Text>
            </View>
          )}

          {item.replyToId && (
            <TouchableOpacity activeOpacity={0.8} onPress={() => onReply?.(item)} style={styles.replyBox}>
              <Text style={styles.replyIcon}>{ProChatIcon.reply}</Text>
              <View style={styles.replyContent}>
                <Text style={styles.replyTitle} numberOfLines={1}>
                  Reply
                </Text>
                <Text style={styles.replyText} numberOfLines={1}>
                  {item.replyTo?.content || 'Original message'}
                </Text>
              </View>
            </TouchableOpacity>
          )}

          <View style={[styles.bubble, isMine && styles.bubbleMine, item.isPinned && styles.bubblePinned, item.status === 'failed' && styles.bubbleFailed]}>
            <View style={styles.senderLine}>
              <Text style={[styles.sender, isMine && styles.senderMine]} numberOfLines={1}>
                @{senderName}
              </Text>
              {item.sender?.isVerified && (
                <View style={styles.verifiedBadge}>
                  <Text style={styles.verifiedText}>{ProChatIcon.verified}</Text>
                </View>
              )}
              {!!item.sender?.level && <Text style={styles.levelText}>{item.sender.level}</Text>}
            </View>

            <Text style={[styles.content, isMine && styles.contentMine, item.isDeleted && styles.deletedText]}>
              {item.isDeleted ? 'This message was deleted' : item.content}
            </Text>

            <View style={styles.metaLine}>
              {item.isEdited && <Text style={styles.editedText}>{ProChatIcon.edit} edited</Text>}
              <Text style={[styles.timeText, isMine && styles.timeTextMine]}>{formatTime(item.timestamp)}</Text>
              {item.status === 'sending' && <Text style={styles.statusSending}>{ProChatIcon.sending}</Text>}
              {item.status === 'failed' && (
                <TouchableOpacity onPress={() => onRetry?.(item)} style={styles.retryPill}>
                  <Text style={styles.retryText}>{ProChatIcon.failed} Retry</Text>
                </TouchableOpacity>
              )}
            </View>
          </View>

          <ReactionBar message={item} onReaction={onReaction} />

          {showQuick && <QuickReactionRow messageId={item.id} onReaction={onReaction} />}
        </View>
        {isMine && <Avatar sender={item.sender || { username: 'You' }} />}
      </Pressable>
    );
  }
);

export default function ChatView({
  messages = [],
  onReaction,
  onSend,
  onReply,
  onLongPressMessage,
  onRetry,
  roomId = null,
  currentUserId = null,
  maxHeight = 260,
  placeholder = 'Type message...',
  disabled = false,
  compact = false,
  style
}: ChatViewProps) {
  const [input, setInput] = useState('');
  const [replyingTo, setReplyingTo] = useState<VoiceChatMessage | null>(null);
  const listRef = useRef<FlashList<VoiceChatMessage>>(null);

  const store = useRoomStore() as any;
  const addChat = store?.addChat;
  const sendChat = store?.sendChat;
  const emit = store?.emit;
  const user = store?.user || store?.me || store?.currentUser;
  const activeUserId = currentUserId || user?.id || store?.userId || 'me';

  const data = useMemo(() => normalizeMessages(messages), [messages]);

  const pinned = useMemo(() => data.filter(item => item.isPinned).slice(-2), [data]);

  useEffect(() => {
    if (!data.length) return;
    requestAnimationFrame(() => {
      listRef.current?.scrollToEnd?.({ animated: true });
    });
  }, [data.length]);

  const handleReaction = useCallback(
    (id: string, emoji: string) => {
      Haptics.selectionAsync().catch(() => null);
      onReaction?.(id, emoji);
      if (!onReaction && typeof emit === 'function') {
        emit('chat:react', { roomId, messageId: id, emoji });
      }
    },
    [emit, onReaction, roomId]
  );

  const handleReply = useCallback(
    (message: VoiceChatMessage | null) => {
      setReplyingTo(message);
      onReply?.(message);
    },
    [onReply]
  );

  const send = useCallback(() => {
    const content = input.trim();
    if (!content || disabled) return;

    const temp: VoiceChatMessage = {
      id: createClientId(),
      senderId: activeUserId,
      content,
      replyToId: replyingTo?.id,
      replyTo: replyingTo || undefined,
      reactions: {},
      myReactions: [],
      isPinned: false,
      timestamp: Date.now(),
      sender: user || { id: activeUserId, username: 'You', avatarUrl: '', isVerified: false },
      status: 'sending',
      type: 'text'
    };

    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    addChat?.(temp);
    setInput('');
    setReplyingTo(null);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => null);

    const extra = {
      roomId,
      replyToId: replyingTo?.id,
      clientId: temp.id
    };

    if (onSend) {
      onSend(content, extra);
      return;
    }

    if (typeof sendChat === 'function') {
      sendChat(content, extra);
      return;
    }

    if (typeof emit === 'function') {
      emit('chat:send', { content, ...extra });
    }
  }, [activeUserId, addChat, disabled, emit, input, onSend, replyingTo, roomId, sendChat, user]);

  const onSubmitEditing = useCallback(
    (_event: NativeSyntheticEvent<TextInputSubmitEditingEventData>) => {
      send();
    },
    [send]
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<VoiceChatMessage>) => {
      const isMine = item.senderId === activeUserId || item.sender?.id === activeUserId;

      return (
        <MessageBubble
          item={item}
          isMine={isMine}
          compact={compact}
          onReaction={handleReaction}
          onReply={handleReply}
          onLongPressMessage={onLongPressMessage}
          onRetry={onRetry}
        />
      );
    },
    [activeUserId, compact, handleReaction, handleReply, onLongPressMessage, onRetry]
  );

  const keyExtractor = useCallback((item: VoiceChatMessage) => item.id, []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { maxHeight }, compact && styles.containerCompact, style]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 80 : 0}
    >
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <Text style={styles.headerIcon}>{ProChatIcon.chat || '▣'}</Text>
          <Text style={styles.headerTitle}>Live Chat</Text>
          <Text style={styles.headerCount}>{data.length}</Text>
        </View>
        <View style={styles.headerRight}>
          <Text style={styles.headerSpark}>{ProChatIcon.spark}</Text>
        </View>
      </View>

      {!!pinned.length && (
        <View style={styles.pinnedDock}>
          {pinned.map(item => (
            <TouchableOpacity key={`pinned-${item.id}`} activeOpacity={0.82} onPress={() => handleReply(item)} style={styles.pinnedMini}>
              <Text style={styles.pinnedMiniIcon}>{ProChatIcon.pin}</Text>
              <Text style={styles.pinnedMiniText} numberOfLines={1}>
                {item.content}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      <FlashList
        ref={listRef}
        data={data}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        estimatedItemSize={74}
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={styles.emptyIcon}>{ProChatIcon.spark}</Text>
            <Text style={styles.emptyTitle}>No messages yet</Text>
            <Text style={styles.emptyText}>Start the room conversation</Text>
          </View>
        }
      />

      {replyingTo && (
        <View style={styles.replyComposer}>
          <View style={styles.replyComposerBar} />
          <View style={styles.replyComposerContent}>
            <Text style={styles.replyComposerTitle}>Replying to @{safeName(replyingTo.sender)}</Text>
            <Text style={styles.replyComposerText} numberOfLines={1}>
              {replyingTo.content}
            </Text>
          </View>
          <TouchableOpacity onPress={() => handleReply(null)} style={styles.replyClose}>
            <Text style={styles.replyCloseText}>{ProChatIcon.close}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={[styles.inputRow, disabled && styles.inputRowDisabled]}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder={disabled ? 'Chat locked' : placeholder}
          placeholderTextColor="#9B9B9B"
          onSubmitEditing={onSubmitEditing}
          editable={!disabled}
          returnKeyType="send"
          maxLength={500}
          multiline
        />
        <TouchableOpacity
          onPress={send}
          activeOpacity={0.82}
          disabled={disabled || !input.trim()}
          style={[styles.send, (!input.trim() || disabled) && styles.sendDisabled]}
        >
          <Text style={styles.sendText}>{ProChatIcon.send}</Text>
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

export { ProChatIcon };

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: 'rgba(250,250,250,0.96)',
    borderRadius: 22,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4
  },
  containerCompact: {
    borderRadius: 18
  },
  header: {
    height: 42,
    paddingHorizontal: 12,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(0,0,0,0.055)'
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  headerIcon: {
    fontSize: 13,
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    marginRight: 7
  },
  headerTitle: {
    fontSize: 13,
    fontWeight: '900',
    color: '#151515',
    letterSpacing: 0.3
  },
  headerCount: {
    marginLeft: 8,
    fontSize: 10,
    fontWeight: '900',
    color: '#777',
    backgroundColor: '#F1F1F1',
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
    overflow: 'hidden'
  },
  headerRight: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,168,87,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.22)'
  },
  headerSpark: {
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    fontSize: 13
  },
  pinnedDock: {
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 6,
    backgroundColor: '#FFF9E8',
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(212,168,87,0.2)'
  },
  pinnedMini: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.2)'
  },
  pinnedMiniIcon: {
    color: theme.colors?.gold || '#D4A857',
    fontSize: 12,
    fontWeight: '900',
    marginRight: 7
  },
  pinnedMiniText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '700',
    color: '#4A3A16'
  },
  listContent: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    paddingBottom: 12
  },
  msgRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginBottom: 9
  },
  msgRowMine: {
    justifyContent: 'flex-end'
  },
  bubbleWrap: {
    flex: 1,
    maxWidth: '82%',
    marginLeft: 8
  },
  bubbleWrapMine: {
    marginLeft: 0,
    marginRight: 8,
    alignItems: 'flex-end'
  },
  bubble: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 18,
    borderBottomLeftRadius: 6,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.055)',
    shadowColor: '#000',
    shadowOpacity: 0.04,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2
  },
  bubbleMine: {
    alignSelf: 'flex-end',
    backgroundColor: theme.colors?.neonCyan || '#00E0FF',
    borderBottomLeftRadius: 18,
    borderBottomRightRadius: 6,
    borderColor: 'rgba(0,0,0,0.04)'
  },
  bubblePinned: {
    borderColor: 'rgba(212,168,87,0.42)',
    backgroundColor: '#FFFDF4'
  },
  bubbleFailed: {
    borderColor: 'rgba(255,59,95,0.45)'
  },
  senderLine: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 3,
    maxWidth: '100%'
  },
  sender: {
    fontWeight: '900',
    fontSize: 12,
    color: theme.colors?.neonCyan || '#00AFCB',
    maxWidth: 140
  },
  senderMine: {
    color: '#05343C'
  },
  verifiedBadge: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 5
  },
  verifiedText: {
    color: theme.colors?.gold || '#D4A857',
    fontSize: 9,
    fontWeight: '900'
  },
  levelText: {
    marginLeft: 5,
    fontSize: 9,
    fontWeight: '900',
    color: '#6F5A2A',
    backgroundColor: 'rgba(212,168,87,0.15)',
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    overflow: 'hidden'
  },
  content: {
    fontSize: 13.5,
    lineHeight: 19,
    color: '#202020',
    fontWeight: '500'
  },
  contentMine: {
    color: '#021D22'
  },
  deletedText: {
    color: '#888',
    fontStyle: 'italic'
  },
  metaLine: {
    marginTop: 5,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6
  },
  timeText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#9A9A9A'
  },
  timeTextMine: {
    color: 'rgba(0,0,0,0.45)'
  },
  editedText: {
    fontSize: 9,
    fontWeight: '700',
    color: '#999'
  },
  statusSending: {
    fontSize: 10,
    color: '#777',
    fontWeight: '900'
  },
  retryPill: {
    backgroundColor: '#FFE9EE',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 999
  },
  retryText: {
    color: '#FF3B5F',
    fontSize: 9,
    fontWeight: '900'
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#EEE'
  },
  avatarFallback: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#151515',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.45)'
  },
  avatarFallbackText: {
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    fontSize: 12
  },
  systemAvatar: {
    backgroundColor: '#111',
    alignItems: 'center',
    justifyContent: 'center'
  },
  systemAvatarText: {
    color: theme.colors?.gold || '#D4A857',
    fontSize: 12,
    fontWeight: '900'
  },
  pinStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginBottom: 5,
    backgroundColor: '#FFF4D6',
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999
  },
  pinIcon: {
    fontSize: 9,
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    marginRight: 5
  },
  pinText: {
    fontSize: 9,
    fontWeight: '900',
    color: '#7B5B16',
    textTransform: 'uppercase',
    letterSpacing: 0.35
  },
  replyBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.045)',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 6,
    marginBottom: 6,
    borderLeftWidth: 2,
    borderLeftColor: theme.colors?.gold || '#D4A857'
  },
  replyIcon: {
    fontSize: 12,
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    marginRight: 7
  },
  replyContent: {
    flex: 1
  },
  replyTitle: {
    fontSize: 10,
    fontWeight: '900',
    color: '#555'
  },
  replyText: {
    fontSize: 10,
    color: '#777',
    marginTop: 1
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 5,
    marginTop: 5
  },
  reactBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 7,
    paddingVertical: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.07)'
  },
  reactBadgeActive: {
    backgroundColor: '#111',
    borderColor: 'rgba(212,168,87,0.55)'
  },
  reactEmoji: {
    fontSize: 11,
    marginRight: 3
  },
  reactCount: {
    fontSize: 10,
    fontWeight: '900',
    color: '#555'
  },
  reactCountActive: {
    color: theme.colors?.gold || '#D4A857'
  },
  quickReactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 6,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 5,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.07)',
    alignSelf: 'flex-start'
  },
  quickReaction: {
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F5F5F5'
  },
  quickReactionText: {
    fontSize: 13
  },
  systemRow: {
    alignItems: 'center',
    marginVertical: 7
  },
  systemPill: {
    maxWidth: '86%',
    backgroundColor: '#F1F1F1',
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.055)'
  },
  systemText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#777',
    textAlign: 'center'
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 34
  },
  emptyIcon: {
    fontSize: 22,
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    marginBottom: 8
  },
  emptyTitle: {
    fontSize: 14,
    fontWeight: '900',
    color: '#222'
  },
  emptyText: {
    marginTop: 3,
    fontSize: 12,
    color: '#888',
    fontWeight: '600'
  },
  replyComposer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFF9E8',
    borderTopWidth: 1,
    borderTopColor: 'rgba(212,168,87,0.22)',
    paddingHorizontal: 10,
    paddingVertical: 8
  },
  replyComposerBar: {
    width: 3,
    height: 34,
    borderRadius: 999,
    backgroundColor: theme.colors?.gold || '#D4A857',
    marginRight: 9
  },
  replyComposerContent: {
    flex: 1
  },
  replyComposerTitle: {
    fontSize: 11,
    fontWeight: '900',
    color: '#6F5A2A'
  },
  replyComposerText: {
    fontSize: 11,
    color: '#777',
    marginTop: 2,
    fontWeight: '600'
  },
  replyClose: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8
  },
  replyCloseText: {
    fontSize: 17,
    color: '#777',
    fontWeight: '900'
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 9,
    borderTopWidth: 1,
    borderTopColor: 'rgba(0,0,0,0.06)',
    backgroundColor: '#FFFFFF'
  },
  inputRowDisabled: {
    opacity: 0.72
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 92,
    backgroundColor: '#F5F5F5',
    borderRadius: 20,
    paddingHorizontal: 14,
    paddingTop: Platform.OS === 'ios' ? 10 : 8,
    paddingBottom: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 13.5,
    fontWeight: '600',
    color: '#111',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.045)'
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: theme.colors?.neonCyan || '#00E0FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
    shadowColor: theme.colors?.neonCyan || '#00E0FF',
    shadowOpacity: 0.28,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4
  },
  sendDisabled: {
    backgroundColor: '#D8D8D8',
    shadowOpacity: 0,
    elevation: 0
  },
  sendText: {
    color: '#021D22',
    fontSize: 18,
    fontWeight: '900',
    marginLeft: 2
  }
});
