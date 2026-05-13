import React, { memo, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  Animated,
  Easing,
  Pressable,
  Platform,
  ViewStyle,
  ImageStyle
} from 'react-native';
import { theme } from '../../theme';

type SeatUser = {
  id?: string;
  username?: string;
  fullName?: string;
  displayName?: string;
  avatarUrl?: string;
  isVerified?: boolean;
  level?: string;
  badges?: Array<{ id?: string; name?: string; iconUrl?: string }>;
};

export interface VoiceSeatData {
  id?: string;
  userId: string;
  isHost?: boolean;
  isCoHost?: boolean;
  isModerator?: boolean;
  isMuted?: boolean;
  isSpeaking?: boolean;
  handRaised?: boolean;
  isOnline?: boolean;
  audioLevel?: number;
  seatIndex?: number;
  position?: number;
  user?: SeatUser | any;
}

type VoiceSeatProps = {
  seat: VoiceSeatData;
  isMine?: boolean;
  compact?: boolean;
  showRole?: boolean;
  showLevel?: boolean;
  showAudioMeter?: boolean;
  onPress?: (seat: VoiceSeatData) => void;
  onLongPress?: (seat: VoiceSeatData) => void;
  style?: ViewStyle;
};

const VoiceSeatIcon = {
  host: '♛',
  cohost: '◆',
  mod: '✦',
  verified: '✓',
  muted: '◌',
  mic: '◉',
  speaking: '◍',
  hand: '✧',
  online: '●',
  offline: '○',
  level: '◇',
  shield: '⬡'
} as const;

const FALLBACK_AVATAR =
  'https://ui-avatars.com/api/?name=Voice&background=111111&color=D4A857&bold=true&size=256';

function getDisplayName(user: any) {
  return user?.displayName || user?.fullName || user?.username || 'Guest';
}

function getUsername(user: any) {
  const username = user?.username || user?.displayName || user?.fullName || 'guest';
  return String(username).replace(/^@/, '');
}

function getRole(seat: VoiceSeatData) {
  if (seat.isHost) return { label: 'HOST', icon: VoiceSeatIcon.host, style: 'host' as const };
  if (seat.isCoHost) return { label: 'CO-HOST', icon: VoiceSeatIcon.cohost, style: 'cohost' as const };
  if (seat.isModerator) return { label: 'MOD', icon: VoiceSeatIcon.mod, style: 'mod' as const };
  return null;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function VoiceSeat({
  seat,
  isMine = false,
  compact = false,
  showRole = true,
  showLevel = true,
  showAudioMeter = true,
  onPress,
  onLongPress,
  style
}: VoiceSeatProps) {
  const pulse = useRef(new Animated.Value(0)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const meter = useRef(new Animated.Value(0)).current;
  const mounted = useRef(true);

  const user = seat?.user || {};
  const role = useMemo(() => getRole(seat), [seat?.isHost, seat?.isCoHost, seat?.isModerator]);
  const displayName = useMemo(() => getDisplayName(user), [user]);
  const username = useMemo(() => getUsername(user), [user]);
  const isSpeaking = !!seat?.isSpeaking && !seat?.isMuted;
  const audioLevel = clamp(Number(seat?.audioLevel || 0), 0, 1);
  const avatarSize = compact ? 44 : 54;
  const avatarUri = user?.avatarUrl || FALLBACK_AVATAR;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pulse.stopAnimation();
      ring.stopAnimation();
      meter.stopAnimation();
    };
  }, [pulse, ring, meter]);

  useEffect(() => {
    pulse.stopAnimation();
    ring.stopAnimation();

    if (isSpeaking) {
      Animated.loop(
        Animated.parallel([
          Animated.sequence([
            Animated.timing(pulse, {
              toValue: 1,
              duration: 520,
              easing: Easing.out(Easing.quad),
              useNativeDriver: true
            }),
            Animated.timing(pulse, {
              toValue: 0,
              duration: 520,
              easing: Easing.in(Easing.quad),
              useNativeDriver: true
            })
          ]),
          Animated.sequence([
            Animated.timing(ring, {
              toValue: 1,
              duration: 760,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true
            }),
            Animated.timing(ring, {
              toValue: 0,
              duration: 0,
              useNativeDriver: true
            })
          ])
        ])
      ).start();
    } else {
      Animated.parallel([
        Animated.timing(pulse, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true
        }),
        Animated.timing(ring, {
          toValue: 0,
          duration: 180,
          useNativeDriver: true
        })
      ]).start();
    }
  }, [isSpeaking, pulse, ring]);

  useEffect(() => {
    Animated.timing(meter, {
      toValue: isSpeaking ? Math.max(audioLevel, 0.18) : 0,
      duration: 160,
      easing: Easing.out(Easing.quad),
      useNativeDriver: false
    }).start();
  }, [audioLevel, isSpeaking, meter]);

  const pulseScale = pulse.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.06]
  });

  const ringScale = ring.interpolate({
    inputRange: [0, 1],
    outputRange: [1, 1.38]
  });

  const ringOpacity = ring.interpolate({
    inputRange: [0, 0.7, 1],
    outputRange: [0.28, 0.14, 0]
  });

  const meterWidth = meter.interpolate({
    inputRange: [0, 1],
    outputRange: ['8%', '100%']
  });

  const roleStyle =
    role?.style === 'host'
      ? styles.roleHost
      : role?.style === 'cohost'
        ? styles.roleCoHost
        : styles.roleMod;

  return (
    <Pressable
      onPress={() => onPress?.(seat)}
      onLongPress={() => onLongPress?.(seat)}
      disabled={!onPress && !onLongPress}
      style={({ pressed }) => [
        styles.card,
        compact && styles.compactCard,
        isMine && styles.myCard,
        seat?.isHost && styles.hostCard,
        isSpeaking && styles.speakingCard,
        pressed && styles.pressed,
        style
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${displayName}, ${role?.label || 'speaker'}${seat?.isMuted ? ', muted' : ''}${isSpeaking ? ', speaking' : ''}`}
    >
      {isSpeaking && (
        <Animated.View
          pointerEvents="none"
          style={[
            styles.speakingAura,
            {
              opacity: ringOpacity,
              transform: [{ scale: ringScale }]
            }
          ]}
        />
      )}

      <View style={styles.topRow}>
        {showRole && role ? (
          <View style={[styles.roleBadge, roleStyle]}>
            <Text style={styles.roleIcon}>{role.icon}</Text>
            {!compact && <Text style={styles.roleText}>{role.label}</Text>}
          </View>
        ) : (
          <View style={styles.statusPill}>
            <Text style={[styles.onlineDot, seat?.isOnline === false && styles.offlineDot]}>
              {seat?.isOnline === false ? VoiceSeatIcon.offline : VoiceSeatIcon.online}
            </Text>
          </View>
        )}

        {seat?.handRaised && (
          <View style={styles.handBadge}>
            <Text style={styles.handText}>{VoiceSeatIcon.hand}</Text>
          </View>
        )}
      </View>

      <View style={styles.avatarZone}>
        {isSpeaking && (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.avatarPulse,
              {
                width: avatarSize + 18,
                height: avatarSize + 18,
                borderRadius: (avatarSize + 18) / 2,
                transform: [{ scale: pulseScale }]
              }
            ]}
          />
        )}

        <Image
          source={{ uri: avatarUri }}
          style={[
            styles.avatar,
            {
              width: avatarSize,
              height: avatarSize,
              borderRadius: avatarSize / 2
            } as ImageStyle,
            isSpeaking && styles.speakingAvatar,
            seat?.isMuted && styles.mutedAvatar
          ]}
        />

        <View style={[styles.micBadge, seat?.isMuted ? styles.micMuted : styles.micActive]}>
          <Text style={[styles.micText, seat?.isMuted && styles.micMutedText]}>
            {seat?.isMuted ? VoiceSeatIcon.muted : VoiceSeatIcon.mic}
          </Text>
        </View>

        {user?.isVerified && (
          <View style={styles.verifiedBadge}>
            <Text style={styles.verifiedText}>{VoiceSeatIcon.verified}</Text>
          </View>
        )}
      </View>

      <View style={styles.identity}>
        <Text style={styles.name} numberOfLines={1}>
          {displayName}
        </Text>
        <Text style={styles.username} numberOfLines={1}>
          @{username}
        </Text>
      </View>

      {showLevel && !!user?.level && (
        <View style={styles.levelPill}>
          <Text style={styles.levelIcon}>{VoiceSeatIcon.level}</Text>
          <Text style={styles.levelText} numberOfLines={1}>
            {String(user.level)}
          </Text>
        </View>
      )}

      {showAudioMeter && (
        <View style={styles.audioTrack}>
          <Animated.View style={[styles.audioFill, { width: meterWidth }]} />
        </View>
      )}
    </Pressable>
  );
}

export default memo(VoiceSeat);

export { VoiceSeatIcon };

const styles = StyleSheet.create({
  card: {
    flex: 1,
    minHeight: 116,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)',
    paddingHorizontal: 8,
    paddingVertical: 10,
    position: 'relative',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.08,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4
  },
  compactCard: {
    minHeight: 104,
    paddingVertical: 8
  },
  pressed: {
    opacity: 0.88,
    transform: [{ scale: 0.985 }]
  },
  hostCard: {
    borderColor: theme.colors?.premiumGold || theme.colors?.gold || '#D4A857',
    borderWidth: 1.6
  },
  myCard: {
    borderColor: theme.colors?.neonCyan || '#00E0FF',
    borderWidth: 1.6
  },
  speakingCard: {
    shadowColor: theme.colors?.neonCyan || '#00E0FF',
    shadowOpacity: 0.22,
    shadowRadius: 18,
    elevation: 8
  },
  speakingAura: {
    position: 'absolute',
    width: '88%',
    height: '88%',
    borderRadius: 999,
    backgroundColor: theme.colors?.neonCyan || '#00E0FF'
  },
  topRow: {
    position: 'absolute',
    top: 7,
    left: 7,
    right: 7,
    zIndex: 6,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  roleBadge: {
    minHeight: 22,
    borderRadius: 999,
    paddingHorizontal: 7,
    paddingVertical: 3,
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1
  },
  roleHost: {
    backgroundColor: '#17120A',
    borderColor: 'rgba(212,168,87,0.72)'
  },
  roleCoHost: {
    backgroundColor: '#101827',
    borderColor: 'rgba(93,188,255,0.52)'
  },
  roleMod: {
    backgroundColor: '#181124',
    borderColor: 'rgba(185,130,255,0.52)'
  },
  roleIcon: {
    color: theme.colors?.premiumGold || theme.colors?.gold || '#D4A857',
    fontSize: 11,
    fontWeight: '900',
    marginRight: 4
  },
  roleText: {
    color: '#FFFFFF',
    fontSize: 7.5,
    fontWeight: '900',
    letterSpacing: 0.55
  },
  statusPill: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.86)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)'
  },
  onlineDot: {
    color: '#23C55E',
    fontSize: 10,
    fontWeight: '900'
  },
  offlineDot: {
    color: '#A0A0A0'
  },
  handBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#F4E9FF',
    borderWidth: 1,
    borderColor: '#D8BAFF'
  },
  handText: {
    color: '#8B35FF',
    fontSize: 13,
    fontWeight: '900'
  },
  avatarZone: {
    marginTop: 12,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  avatarPulse: {
    position: 'absolute',
    backgroundColor: 'rgba(0,224,255,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(0,224,255,0.42)'
  },
  avatar: {
    backgroundColor: '#EFEFEF',
    borderWidth: 2,
    borderColor: '#FFFFFF',
    zIndex: 2
  },
  speakingAvatar: {
    borderColor: theme.colors?.neonCyan || '#00E0FF'
  },
  mutedAvatar: {
    opacity: 0.58
  },
  micBadge: {
    position: 'absolute',
    right: -4,
    bottom: -2,
    width: 23,
    height: 23,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    borderWidth: 2,
    borderColor: '#FFFFFF'
  },
  micActive: {
    backgroundColor: '#EFFFFB'
  },
  micMuted: {
    backgroundColor: '#191919'
  },
  micText: {
    color: '#00A985',
    fontSize: 12,
    fontWeight: '900',
    marginTop: Platform.OS === 'ios' ? -1 : 0
  },
  micMutedText: {
    color: '#FFFFFF'
  },
  verifiedBadge: {
    position: 'absolute',
    left: -4,
    bottom: -2,
    width: 21,
    height: 21,
    borderRadius: 11,
    backgroundColor: theme.colors?.neonCyan || '#00E0FF',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
    borderWidth: 2,
    borderColor: '#FFFFFF'
  },
  verifiedText: {
    color: '#071012',
    fontSize: 11,
    fontWeight: '900'
  },
  identity: {
    width: '100%',
    alignItems: 'center',
    marginTop: 7,
    paddingHorizontal: 2
  },
  name: {
    maxWidth: '100%',
    color: '#171717',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 0.1
  },
  username: {
    maxWidth: '100%',
    color: '#8A8A8A',
    fontSize: 10,
    fontWeight: '700',
    marginTop: 1
  },
  levelPill: {
    marginTop: 5,
    maxWidth: '92%',
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: 'rgba(212,168,87,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.22)',
    flexDirection: 'row',
    alignItems: 'center'
  },
  levelIcon: {
    color: theme.colors?.gold || '#D4A857',
    fontSize: 9,
    fontWeight: '900',
    marginRight: 3
  },
  levelText: {
    color: '#6E5522',
    fontSize: 8.5,
    fontWeight: '900',
    letterSpacing: 0.25,
    textTransform: 'uppercase'
  },
  audioTrack: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 7,
    height: 3,
    borderRadius: 999,
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.055)'
  },
  audioFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: theme.colors?.neonCyan || '#00E0FF'
  }
});
