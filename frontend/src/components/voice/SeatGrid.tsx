import React, { memo, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  LayoutAnimation,
  Platform,
  UIManager,
  AccessibilityRole,
  ViewStyle
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
  avatarUrl?: string;
  isVerified?: boolean;
  level?: string;
};

export interface Seat {
  id: string;
  userId: string;
  isHost?: boolean;
  isCoHost?: boolean;
  isModerator?: boolean;
  isMuted?: boolean;
  isSpeaking?: boolean;
  handRaised?: boolean;
  audioLevel?: number;
  user?: SeatUser | any;
}

type SeatGridProps = {
  seats?: Seat[];
  onTakeSeat: (index?: number) => void;
  maxSeats?: number;
  columns?: number;
  disabled?: boolean;
  locked?: boolean;
  mySeatId?: string | null;
  style?: ViewStyle;
  emptyLabel?: string;
  showSeatNumbers?: boolean;
};

const ProVoiceIcon = {
  sit: '◇',
  lock: '▰',
  live: '●',
  host: '♛',
  mic: '◉',
  muted: '◌',
  hand: '✧',
  empty: '＋'
} as const;

function normalizeSeats(seats: Seat[], maxSeats: number) {
  const grid: Array<Seat | null> = Array.from({ length: maxSeats }, () => null);
  const used = new Set<number>();

  seats.forEach((seat, fallbackIndex) => {
    const rawIndex = Number((seat as any)?.seatIndex ?? (seat as any)?.position ?? fallbackIndex);
    const preferredIndex = Number.isFinite(rawIndex) && rawIndex >= 0 && rawIndex < maxSeats ? rawIndex : -1;

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

function EmptySeat({
  index,
  locked,
  disabled,
  label,
  showSeatNumbers
}: {
  index: number;
  locked: boolean;
  disabled: boolean;
  label: string;
  showSeatNumbers: boolean;
}) {
  return (
    <View style={[styles.empty, locked && styles.emptyLocked, disabled && styles.emptyDisabled]}>
      <View style={[styles.emptyIconWrap, locked && styles.emptyIconLocked]}>
        <Text style={[styles.emptyIcon, locked && styles.emptyIconTextLocked]}>
          {locked ? ProVoiceIcon.lock : ProVoiceIcon.empty}
        </Text>
      </View>
      <Text style={[styles.emptyText, locked && styles.emptyTextLocked]} numberOfLines={1}>
        {locked ? 'Locked' : label}
      </Text>
      {showSeatNumbers && <Text style={styles.seatNumber}>Seat {index + 1}</Text>}
    </View>
  );
}

const MemoEmptySeat = memo(EmptySeat);

function SeatGrid({
  seats = [],
  onTakeSeat,
  maxSeats = 10,
  columns = 3,
  disabled = false,
  locked = false,
  mySeatId = null,
  style,
  emptyLabel = 'Take Seat',
  showSeatNumbers = false
}: SeatGridProps) {
  const safeMaxSeats = Math.max(1, Math.min(24, Number(maxSeats) || 10));
  const safeColumns = Math.max(2, Math.min(5, Number(columns) || 3));

  const grid = useMemo(() => normalizeSeats(Array.isArray(seats) ? seats : [], safeMaxSeats), [seats, safeMaxSeats]);

  const takenCount = useMemo(() => grid.filter(Boolean).length, [grid]);
  const availableCount = safeMaxSeats - takenCount;

  const handleTakeSeat = useCallback(
    (index: number) => {
      if (disabled || locked) return;
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      onTakeSeat?.(index);
    },
    [disabled, locked, onTakeSeat]
  );

  const cellBasis = `${100 / safeColumns - 2.2}%` as any;

  return (
    <View style={[styles.wrapper, style]}>
      <View style={styles.topBar}>
        <View style={styles.livePill}>
          <Text style={styles.liveDot}>{ProVoiceIcon.live}</Text>
          <Text style={styles.liveText}>Voice Seats</Text>
        </View>
        <View style={styles.capacityPill}>
          <Text style={styles.capacityText}>{takenCount}/{safeMaxSeats}</Text>
          <Text style={styles.capacitySub}>{availableCount > 0 ? `${availableCount} open` : 'full'}</Text>
        </View>
      </View>

      <View style={styles.grid}>
        {grid.map((seat, index) => {
          const isMine = !!seat?.id && seat.id === mySeatId;
          const isEmptyDisabled = disabled || locked || availableCount <= 0;

          return (
            <TouchableOpacity
              key={seat?.id || `empty-seat-${index}`}
              activeOpacity={seat ? 0.88 : isEmptyDisabled ? 1 : 0.72}
              style={[
                styles.cell,
                { width: cellBasis },
                seat?.isSpeaking && styles.speakingCell,
                seat?.handRaised && styles.handCell,
                isMine && styles.myCell
              ]}
              onPress={() => {
                if (!seat) handleTakeSeat(index);
              }}
              disabled={!!seat || isEmptyDisabled}
              accessibilityRole={'button' as AccessibilityRole}
              accessibilityLabel={seat ? `${seat?.user?.username || 'User'} seated` : locked ? 'Seat locked' : 'Take empty voice seat'}
            >
              {seat ? (
                <View style={styles.seatWrap}>
                  {seat.isHost && (
                    <View style={styles.roleBadge}>
                      <Text style={styles.roleBadgeText}>{ProVoiceIcon.host}</Text>
                    </View>
                  )}
                  {seat.handRaised && (
                    <View style={styles.handBadge}>
                      <Text style={styles.handBadgeText}>{ProVoiceIcon.hand}</Text>
                    </View>
                  )}
                  <VoiceSeat seat={seat} />
                  {showSeatNumbers && <Text style={styles.occupiedSeatNumber}>#{index + 1}</Text>}
                </View>
              ) : (
                <MemoEmptySeat
                  index={index}
                  locked={locked}
                  disabled={disabled}
                  label={emptyLabel}
                  showSeatNumbers={showSeatNumbers}
                />
              )}
            </TouchableOpacity>
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
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 10
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.22)',
    shadowColor: '#000',
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2
  },
  liveDot: {
    fontSize: 12,
    color: '#FF3B5F',
    marginRight: 7,
    fontWeight: '900'
  },
  liveText: {
    fontSize: 12,
    fontWeight: '900',
    color: '#151515',
    letterSpacing: 0.35
  },
  capacityPill: {
    alignItems: 'flex-end'
  },
  capacityText: {
    fontSize: 13,
    fontWeight: '900',
    color: theme.colors?.gold || '#D4A857'
  },
  capacitySub: {
    fontSize: 10,
    fontWeight: '700',
    color: '#8A8A8A',
    marginTop: 1,
    textTransform: 'uppercase',
    letterSpacing: 0.4
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    justifyContent: 'space-between'
  },
  cell: {
    aspectRatio: 0.92,
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: 'rgba(255,255,255,0.78)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.055)',
    shadowColor: '#000',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 3
  },
  speakingCell: {
    borderColor: theme.colors?.neonCyan || '#00E0FF',
    shadowColor: theme.colors?.neonCyan || '#00E0FF',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 6
  },
  handCell: {
    borderColor: '#B982FF',
    shadowColor: '#B982FF',
    shadowOpacity: 0.18
  },
  myCell: {
    borderColor: theme.colors?.gold || '#D4A857',
    borderWidth: 1.5
  },
  seatWrap: {
    flex: 1,
    position: 'relative',
    borderRadius: 22,
    overflow: 'hidden',
    backgroundColor: '#FFFFFF'
  },
  roleBadge: {
    position: 'absolute',
    top: 8,
    left: 8,
    zIndex: 10,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#161616',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.8)'
  },
  roleBadgeText: {
    color: theme.colors?.gold || '#D4A857',
    fontSize: 13,
    fontWeight: '900'
  },
  handBadge: {
    position: 'absolute',
    top: 8,
    right: 8,
    zIndex: 10,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#F4E9FF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#D7B6FF'
  },
  handBadgeText: {
    color: '#8A35FF',
    fontSize: 13,
    fontWeight: '900'
  },
  occupiedSeatNumber: {
    position: 'absolute',
    bottom: 7,
    right: 9,
    fontSize: 9,
    fontWeight: '900',
    color: 'rgba(0,0,0,0.35)'
  },
  empty: {
    flex: 1,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(250,250,250,0.94)',
    borderWidth: 1.4,
    borderColor: 'rgba(212,168,87,0.28)',
    borderStyle: 'dashed',
    padding: 8
  },
  emptyLocked: {
    backgroundColor: 'rgba(245,245,245,0.92)',
    borderColor: 'rgba(0,0,0,0.1)'
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
  emptyIconLocked: {
    backgroundColor: 'rgba(0,0,0,0.05)',
    borderColor: 'rgba(0,0,0,0.12)'
  },
  emptyIcon: {
    fontSize: 22,
    color: theme.colors?.gold || '#D4A857',
    fontWeight: '900',
    marginTop: Platform.OS === 'ios' ? -1 : 0
  },
  emptyIconTextLocked: {
    color: '#777',
    fontSize: 17
  },
  emptyText: {
    color: '#6F5A2A',
    fontWeight: '900',
    fontSize: 12,
    letterSpacing: 0.25,
    textTransform: 'uppercase'
  },
  emptyTextLocked: {
    color: '#777'
  },
  seatNumber: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '700',
    color: '#A5A5A5'
  }
});
