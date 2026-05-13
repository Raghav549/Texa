import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Dimensions,
  TouchableOpacity,
  Animated,
  Easing,
  StatusBar,
  Platform,
  SafeAreaView,
  Pressable,
  ActivityIndicator,
  AppState
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import * as Haptics from 'expo-haptics';
import { useVoiceSocket, VoiceIcon } from '../../hooks/useVoiceSocket';
import { useRoomStore } from '../../store/voice/roomSlice';
import SeatGrid from '../../components/voice/SeatGrid';
import ChatView from '../../components/voice/ChatView';
import GiftBar from '../../components/voice/GiftBar';
import HostControls from '../../components/voice/HostControls';
import GiftOverlay from '../../components/voice/GiftOverlay';
import { theme } from '../../theme';

const { width, height } = Dimensions.get('window');

type PanelMode = 'chat' | 'gifts' | 'controls' | 'none';

const ProIcon = {
  back: '‹',
  live: '●',
  users: '◌',
  micOn: '◉',
  micOff: '◌',
  chat: '▣',
  gift: '✧',
  seat: '◇',
  host: '♛',
  lock: '▰',
  unlock: '▱',
  poll: '◈',
  signal: '▰▰▰',
  close: '×',
  more: '⋯',
  raise: '△',
  ptt: '◆',
  reconnect: '↻',
  muted: '◌',
  speaker: '◍'
} as const;

function safeCount(value: any) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number') return value;
  return 0;
}

function getRoomHostId(room: any) {
  return room?.host?.id || room?.hostId || room?.ownerId || room?.createdById || null;
}

function getRoomTitle(room: any) {
  return room?.title || room?.name || 'Voice Room';
}

function getRoomSubtitle(room: any, seats: any[]) {
  const host = room?.host?.username || room?.host?.displayName || 'Host';
  const capacity = room?.capacity || room?.maxSeats || 10;
  return `${safeCount(seats)}/${capacity} seats • ${host}`;
}

function formatLatency(latency: number | null) {
  if (latency === null || Number.isNaN(latency)) return 'SYNC';
  if (latency < 120) return 'FAST';
  if (latency < 300) return 'GOOD';
  return 'SLOW';
}

function IconButton({
  icon,
  label,
  active,
  danger,
  disabled,
  onPress,
  size = 48
}: {
  icon: string;
  label?: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onPress?: () => void;
  size?: number;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const pressIn = () => {
    Animated.spring(scale, { toValue: 0.92, useNativeDriver: true, friction: 7, tension: 160 }).start();
  };

  const pressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 7, tension: 160 }).start();
  };

  return (
    <Pressable onPress={disabled ? undefined : onPress} onPressIn={pressIn} onPressOut={pressOut} style={{ opacity: disabled ? 0.45 : 1 }}>
      <Animated.View style={[styles.iconButtonWrap, { transform: [{ scale }] }]}>
        <LinearGradient
          colors={
            danger
              ? ['#FF4D6D', '#B5172F']
              : active
                ? ['#00F5FF', '#7C3CFF']
                : ['rgba(255,255,255,0.96)', 'rgba(245,247,255,0.9)']
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[styles.iconButton, { width: size, height: size, borderRadius: size / 2 }]}
        >
          <Text style={[styles.iconButtonText, { color: active || danger ? '#FFFFFF' : '#111827' }]}>{icon}</Text>
        </LinearGradient>
        {!!label && <Text style={styles.iconButtonLabel} numberOfLines={1}>{label}</Text>}
      </Animated.View>
    </Pressable>
  );
}

function ConnectionPill({ status, latency, onReconnect }: { status: string; latency: number | null; onReconnect: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;
  const connected = status === 'connected';

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.in(Easing.quad), useNativeDriver: true })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const dotScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.55] });
  const dotOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0.25] });

  return (
    <TouchableOpacity activeOpacity={0.85} onPress={connected ? undefined : onReconnect} style={styles.connectionPill}>
      <View style={styles.liveDotBox}>
        <Animated.View style={[styles.liveDotGlow, { transform: [{ scale: dotScale }], opacity: dotOpacity, backgroundColor: connected ? '#00F5A0' : '#FFB020' }]} />
        <View style={[styles.liveDot, { backgroundColor: connected ? '#00F5A0' : '#FFB020' }]} />
      </View>
      <Text style={styles.connectionText}>{connected ? formatLatency(latency) : status.toUpperCase()}</Text>
      {!connected && <Text style={styles.reconnectText}>{ProIcon.reconnect}</Text>}
    </TouchableOpacity>
  );
}

function PollCard({ poll, onVote }: { poll: any; onVote: (option: any, index: number) => void }) {
  const total = useMemo(() => {
    if (!poll?.options) return 0;
    return poll.options.reduce((sum: number, opt: any) => sum + Number(opt.count || opt.votes || 0), 0);
  }, [poll]);

  if (!poll) return null;

  return (
    <View style={styles.pollCard}>
      <View style={styles.pollHeader}>
        <Text style={styles.pollIcon}>{ProIcon.poll}</Text>
        <Text style={styles.pollQuestion} numberOfLines={2}>{poll.question}</Text>
      </View>
      <View style={styles.pollOptions}>
        {poll.options?.map((opt: any, i: number) => {
          const count = Number(opt.count || opt.votes || 0);
          const percent = total > 0 ? Math.round((count / total) * 100) : 0;
          return (
            <TouchableOpacity key={opt.id || i} activeOpacity={0.86} style={styles.pollOption} onPress={() => onVote(opt, i)}>
              <View style={[styles.pollFill, { width: `${percent}%` }]} />
              <Text style={styles.pollOptionText} numberOfLines={1}>{opt.text || opt.label || `Option ${i + 1}`}</Text>
              <Text style={styles.pollCount}>{percent}%</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

export default function VoiceRoomScreen({ route, navigation }: any) {
  const roomId = route?.params?.roomId;
  const {
    emit,
    emitAsync,
    joinRoom,
    leaveRoom,
    muteMic,
    raiseHand,
    sendGift,
    submitPollVote,
    updateSpeaking,
    connect,
    status,
    latency,
    lastError,
    isConnected
  } = useVoiceSocket(roomId, {
    autoJoin: true,
    enableQueue: true,
    enablePresence: true,
    enableHeartbeat: true
  });

  const {
    seats,
    chat,
    gifts,
    poll,
    isMuted,
    isPushToTalk,
    room,
    mySeatId,
    hostControls,
    setUi
  } = useRoomStore() as any;

  const [activeOverlay, setActiveOverlay] = useState<any>(null);
  const [panel, setPanel] = useState<PanelMode>('chat');
  const [joiningSeat, setJoiningSeat] = useState(false);
  const [handRaised, setHandRaisedLocal] = useState(false);
  const [pttActive, setPttActive] = useState(false);

  const bgPulse = useRef(new Animated.Value(0)).current;
  const roomGlow = useRef(new Animated.Value(0)).current;
  const giftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hostId = getRoomHostId(room);
  const me = useRoomStore.getState() as any;
  const currentUserId = me?.user?.id || me?.currentUser?.id || me?.authUser?.id || me?.room?.me?.id || me?.id || null;
  const isHost = !!hostId && !!currentUserId && hostId === currentUserId;
  const isLocked = !!hostControls?.locked || !!room?.locked || !!room?.isLocked;

  useEffect(() => {
    const bgLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(bgPulse, { toValue: 1, duration: 3600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(bgPulse, { toValue: 0, duration: 3600, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
      ])
    );

    const glowLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(roomGlow, { toValue: 1, duration: 1300, easing: Easing.out(Easing.quad), useNativeDriver: true }),
        Animated.timing(roomGlow, { toValue: 0, duration: 1300, easing: Easing.in(Easing.quad), useNativeDriver: true })
      ])
    );

    bgLoop.start();
    glowLoop.start();

    return () => {
      bgLoop.stop();
      glowLoop.stop();
    };
  }, [bgPulse, roomGlow]);

  useFocusEffect(
    useCallback(() => {
      joinRoom(roomId);
      setUi?.({ activeScreen: 'VoiceRoom', activeRoomId: roomId });
      return () => {
        leaveRoom(roomId);
        setUi?.({ activeScreen: null });
      };
    }, [roomId, joinRoom, leaveRoom, setUi])
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') emit('room:resync', { roomId, at: Date.now() });
      if (state === 'background' || state === 'inactive') emit('presence:away', { roomId, at: Date.now() });
    });
    return () => sub.remove();
  }, [emit, roomId]);

  useEffect(() => {
    if (!gifts?.length) return;
    const last = gifts[gifts.length - 1];
    setActiveOverlay(last);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => null);
    if (giftTimer.current) clearTimeout(giftTimer.current);
    giftTimer.current = setTimeout(() => setActiveOverlay(null), 2600);
    return () => {
      if (giftTimer.current) clearTimeout(giftTimer.current);
    };
  }, [gifts]);

  const bgTranslate = bgPulse.interpolate({ inputRange: [0, 1], outputRange: [-18, 18] });
  const glowScale = roomGlow.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const glowOpacity = roomGlow.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });

  const toggleMic = useCallback(() => {
    const next = !isMuted;
    muteMic(next);
    Haptics.selectionAsync().catch(() => null);
  }, [isMuted, muteMic]);

  const takeSeat = useCallback(async () => {
    if (mySeatId || joiningSeat || isLocked) return;
    setJoiningSeat(true);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => null);
    const response = await emitAsync('seat:take', { roomId }, 12000);
    if (!response.ok) emit('room:toast', { type: 'error', message: response.error || 'Seat request failed' });
    setJoiningSeat(false);
  }, [mySeatId, joiningSeat, isLocked, emitAsync, emit, roomId]);

  const leaveSeat = useCallback(async () => {
    if (!mySeatId) return;
    Haptics.selectionAsync().catch(() => null);
    await emitAsync('seat:leave', { roomId, seatId: mySeatId }, 10000);
  }, [mySeatId, emitAsync, roomId]);

  const toggleHand = useCallback(() => {
    const next = !handRaised;
    setHandRaisedLocal(next);
    raiseHand(next);
    Haptics.selectionAsync().catch(() => null);
  }, [handRaised, raiseHand]);

  const startPushToTalk = useCallback(() => {
    setPttActive(true);
    updateSpeaking(true, 1);
    emit('mic:push_to_talk', { roomId, active: true });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => null);
  }, [emit, roomId, updateSpeaking]);

  const stopPushToTalk = useCallback(() => {
    setPttActive(false);
    updateSpeaking(false, 0);
    emit('mic:push_to_talk', { roomId, active: false });
  }, [emit, roomId, updateSpeaking]);

  const onPollVote = useCallback((option: any, index: number) => {
    const optionId = option?.id || option?.optionId || String(index);
    if (poll?.id) submitPollVote(poll.id, optionId);
    else emit('poll:vote', { roomId, optionIndex: index });
    Haptics.selectionAsync().catch(() => null);
  }, [poll, submitPollVote, emit, roomId]);

  const onSendGift = useCallback((giftId: string, amount: number) => {
    const toUserId = room?.host?.id || hostId;
    if (!toUserId) return;
    sendGift(giftId, toUserId, amount);
  }, [room, hostId, sendGift]);

  const onBack = useCallback(() => {
    leaveRoom(roomId);
    navigation.goBack();
  }, [leaveRoom, navigation, roomId]);

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="light-content" backgroundColor="#080A12" />
      <View style={styles.container}>
        <LinearGradient colors={['#080A12', '#111827', '#17132A']} style={StyleSheet.absoluteFill} />
        <Animated.View style={[styles.bgOrbOne, { transform: [{ translateX: bgTranslate }, { scale: glowScale }], opacity: glowOpacity }]} />
        <Animated.View style={[styles.bgOrbTwo, { transform: [{ translateX: Animated.multiply(bgTranslate, -1) }] }]} />

        <View style={styles.header}>
          <TouchableOpacity activeOpacity={0.8} onPress={onBack} style={styles.backBtn}>
            <Text style={styles.backIcon}>{ProIcon.back}</Text>
          </TouchableOpacity>

          <View style={styles.headerCenter}>
            <View style={styles.titleRow}>
              <Text style={styles.liveMark}>{ProIcon.live}</Text>
              <Text style={styles.title} numberOfLines={1}>{getRoomTitle(room)}</Text>
              {isHost && <Text style={styles.hostMark}>{ProIcon.host}</Text>}
              {isLocked && <Text style={styles.lockMark}>{ProIcon.lock}</Text>}
            </View>
            <Text style={styles.meta} numberOfLines={1}>{getRoomSubtitle(room, seats)}</Text>
          </View>

          <ConnectionPill status={status} latency={latency} onReconnect={connect} />
        </View>

        {!!lastError && status === 'error' && (
          <TouchableOpacity activeOpacity={0.85} onPress={connect} style={styles.errorBar}>
            <Text style={styles.errorText} numberOfLines={1}>{lastError}</Text>
            <Text style={styles.errorAction}>{ProIcon.reconnect}</Text>
          </TouchableOpacity>
        )}

        <View style={styles.stage}>
          <Animated.View style={[styles.stageGlow, { transform: [{ scale: glowScale }], opacity: glowOpacity }]} />
          <SeatGrid seats={seats} onTakeSeat={takeSeat} onLeaveSeat={leaveSeat} mySeatId={mySeatId} isLocked={isLocked} joiningSeat={joiningSeat} />
        </View>

        <PollCard poll={poll} onVote={onPollVote} />

        <View style={styles.panelTabs}>
          <TouchableOpacity activeOpacity={0.85} onPress={() => setPanel(panel === 'chat' ? 'none' : 'chat')} style={[styles.panelTab, panel === 'chat' && styles.panelTabActive]}>
            <Text style={[styles.panelTabIcon, panel === 'chat' && styles.panelTabTextActive]}>{ProIcon.chat}</Text>
            <Text style={[styles.panelTabText, panel === 'chat' && styles.panelTabTextActive]}>Chat</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.85} onPress={() => setPanel(panel === 'gifts' ? 'none' : 'gifts')} style={[styles.panelTab, panel === 'gifts' && styles.panelTabActive]}>
            <Text style={[styles.panelTabIcon, panel === 'gifts' && styles.panelTabTextActive]}>{ProIcon.gift}</Text>
            <Text style={[styles.panelTabText, panel === 'gifts' && styles.panelTabTextActive]}>Gifts</Text>
          </TouchableOpacity>
          {isHost && (
            <TouchableOpacity activeOpacity={0.85} onPress={() => setPanel(panel === 'controls' ? 'none' : 'controls')} style={[styles.panelTab, panel === 'controls' && styles.panelTabActive]}>
              <Text style={[styles.panelTabIcon, panel === 'controls' && styles.panelTabTextActive]}>{ProIcon.host}</Text>
              <Text style={[styles.panelTabText, panel === 'controls' && styles.panelTabTextActive]}>Host</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={[styles.contentPanel, panel === 'none' && styles.contentPanelHidden]}>
          {panel === 'chat' && (
            <ChatView
              messages={chat}
              roomId={roomId}
              onReaction={(msgId: string, emoji: string) => emit('chat:reaction', { roomId, messageId: msgId, emoji })}
              onSend={(content: string, extra: any = {}) => emit('chat:send', { roomId, content, ...extra })}
            />
          )}

          {panel === 'gifts' && (
            <View style={styles.giftPanel}>
              <GiftBar onSend={onSendGift} roomId={roomId} hostId={hostId} />
            </View>
          )}

          {panel === 'controls' && isHost && (
            <HostControls emit={emit} roomId={roomId} room={room} />
          )}
        </View>

        <View style={styles.controls}>
          <IconButton icon={isMuted ? ProIcon.micOff : ProIcon.micOn} label={isMuted ? 'Muted' : 'Mic'} active={!isMuted} danger={isMuted} onPress={toggleMic} />
          <IconButton icon={mySeatId ? ProIcon.seat : ProIcon.users} label={mySeatId ? 'Leave' : 'Seat'} active={!!mySeatId} disabled={joiningSeat || (!mySeatId && isLocked)} onPress={mySeatId ? leaveSeat : takeSeat} />
          <Pressable onPressIn={startPushToTalk} onPressOut={stopPushToTalk} disabled={isMuted} style={({ pressed }) => [styles.pttButton, (pressed || pttActive) && styles.pttButtonActive, isMuted && styles.pttDisabled]}>
            <LinearGradient colors={(pttActive || isPushToTalk) ? ['#7C3CFF', '#00F5FF'] : ['rgba(255,255,255,0.95)', 'rgba(245,247,255,0.86)']} style={styles.pttGradient}>
              <Text style={[styles.pttIcon, (pttActive || isPushToTalk) && styles.pttIconActive]}>{ProIcon.ptt}</Text>
              <Text style={[styles.pttText, (pttActive || isPushToTalk) && styles.pttTextActive]}>{pttActive ? 'TALKING' : 'HOLD'}</Text>
            </LinearGradient>
          </Pressable>
          <IconButton icon={ProIcon.raise} label={handRaised ? 'Raised' : 'Hand'} active={handRaised} onPress={toggleHand} />
          <IconButton icon={panel === 'chat' ? ProIcon.close : ProIcon.chat} label={panel === 'chat' ? 'Hide' : 'Chat'} active={panel === 'chat'} onPress={() => setPanel(panel === 'chat' ? 'none' : 'chat')} />
        </View>

        {joiningSeat && (
          <View style={styles.loadingSeat}>
            <ActivityIndicator color="#FFFFFF" />
            <Text style={styles.loadingSeatText}>Taking seat</Text>
          </View>
        )}

        {activeOverlay && <GiftOverlay gift={activeOverlay} />}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: '#080A12'
  },
  container: {
    flex: 1,
    backgroundColor: '#080A12',
    overflow: 'hidden'
  },
  bgOrbOne: {
    position: 'absolute',
    width: width * 0.9,
    height: width * 0.9,
    borderRadius: width,
    backgroundColor: 'rgba(0,245,255,0.16)',
    top: -width * 0.42,
    right: -width * 0.35
  },
  bgOrbTwo: {
    position: 'absolute',
    width: width * 0.75,
    height: width * 0.75,
    borderRadius: width,
    backgroundColor: 'rgba(124,60,255,0.18)',
    bottom: height * 0.12,
    left: -width * 0.38
  },
  header: {
    paddingHorizontal: 14,
    paddingTop: Platform.OS === 'android' ? 14 : 8,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  backBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)'
  },
  backIcon: {
    fontSize: 34,
    lineHeight: 36,
    color: '#FFFFFF',
    fontWeight: '300',
    marginTop: -2
  },
  headerCenter: {
    flex: 1,
    minWidth: 0
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6
  },
  liveMark: {
    color: '#FF3B6B',
    fontSize: 12
  },
  title: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
    letterSpacing: 0.2
  },
  hostMark: {
    color: '#FFD166',
    fontSize: 16,
    fontWeight: '900'
  },
  lockMark: {
    color: '#A7B0C0',
    fontSize: 13,
    fontWeight: '900'
  },
  meta: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3
  },
  connectionPill: {
    minWidth: 74,
    height: 34,
    borderRadius: 17,
    paddingHorizontal: 10,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.13)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6
  },
  liveDotBox: {
    width: 10,
    height: 10,
    alignItems: 'center',
    justifyContent: 'center'
  },
  liveDotGlow: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4
  },
  connectionText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.5
  },
  reconnectText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '900'
  },
  errorBar: {
    marginHorizontal: 14,
    marginBottom: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 14,
    backgroundColor: 'rgba(255,77,109,0.16)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,109,0.35)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  errorText: {
    flex: 1,
    color: '#FFD8E0',
    fontSize: 12,
    fontWeight: '800'
  },
  errorAction: {
    color: '#FFFFFF',
    fontSize: 16,
    fontWeight: '900'
  },
  stage: {
    marginHorizontal: 12,
    borderRadius: 30,
    paddingVertical: 14,
    paddingHorizontal: 8,
    minHeight: height * 0.31,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden'
  },
  stageGlow: {
    position: 'absolute',
    width: width * 0.9,
    height: width * 0.9,
    borderRadius: width,
    backgroundColor: 'rgba(0,245,255,0.12)',
    alignSelf: 'center',
    top: -width * 0.35
  },
  pollCard: {
    marginHorizontal: 12,
    marginTop: 10,
    padding: 12,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.11)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)'
  },
  pollHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10
  },
  pollIcon: {
    color: '#00F5FF',
    fontSize: 16,
    fontWeight: '900'
  },
  pollQuestion: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900'
  },
  pollOptions: {
    gap: 8
  },
  pollOption: {
    height: 38,
    borderRadius: 13,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12
  },
  pollFill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,245,255,0.22)'
  },
  pollOptionText: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '800'
  },
  pollCount: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 11,
    fontWeight: '900'
  },
  panelTabs: {
    marginHorizontal: 12,
    marginTop: 10,
    flexDirection: 'row',
    gap: 8
  },
  panelTab: {
    flex: 1,
    height: 40,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  panelTabActive: {
    backgroundColor: 'rgba(0,245,255,0.18)',
    borderColor: 'rgba(0,245,255,0.36)'
  },
  panelTabIcon: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 13,
    fontWeight: '900'
  },
  panelTabText: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 12,
    fontWeight: '900'
  },
  panelTabTextActive: {
    color: '#FFFFFF'
  },
  contentPanel: {
    flex: 1,
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 8,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)'
  },
  contentPanelHidden: {
    height: 0,
    flex: 0,
    opacity: 0,
    marginTop: 0,
    marginBottom: 0,
    borderWidth: 0
  },
  giftPanel: {
    flex: 1,
    padding: 10,
    justifyContent: 'center'
  },
  controls: {
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: Platform.OS === 'android' ? 14 : 10,
    backgroundColor: 'rgba(8,10,18,0.92)',
    borderTopWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8
  },
  iconButtonWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 54
  },
  iconButton: {
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#00F5FF',
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 3
  },
  iconButtonText: {
    fontSize: 19,
    fontWeight: '900'
  },
  iconButtonLabel: {
    color: 'rgba(255,255,255,0.68)',
    fontSize: 10,
    fontWeight: '900',
    marginTop: 4,
    maxWidth: 58
  },
  pttButton: {
    flex: 1,
    height: 58,
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: '#7C3CFF',
    shadowOpacity: 0.24,
    shadowRadius: 16,
    elevation: 4
  },
  pttButtonActive: {
    transform: [{ scale: 1.02 }]
  },
  pttDisabled: {
    opacity: 0.45
  },
  pttGradient: {
    flex: 1,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.16)'
  },
  pttIcon: {
    color: '#111827',
    fontSize: 16,
    fontWeight: '900'
  },
  pttIconActive: {
    color: '#FFFFFF'
  },
  pttText: {
    color: '#111827',
    fontSize: 11,
    fontWeight: '900',
    letterSpacing: 0.7,
    marginTop: 2
  },
  pttTextActive: {
    color: '#FFFFFF'
  },
  loadingSeat: {
    position: 'absolute',
    alignSelf: 'center',
    top: height * 0.42,
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.62)',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10
  },
  loadingSeatText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900'
  }
});
