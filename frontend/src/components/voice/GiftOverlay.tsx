import React, { memo, useEffect, useMemo, useRef } from 'react';
import {
  View,
  Text,
  Animated,
  StyleSheet,
  Dimensions,
  Easing,
  Platform,
  AccessibilityInfo
} from 'react-native';
import Svg, {
  Path,
  Circle,
  Defs,
  LinearGradient,
  Stop,
  Rect,
  G,
  Ellipse
} from 'react-native-svg';
import { theme } from '../../theme';

const { width, height } = Dimensions.get('window');

type GiftTier = 'basic' | 'premium' | 'legendary' | 'mythic';

type GiftOverlayPayload = {
  from: string;
  to: string;
  giftId: string;
  amount: number;
  fromName?: string;
  toName?: string;
  quantity?: number;
  tier?: GiftTier;
  message?: string;
};

type GiftOverlayProps = {
  gift: GiftOverlayPayload;
  durationMs?: number;
  onFinish?: () => void;
  compact?: boolean;
};

type GiftMeta = {
  id: string;
  name: string;
  tier: GiftTier;
  accent: string;
  glow: string;
  valueLabel: string;
  Icon: React.ComponentType<{ size?: number; color?: string; glow?: string }>;
};

const gold = theme.colors?.premiumGold || theme.colors?.gold || '#D4A857';
const cyan = theme.colors?.neonCyan || theme.colors?.neon || '#00E0FF';

function RoseIcon({ size = 72, color = '#FF3B6A', glow = '#FFD0DC' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="overlayRoseA" x1="12" y1="8" x2="52" y2="52">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.52" stopColor={color} />
          <Stop offset="1" stopColor="#9E123C" />
        </LinearGradient>
        <LinearGradient id="overlayRoseB" x1="22" y1="34" x2="46" y2="60">
          <Stop offset="0" stopColor="#46D36B" />
          <Stop offset="1" stopColor="#087C3A" />
        </LinearGradient>
      </Defs>
      <Path d="M31 33c-8-1-15-6-15-14 0-7 6-12 13-9 2-6 12-7 16-1 7 1 10 9 6 15-3 6-10 9-20 9Z" fill="url(#overlayRoseA)" />
      <Path d="M31 33c-2-9 3-18 14-24-4 9-5 17-14 24Z" fill="#FF8AAA" opacity="0.72" />
      <Path d="M31 33c-8-3-11-9-9-18 4 7 9 10 17 9-2 4-4 7-8 9Z" fill="#E91E63" opacity="0.9" />
      <Path d="M31 32c4-5 10-7 18-6-5 5-11 8-18 6Z" fill="#C2185B" opacity="0.86" />
      <Path d="M31 31c-1 10-2 19-6 27" stroke="#138A45" strokeWidth="5" strokeLinecap="round" />
      <Path d="M27 48c-7-7-15-5-19 2 8 4 15 3 19-2Z" fill="url(#overlayRoseB)" />
      <Path d="M30 45c8-5 16-2 19 6-8 2-15 1-19-6Z" fill="url(#overlayRoseB)" />
    </Svg>
  );
}

function StarIcon({ size = 72, color = '#FFC83D', glow = '#FFF2A8' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="overlayStarA" x1="10" y1="6" x2="54" y2="58">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.5" stopColor={color} />
          <Stop offset="1" stopColor="#E07A00" />
        </LinearGradient>
      </Defs>
      <Path d="M32 5l7.7 16 17.6 2.4-12.8 12.3 3.2 17.5L32 44.7 16.3 53.2l3.2-17.5L6.7 23.4l17.6-2.4L32 5Z" fill="url(#overlayStarA)" />
      <Path d="M32 13l4.6 10 10.8 1.5-7.9 7.5 2 10.8-9.5-5.2-9.5 5.2 2-10.8-7.9-7.5 10.8-1.5L32 13Z" fill="#FFF8CF" opacity="0.45" />
      <Circle cx="32" cy="32" r="5" fill="#FFFFFF" opacity="0.55" />
    </Svg>
  );
}

function CrownIcon({ size = 72, color = '#D4A857', glow = '#FFF1B8' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="overlayCrownA" x1="8" y1="10" x2="56" y2="54">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.55" stopColor={color} />
          <Stop offset="1" stopColor="#8B5A13" />
        </LinearGradient>
      </Defs>
      <Path d="M10 22l12 12 10-20 10 20 12-12-5 28H15L10 22Z" fill="url(#overlayCrownA)" />
      <Circle cx="10" cy="21" r="5" fill="#FFEAA0" />
      <Circle cx="32" cy="13" r="5" fill="#FFF3B8" />
      <Circle cx="54" cy="21" r="5" fill="#FFEAA0" />
      <Rect x="15" y="47" width="34" height="8" rx="4" fill="#7A4A10" opacity="0.72" />
      <Path d="M23 42h18" stroke="#FFF4B8" strokeWidth="3" strokeLinecap="round" opacity="0.7" />
    </Svg>
  );
}

function RocketIcon({ size = 72, color = '#7C5CFF', glow = '#DCD5FF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="overlayRocketA" x1="17" y1="8" x2="50" y2="50">
          <Stop offset="0" stopColor="#FFFFFF" />
          <Stop offset="0.5" stopColor={glow} />
          <Stop offset="1" stopColor={color} />
        </LinearGradient>
        <LinearGradient id="overlayRocketB" x1="18" y1="42" x2="36" y2="62">
          <Stop offset="0" stopColor="#FFD15C" />
          <Stop offset="0.5" stopColor="#FF6B2C" />
          <Stop offset="1" stopColor="#D71920" />
        </LinearGradient>
      </Defs>
      <Path d="M42 6c-12 3-22 14-25 28l13 13c14-3 25-13 28-25 2-8-8-18-16-16Z" fill="url(#overlayRocketA)" />
      <Circle cx="41" cy="23" r="7" fill="#00D9FF" opacity="0.9" />
      <Circle cx="41" cy="23" r="3" fill="#FFFFFF" opacity="0.75" />
      <Path d="M19 34l-9 5 2-12 8-4" fill="#5C45D9" />
      <Path d="M30 45l-5 9 12-2 4-8" fill="#4C35C9" />
      <Path d="M22 45c-6 3-10 8-12 15 7-2 12-6 15-12l-3-3Z" fill="url(#overlayRocketB)" />
      <Path d="M47 12c3 2 5 4 6 7" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
    </Svg>
  );
}

function DiamondIcon({ size = 72, color = '#00E0FF', glow = '#D9FBFF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="overlayDiamondA" x1="10" y1="8" x2="54" y2="58">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.55" stopColor={color} />
          <Stop offset="1" stopColor="#1E4DFF" />
        </LinearGradient>
      </Defs>
      <Path d="M18 10h28l12 16-26 30L6 26l12-16Z" fill="url(#overlayDiamondA)" />
      <Path d="M18 10l14 46L46 10" fill="none" stroke="#FFFFFF" strokeWidth="2" opacity="0.45" />
      <Path d="M6 26h52" stroke="#FFFFFF" strokeWidth="2" opacity="0.5" />
      <Path d="M18 10l-4 16 18 30 18-30-4-16" fill="none" stroke="#003E73" strokeWidth="2" opacity="0.22" />
    </Svg>
  );
}

function PhoenixIcon({ size = 72, color = '#FF6B2C', glow = '#FFE1A6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="overlayPhoenixA" x1="8" y1="6" x2="56" y2="58">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.45" stopColor={color} />
          <Stop offset="1" stopColor="#B5122A" />
        </LinearGradient>
      </Defs>
      <Path d="M32 8c6 10 18 12 25 7-3 14-13 22-25 23C20 37 10 29 7 15c7 5 19 3 25-7Z" fill="url(#overlayPhoenixA)" />
      <Path d="M32 20c5 9 12 15 22 19-12 2-19 0-22-7-3 7-10 9-22 7 10-4 17-10 22-19Z" fill="#FFD15C" opacity="0.82" />
      <Path d="M32 32c4 8 8 14 16 22-8-1-13-5-16-12-3 7-8 11-16 12 8-8 12-14 16-22Z" fill="#FF3B3B" opacity="0.78" />
      <Circle cx="32" cy="22" r="4" fill="#FFF7D6" />
    </Svg>
  );
}

function CoinIcon({ size = 18 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Defs>
        <LinearGradient id="overlayCoinA" x1="4" y1="2" x2="28" y2="30">
          <Stop offset="0" stopColor="#FFF5B8" />
          <Stop offset="0.55" stopColor={gold} />
          <Stop offset="1" stopColor="#8B5A13" />
        </LinearGradient>
      </Defs>
      <Circle cx="16" cy="16" r="13" fill="url(#overlayCoinA)" />
      <Circle cx="16" cy="16" r="8" fill="none" stroke="#FFFFFF" strokeWidth="2" opacity="0.45" />
      <Path d="M16 9v14M11 14h10" stroke="#5C390A" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
}

function ArrowIcon({ size = 28, color = '#FFFFFF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 40 40">
      <Circle cx="20" cy="20" r="18" fill="rgba(255,255,255,0.12)" />
      <Path d="M12 20h14M21 14l6 6-6 6" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function Spark({ size = 18, color = '#FFFFFF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path d="M16 2l3.4 10.6L30 16l-10.6 3.4L16 30l-3.4-10.6L2 16l10.6-3.4L16 2Z" fill={color} />
      <Circle cx="16" cy="16" r="3" fill="#FFFFFF" opacity="0.55" />
    </Svg>
  );
}

const GIFT_META: Record<string, GiftMeta> = {
  rose: { id: 'rose', name: 'Rose', tier: 'basic', accent: '#FF3B6A', glow: '#FFE1EA', valueLabel: 'Sweet Gift', Icon: RoseIcon },
  star: { id: 'star', name: 'Star', tier: 'basic', accent: '#FFC83D', glow: '#FFF4B8', valueLabel: 'Bright Gift', Icon: StarIcon },
  crown: { id: 'crown', name: 'Crown', tier: 'premium', accent: gold, glow: '#FFF1B8', valueLabel: 'Royal Gift', Icon: CrownIcon },
  rocket: { id: 'rocket', name: 'Rocket', tier: 'premium', accent: '#7C5CFF', glow: '#E6E0FF', valueLabel: 'Boost Gift', Icon: RocketIcon },
  diamond: { id: 'diamond', name: 'Diamond', tier: 'legendary', accent: cyan, glow: '#D9FBFF', valueLabel: 'Legend Gift', Icon: DiamondIcon },
  phoenix: { id: 'phoenix', name: 'Phoenix', tier: 'mythic', accent: '#FF6B2C', glow: '#FFE1A6', valueLabel: 'Mythic Gift', Icon: PhoenixIcon }
};

function getGiftMeta(giftId: string, tier?: GiftTier) {
  return GIFT_META[giftId] || {
    id: giftId || 'gift',
    name: giftId ? giftId.replace(/[_-]/g, ' ').replace(/\b\w/g, s => s.toUpperCase()) : 'Gift',
    tier: tier || 'basic',
    accent: gold,
    glow: '#FFF1B8',
    valueLabel: 'Special Gift',
    Icon: StarIcon
  };
}

function tierText(tier: GiftTier) {
  if (tier === 'mythic') return 'MYTHIC DROP';
  if (tier === 'legendary') return 'LEGENDARY';
  if (tier === 'premium') return 'PREMIUM';
  return 'GIFT SENT';
}

function tierGradient(tier: GiftTier) {
  if (tier === 'mythic') return ['#FF6B2C', '#D7195A'];
  if (tier === 'legendary') return ['#00E0FF', '#345BFF'];
  if (tier === 'premium') return [gold, '#8B5A13'];
  return ['#FF3B6A', '#B5124B'];
}

function safeName(value?: string) {
  if (!value) return 'User';
  return String(value).replace(/^@+/, '').trim() || 'User';
}

function FloatingSpark({
  index,
  accent,
  delay
}: {
  index: number;
  accent: string;
  delay: number;
}) {
  const progress = useRef(new Animated.Value(0)).current;
  const x = useMemo(() => {
    const positions = [-0.42, -0.3, -0.18, 0.18, 0.3, 0.42, -0.08, 0.08];
    return width * (positions[index % positions.length] || 0.2);
  }, [index]);

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(progress, {
          toValue: 1,
          duration: 1500 + index * 90,
          easing: Easing.out(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(progress, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true
        })
      ])
    ).start();
  }, [delay, index, progress]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.spark,
        {
          opacity: progress.interpolate({ inputRange: [0, 0.2, 0.8, 1], outputRange: [0, 1, 0.75, 0] }),
          transform: [
            { translateX: x },
            { translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [80, -height * 0.32] }) },
            { scale: progress.interpolate({ inputRange: [0, 0.45, 1], outputRange: [0.6, 1.25, 0.75] }) },
            { rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '220deg'] }) }
          ]
        }
      ]}
    >
      <Spark size={14 + (index % 3) * 4} color={index % 2 ? accent : '#FFFFFF'} />
    </Animated.View>
  );
}

function GiftOverlay({ gift, durationMs = 2600, onFinish, compact = false }: GiftOverlayProps) {
  const opacity = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(0.74)).current;
  const iconScale = useRef(new Animated.Value(0.4)).current;
  const translateY = useRef(new Animated.Value(42)).current;
  const glowScale = useRef(new Animated.Value(0.65)).current;
  const ring = useRef(new Animated.Value(0)).current;
  const slide = useRef(new Animated.Value(24)).current;
  const shimmer = useRef(new Animated.Value(0)).current;

  const meta = useMemo(() => getGiftMeta(gift.giftId, gift.tier), [gift.giftId, gift.tier]);
  const gradient = useMemo(() => tierGradient(meta.tier), [meta.tier]);
  const Icon = meta.Icon;
  const from = safeName(gift.fromName || gift.from);
  const to = safeName(gift.toName || gift.to);
  const quantity = Math.max(1, Number(gift.quantity || 1));
  const amount = Math.max(0, Number(gift.amount || 0));

  useEffect(() => {
    AccessibilityInfo.announceForAccessibility?.(`${from} sent ${meta.name} to ${to}`);
    Animated.parallel([
      Animated.timing(opacity, {
        toValue: 1,
        duration: 180,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true
      }),
      Animated.spring(cardScale, {
        toValue: 1,
        speed: 18,
        bounciness: 8,
        useNativeDriver: true
      }),
      Animated.spring(iconScale, {
        toValue: 1,
        speed: 16,
        bounciness: 14,
        useNativeDriver: true
      }),
      Animated.spring(translateY, {
        toValue: 0,
        speed: 18,
        bounciness: 7,
        useNativeDriver: true
      }),
      Animated.timing(glowScale, {
        toValue: 1,
        duration: 520,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      }),
      Animated.timing(slide, {
        toValue: 0,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true
      })
    ]).start();

    Animated.loop(
      Animated.timing(ring, {
        toValue: 1,
        duration: 1400,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true
      })
    ).start();

    Animated.loop(
      Animated.timing(shimmer, {
        toValue: 1,
        duration: 1200,
        easing: Easing.linear,
        useNativeDriver: true
      })
    ).start();

    const timer = setTimeout(() => {
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 360,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(cardScale, {
          toValue: 0.92,
          duration: 360,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        }),
        Animated.timing(translateY, {
          toValue: -28,
          duration: 360,
          easing: Easing.in(Easing.quad),
          useNativeDriver: true
        })
      ]).start(({ finished }) => {
        if (finished) onFinish?.();
      });
    }, durationMs);

    return () => clearTimeout(timer);
  }, [amount, cardScale, durationMs, from, gift.giftId, glowScale, iconScale, meta.name, onFinish, opacity, ring, shimmer, slide, to, translateY]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.overlay,
        {
          opacity
        }
      ]}
      accessibilityElementsHidden={false}
      importantForAccessibility="yes"
    >
      <View style={styles.backdrop} />
      {Array.from({ length: meta.tier === 'mythic' ? 14 : meta.tier === 'legendary' ? 11 : 8 }).map((_, index) => (
        <FloatingSpark key={`spark-${index}`} index={index} accent={meta.accent} delay={index * 90} />
      ))}
      <Animated.View
        style={[
          styles.glow,
          {
            backgroundColor: meta.accent,
            transform: [{ scale: glowScale }]
          }
        ]}
      />
      <Animated.View
        style={[
          styles.card,
          compact && styles.cardCompact,
          {
            transform: [{ scale: cardScale }, { translateY }]
          }
        ]}
      >
        <View style={[styles.topStrip, { backgroundColor: gradient[0] }]} />
        <Animated.View
          style={[
            styles.shimmer,
            {
              transform: [
                {
                  translateX: shimmer.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-width * 0.6, width * 0.6]
                  })
                },
                { rotate: '-18deg' }
              ]
            }
          ]}
        />
        <View style={styles.tierRow}>
          <View style={[styles.tierPill, { backgroundColor: gradient[0] }]}>
            <Text style={styles.tierText}>{tierText(meta.tier)}</Text>
          </View>
          <View style={styles.valuePill}>
            <CoinIcon size={15} />
            <Text style={styles.valueText}>{amount.toLocaleString()}c</Text>
          </View>
        </View>
        <View style={styles.iconStage}>
          <Animated.View
            style={[
              styles.ring,
              {
                borderColor: meta.accent,
                opacity: ring.interpolate({ inputRange: [0, 0.75, 1], outputRange: [0.4, 0.08, 0] }),
                transform: [{ scale: ring.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1.75] }) }]
              }
            ]}
          />
          <Animated.View
            style={[
              styles.iconOrb,
              {
                backgroundColor: meta.glow,
                borderColor: meta.accent,
                transform: [{ scale: iconScale }]
              }
            ]}
          >
            <Icon size={compact ? 68 : 86} color={meta.accent} glow={meta.glow} />
          </Animated.View>
          {quantity > 1 && (
            <View style={[styles.quantityBadge, { backgroundColor: meta.accent }]}>
              <Text style={styles.quantityText}>×{quantity}</Text>
            </View>
          )}
        </View>
        <Animated.View style={[styles.names, { transform: [{ translateY: slide }] }]}>
          <View style={styles.userBlock}>
            <Text style={styles.userLabel}>FROM</Text>
            <Text style={[styles.userName, { color: cyan }]} numberOfLines={1}>@{from}</Text>
          </View>
          <View style={styles.arrowWrap}>
            <ArrowIcon size={30} />
          </View>
          <View style={styles.userBlock}>
            <Text style={styles.userLabel}>TO</Text>
            <Text style={[styles.userName, { color: gold }]} numberOfLines={1}>@{to}</Text>
          </View>
        </Animated.View>
        <Text style={styles.giftName} numberOfLines={1}>{meta.name}</Text>
        <Text style={styles.giftSubtitle} numberOfLines={1}>{gift.message || meta.valueLabel}</Text>
      </Animated.View>
    </Animated.View>
  );
}

export default memo(GiftOverlay);

export {
  RoseIcon,
  StarIcon,
  CrownIcon,
  RocketIcon,
  DiamondIcon,
  PhoenixIcon,
  CoinIcon,
  Spark,
  GIFT_META
};

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 999,
    justifyContent: 'center',
    alignItems: 'center'
  },
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(5,6,12,0.62)'
  },
  glow: {
    position: 'absolute',
    width: width * 0.82,
    height: width * 0.82,
    borderRadius: width,
    opacity: 0.18
  },
  spark: {
    position: 'absolute',
    top: height * 0.54,
    left: width / 2,
    zIndex: 2
  },
  card: {
    width: Math.min(width - 34, 370),
    minHeight: 360,
    borderRadius: 34,
    paddingHorizontal: 22,
    paddingTop: 18,
    paddingBottom: 22,
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.58)',
    alignItems: 'center',
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 18 },
    elevation: 12
  },
  cardCompact: {
    minHeight: 310,
    paddingHorizontal: 18,
    paddingBottom: 18
  },
  topStrip: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 6,
    opacity: 0.9
  },
  shimmer: {
    position: 'absolute',
    top: -40,
    width: 70,
    height: 480,
    backgroundColor: 'rgba(255,255,255,0.34)'
  },
  tierRow: {
    width: '100%',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  tierPill: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3
  },
  tierText: {
    color: '#FFFFFF',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 0.9
  },
  valuePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.06)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.06)'
  },
  valueText: {
    marginLeft: 5,
    color: '#171717',
    fontSize: 12,
    fontWeight: '900'
  },
  iconStage: {
    width: 150,
    height: 150,
    marginTop: 24,
    justifyContent: 'center',
    alignItems: 'center'
  },
  ring: {
    position: 'absolute',
    width: 126,
    height: 126,
    borderRadius: 63,
    borderWidth: 3
  },
  iconOrb: {
    width: 126,
    height: 126,
    borderRadius: 63,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.4,
    shadowColor: '#000',
    shadowOpacity: 0.14,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6
  },
  quantityBadge: {
    position: 'absolute',
    right: 8,
    bottom: 16,
    minWidth: 42,
    height: 30,
    paddingHorizontal: 8,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#FFFFFF'
  },
  quantityText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 13
  },
  names: {
    width: '100%',
    marginTop: 18,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  userBlock: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 6,
    alignItems: 'center'
  },
  userLabel: {
    fontSize: 9,
    fontWeight: '900',
    color: '#9B9B9B',
    letterSpacing: 1
  },
  userName: {
    marginTop: 3,
    fontSize: 16,
    fontWeight: '900',
    maxWidth: '100%'
  },
  arrowWrap: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#171717',
    shadowColor: '#000',
    shadowOpacity: 0.16,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
    elevation: 4
  },
  giftName: {
    marginTop: 22,
    fontSize: 28,
    fontWeight: '900',
    color: '#111111',
    letterSpacing: 0.2
  },
  giftSubtitle: {
    marginTop: 5,
    fontSize: 12,
    fontWeight: '800',
    color: '#8B8B8B',
    letterSpacing: 0.4,
    textTransform: 'uppercase'
  }
});
