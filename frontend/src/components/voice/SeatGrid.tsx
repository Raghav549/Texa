import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
  AccessibilityRole,
  ViewStyle,
  Animated,
  Easing,
  I18nManager
} from 'react-native';
import VoiceSeat from './VoiceSeat';
import { theme } from '../../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type SeatUser = {
  id?: string;
  username?: string;
  fullName?: string;
  displayName?: string;
  avatarUrl?: string;
  isVerified?: boolean;
  level?: string | number;
  role?: string;
  online?: boolean;
};

export interface Seat {
  id: string;
  userId: string;
  seatIndex?: number;
  position?: number;
  isHost?: boolean;
  isCoHost?: boolean;
  isModerator?: boolean;
  isMuted?: boolean;
  isSpeaking?: boolean;
  handRaised?: boolean;
  audioLevel?: number;
  isLocked?: boolean;
  isReserved?: boolean;
  reservedFor?: string | null;
  user?: SeatUser | any;
}

type SeatGridProps = {
  seats?: Seat[];
  onTakeSeat: (index?: number) => void;
  onSeatPress?: (seat: Seat, index: number) => void;
  onSeatLongPress?: (seat: Seat, index: number) => void;
  maxSeats?: number;
  columns?: number;
  disabled?: boolean;
  locked?: boolean;
  mySeatId?: string | null;
  myUserId?: string | null;
  style?: ViewStyle;
  emptyLabel?: string;
  lockedLabel?: string;
  reservedLabel?: string;
  title?: string;
  showSeatNumbers?: boolean;
  showTopBar?: boolean;
  showCapacity?: boolean;
  showRoleBadges?: boolean;
  showAudioPulse?: boolean;
  compact?: boolean;
  premium?: boolean;
};

const ProVoiceIcon = {
  sit: '◇',
  lock: '▰',
  live: '●',
  host: '♛',
  cohost: '◆',
  mod: '✦',
  mic: '◉',
  muted: '◌',
  hand: '✧',
  empty: '＋',
  reserved: '◈',
  crown: '♕',
  signal: '▰▰▰',
  spark: '✦'
} as const;

const palette = {
  gold: theme.colors?.gold || theme.colors?.premiumGold || '#D4A857',
  cyan: theme.colors?.neonCyan || theme.colors?.neon || '#00E0FF',
  ink: '#111111',
  softInk: '#4B4B4B',
  muted: '#8A8A8A',
  card: '#FFFFFF',
  glass: 'rgba(255,255,255,0.88)',
  bg: 'rgba(250,250,250,0.96)',
  danger: '#FF3B5F',
  purple: '#8A35FF',
  purpleBg: '#F4E9FF',
  border: 'rgba(0,0,0,0.065)'
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function getSeatIndex(seat: Seat, fallbackIndex: number, maxSeats: number) {
  const rawIndex = Number(seat?.seatIndex ?? seat?.position ?? fallbackIndex);
  return Number.isFinite(rawIndex) && rawIndex >= 0 && rawIndex < maxSeats ? rawIndex : -1;
}

function normalizeSeats(seats: Seat[], maxSeats: number) {
  const grid: Array<Seat | null> = Array.from({ length: maxSeats }, () => null);
  const used = new Set<number>();

  seats.filter(Boolean).forEach((seat, fallbackIndex) => {
    const preferredIndex = getSeatIndex(seat, fallbackIndex, maxSeats);

    if (preferredIndex >= 0 && !used.has(preferredIndex)) {
      grid[preferredIndex] = seat;
      used.add(preferredIndex);
      return;
    }

    const freeIndex = grid.findIndex(item => !item);
    if (freeIndex >= 0) {
      grid[freeIndex] = seat;
      used.add(freeIndex);
    }
  });

  return grid;
}

function usePulse(active: boolean, min = 1, max = 1.06, duration = 900) {
  const value = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let loop: Animated.CompositeAnimation | null = null;

    if (active) {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true
          }),
          Animated.timing(value, {
            toValue: 0,
            duration,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true
          })
        ])
      );
      loop.start();
    } else {
      value.stopAnimation();
      value.setValue(0);
    }

    return () => {
      loop?.stop();
      value.stopAnimation();
    };
  }, [active, duration, value]);

  return {
    transform: [
      {
        scale: value.interpolate({
          inputRange: [0, 1],
          outputRange: [min, max]
        })
      }
    ],
    opacity: value.interpolate({
      inputRange: [0, 1],
      outputRange: [0.45, 1]
    })
  };
}

function getRole(seat?: Seat | null) {
  if (!seat) return null;
  if (seat.isHost) return { label: 'HOST', icon: ProVoiceIcon.host, style: 'host' as const };
  if (seat.isCoHost) return { label: 'CO', icon: ProVoiceIcon.cohost, style: 'cohost' as const };
  if (seat.isModerator) return { label: 'MOD', icon: ProVoiceIcon.mod, style: 'mod' as const };
  return null;
}

function getUserName(seat?: Seat | null) {
  const user = seat?.user || {};
  return user.displayName || user.fullName || user.username || 'Guest';
}

function getUserHandle(seat?: Seat | null) {
  const user = seat?.user || {};
  return user.username ? `@${user.username}` : 'Voice member';
}

function EmptySeat({
  index,
  locked,
  reserved,
  disabled,
  label,
  lockedLabel,
  reservedLabel,
  showSeatNumbers,
  compact,
  premium
}: {
  index: number;
  locked: boolean;
  reserved: boolean;
  disabled: boolean;
  label: string;
  lockedLabel: string;
  reservedLabel: string;
  showSeatNumbers: boolean;
  compact: boolean;
  premium: boolean;
}) {
  const pulseStyle = usePulse(!locked && !reserved && !disabled, 1, 1.04, 1100);

  const icon = locked ? ProVoiceIcon.lock : reserved ? ProVoiceIcon.reserved : ProVoiceIcon.empty;
  const text = locked ? lockedLabel : reserved ? reservedLabel : label;

  return (
    <View
      style={[
        styles.empty,
        compact && styles.emptyCompact,
        premium && styles.emptyPremium,
        locked && styles.emptyLocked,
        reserved && styles.emptyReserved,
        disabled && styles.emptyDisabled
      ]}
    >
      <Animated.View
        style={[
          styles.emptyIconWrap,
          compact && styles.emptyIconWrapCompact,
          locked && styles.emptyIconLocked,
          reserved && styles.emptyIconReserved,
          !locked && !reserved && !disabled && pulseStyle
        ]}
      >
        <Text
          style={[
            styles.emptyIcon,
            compact && styles.emptyIconCompact,
            locked && styles.emptyIconTextLocked,
            reserved && styles.emptyIconTextReserved
          ]}
        >
          {icon}
        </Text>
      </Animated.View>
      <Text
        style={[
          styles.emptyText,
          compact && styles.emptyTextCompact,
          locked && styles.emptyTextLocked,
          reserved && styles.emptyTextReserved
        ]}
        numberOfLines={1}
      >
        {text}
      </Text>
      {showSeatNumbers && <Text style={[styles.seatNumber, compact && styles.seatNumberCompact]}>Seat {index + 1}</Text>}
    </View>
  );
}

const MemoEmptySeat = memo(EmptySeat);

function SeatStatusRail({
  seat,
  compact
}: {
  seat: Seat;
  compact: boolean;
}) {
  const level = seat?.user?.level;
  const muted = !!seat?.isMuted;
  const speaking = !!seat?.isSpeaking && !muted;

  return (
    <View style={[styles.statusRail, compact && styles.statusRailCompact]}>
      <View style={[styles.statusDot, speaking && styles.statusDotSpeaking, muted && styles.statusDotMuted]}>
        <Text style={[styles.statusIcon, compact && styles.statusIconCompact]}>
          {muted ? ProVoiceIcon.muted : speaking ? ProVoiceIcon.mic : ProVoiceIcon.live}
        </Text>
      </View>
      {typeof level !== 'undefined' && level !== null && String(level).length > 0 && (
        <View style={[styles.levelMini, compact && styles.levelMiniCompact]}>
          <Text style={[styles.levelMiniText, compact && styles.levelMiniTextCompact]} numberOfLines={1}>
            {String(level).slice(0, 4)}
          </Text>
        </View>
      )}
    </View>
  );
}

const MemoSeatStatusRail = memo(SeatStatusRail);

function AudioAura({
  active,
  level,
  compact
}: {
  active: boolean;
  level?: number;
  compact: boolean;
}) {
  const pulse = usePulse(active, 1, clamp(1.05 + Number(level || 0) / 180, 1.06, 1.22), 520);

  if (!active) return null;

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.audioAura,
        compact && styles.audioAuraCompact,
        pulse
      ]}
    />
  );
}

const MemoAudioAura = memo(AudioAura);

function SeatCell({
  seat,
  index,
  width,
  disabled,
  locked,
  isMine,
  onTakeSeat,
  onSeatPress,
  onSeatLongPress,
  emptyLabel,
  lockedLabel,
  reservedLabel,
  showSeatNumbers,
  showRoleBadges,
  showAudioPulse,
  compact,
  premium
}: {
  seat: Seat | null;
  index: number;
  width: `${number}%`;
  disabled: boolean;
  locked: boolean;
  isMine: boolean;
  onTakeSeat: (index: number) => void;
  onSeatPress?: (seat: Seat, index: number) => void;
  onSeatLongPress?: (seat: Seat, index: number) => void;
  emptyLabel: string;
  lockedLabel: string;
  reservedLabel: string;
  showSeatNumbers: boolean;
  showRoleBadges: boolean;
  showAudioPulse: boolean;
  compact: boolean;
  premium: boolean;
}) {
  const role = getRole(seat);
  const isSeatLocked = locked || !!seat?.isLocked;
  const isReserved = !seat && false;
  const isSpeaking = !!seat?.isSpeaking && !seat?.isMuted;
  const isHandRaised = !!seat?.handRaised;
  const isDisabled = disabled || isSeatLocked;

  const handlePress = useCallback(() => {
    if (seat) {
      onSeatPress?.(seat, index);
      return;
    }
    if (!isDisabled) onTakeSeat(index);
  }, [seat, index, isDisabled, onTakeSeat, onSeatPress]);

  const handleLongPress = useCallback(() => {
    if (seat) onSeatLongPress?.(seat, index);
  }, [seat, index, onSeatLongPress]);

  return (
    <TouchableOpacity
      activeOpacity={seat ? 0.86 : isDisabled ? 1 : 0.72}
      style={[
        styles.cell,
        compact && styles.cellCompact,
        premium && styles.cellPremium,
        { width },
        isSpeaking && styles.speakingCell,
        isHandRaised && styles.handCell,
        isMine && styles.myCell,
        isSeatLocked && !seat && styles.lockedCell
      ]}
      onPress={handlePress}
      onLongPress={handleLongPress}
      disabled={!seat && isDisabled}
      accessibilityRole={'button' as AccessibilityRole}
      accessibilityLabel={seat ? `${getUserName(seat)} seated, ${getUserHandle(seat)}` : isSeatLocked ? 'Seat locked' : 'Take empty voice seat'}
      accessibilityHint={seat ? 'Open seat actions' : 'Join this voice seat'}
    >
      {seat ? (
        <View style={[styles.seatWrap, compact && styles.seatWrapCompact]}>
          {showAudioPulse && <MemoAudioAura active={isSpeaking} level={seat.audioLevel} compact={compact} />}
          {showRoleBadges && role && (
            <View
              style={[
                styles.roleBadge,
                compact && styles.roleBadgeCompact,
                role.style === 'host' && styles.roleBadgeHost,
                role.style === 'cohost' && styles.roleBadgeCoHost,
                role.style === 'mod' && styles.roleBadgeMod
              ]}
            >
              <Text style={[styles.roleBadgeIcon, compact && styles.roleBadgeIconCompact]}>{role.icon}</Text>
              {!compact && <Text style={styles.roleBadgeText}>{role.label}</Text>}
            </View>
          )}
          {seat.handRaised && (
            <View style={[styles.handBadge, compact && styles.handBadgeCompact]}>
              <Text style={[styles.handBadgeText, compact && styles.handBadgeTextCompact]}>{ProVoiceIcon.hand}</Text>
            </View>
          )}
          {isMine && (
            <View style={[styles.mineBadge, compact && styles.mineBadgeCompact]}>
              <Text style={[styles.mineBadgeText, compact && styles.mineBadgeTextCompact]}>YOU</Text>
            </View>
          )}
          <VoiceSeat seat={seat} isMine={isMine} compact={compact} showRole={false} showAudioMeter />
          <MemoSeatStatusRail seat={seat} compact={compact} />
          {showSeatNumbers && <Text style={[styles.occupiedSeatNumber, compact && styles.occupiedSeatNumberCompact]}>#{index + 1}</Text>}
        </View>
      ) : (
        <MemoEmptySeat
          index={index}
          locked={isSeatLocked}
          reserved={isReserved}
          disabled={disabled}
          label={emptyLabel}
          lockedLabel={lockedLabel}
          reservedLabel={reservedLabel}
          showSeatNumbers={showSeatNumbers}
          compact={compact}
          premium={premium}
        />
      )}
    </TouchableOpacity>
  );
}

const MemoSeatCell = memo(SeatCell);

function SeatGrid({
  seats = [],
  onTakeSeat,
  onSeatPress,
  onSeatLongPress,
  maxSeats = 10,
  columns = 3,
  disabled = false,
  locked = false,
  mySeatId = null,
  myUserId = null,
  style,
  emptyLabel = 'Take Seat',
  lockedLabel = 'Locked',
  reservedLabel = 'Reserved',
  title = 'Voice Seats',
  showSeatNumbers = false,
  showTopBar = true,
  showCapacity = true,
  showRoleBadges = true,
  showAudioPulse = true,
  compact = false,
  premium = true
}: SeatGridProps) {
  const safeMaxSeats = clamp(Number(maxSeats) || 10, 1, 24);
  const safeColumns = clamp(Number(columns) || 3, 2, 5);

  const grid = useMemo(() => normalizeSeats(Array.isArray(seats) ? seats : [], safeMaxSeats), [seats, safeMaxSeats]);

  const takenCount = useMemo(() => grid.filter(Boolean).length, [grid]);
  const availableCount = safeMaxSeats - takenCount;
  const hostSeat = useMemo(() => grid.find(seat => seat?.isHost) || null, [grid]);
  const speakingCount = useMemo(() => grid.filter(seat => seat?.isSpeaking && !seat?.isMuted).length, [grid]);
  const handCount = useMemo(() => grid.filter(seat => seat?.handRaised).length, [grid]);

  const handleTakeSeat = useCallback(
    (index: number) => {
      if (disabled || locked) return;
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      onTakeSeat?.(index);
    },
    [disabled, locked, onTakeSeat]
  );

  const cellWidth = useMemo(() => {
    const gapCompensation = safeColumns === 2 ? 1.8 : safeColumns === 3 ? 2.25 : safeColumns === 4 ? 2.65 : 3;
    return `${100 / safeColumns - gapCompensation}%` as `${number}%`;
  }, [safeColumns]);

  return (
    <View style={[styles.wrapper, compact && styles.wrapperCompact, premium && styles.wrapperPremium, style]}>
      {showTopBar && (
        <View style={[styles.topBar, compact && styles.topBarCompact]}>
          <View style={styles.topLeft}>
            <View style={[styles.livePill, compact && styles.livePillCompact]}>
              <Text style={[styles.liveDot, compact && styles.liveDotCompact]}>{ProVoiceIcon.live}</Text>
              <Text style={[styles.liveText, compact && styles.liveTextCompact]} numberOfLines={1}>{title}</Text>
            </View>
            {!!hostSeat && !compact && (
              <Text style={styles.hostLine} numberOfLines={1}>
                {ProVoiceIcon.crown} {getUserName(hostSeat)}
              </Text>
            )}
          </View>
          {showCapacity && (
            <View style={styles.capacityWrap}>
              <View style={[styles.capacityPill, compact && styles.capacityPillCompact]}>
                <Text style={[styles.capacityText, compact && styles.capacityTextCompact]}>{takenCount}/{safeMaxSeats}</Text>
                <Text style={[styles.capacitySub, compact && styles.capacitySubCompact]}>{availableCount > 0 ? `${availableCount} open` : 'full'}</Text>
              </View>
              {!compact && (
                <View style={styles.signalRow}>
                  <Text style={styles.signalText}>{ProVoiceIcon.signal}</Text>
                  <Text style={styles.signalMeta}>{speakingCount} live</Text>
                  {handCount > 0 && <Text style={styles.handMeta}>{ProVoiceIcon.hand} {handCount}</Text>}
                </View>
              )}
            </View>
          )}
        </View>
      )}

      <View style={[styles.grid, compact && styles.gridCompact]}>
        {grid.map((seat, index) => {
          const isMine = !!seat && ((!!mySeatId && seat.id === mySeatId) || (!!myUserId && seat.userId === myUserId));

          return (
            <MemoSeatCell
              key={seat?.id || `empty-seat-${index}`}
              seat={seat}
              index={index}
              width={cellWidth}
              disabled={disabled}
              locked={locked}
              isMine={isMine}
              onTakeSeat={handleTakeSeat}
              onSeatPress={onSeatPress}
              onSeatLongPress={onSeatLongPress}
              emptyLabel={emptyLabel}
              lockedLabel={lockedLabel}
              reservedLabel={reservedLabel}
              showSeatNumbers={showSeatNumbers}
              showRoleBadges={showRoleBadges}
              showAudioPulse={showAudioPulse}
              compact={compact}
              premium={premium}
            />
          );
        })}
      </View>
    </View>
  );
}

export default memo(SeatGrid);

export { ProVoiceIcon };

const styles = StyleSheet.create({
  wrapper: {
    width: '100%',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 8
  },
  wrapperCompact: {
    paddingHorizontal: 8,
    paddingTop: 6,
    paddingBottom: 6
  },
  wrapperPremium: {
    backgroundColor: 'transparent'
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  topBarCompact: {
    marginBottom: 7,
    alignItems: 'center'
  },
  topLeft: {
    flex: 1,
    paddingRight: 10
  },
  livePill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: palette.glass,
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.24)',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2
  },
  livePillCompact: {
    paddingHorizontal: 9,
    paddingVertical: 5
  },
  liveDot: {
    fontSize: 12,
    color: palette.danger,
    marginRight: 7,
    fontWeight: '900'
  },
  liveDotCompact: {
    fontSize: 10,
    marginRight: 5
  },
  liveText: {
    fontSize: 12,
    fontWeight: '900',
    color: palette.ink,
    letterSpacing: 0.35
  },
  liveTextCompact: {
    fontSize: 10.5
  },
  hostLine: {
    marginTop: 6,
    marginLeft: 3,
    fontSize: 11,
    fontWeight: '800',
    color: palette.muted,
    letterSpacing: 0.2
  },
  capacityWrap: {
    alignItems: 'flex-end'
  },
  capacityPill: {
    alignItems: 'flex-end'
  },
  capacityPillCompact: {
    alignItems: 'flex-end'
  },
  capacityText: {
    fontSize: 13,
    fontWeight: '900',
    color: palette.gold
  },
  capacityTextCompact: {
    fontSize: 11.5
  },
  capacitySub: {
    fontSize: 10,
    fontWeight: '800',
    color: palette.muted,
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  capacitySubCompact: {
    fontSize: 8.5
  },
  signalRow: {
    flexDirection: I18nManager.isRTL ? 'row-reverse' : 'row',
    alignItems: 'center',
    marginTop: 5
  },
  signalText: {
    fontSize: 8,
    color: palette.cyan,
    fontWeight: '900',
    letterSpacing: -1
  },
  signalMeta: {
    marginLeft: 5,
    fontSize: 9.5,
    fontWeight: '800',
    color: palette.muted,
    textTransform: 'uppercase'
  },
  handMeta: {
    marginLeft: 7,
    fontSize: 9.5,
    fontWeight: '900',
    color: palette.purple
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between'
  },
  gridCompact: {
    gap: 7
  },
  cell: {
    aspectRatio: 0.92,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: palette.border,
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3
  },
  cellCompact: {
    borderRadius: 18,
    aspectRatio: 0.9,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 5 },
    elevation: 2
  },
  cellPremium: {
    backgroundColor: 'rgba(255,255,255,0.86)'
  },
  speakingCell: {
    borderColor: palette.cyan,
    shadowColor: palette.cyan,
    shadowOpacity: 0.24,
    shadowRadius: 18,
    elevation: 6
  },
  handCell: {
    borderColor: '#B982FF',
    shadowColor: '#B982FF',
    shadowOpacity: 0.18
  },
  myCell: {
    borderColor: palette.gold,
    borderWidth: 1.6
  },
  lockedCell: {
    opacity: 0.78
  },
  seatWrap: {
    flex: 1,
    position: 'relative',
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: palette.card
  },
  seatWrapCompact: {
    borderRadius: 18
  },
  audioAura: {
    position: 'absolute',
    top: -8,
    left: -8,
    right: -8,
    bottom: -8,
    borderRadius: 28,
    backgroundColor: palette.cyan,
    opacity: 0.14,
    zIndex: 1
  },
  audioAuraCompact: {
    top: -5,
    left: -5,
    right: -5,
    bottom: -5,
    borderRadius: 22
  },
  roleBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 20,
    minWidth: 26,
    height: 24,
    borderRadius: 12,
    paddingHorizontal: 6,
    backgroundColor: '#161616',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.8)'
  },
  roleBadgeCompact: {
    top: 6,
    left: 6,
    width: 21,
    height: 21,
    minWidth: 21,
    borderRadius: 10.5,
    paddingHorizontal: 0
  },
  roleBadgeHost: {
    backgroundColor: '#161616',
    borderColor: 'rgba(212,168,87,0.9)'
  },
  roleBadgeCoHost: {
    backgroundColor: '#101A22',
    borderColor: 'rgba(0,224,255,0.72)'
  },
  roleBadgeMod: {
    backgroundColor: '#1B1026',
    borderColor: 'rgba(138,53,255,0.68)'
  },
  roleBadgeIcon: {
    color: palette.gold,
    fontSize: 12,
    fontWeight: '900'
  },
  roleBadgeIconCompact: {
    fontSize: 11
  },
  roleBadgeText: {
    color: '#FFFFFF',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.45,
    marginLeft: 4
  },
  handBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 20,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: palette.purpleBg,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D7B6FF'
  },
  handBadgeCompact: {
    top: 6,
    right: 6,
    width: 21,
    height: 21,
    borderRadius: 10.5
  },
  handBadgeText: {
    color: palette.purple,
    fontSize: 13,
    fontWeight: '900'
  },
  handBadgeTextCompact: {
    fontSize: 11
  },
  mineBadge: {
    position: 'absolute',
    left: 8,
    bottom: 8,
    zIndex: 22,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(212,168,87,0.14)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.55)'
  },
  mineBadgeCompact: {
    left: 6,
    bottom: 6,
    paddingHorizontal: 5,
    paddingVertical: 2
  },
  mineBadgeText: {
    fontSize: 8,
    fontWeight: '900',
    color: '#6F5A2A',
    letterSpacing: 0.45
  },
  mineBadgeTextCompact: {
    fontSize: 7
  },
  statusRail: {
    position: 'absolute',
    right: 7,
    bottom: 7,
    zIndex: 18,
    alignItems: 'center'
  },
  statusRailCompact: {
    right: 5,
    bottom: 5
  },
  statusDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: 'rgba(17,17,17,0.82)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.7)'
  },
  statusDotSpeaking: {
    backgroundColor: palette.cyan
  },
  statusDotMuted: {
    backgroundColor: 'rgba(0,0,0,0.34)'
  },
  statusIcon: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900'
  },
  statusIconCompact: {
    fontSize: 8.5
  },
  levelMini: {
    marginTop: 3,
    minWidth: 22,
    paddingHorizontal: 4,
    paddingVertical: 1.5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.88)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    alignItems: 'center'
  },
  levelMiniCompact: {
    minWidth: 18,
    paddingHorizontal: 3,
    paddingVertical: 1
  },
  levelMiniText: {
    fontSize: 7.5,
    fontWeight: '900',
    color: palette.gold
  },
  levelMiniTextCompact: {
    fontSize: 6.5
  },
  occupiedSeatNumber: {
    position: 'absolute',
    bottom: 7,
    left: 9,
    fontSize: 9,
    fontWeight: '900',
    color: 'rgba(0,0,0,0.35)',
    zIndex: 18
  },
  occupiedSeatNumberCompact: {
    bottom: 5,
    left: 7,
    fontSize: 8
  },
  empty: {
    flex: 1,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: palette.bg,
    borderWidth: 1.4,
    borderColor: 'rgba(212,168,87,0.28)',
    borderStyle: 'dashed',
    padding: 8
  },
  emptyCompact: {
    borderRadius: 18,
    padding: 6
  },
  emptyPremium: {
    backgroundColor: 'rgba(255,255,255,0.92)'
  },
  emptyLocked: {
    backgroundColor: 'rgba(245,245,245,0.92)',
    borderColor: 'rgba(0,0,0,0.1)'
  },
  emptyReserved: {
    backgroundColor: 'rgba(244,233,255,0.58)',
    borderColor: 'rgba(138,53,255,0.22)'
  },
  emptyDisabled: {
    opacity: 0.65
  },
  emptyIconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(212,168,87,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.35)',
    marginBottom: 8
  },
  emptyIconWrapCompact: {
    width: 34,
    height: 34,
    borderRadius: 17,
    marginBottom: 6
  },
  emptyIconLocked: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderColor: 'rgba(0,0,0,0.12)'
  },
  emptyIconReserved: {
    backgroundColor: 'rgba(138,53,255,0.1)',
    borderColor: 'rgba(138,53,255,0.22)'
  },
  emptyIcon: {
    fontSize: 22,
    color: palette.gold,
    fontWeight: '900',
    marginTop: Platform.OS === 'ios' ? -1 : 0
  },
  emptyIconCompact: {
    fontSize: 18
  },
  emptyIconTextLocked: {
    color: '#777',
    fontSize: 17
  },
  emptyIconTextReserved: {
    color: palette.purple,
    fontSize: 17
  },
  emptyText: {
    color: '#6F5A2A',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.25,
    textTransform: 'uppercase'
  },
  emptyTextCompact: {
    fontSize: 10
  },
  emptyTextLocked: {
    color: '#777'
  },
  emptyTextReserved: {
    color: palette.purple
  },
  seatNumber: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: '#A5A5A5'
  },
  seatNumberCompact: {
    fontSize: 8.5
  }
});
