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
};

type VoiceSocketOptions = {
  autoJoin?: boolean;
  enableQueue?: boolean;
  enablePresence?: boolean;
  enableHeartbeat?: boolean;
  heartbeatMs?: number;
  reconnectAttempts?: number;
  reconnectDelay?: number;
};

const DEFAULT_WS_URL = 'wss://api.texa.app';
const TOKEN_KEYS = ['token', 'accessToken', 'authToken'];
const MAX_QUEUE = 80;
const QUEUE_TTL = 45_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

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
  reconnect: '↻'
} as const;

function getExtraValue(key: string) {
  const extra = Constants.expoConfig?.extra || Constants.manifest2?.extra || {};
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

function cleanQueue(queue: QueuedEvent[]) {
  const now = Date.now();
  return queue.filter(item => now - item.ts <= QUEUE_TTL).slice(-MAX_QUEUE);
}

function safeAck(ack: any, response: EmitAck) {
  if (typeof ack === 'function') ack(response);
}

function isConnected(socket?: Socket | null) {
  return !!socket?.connected;
}

export function useVoiceSocket(roomId: string | null, options: VoiceSocketOptions = {}) {
  const {
    autoJoin = true,
    enableQueue = true,
    enablePresence = true,
    enableHeartbeat = true,
    heartbeatMs = DEFAULT_HEARTBEAT_MS,
    reconnectAttempts = 12,
    reconnectDelay = 700
  } = options;

  const socketRef = useRef<Socket | null>(null);
  const queueRef = useRef<QueuedEvent[]>([]);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRoomRef = useRef<string | null>(roomId);
  const mountedRef = useRef(true);

  const [status, setStatus] = useState<VoiceSocketStatus>('idle');
  const [socketId, setSocketId] = useState<string | null>(null);
  const [latency, setLatency] = useState<number | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

  const {
    sync,
    setSeats,
    addChat,
    upsertChat,
    editChat,
    deleteChat,
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

  const updateStatus = useCallback((next: VoiceSocketStatus, error?: string | null) => {
    if (!mountedRef.current) return;
    setStatus(next);
    if (typeof error !== 'undefined') setLastError(error);
    setConnection?.({
      status: next,
      socketId: socketRef.current?.id || null,
      latency,
      error: error || null,
      lastSyncAt: Date.now()
    });
  }, [latency, setConnection]);

  const flushQueue = useCallback(() => {
    const socket = socketRef.current;
    if (!enableQueue || !isConnected(socket)) return;

    const pending = cleanQueue(queueRef.current);
    queueRef.current = [];

    pending.forEach(item => {
      socket?.emit(item.event, item.data, (response: EmitAck) => {
        safeAck(item.ack, response || { ok: true });
      });
    });
  }, [enableQueue]);

  const emit = useCallback((event: string, data: any = {}, ack?: (response: EmitAck) => void) => {
    const socket = socketRef.current;

    if (isConnected(socket)) {
      socket?.emit(event, data, (response: EmitAck) => {
        safeAck(ack, response || { ok: true });
      });
      return true;
    }

    if (enableQueue) {
      queueRef.current = cleanQueue([...queueRef.current, { event, data, ack, ts: Date.now() }]);
      safeAck(ack, { ok: false, code: 'QUEUED', error: 'Socket not connected. Event queued.' });
      return false;
    }

    safeAck(ack, { ok: false, code: 'SOCKET_DISCONNECTED', error: 'Socket not connected' });
    return false;
  }, [enableQueue]);

  const emitAsync = useCallback(<T = any>(event: string, data: any = {}, timeoutMs = 12_000) => {
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
      });
    });
  }, [emit]);

  const joinRoom = useCallback((targetRoomId = activeRoomRef.current) => {
    if (!targetRoomId) return false;
    return emit('room:join', { roomId: targetRoomId, at: Date.now() });
  }, [emit]);

  const leaveRoom = useCallback((targetRoomId = activeRoomRef.current) => {
    if (!targetRoomId) return false;
    return emit('room:leave', { roomId: targetRoomId, at: Date.now() });
  }, [emit]);

  const sendChat = useCallback((content: string, extra: Record<string, any> = {}) => {
    if (!activeRoomRef.current || !content?.trim()) return false;
    return emit('chat:send', {
      roomId: activeRoomRef.current,
      content: content.trim(),
      ...extra,
      clientId: extra.clientId || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    });
  }, [emit]);

  const reactMessage = useCallback((messageId: string, emoji: string) => {
    if (!activeRoomRef.current || !messageId || !emoji) return false;
    return emit('chat:react', { roomId: activeRoomRef.current, messageId, emoji });
  }, [emit]);

  const sendGift = useCallback((giftId: string, toUserId: string, amount = 1, meta: Record<string, any> = {}) => {
    if (!activeRoomRef.current || !giftId || !toUserId) return false;
    return emit('gift:send', { roomId: activeRoomRef.current, giftId, toUserId, amount, meta });
  }, [emit]);

  const raiseHand = useCallback((raised = true) => {
    if (!activeRoomRef.current) return false;
    setHandRaised?.(undefined, raised);
    return emit('hand:set', { roomId: activeRoomRef.current, raised });
  }, [emit, setHandRaised]);

  const muteMic = useCallback((muted = true) => {
    if (!activeRoomRef.current) return false;
    setMuted?.(muted);
    return emit('mic:set', { roomId: activeRoomRef.current, isMuted: muted });
  }, [emit, setMuted]);

  const pushToTalk = useCallback((active: boolean) => {
    if (!activeRoomRef.current) return false;
    return emit('mic:push_to_talk', { roomId: activeRoomRef.current, active });
  }, [emit]);

  const updateSpeaking = useCallback((isSpeaking: boolean, audioLevel = 0) => {
    if (!activeRoomRef.current) return false;
    return emit('voice:activity', { roomId: activeRoomRef.current, isSpeaking, audioLevel, at: Date.now() });
  }, [emit]);

  const createPoll = useCallback((question: string, options: string[], durationMs?: number) => {
    if (!activeRoomRef.current || !question || !options?.length) return false;
    return emit('poll:create', { roomId: activeRoomRef.current, question, options, durationMs });
  }, [emit]);

  const submitPollVote = useCallback((pollId: string, optionId: string) => {
    if (!activeRoomRef.current || !pollId || !optionId) return false;
    votePoll?.(pollId, optionId);
    return emit('poll:vote', { roomId: activeRoomRef.current, pollId, optionId });
  }, [emit, votePoll]);

  const updateHostControl = useCallback((control: string, value: any) => {
    if (!activeRoomRef.current) return false;
    setHostControl?.(control, value);
    return emit('host:control', { roomId: activeRoomRef.current, control, value });
  }, [emit, setHostControl]);

  const startHeartbeat = useCallback(() => {
    if (!enableHeartbeat) return;

    if (heartbeatRef.current) clearInterval(heartbeatRef.current);

    heartbeatRef.current = setInterval(() => {
      const socket = socketRef.current;
      if (!isConnected(socket)) return;

      const start = Date.now();
      socket?.emit('voice:ping', { roomId: activeRoomRef.current, ts: start }, () => {
        const ms = Date.now() - start;
        setLatency(ms);
        setConnection?.({
          status: 'connected',
          socketId: socket.id,
          latency: ms,
          error: null,
          lastSyncAt: Date.now()
        });
      });

      sweepTyping?.();
    }, heartbeatMs);
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
      if (activeRoomRef.current) socket.emit('room:leave', { roomId: activeRoomRef.current, at: Date.now() });
      socket.removeAllListeners();
      socket.disconnect();
    }
    socketRef.current = null;
    setSocketId(null);
    updateStatus('disconnected', null);
  }, [stopHeartbeat, updateStatus]);

  const connect = useCallback(async () => {
    if (!activeRoomRef.current) return null;

    disconnect();
    updateStatus('connecting', null);

    const token = await getStoredToken();
    const baseUrl = getBaseUrl();

    if (!token) {
      updateStatus('error', 'Auth token missing');
      return null;
    }

    const socket: Socket = io(`${baseUrl}/voice`, {
      auth: { token },
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: reconnectAttempts,
      reconnectionDelay: reconnectDelay,
      reconnectionDelayMax: 5000,
      timeout: 15_000,
      forceNew: true,
      autoConnect: true
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setSocketId(socket.id || null);
      updateStatus('connected', null);
      if (autoJoin) joinRoom(activeRoomRef.current);
      flushQueue();
      startHeartbeat();
      if (enablePresence) emit('presence:online', { roomId: activeRoomRef.current, at: Date.now() });
    });

    socket.on('disconnect', reason => {
      setSocketId(null);
      stopHeartbeat();
      updateStatus(reason === 'io client disconnect' ? 'disconnected' : 'reconnecting', reason);
    });

    socket.on('connect_error', error => {
      updateStatus('error', error?.message || 'Connection failed');
    });

    socket.io.on('reconnect_attempt', () => {
      updateStatus('reconnecting', null);
    });

    socket.io.on('reconnect', () => {
      updateStatus('connected', null);
      if (autoJoin) joinRoom(activeRoomRef.current);
      flushQueue();
      startHeartbeat();
    });

    socket.io.on('reconnect_failed', () => {
      updateStatus('error', 'Reconnect failed');
    });

    socket.on('room:sync', state => {
      sync?.(state);
      setConnection?.({
        status: 'connected',
        socketId: socket.id,
        latency,
        error: null,
        lastSyncAt: Date.now()
      });
    });

    socket.on('room:joined', payload => {
      sync?.(payload?.state || payload);
      setUi?.({ activePanel: 'chat' });
    });

    socket.on('room:left', () => {
      clearRoom?.();
    });

    socket.on('room:closed', payload => {
      updateStatus('disconnected', payload?.reason || 'Room closed');
      clearRoom?.();
    });

    socket.on('room:error', payload => {
      updateStatus('error', payload?.message || payload?.error || 'Room error');
    });

    socket.on('seats:update', payload => {
      setSeats?.(payload?.seats || []);
    });

    socket.on('seat:upsert', payload => {
      upsertSeat?.(payload?.seat || payload);
    });

    socket.on('seat:update', payload => {
      if (payload?.seatId) updateSeat?.(payload.seatId, payload.updates || payload);
      else if (payload?.seat) upsertSeat?.(payload.seat);
    });

    socket.on('seat:removed', payload => {
      removeSeat?.(payload?.seatId || payload?.userId || payload?.id);
    });

    socket.on('room:user_joined', payload => {
      if (payload?.seat) upsertSeat?.(payload.seat);
      if (payload?.message) addChat?.(payload.message);
    });

    socket.on('room:user_left', payload => {
      removeSeat?.(payload?.seatId || payload?.userId);
      if (payload?.message) addChat?.(payload.message);
    });

    socket.on('chat:new', msg => {
      addChat?.(msg);
    });

    socket.on('chat:upsert', msg => {
      upsertChat?.(msg);
    });

    socket.on('chat:edited', payload => {
      editChat?.(payload?.messageId || payload?.id, payload?.content, payload?.updates);
    });

    socket.on('chat:deleted', payload => {
      deleteChat?.(payload?.messageId || payload?.id);
    });

    socket.on('chat:pinned', payload => {
      pinChat?.(payload?.messageId || payload?.id, true);
    });

    socket.on('chat:unpinned', payload => {
      pinChat?.(payload?.messageId || payload?.id, false);
    });

    socket.on('chat:reaction_updated', payload => {
      updateChatReaction?.(payload?.messageId || payload?.id, payload?.reactions || {});
    });

    socket.on('chat:reaction_added', payload => {
      addMessageReaction?.(payload?.messageId, payload?.emoji, payload?.userId);
    });

    socket.on('chat:reaction_removed', payload => {
      removeMessageReaction?.(payload?.messageId, payload?.emoji, payload?.userId);
    });

    socket.on('typing:update', payload => {
      setTyping?.(payload?.userId, !!payload?.isTyping);
    });

    socket.on('gift:trigger', gift => {
      addGift?.(gift);
    });

    socket.on('gift:new', gift => {
      addGift?.(gift);
    });

    socket.on('poll:updated', poll => {
      setPoll?.(poll);
    });

    socket.on('poll:created', poll => {
      setPoll?.(poll);
    });

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
      if (payload?.userId) setMuted?.(!!payload.isMuted, payload.userId);
    });

    socket.on('voice:activity', payload => {
      if (payload?.seatId || payload?.userId) {
        setSpeaking?.(payload.seatId || payload.userId, !!payload.isSpeaking, payload.audioLevel || 0);
      }
    });

    socket.on('hand:update', payload => {
      setHandRaised?.(payload?.seatId || payload?.userId, !!payload?.raised);
    });

    socket.on('host:controls', payload => {
      patchHostControls?.(payload?.controls || payload || {});
    });

    socket.on('host:control_updated', payload => {
      if (payload?.control) setHostControl?.(payload.control, payload.value);
      else patchHostControls?.(payload || {});
    });

    socket.on('moderation:kick', payload => {
      updateStatus('disconnected', payload?.reason || 'Removed from room');
      clearRoom?.();
      socket.disconnect();
    });

    socket.on('moderation:mute', payload => {
      setMuted?.(true, payload?.userId);
    });

    socket.on('presence:update', payload => {
      if (payload?.seat) upsertSeat?.(payload.seat);
    });

    socket.on('voice:pong', payload => {
      const sentAt = Number(payload?.ts || 0);
      if (sentAt) setLatency(Date.now() - sentAt);
    });

    socket.on('commerce:gift_balance', payload => {
      setUi?.({ giftBalance: payload?.balance || 0 });
    });

    socket.on('analytics:room', payload => {
      setUi?.({ analytics: payload });
    });

    socket.on('server:notice', payload => {
      if (payload?.message) addChat?.({
        id: payload.id || `notice-${Date.now()}`,
        senderId: 'system',
        content: payload.message,
        type: 'system',
        reactions: {},
        isPinned: false,
        timestamp: Date.now(),
        sender: { id: 'system', username: 'System', avatarUrl: '', isVerified: true }
      });
    });

    return socket;
  }, [
    autoJoin,
    reconnectAttempts,
    reconnectDelay,
    disconnect,
    updateStatus,
    joinRoom,
    flushQueue,
    startHeartbeat,
    stopHeartbeat,
    enablePresence,
    emit,
    sync,
    setConnection,
    latency,
    setUi,
    clearRoom,
    setSeats,
    upsertSeat,
    updateSeat,
    removeSeat,
    addChat,
    upsertChat,
    editChat,
    deleteChat,
    pinChat,
    updateChatReaction,
    addMessageReaction,
    removeMessageReaction,
    setTyping,
    addGift,
    setPoll,
    votePoll,
    closePoll,
    setMuted,
    setSpeaking,
    setHandRaised,
    patchHostControls,
    setHostControl
  ]);

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
  }, [roomId]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (!activeRoomRef.current) return;

      if (nextState === 'active') {
        if (!isConnected(socketRef.current)) connect();
        else {
          emit('presence:online', { roomId: activeRoomRef.current, at: Date.now() });
          emit('room:resync', { roomId: activeRoomRef.current, at: Date.now() });
        }
      }

      if (nextState === 'background' || nextState === 'inactive') {
        emit('presence:away', { roomId: activeRoomRef.current, at: Date.now() });
      }
    });

    return () => sub.remove();
  }, [connect, emit]);

  const api = useMemo(() => ({
    socket: socketRef.current,
    socketId,
    status,
    latency,
    lastError,
    isConnected: status === 'connected' && !!socketRef.current?.connected,
    icons: VoiceIcon,
    emit,
    emitAsync,
    connect,
    disconnect,
    joinRoom,
    leaveRoom,
    sendChat,
    reactMessage,
    sendGift,
    raiseHand,
    muteMic,
    pushToTalk,
    updateSpeaking,
    createPoll,
    submitPollVote,
    updateHostControl
  }), [
    socketId,
    status,
    latency,
    lastError,
    emit,
    emitAsync,
    connect,
    disconnect,
    joinRoom,
    leaveRoom,
    sendChat,
    reactMessage,
    sendGift,
    raiseHand,
    muteMic,
    pushToTalk,
    updateSpeaking,
    createPoll,
    submitPollVote,
    updateHostControl
  ]);

  return api;
}

export { VoiceIcon };
