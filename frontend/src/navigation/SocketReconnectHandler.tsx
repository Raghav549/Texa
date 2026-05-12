import { useEffect, useRef } from 'react';
import { AppState, AppStateStatus, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo, { NetInfoSubscription } from '@react-native-community/netinfo';
import { ws } from '../api/ws';
import { useAuth } from '../store/auth';

type SocketLike = {
  connected?: boolean;
  disconnected?: boolean;
  id?: string;
  connect?: () => void;
  disconnect?: () => void;
  emit: (event: string, payload?: any, ack?: any) => void;
  on: (event: string, handler: (...args: any[]) => void) => void;
  off: (event: string, handler?: (...args: any[]) => void) => void;
  io?: {
    opts?: Record<string, any>;
    reconnection?: (value: boolean) => void;
    reconnectionAttempts?: (value: number) => void;
    reconnectionDelay?: (value: number) => void;
    reconnectionDelayMax?: (value: number) => void;
    timeout?: (value: number) => void;
  };
};

type PendingEvent = {
  event: string;
  payload?: any;
  createdAt: number;
  attempts: number;
};

const STORAGE_TOKEN_KEYS = ['token', 'authToken', 'accessToken'];
const PENDING_EVENTS_KEY = 'socket:pending_events';
const DEVICE_ID_KEY = 'socket:device_id';
const MAX_PENDING_EVENTS = 80;
const MAX_EVENT_AGE = 1000 * 60 * 60 * 12;
const HEARTBEAT_INTERVAL = 25000;
const PRESENCE_INTERVAL = 30000;
const RECONNECT_MIN = 700;
const RECONNECT_MAX = 20000;
const MAX_RECONNECT_ATTEMPTS = 40;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const createDeviceId = () =>
  `dev_${Platform.OS}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;

const getDeviceId = async () => {
  const existing = await AsyncStorage.getItem(DEVICE_ID_KEY);
  if (existing) return existing;
  const id = createDeviceId();
  await AsyncStorage.setItem(DEVICE_ID_KEY, id);
  return id;
};

const getToken = async () => {
  for (const key of STORAGE_TOKEN_KEYS) {
    const token = await AsyncStorage.getItem(key);
    if (token) return token;
  }
  return null;
};

const jitter = (base: number) => Math.floor(base + Math.random() * Math.min(1200, base));

const getBackoff = (attempt: number) =>
  jitter(Math.min(RECONNECT_MAX, RECONNECT_MIN * Math.pow(1.75, Math.max(0, attempt - 1))));

const safeJsonParse = <T,>(value: string | null, fallback: T): T => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const loadPendingEvents = async (): Promise<PendingEvent[]> => {
  const raw = await AsyncStorage.getItem(PENDING_EVENTS_KEY);
  const events = safeJsonParse<PendingEvent[]>(raw, []);
  const now = Date.now();
  return events
    .filter(e => e?.event && now - e.createdAt < MAX_EVENT_AGE)
    .slice(-MAX_PENDING_EVENTS);
};

const savePendingEvents = async (events: PendingEvent[]) => {
  const now = Date.now();
  const clean = events
    .filter(e => e?.event && now - e.createdAt < MAX_EVENT_AGE)
    .slice(-MAX_PENDING_EVENTS);
  await AsyncStorage.setItem(PENDING_EVENTS_KEY, JSON.stringify(clean));
};

const enqueuePendingEvent = async (event: string, payload?: any) => {
  const events = await loadPendingEvents();
  events.push({ event, payload, createdAt: Date.now(), attempts: 0 });
  await savePendingEvents(events);
};

export async function emitReliable(event: string, payload?: any) {
  try {
    const socket = await ws();
    if (socket?.connected) {
      socket.emit(event, payload);
      return true;
    }
  } catch {}
  await enqueuePendingEvent(event, payload);
  return false;
}

export default function SocketReconnectHandler() {
  const socketRef = useRef<SocketLike | null>(null);
  const reconnectAttempts = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const presenceTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const appState = useRef<AppStateStatus>(AppState.currentState);
  const isOnline = useRef(true);
  const isMounted = useRef(true);
  const connecting = useRef(false);
  const lastPresence = useRef(0);
  const lastHeartbeatAck = useRef(Date.now());
  const userId = useAuth.getState()?.user?.id;

  useEffect(() => {
    isMounted.current = true;

    const clearReconnectTimer = () => {
      if (reconnectTimer.current) {
        clearTimeout(reconnectTimer.current);
        reconnectTimer.current = null;
      }
    };

    const clearHeartbeat = () => {
      if (heartbeatTimer.current) {
        clearInterval(heartbeatTimer.current);
        heartbeatTimer.current = null;
      }
    };

    const clearPresence = () => {
      if (presenceTimer.current) {
        clearInterval(presenceTimer.current);
        presenceTimer.current = null;
      }
    };

    const emitPresence = async (online: boolean, force = false) => {
      const socket = socketRef.current;
      const now = Date.now();
      if (!socket?.connected) return;
      if (!force && now - lastPresence.current < 4000) return;
      lastPresence.current = now;
      const deviceId = await getDeviceId();
      socket.emit('presence:update', {
        isOnline: online,
        appState: appState.current,
        deviceId,
        platform: Platform.OS,
        userId,
        timestamp: now
      });
    };

    const flushPendingEvents = async () => {
      const socket = socketRef.current;
      if (!socket?.connected) return;

      const events = await loadPendingEvents();
      if (!events.length) return;

      const remaining: PendingEvent[] = [];

      for (const item of events) {
        if (!socketRef.current?.connected) {
          remaining.push(item);
          continue;
        }

        let delivered = false;

        await new Promise<void>(resolve => {
          let done = false;
          const timeout = setTimeout(() => {
            if (done) return;
            done = true;
            resolve();
          }, 3500);

          try {
            socketRef.current?.emit(item.event, item.payload, (ack: any) => {
              if (done) return;
              done = true;
              clearTimeout(timeout);
              delivered = ack?.ok !== false;
              resolve();
            });
          } catch {
            if (done) return;
            done = true;
            clearTimeout(timeout);
            resolve();
          }
        });

        if (!delivered && item.attempts < 5) {
          remaining.push({ ...item, attempts: item.attempts + 1 });
        }

        await sleep(40);
      }

      await savePendingEvents(remaining);
    };

    const startHeartbeat = () => {
      clearHeartbeat();
      heartbeatTimer.current = setInterval(() => {
        const socket = socketRef.current;
        if (!socket?.connected) return;

        const sentAt = Date.now();

        socket.emit('socket:ping', { sentAt, appState: appState.current }, (ack: any) => {
          if (ack?.ok !== false) lastHeartbeatAck.current = Date.now();
        });

        if (Date.now() - lastHeartbeatAck.current > HEARTBEAT_INTERVAL * 3) {
          try {
            socket.disconnect?.();
          } catch {}
          scheduleReconnect('heartbeat_timeout');
        }
      }, HEARTBEAT_INTERVAL);
    };

    const startPresenceLoop = () => {
      clearPresence();
      presenceTimer.current = setInterval(() => {
        if (appState.current === 'active') emitPresence(true);
      }, PRESENCE_INTERVAL);
    };

    const cleanupSocketListeners = (socket: SocketLike | null) => {
      if (!socket) return;
      socket.off('connect');
      socket.off('disconnect');
      socket.off('connect_error');
      socket.off('reconnect');
      socket.off('reconnect_attempt');
      socket.off('reconnect_error');
      socket.off('reconnect_failed');
      socket.off('auth:expired');
      socket.off('token:expired');
      socket.off('force:logout');
      socket.off('server:maintenance');
      socket.off('presence:sync');
    };

    const disconnectSocket = async (online = false) => {
      clearReconnectTimer();
      clearHeartbeat();
      clearPresence();

      const socket = socketRef.current;
      if (socket?.connected) {
        try {
          await emitPresence(online, true);
        } catch {}
      }

      cleanupSocketListeners(socket);

      try {
        socket?.disconnect?.();
      } catch {}

      socketRef.current = null;
      connecting.current = false;
    };

    const scheduleReconnect = (reason = 'unknown') => {
      if (!isMounted.current) return;
      if (!isOnline.current) return;
      if (appState.current !== 'active') return;
      if (connecting.current) return;
      if (reconnectAttempts.current >= MAX_RECONNECT_ATTEMPTS) return;

      clearReconnectTimer();

      reconnectAttempts.current += 1;
      const delay = getBackoff(reconnectAttempts.current);

      reconnectTimer.current = setTimeout(() => {
        connect(reason);
      }, delay);
    };

    const connect = async (_reason = 'manual') => {
      if (!isMounted.current) return;
      if (connecting.current) return;
      if (!isOnline.current) return;

      const token = await getToken();
      if (!token) {
        await disconnectSocket(false);
        return;
      }

      connecting.current = true;

      try {
        const deviceId = await getDeviceId();
        const socket = await ws();

        if (!isMounted.current) {
          try {
            socket?.disconnect?.();
          } catch {}
          return;
        }

        if (socketRef.current && socketRef.current !== socket) {
          cleanupSocketListeners(socketRef.current);
          try {
            socketRef.current.disconnect?.();
          } catch {}
        }

        socketRef.current = socket as SocketLike;

        try {
          socketRef.current.io?.reconnection?.(true);
          socketRef.current.io?.reconnectionAttempts?.(Infinity);
          socketRef.current.io?.reconnectionDelay?.(800);
          socketRef.current.io?.reconnectionDelayMax?.(15000);
          socketRef.current.io?.timeout?.(12000);
          if (socketRef.current.io?.opts) {
            socketRef.current.io.opts.auth = { token, deviceId, platform: Platform.OS };
            socketRef.current.io.opts.transports = ['websocket', 'polling'];
          }
        } catch {}

        cleanupSocketListeners(socketRef.current);

        socketRef.current.on('connect', async () => {
          connecting.current = false;
          reconnectAttempts.current = 0;
          lastHeartbeatAck.current = Date.now();
          clearReconnectTimer();
          await emitPresence(appState.current === 'active', true);
          await flushPendingEvents();
          startHeartbeat();
          startPresenceLoop();
          socketRef.current?.emit('client:ready', {
            socketId: socketRef.current?.id,
            deviceId,
            platform: Platform.OS,
            appState: appState.current,
            timestamp: Date.now()
          });
        });

        socketRef.current.on('disconnect', async (reason: string) => {
          connecting.current = false;
          clearHeartbeat();
          clearPresence();

          if (reason === 'io server disconnect') {
            scheduleReconnect(reason);
            return;
          }

          if (reason === 'transport close' || reason === 'transport error' || reason === 'ping timeout') {
            scheduleReconnect(reason);
            return;
          }

          scheduleReconnect(reason);
        });

        socketRef.current.on('connect_error', async (error: any) => {
          connecting.current = false;

          const message = String(error?.message || '').toLowerCase();

          if (message.includes('auth') || message.includes('token') || message.includes('unauthorized') || message.includes('jwt')) {
            await AsyncStorage.multiRemove(STORAGE_TOKEN_KEYS);
            try {
              useAuth.getState().logout();
            } catch {}
            await disconnectSocket(false);
            return;
          }

          scheduleReconnect('connect_error');
        });

        socketRef.current.on('auth:expired', async () => {
          await AsyncStorage.multiRemove(STORAGE_TOKEN_KEYS);
          try {
            useAuth.getState().logout();
          } catch {}
          await disconnectSocket(false);
        });

        socketRef.current.on('token:expired', async () => {
          await AsyncStorage.multiRemove(STORAGE_TOKEN_KEYS);
          try {
            useAuth.getState().logout();
          } catch {}
          await disconnectSocket(false);
        });

        socketRef.current.on('force:logout', async () => {
          await AsyncStorage.multiRemove(STORAGE_TOKEN_KEYS);
          try {
            useAuth.getState().logout();
          } catch {}
          await disconnectSocket(false);
        });

        socketRef.current.on('server:maintenance', () => {
          clearHeartbeat();
          clearPresence();
          scheduleReconnect('maintenance');
        });

        socketRef.current.on('presence:sync', async () => {
          await emitPresence(appState.current === 'active', true);
        });

        if (!socketRef.current.connected) {
          try {
            socketRef.current.connect?.();
          } catch {}
        }
      } catch {
        connecting.current = false;
        scheduleReconnect('connect_exception');
      }
    };

    const netSub: NetInfoSubscription = NetInfo.addEventListener(state => {
      const reachable = state.isConnected === true && state.isInternetReachable !== false;
      const wasOnline = isOnline.current;
      isOnline.current = reachable;

      if (!reachable) {
        clearReconnectTimer();
        clearHeartbeat();
        clearPresence();
        return;
      }

      if (!wasOnline && reachable) {
        reconnectAttempts.current = 0;
        connect('network_restored');
      }
    });

    const appStateSub = AppState.addEventListener('change', async nextState => {
      const previous = appState.current;
      appState.current = nextState;

      if (previous === 'active' && nextState.match(/inactive|background/)) {
        await emitPresence(false, true);
        clearHeartbeat();
        clearPresence();
        return;
      }

      if (nextState === 'active') {
        const token = await getToken();
        if (!token) return;

        if (!socketRef.current?.connected) {
          reconnectAttempts.current = 0;
          connect('app_foreground');
        } else {
          await emitPresence(true, true);
          await flushPendingEvents();
          startHeartbeat();
          startPresenceLoop();
        }
      }
    });

    NetInfo.fetch().then(state => {
      isOnline.current = state.isConnected === true && state.isInternetReachable !== false;
      if (isOnline.current) connect('initial');
    });

    return () => {
      isMounted.current = false;
      netSub();
      appStateSub.remove();
      disconnectSocket(false);
    };
  }, [userId]);

  return null;
}
