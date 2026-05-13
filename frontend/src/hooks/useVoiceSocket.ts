import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { io, Socket } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { useRoomStore } from '../../store/voice/roomSlice';

type VoiceSocketStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

type EmitAck<T = any> = {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
};

type QueuedEvent = {
  event: string;
  data?: any;
  ack?: (response: EmitAck) => void;
  ts: number;
  priority: number;
  retries: number;
  clientId: string;
};

type VoiceSocketOptions = {
  autoJoin?: boolean;
  enableQueue?: boolean;
  enablePresence?: boolean;
  enableHeartbeat?: boolean;
  heartbeatMs?: number;
  reconnectAttempts?: number;
  reconnectDelay?: number;
  ackTimeoutMs?: number;
  namespace?: string;
  debug?: boolean;
};

type VoiceSocketApi = {
  socket: Socket | null;
  socketId: string | null;
  status: VoiceSocketStatus;
  latency: number | null;
  lastError: string | null;
  isConnected: boolean;
  queueSize: number;
  icons: typeof VoiceIcon;
  emit: (event: string, data?: any, ack?: (response: EmitAck) => void, priority?: number) => boolean;
  emitAsync: <T = any>(event: string, data?: any, timeoutMs?: number, priority?: number) => Promise<EmitAck<T>>;
  connect: () => Promise<Socket | null>;
  disconnect: () => void;
  reconnect: () => Promise<Socket | null>;
  joinRoom: (targetRoomId?: string | null) => boolean;
  leaveRoom: (targetRoomId?: string | null) => boolean;
  resyncRoom: () => boolean;
  sendChat: (content: string, extra?: Record<string, any>) => boolean;
  editMessage: (messageId: string, content: string) => boolean;
  deleteMessage: (messageId: string) => boolean;
  pinMessage: (messageId: string, pinned?: boolean) => boolean;
  reactMessage: (messageId: string, emoji: string, remove?: boolean) => boolean;
  sendTyping: (isTyping: boolean) => boolean;
  sendGift: (giftId: string, toUserId: string, amount?: number, meta?: Record<string, any>) => boolean;
  takeSeat: (seatId?: string | null) => boolean;
  leaveSeat: () => boolean;
  raiseHand: (raised?: boolean) => boolean;
  muteMic: (muted?: boolean) => boolean;
  toggleMic: () => boolean;
  pushToTalk: (active: boolean) => boolean;
  updateSpeaking: (isSpeaking: boolean, audioLevel?: number) => boolean;
  createPoll: (question: string, options: string[], durationMs?: number) => boolean;
  submitPollVote: (pollId: string, optionId: string) => boolean;
  closeActivePoll: (pollId?: string) => boolean;
  updateHostControl: (control: string, value: any) => boolean;
  lockRoom: (locked: boolean) => boolean;
  setRoomMusic: (music: any) => boolean;
  inviteUser: (userId: string) => boolean;
  kickUser: (userId: string, reason?: string) => boolean;
  muteUser: (userId: string, muted?: boolean) => boolean;
};

const DEFAULT_WS_URL = 'wss://api.texa.app';
const TOKEN_KEYS = ['token', 'accessToken', 'authToken'];
const MAX_QUEUE = 120;
const QUEUE_TTL = 60_000;
const DEFAULT_HEARTBEAT_MS = 12_000;
const DEFAULT_ACK_TIMEOUT_MS = 12_000;
const MAX_EVENT_NAME_LENGTH = 96;
const MAX_REPLAY_RETRIES = 2;

const VoiceIcon = {
  live: '●',
  host: '♛',
  cohost: '◆',
  mod: '✦',
  micOn: '◉',
  micOff: '◌',
  speaking: '◍',
  hand: '◇',
  gift: '✧',
  poll: '◈',
  chat: '▣',
  locked: '▰',
  signal: '▰▰▰',
  reconnect: '↻',
  seat: '◐',
  leave: '◑',
  shield: '⬟',
  crown: '♛',
  spark: '✦',
  warning: '△'
} as const;

function getExtraValue(key: string) {
  const extra = Constants.expoConfig?.extra || (Constants as any).manifest2?.extra || (Constants as any).manifest?.extra || {};
  return (extra as any)?.[key];
}

function getBaseUrl() {
  const url = getExtraValue('wsUrl') || getExtraValue('apiWsUrl') || getExtraValue('socketUrl') || DEFAULT_WS_URL;
  return String(url).replace(/\/$/, '');
}

async function getStoredToken() {
  for (const key of TOKEN_KEYS) {
    const value = await AsyncStorage.getItem(key);
    if (value && value.trim()) return value.trim();
  }
  return '';
}

function now() {
  return Date.now();
}

function clientId(prefix = 'evt') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function cleanQueue(queue: QueuedEvent[]) {
  const current = now();
  return queue
    .filter(item => current - item.ts <= QUEUE_TTL && item.retries <= MAX_REPLAY_RETRIES)
    .sort((a, b) => b.priority - a.priority || a.ts - b.ts)
    .slice(-MAX_QUEUE);
}

function safeAck(ack: any, response: EmitAck) {
  if (typeof ack === 'function') ack(response);
}

function connected(socket?: Socket | null) {
  return !!socket?.connected;
}

function validEvent(event: string) {
  return typeof event === 'string' && event.length > 0 && event.length <= MAX_EVENT_NAME_LENGTH && /^[a-zA-Z0-9:_-]+$/.test(event);
}

function safePayload(data: any) {
  if (data === undefined || data === null) return {};
  if (typeof data !== 'object') return { value: data };
  return data;
}

function getRoomStateSnapshot() {
  try {
    return useRoomStore.getState() as any;
  } catch {
    return {};
  }
}

export function useVoiceSocket(roomId: string | null, options: VoiceSocketOptions = {}): VoiceSocketApi {
  const {
    autoJoin = true,
    enableQueue = true,
    enablePresence = true,
    enableHeartbeat = true,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    reconnectAttempts = 15,
    reconnectDelay = 650,
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    namespace = '/voice',
    debug = false
  } = options;

  const socketRef = useRef<Socket | null>(null);
  const queueRef = useRef<QueuedEvent[]>([]);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const connectingRef = useRef(false);
  const activeRoomRef = useRef<string | null>(roomId);
  const mountedRef = useRef(true);
  const lastJoinRef = useRef(0);
  const lastTypingRef = useRef(0);
  const lastSpeakingRef = useRef(0);

  const [status, setStatus] = useState<VoiceSocketStatus>('idle');
  const [socketId, setSocketId] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [queueSize, setQueueSize] = useState(0);

  const {
    sync,
    setSeats,
    addChat,
    upsertChat,
    editChat: storeEditChat,
    deleteChat: storeDeleteChat,
    pinChat,
    updateChatReaction,
    addMessageReaction,
    removeMessageReaction,
    addGift,
    setPoll,
    votePoll,
    closePoll,
    setConnection,
    upsertSeat,
    removeSeat,
    updateSeat,
    setSpeaking,
    setHandRaised,
    setMuted,
    setTyping,
    sweepTyping,
    setHostControl,
    patchHostControls,
    setUi,
    clearRoom
  } = useRoomStore() as any;

  const log = useCallback((...args: any[]) => {
    if (debug) console.log('[voice-socket]', ...args);
  }, [debug]);

  const updateStatus = useCallback((next: VoiceSocketStatus, error?: string | null) => {
    if (!mountedRef.current) return;
    setStatus(next);
    if (typeof error !== 'undefined') setLastError(error);
    setConnection?.({
      status: next,
      socketId: socketRef.current?.id || null,
      latency,
      error: error || null,
      lastSyncAt: now()
    });
  }, [latency, setConnection]);

  const flushQueue = useCallback(() => {
    const socket = socketRef.current;
    if (!enableQueue || !connected(socket)) return;

    const pending = cleanQueue(queueRef.current);
    queueRef.current = [];
    setQueueSize(0);

    pending.forEach(item => {
      if (!validEvent(item.event)) {
        safeAck(item.ack, { ok: false, code: 'INVALID_EVENT', error: 'Invalid socket event' });
        return;
      }

      socket.emit(item.event, { ...safePayload(item.data), clientId: item.clientId, replayed: item.retries > 0 }, (response: EmitAck) => {
        const res = response || { ok: true };
        if (!res.ok && item.retries < MAX_REPLAY_RETRIES) {
          queueRef.current = cleanQueue([...queueRef.current, { ...item, retries: item.retries + 1, ts: now() }]);
          setQueueSize(queueRef.current.length);
        }
        safeAck(item.ack, res);
      });
    });
  }, [enableQueue]);

  const emit = useCallback((event: string, data: any = {}, ack?: (response: EmitAck) => void, priority = 1) => {
    if (!validEvent(event)) {
      safeAck(ack, { ok: false, code: 'INVALID_EVENT', error: 'Invalid socket event' });
      return false;
    }

    const socket = socketRef.current;
    const payload = safePayload(data);
    const id = payload.clientId || clientId(event.replace(/[:_-]/g, ''));

    if (connected(socket)) {
      socket?.emit(event, { ...payload, clientId: id }, (response: EmitAck) => {
        safeAck(ack, response || { ok: true });
      });
      return true;
    }

    if (enableQueue) {
      queueRef.current = cleanQueue([...queueRef.current, { event, data: { ...payload, clientId: id }, ack, ts: now(), priority, retries: 0, clientId: id }]);
      setQueueSize(queueRef.current.length);
      safeAck(ack, { ok: false, code: 'QUEUED', error: 'Socket not connected. Event queued.' });
      return false;
    }

    safeAck(ack, { ok: false, code: 'SOCKET_DISCONNECTED', error: 'Socket not connected' });
    return false;
  }, [enableQueue]);

  const emitAsync = useCallback(<T = any>(event: string, data: any = {}, timeoutMs = ackTimeoutMs, priority = 1) => {
    return new Promise<EmitAck<T>>(resolve => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, code: 'ACK_TIMEOUT', error: 'Socket acknowledgement timeout' });
      }, timeoutMs);

      emit(event, data, response => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response as EmitAck<T>);
      }, priority);
    });
  }, [ackTimeoutMs, emit]);

  const joinRoom = useCallback((targetRoomId = activeRoomRef.current) => {
    if (!targetRoomId) return false;
    const current = now();
    if (current - lastJoinRef.current < 700) return true;
    lastJoinRef.current = current;
    return emit('room:join', { roomId: targetRoomId, at: current }, undefined, 10);
  }, [emit]);

  const leaveRoom = useCallback((targetRoomId = activeRoomRef.current) => {
    if (!targetRoomId) return false;
    return emit('room:leave', { roomId: targetRoomId, at: now() }, undefined, 10);
  }, [emit]);

  const resyncRoom = useCallback(() => {
    if (!activeRoomRef.current) return false;
    return emit('room:resync', { roomId: activeRoomRef.current, at: now() }, undefined, 8);
  }, [emit]);

  const sendChat = useCallback((content: string, extra: Record<string, any> = {}) => {
    if (!activeRoomRef.current || !content?.trim()) return false;

    const id = extra.clientId || clientId('chat');
    const text = content.trim();

    upsertChat?.({
      id,
      clientId: id,
      senderId: extra.senderId || 'me',
      content: text,
      mediaUrl: extra.mediaUrl,
      replyToId: extra.replyToId,
      reactions: {},
      isPinned: false,
      pending: true,
      failed: false,
      timestamp: now(),
      sender: extra.sender || { id: 'me', username: 'You', avatarUrl: '', isVerified: false }
    });

    return emit('chat:send', { roomId: activeRoomRef.current, content: text, ...extra, clientId: id }, response => {
      if (!response?.ok) {
        storeEditChat?.(id, text, { pending: false, failed: true, error: response?.error || 'Failed to send' });
      }
    }, 5);
  }, [emit, storeEditChat, upsertChat]);

  const editMessage = useCallback((messageId: string, content: string) => {
    if (!activeRoomRef.current || !messageId || !content.trim()) return false;
    storeEditChat?.(messageId, content.trim(), { editedAt: now(), pending: true });
    return emit('chat:edit', { roomId: activeRoomRef.current, messageId, content: content.trim() }, undefined, 4);
  }, [emit, storeEditChat]);

  const deleteMessage = useCallback((messageId: string) => {
    if (!activeRoomRef.current || !messageId) return false;
    storeDeleteChat?.(messageId);
    return emit('chat:delete', { roomId: activeRoomRef.current, messageId }, undefined, 4);
  }, [emit, storeDeleteChat]);

  const pinMessage = useCallback((messageId: string, pinned = true) => {
    if (!activeRoomRef.current || !messageId) return false;
    pinChat?.(messageId, pinned);
    return emit(pinned ? 'chat:pin' : 'chat:unpin', { roomId: activeRoomRef.current, messageId }, undefined, 4);
  }, [emit, pinChat]);

  const reactMessage = useCallback((messageId: string, emoji: string, remove = false) => {
    if (!activeRoomRef.current || !messageId || !emoji) return false;
    if (remove) removeMessageReaction?.(messageId, emoji, 'me');
    else addMessageReaction?.(messageId, emoji, 'me');
    return emit(remove ? 'chat:reaction_remove' : 'chat:react', { roomId: activeRoomRef.current, messageId, emoji }, undefined, 3);
  }, [addMessageReaction, emit, removeMessageReaction]);

  const sendTyping = useCallback((isTyping: boolean) => {
    if (!activeRoomRef.current) return false;
    const current = now();
    if (isTyping && current - lastTypingRef.current < 1200) return true;
    lastTypingRef.current = current;
    return emit('typing:set', { roomId: activeRoomRef.current, isTyping, at: current }, undefined, 1);
  }, [emit]);

  const sendGift = useCallback((giftId: string, toUserId: string, amount = 1, meta: Record<string, any> = {}) => {
    if (!activeRoomRef.current || !giftId || !toUserId || amount <= 0) return false;
    return emit('gift:send', { roomId: activeRoomRef.current, giftId, toUserId, amount, meta }, undefined, 6);
  }, [emit]);

  const takeSeat = useCallback((seatId?: string | null) => {
    if (!activeRoomRef.current) return false;
    return emit('seat:take', { roomId: activeRoomRef.current, seatId: seatId || undefined }, undefined, 7);
  }, [emit]);

  const leaveSeat = useCallback(() => {
    if (!activeRoomRef.current) return false;
    return emit('seat:leave', { roomId: activeRoomRef.current }, undefined, 7);
  }, [emit]);

  const raiseHand = useCallback((raised = true) => {
    if (!activeRoomRef.current) return false;
    setHandRaised?.(undefined, raised);
    return emit('hand:set', { roomId: activeRoomRef.current, raised }, undefined, 4);
  }, [emit, setHandRaised]);

  const muteMic = useCallback((muted = true) => {
    if (!activeRoomRef.current) return false;
    setMuted?.(muted);
    return emit('mic:set', { roomId: activeRoomRef.current, isMuted: muted }, undefined, 6);
  }, [emit, setMuted]);

  const toggleMic = useCallback(() => {
    const state = getRoomStateSnapshot();
    return muteMic(!state?.isMuted);
  }, [muteMic]);

  const pushToTalk = useCallback((active: boolean) => {
    if (!activeRoomRef.current) return false;
    return emit('mic:push_to_talk', { roomId: activeRoomRef.current, active, at: now() }, undefined, 6);
  }, [emit]);

  const updateSpeaking = useCallback((isSpeaking: boolean, audioLevel = 0) => {
    if (!activeRoomRef.current) return false;
    const current = now();
    if (current - lastSpeakingRef.current < 250 && isSpeaking) return true;
    lastSpeakingRef.current = current;
    return emit('voice:activity', { roomId: activeRoomRef.current, isSpeaking, audioLevel, at: current }, undefined, 1);
  }, [emit]);

  const createPoll = useCallback((question: string, options: string[], durationMs?: number) => {
    if (!activeRoomRef.current || !question.trim() || !options?.filter(Boolean).length) return false;
    return emit('poll:create', { roomId: activeRoomRef.current, question: question.trim(), options: options.map(o => o.trim()).filter(Boolean), durationMs }, undefined, 5);
  }, [emit]);

  const submitPollVote = useCallback((pollId: string, optionId: string) => {
    if (!activeRoomRef.current || !pollId || !optionId) return false;
    votePoll?.(pollId, optionId, 'me');
    return emit('poll:vote', { roomId: activeRoomRef.current, pollId, optionId }, undefined, 4);
  }, [emit, votePoll]);

  const closeActivePoll = useCallback((pollId?: string) => {
    const state = getRoomStateSnapshot();
    const id = pollId || state?.poll?.id;
    if (!activeRoomRef.current || !id) return false;
    closePoll?.(id);
    return emit('poll:close', { roomId: activeRoomRef.current, pollId: id }, undefined, 5);
  }, [closePoll, emit]);

  const updateHostControl = useCallback((control: string, value: any) => {
    if (!activeRoomRef.current || !control) return false;
    setHostControl?.(control, value);
    return emit('host:control', { roomId: activeRoomRef.current, control, value }, undefined, 6);
  }, [emit, setHostControl]);

  const lockRoom = useCallback((locked: boolean) => updateHostControl('locked', locked), [updateHostControl]);

  const setRoomMusic = useCallback((music: any) => updateHostControl('music', music), [updateHostControl]);

  const inviteUser = useCallback((userId: string) => {
    if (!activeRoomRef.current || !userId) return false;
    return emit('room:invite', { roomId: activeRoomRef.current, userId }, undefined, 4);
  }, [emit]);

  const kickUser = useCallback((userId: string, reason = 'Removed by host') => {
    if (!activeRoomRef.current || !userId) return false;
    return emit('moderation:kick', { roomId: activeRoomRef.current, userId, reason }, undefined, 7);
  }, [emit]);

  const muteUser = useCallback((userId: string, muted = true) => {
    if (!activeRoomRef.current || !userId) return false;
    return emit('moderation:mute', { roomId: activeRoomRef.current, userId, muted }, undefined, 7);
  }, [emit]);

  const startHeartbeat = useCallback(() => {
    if (!enableHeartbeat) return;
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);

    heartbeatRef.current = setInterval(() => {
      const socket = socketRef.current;
      if (!connected(socket)) return;

      const start = now();
      socket.emit('voice:ping', { roomId: activeRoomRef.current, ts: start }, (response: any) => {
        const ms = now() - start;
        setLatency(ms);
        setConnection?.({
          status: 'connected',
          socketId: socket.id,
          latency: ms,
          error: response?.error || null,
          lastSyncAt: now()
        });
      });

      sweepTyping?.();
    }, Math.max(5000, heartbeatMs));
  }, [enableHeartbeat, heartbeatMs, setConnection, sweepTyping]);

  const stopHeartbeat = useCallback(() => {
    if (heartbeatRef.current) {
      clearInterval(heartbeatRef.current);
      heartbeatRef.current = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    stopHeartbeat();

    const socket = socketRef.current;

    if (socket) {
      try {
        if (activeRoomRef.current && socket.connected) socket.emit('room:leave', { roomId: activeRoomRef.current, at: now() });
        socket.removeAllListeners();
        socket.io.removeAllListeners();
        socket.disconnect();
      } catch {}
    }

    socketRef.current = null;
    connectingRef.current = false;
    setSocketId(null);
    updateStatus('disconnected', null);
  }, [stopHeartbeat, updateStatus]);

  const bindSocketEvents = useCallback((socket: Socket) => {
    socket.on('connect', () => {
      connectingRef.current = false;
      setSocketId(socket.id || null);
      updateStatus('connected', null);
      if (autoJoin) joinRoom(activeRoomRef.current);
      flushQueue();
      startHeartbeat();
      if (enablePresence) emit('presence:online', { roomId: activeRoomRef.current, at: now() }, undefined, 2);
      log('connected', socket.id);
    });

    socket.on('disconnect', reason => {
      setSocketId(null);
      stopHeartbeat();
      updateStatus(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting', reason);
      log('disconnect', reason);
    });

    socket.on('connect_error', error => {
      connectingRef.current = false;
      updateStatus('error', error?.message || 'Connection failed');
      log('connect_error', error?.message);
    });

    socket.io.on('reconnect_attempt', () => updateStatus('reconnecting', null));

    socket.io.on('reconnect', () => {
      connectingRef.current = false;
      updateStatus('connected', null);
      if (autoJoin) joinRoom(activeRoomRef.current);
      flushQueue();
      startHeartbeat();
      resyncRoom();
    });

    socket.io.on('reconnect_failed', () => {
      connectingRef.current = false;
      updateStatus('error', 'Reconnect failed');
    });

    socket.on('room:sync', state => {
      sync?.(state);
      setConnection?.({ status: 'connected', socketId: socket.id, latency, error: null, lastSyncAt: now() });
    });

    socket.on('room:joined', payload => {
      sync?.(payload?.state || payload);
      setUi?.({ activePanel: 'chat', lastJoinedAt: now() });
    });

    socket.on('room:left', () => clearRoom?.());

    socket.on('room:closed', payload => {
      updateStatus('disconnected', payload?.reason || 'Room closed');
      clearRoom?.();
    });

    socket.on('room:error', payload => updateStatus('error', payload?.message || payload?.error || 'Room error'));

    socket.on('seats:update', payload => setSeats?.(payload?.seats || []));
    socket.on('seat:upsert', payload => upsertSeat?.(payload?.seat || payload));
    socket.on('seat:update', payload => {
      if (payload?.seatId) updateSeat?.(payload.seatId, payload.updates || payload);
      else if (payload?.seat) upsertSeat?.(payload.seat);
    });
    socket.on('seat:removed', payload => removeSeat?.(payload?.seatId || payload?.userId || payload?.id));

    socket.on('room:user_joined', payload => {
      if (payload?.seat) upsertSeat?.(payload.seat);
      if (payload?.message) addChat?.(payload.message);
    });

    socket.on('room:user_left', payload => {
      removeSeat?.(payload?.seatId || payload?.userId);
      if (payload?.message) addChat?.(payload.message);
    });

    socket.on('chat:new', msg => addChat?.(msg));
    socket.on('chat:upsert', msg => upsertChat?.(msg));
    socket.on('chat:sent', msg => upsertChat?.({ ...msg, pending: false, failed: false }));
    socket.on('chat:edited', payload => storeEditChat?.(payload?.messageId || payload?.id, payload?.content, payload?.updates));
    socket.on('chat:deleted', payload => storeDeleteChat?.(payload?.messageId || payload?.id));
    socket.on('chat:pinned', payload => pinChat?.(payload?.messageId || payload?.id, true));
    socket.on('chat:unpinned', payload => pinChat?.(payload?.messageId || payload?.id, false));
    socket.on('chat:reaction_updated', payload => updateChatReaction?.(payload?.messageId || payload?.id, payload?.reactions || {}));
    socket.on('chat:reaction_added', payload => addMessageReaction?.(payload?.messageId, payload?.emoji, payload?.userId));
    socket.on('chat:reaction_removed', payload => removeMessageReaction?.(payload?.messageId, payload?.emoji, payload?.userId));
    socket.on('typing:update', payload => setTyping?.(payload?.userId, !!payload?.isTyping));

    socket.on('gift:trigger', gift => addGift?.(gift));
    socket.on('gift:new', gift => addGift?.(gift));
    socket.on('gift:balance', payload => setUi?.({ giftBalance: payload?.balance || 0 }));

    socket.on('poll:updated', poll => setPoll?.(poll));
    socket.on('poll:created', poll => setPoll?.(poll));
    socket.on('poll:voted', payload => {
      if (payload?.poll) setPoll?.(payload.poll);
      else if (payload?.pollId && payload?.optionId) votePoll?.(payload.pollId, payload.optionId, payload.userId);
    });
    socket.on('poll:closed', payload => {
      if (payload?.poll) setPoll?.(payload.poll);
      else closePoll?.(payload?.pollId);
    });

    socket.on('mic:update', payload => {
      if (payload?.seatId) updateSeat?.(payload.seatId, { isMuted: !!payload.isMuted });
      if (payload?.userId || payload?.isSelf) setMuted?.(!!payload.isMuted, payload?.userId);
    });

    socket.on('voice:activity', payload => {
      if (payload?.seatId || payload?.userId) setSpeaking?.(payload.seatId || payload.userId, !!payload.isSpeaking, payload.audioLevel || 0);
    });

    socket.on('hand:update', payload => setHandRaised?.(payload?.seatId || payload?.userId, !!payload?.raised));

    socket.on('host:controls', payload => patchHostControls?.(payload?.controls || payload || {}));

    socket.on('host:control_updated', payload => {
      if (payload?.control) setHostControl?.(payload.control, payload.value);
      else patchHostControls?.(payload || {});
    });

    socket.on('moderation:kick', payload => {
      updateStatus('disconnected', payload?.reason || 'Removed from room');
      clearRoom?.();
      socket.disconnect();
    });

    socket.on('moderation:mute', payload => setMuted?.(true, payload?.userId));

    socket.on('presence:update', payload => {
      if (payload?.seat) upsertSeat?.(payload.seat);
    });

    socket.on('voice:pong', payload => {
      const sentAt = Number(payload?.ts || 0);
      if (sentAt) {
        const ms = now() - sentAt;
        setLatency(ms);
        setConnection?.({ status: 'connected', socketId: socket.id, latency: ms, error: null, lastSyncAt: now() });
      }
    });

    socket.on('analytics:room', payload => setUi?.({ analytics: payload }));

    socket.on('server:notice', payload => {
      if (payload?.message) {
        addChat?.({
          id: payload.id || `notice-${now()}`,
          senderId: 'system',
          content: payload.message,
          type: 'system',
          reactions: {},
          isPinned: false,
          timestamp: now(),
          sender: { id: 'system', username: 'System', avatarUrl: '', isVerified: true }
        });
      }
    });

    socket.on('server:error', payload => updateStatus('error', payload?.message || payload?.error || 'Server error'));
  }, [
    addChat,
    addGift,
    addMessageReaction,
    autoJoin,
    clearRoom,
    closePoll,
    emit,
    enablePresence,
    flushQueue,
    joinRoom,
    latency,
    log,
    patchHostControls,
    pinChat,
    removeMessageReaction,
    removeSeat,
    resyncRoom,
    setConnection,
    setHandRaised,
    setHostControl,
    setMuted,
    setPoll,
    setSeats,
    setSpeaking,
    setTyping,
    setUi,
    startHeartbeat,
    stopHeartbeat,
    storeDeleteChat,
    storeEditChat,
    sync,
    updateChatReaction,
    updateSeat,
    updateStatus,
    upsertChat,
    upsertSeat,
    votePoll
  ]);

  const connect = useCallback(async () => {
    if (!activeRoomRef.current) return null;
    if (connectingRef.current) return socketRef.current;
    if (connected(socketRef.current)) return socketRef.current;

    connectingRef.current = true;
    disconnect();
    updateStatus('connecting', null);

    const token = await getStoredToken();
    const baseUrl = getBaseUrl();

    if (!token) {
      connectingRef.current = false;
      updateStatus('error', 'Auth token missing');
      return null;
    }

    const socket: Socket = io(`${baseUrl}${namespace}`, {
      auth: { token, roomId: activeRoomRef.current },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts,
      reconnectionDelay,
      reconnectionDelayMax: 5000,
      timeout: 15_000,
      forceNew: true,
      autoConnect: true
    });

    socketRef.current = socket;
    bindSocketEvents(socket);
    return socket;
  }, [bindSocketEvents, disconnect, namespace, reconnectAttempts, reconnectDelay, updateStatus]);

  const reconnect = useCallback(async () => {
    disconnect();
    return connect();
  }, [connect, disconnect]);

  useEffect(() => {
    mountedRef.current = true;
    activeRoomRef.current = roomId;

    if (!roomId) {
      disconnect();
      clearRoom?.();
      updateStatus('idle', null);
      return;
    }

    connect();

    return () => {
      mountedRef.current = false;
      disconnect();
      clearRoom?.();
    };
  }, [roomId, connect, disconnect, clearRoom, updateStatus]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (!activeRoomRef.current) return;

      if (nextState === 'active') {
        if (!connected(socketRef.current)) connect();
        else {
          emit('presence:online', { roomId: activeRoomRef.current, at: now() }, undefined, 2);
          emit('room:resync', { roomId: activeRoomRef.current, at: now() }, undefined, 8);
        }
      }

      if (nextState === 'background' || nextState === 'inactive') {
        emit('presence:away', { roomId: activeRoomRef.current, at: now() }, undefined, 2);
      }
    });

    return () => sub.remove();
  }, [connect, emit]);

  return useMemo(() => ({
    socket: socketRef.current,
    socketId,
    status,
    latency,
    lastError,
    isConnected: status === 'connected' && !!socketRef.current?.connected,
    queueSize,
    icons: VoiceIcon,
    emit,
    emitAsync,
    connect,
    disconnect,
    reconnect,
    joinRoom,
    leaveRoom,
    resyncRoom,
    sendChat,
    editMessage,
    deleteMessage,
    pinMessage,
    reactMessage,
    sendTyping,
    sendGift,
    takeSeat,
    leaveSeat,
    raiseHand,
    muteMic,
    toggleMic,
    pushToTalk,
    updateSpeaking,
    createPoll,
    submitPollVote,
    closeActivePoll,
    updateHostControl,
    lockRoom,
    setRoomMusic,
    inviteUser,
    kickUser,
    muteUser
  }), [
    socketId,
    status,
    latency,
    lastError,
    queueSize,
    emit,
    emitAsync,
    connect,
    disconnect,
    reconnect,
    joinRoom,
    leaveRoom,
    resyncRoom,
    sendChat,
    editMessage,
    deleteMessage,
    pinMessage,
    reactMessage,
    sendTyping,
    sendGift,
    takeSeat,
    leaveSeat,
    raiseHand,
    muteMic,
    toggleMic,
    pushToTalk,
    updateSpeaking,
    createPoll,
    submitPollVote,
    closeActivePoll,
    updateHostControl,
    lockRoom,
    setRoomMusic,
    inviteUser,
    kickUser,
    muteUser
  ]);
}

export { VoiceIcon };
