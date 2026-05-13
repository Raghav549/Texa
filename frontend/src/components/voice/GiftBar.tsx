import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Animated,
  Easing,
  Pressable,
  LayoutAnimation,
  Platform,
  UIManager,
  ViewStyle,
  TextStyle,
  AccessibilityRole
} from 'react-native';
import Svg, {
  Path,
  Circle,
  G,
  Defs,
  LinearGradient,
  Stop,
  Rect,
  Polygon,
  Ellipse
} from 'react-native-svg';
import { theme } from '../../theme';

if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

type GiftTier = 'basic' | 'premium' | 'legendary' | 'mythic';

type Gift = {
  id: string;
  name: string;
  price: number;
  tier: GiftTier;
  accent: string;
  glow: string;
  Icon: React.ComponentType<{ size?: number; color?: string; glow?: string }>;
};

type GiftBarProps = {
  onSend: (id: string, price: number, gift?: Gift) => void;
  balance?: number;
  disabled?: boolean;
  selectedId?: string | null;
  compact?: boolean;
  showBalance?: boolean;
  showTitle?: boolean;
  style?: ViewStyle;
};

const gold = theme.colors?.premiumGold || theme.colors?.gold || '#D4A857';
const cyan = theme.colors?.neonCyan || theme.colors?.neon || '#00E0FF';

function RoseIcon({ size = 28, color = '#FF3B6A', glow = '#FFD0DC' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="roseA" x1="12" y1="8" x2="52" y2="52">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.52" stopColor={color} />
          <Stop offset="1" stopColor="#9E123C" />
        </LinearGradient>
        <LinearGradient id="roseB" x1="22" y1="34" x2="46" y2="60">
          <Stop offset="0" stopColor="#46D36B" />
          <Stop offset="1" stopColor="#087C3A" />
        </LinearGradient>
      </Defs>
      <Path d="M31 33c-8-1-15-6-15-14 0-7 6-12 13-9 2-6 12-7 16-1 7 1 10 9 6 15-3 6-10 9-20 9Z" fill="url(#roseA)" />
      <Path d="M31 33c-2-9 3-18 14-24-4 9-5 17-14 24Z" fill="#FF8AAA" opacity="0.72" />
      <Path d="M31 33c-8-3-11-9-9-18 4 7 9 10 17 9-2 4-4 7-8 9Z" fill="#E91E63" opacity="0.9" />
      <Path d="M31 32c4-5 10-7 18-6-5 5-11 8-18 6Z" fill="#C2185B" opacity="0.86" />
      <Path d="M31 31c-1 10-2 19-6 27" stroke="#138A45" strokeWidth="5" strokeLinecap="round" />
      <Path d="M27 48c-7-7-15-5-19 2 8 4 15 3 19-2Z" fill="url(#roseB)" />
      <Path d="M30 45c8-5 16-2 19 6-8 2-15 1-19-6Z" fill="url(#roseB)" />
    </Svg>
  );
}

function StarIcon({ size = 28, color = '#FFC83D', glow = '#FFF2A8' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="starA" x1="10" y1="6" x2="54" y2="58">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.5" stopColor={color} />
          <Stop offset="1" stopColor="#E07A00" />
        </LinearGradient>
      </Defs>
      <Path d="M32 5l7.7 16 17.6 2.4-12.8 12.3 3.2 17.5L32 44.7 16.3 53.2l3.2-17.5L6.7 23.4l17.6-2.4L32 5Z" fill="url(#starA)" />
      <Path d="M32 13l4.6 10 10.8 1.5-7.9 7.5 2 10.8-9.5-5.2-9.5 5.2 2-10.8-7.9-7.5 10.8-1.5L32 13Z" fill="#FFF8CF" opacity="0.45" />
      <Circle cx="32" cy="32" r="5" fill="#FFFFFF" opacity="0.55" />
    </Svg>
  );
}

function CrownIcon({ size = 28, color = '#D4A857', glow = '#FFF1B8' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="crownA" x1="8" y1="10" x2="56" y2="54">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.55" stopColor={color} />
          <Stop offset="1" stopColor="#8B5A13" />
        </LinearGradient>
      </Defs>
      <Path d="M10 22l12 12 10-20 10 20 12-12-5 28H15L10 22Z" fill="url(#crownA)" />
      <Circle cx="10" cy="21" r="5" fill="#FFEAA0" />
      <Circle cx="32" cy="13" r="5" fill="#FFF3B8" />
      <Circle cx="54" cy="21" r="5" fill="#FFEAA0" />
      <Rect x="15" y="47" width="34" height="8" rx="4" fill="#7A4A10" opacity="0.72" />
      <Path d="M23 42h18" stroke="#FFF4B8" strokeWidth="3" strokeLinecap="round" opacity="0.7" />
    </Svg>
  );
}

function RocketIcon({ size = 28, color = '#7C5CFF', glow = '#DCD5FF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="rocketA" x1="17" y1="8" x2="50" y2="50">
          <Stop offset="0" stopColor="#FFFFFF" />
          <Stop offset="0.5" stopColor={glow} />
          <Stop offset="1" stopColor={color} />
        </LinearGradient>
        <LinearGradient id="rocketB" x1="18" y1="42" x2="36" y2="62">
          <Stop offset="0" stopColor="#FFD15C" />
          <Stop offset="0.5" stopColor="#FF6B2C" />
          <Stop offset="1" stopColor="#D71920" />
        </LinearGradient>
      </Defs>
      <Path d="M42 6c-12 3-22 14-25 28l13 13c14-3 25-13 28-25 2-8-8-18-16-16Z" fill="url(#rocketA)" />
      <Circle cx="41" cy="23" r="7" fill="#00D9FF" opacity="0.9" />
      <Circle cx="41" cy="23" r="3" fill="#FFFFFF" opacity="0.75" />
      <Path d="M19 34l-9 5 2-12 8-4" fill="#5C45D9" />
      <Path d="M30 45l-5 9 12-2 4-8" fill="#4C35C9" />
      <Path d="M22 45c-6 3-10 8-12 15 7-2 12-6 15-12l-3-3Z" fill="url(#rocketB)" />
      <Path d="M47 12c3 2 5 4 6 7" stroke="#FFFFFF" strokeWidth="3" strokeLinecap="round" opacity="0.6" />
    </Svg>
  );
}

function DiamondIcon({ size = 28, color = '#00E0FF', glow = '#D9FBFF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="diamondA" x1="10" y1="8" x2="54" y2="58">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.55" stopColor={color} />
          <Stop offset="1" stopColor="#1E4DFF" />
        </LinearGradient>
      </Defs>
      <Path d="M18 10h28l12 16-26 30L6 26l12-16Z" fill="url(#diamondA)" />
      <Path d="M18 10l14 46L46 10" fill="none" stroke="#FFFFFF" strokeWidth="2" opacity="0.45" />
      <Path d="M6 26h52" stroke="#FFFFFF" strokeWidth="2" opacity="0.5" />
      <Path d="M18 10l-4 16 18 30 18-30-4-16" fill="none" stroke="#003E73" strokeWidth="2" opacity="0.22" />
    </Svg>
  );
}

function PhoenixIcon({ size = 28, color = '#FF6B2C', glow = '#FFE1A6' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="phoenixA" x1="8" y1="6" x2="56" y2="58">
          <Stop offset="0" stopColor={glow} />
          <Stop offset="0.45" stopColor={color} />
          <Stop offset="1" stopColor="#B5122A" />
        </LinearGradient>
      </Defs>
      <Path d="M32 8c6 10 18 12 25 7-3 14-13 22-25 23C20 37 10 29 7 15c7 5 19 3 25-7Z" fill="url(#phoenixA)" />
      <Path d="M32 20c5 9 12 15 22 19-12 2-19 0-22-7-3 7-10 9-22 7 10-4 17-10 22-19Z" fill="#FFD15C" opacity="0.82" />
      <Path d="M32 32c4 8 8 14 16 22-8-1-13-5-16-12-3 7-8 11-16 12 8-8 12-14 16-22Z" fill="#FF3B3B" opacity="0.78" />
      <Circle cx="32" cy="22" r="4" fill="#FFF7D6" />
    </Svg>
  );
}

const GIFTS: Gift[] = [
  { id: 'rose', name: 'Rose', price: 10, tier: 'basic', accent: '#FF3B6A', glow: '#FFE1EA', Icon: RoseIcon },
  { id: 'star', name: 'Star', price: 50, tier: 'basic', accent: '#FFC83D', glow: '#FFF4B8', Icon: StarIcon },
  { id: 'crown', name: 'Crown', price: 100, tier: 'premium', accent: gold, glow: '#FFF1B8', Icon: CrownIcon },
  { id: 'rocket', name: 'Rocket', price: 250, tier: 'premium', accent: '#7C5CFF', glow: '#E6E0FF', Icon: RocketIcon },
  { id: 'diamond', name: 'Diamond', price: 500, tier: 'legendary', accent: cyan, glow: '#D9FBFF', Icon: DiamondIcon },
  { id: 'phoenix', name: 'Phoenix', price: 1000, tier: 'mythic', accent: '#FF6B2C', glow: '#FFE1A6', Icon: PhoenixIcon }
];

const GiftCoinIcon = memo(function GiftCoinIcon({ size = 14 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Defs>
        <LinearGradient id="coinA" x1="4" y1="2" x2="28" y2="30">
          <Stop offset="0" stopColor="#FFF5B8" />
          <Stop offset="0.55" stopColor={gold} />
          <Stop offset="1" stopColor="#8B5A13" />
        </LinearGradient>
      </Defs>
      <Circle cx="16" cy="16" r="13" fill="url(#coinA)" />
      <Circle cx="16" cy="16" r="8" fill="none" stroke="#FFFFFF" strokeWidth="2" opacity="0.45" />
      <Path d="M16 9v14M11 14h10" stroke="#5C390A" strokeWidth="2.4" strokeLinecap="round" />
    </Svg>
  );
});

const SparkIcon = memo(function SparkIcon({ size = 16 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 32 32">
      <Path d="M16 2l3.4 10.6L30 16l-10.6 3.4L16 30l-3.4-10.6L2 16l10.6-3.4L16 2Z" fill={cyan} />
      <Circle cx="16" cy="16" r="3" fill="#FFFFFF" opacity="0.7" />
    </Svg>
  );
});

function tierLabel(tier: GiftTier) {
  if (tier === 'mythic') return 'MYTHIC';
  if (tier === 'legendary') return 'LEGEND';
  if (tier === 'premium') return 'PREMIUM';
  return 'GIFT';
}

function tierStyle(tier: GiftTier) {
  if (tier === 'mythic') return styles.tierMythic;
  if (tier === 'legendary') return styles.tierLegendary;
  if (tier === 'premium') return styles.tierPremium;
  return styles.tierBasic;
}

const GiftItem = memo(function GiftItem({
  gift,
  selected,
  disabled,
  compact,
  affordable,
  onPress
}: {
  gift: Gift;
  selected: boolean;
  disabled: boolean;
  compact: boolean;
  affordable: boolean;
  onPress: (gift: Gift) => void;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const pulse = useRef(new Animated.Value(0)).current;

  const pressIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.94, useNativeDriver: true, speed: 32, bounciness: 7 }).start();
  }, [scale]);

  const pressOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 24, bounciness: 8 }).start();
  }, [scale]);

  const send = useCallback(() => {
    if (disabled || !affordable) return;
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    pulse.setValue(0);
    Animated.timing(pulse, {
      toValue: 1,
      duration: 420,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true
    }).start();
    onPress(gift);
  }, [disabled, affordable, gift, onPress, pulse]);

  const Icon = gift.Icon;

  return (
    <Pressable
      onPress={send}
      onPressIn={pressIn}
      onPressOut={pressOut}
      disabled={disabled || !affordable}
      accessibilityRole={'button' as AccessibilityRole}
      accessibilityLabel={`${gift.name} gift ${gift.price} coins`}
    >
      <Animated.View
        style={[
          styles.gift,
          compact && styles.giftCompact,
          selected && styles.giftSelected,
          !affordable && styles.giftLocked,
          { transform: [{ scale }] }
        ]}
      >
        <Animated.View
          pointerEvents="none"
          style={[
            styles.pulse,
            {
              backgroundColor: gift.glow,
              opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
              transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.75, 1.55] }) }]
            }
          ]}
        />
        <View style={[styles.iconShell, { backgroundColor: gift.glow, borderColor: gift.accent }]}>
          <Icon size={compact ? 25 : 31} color={gift.accent} glow={gift.glow} />
        </View>
        <Text style={[styles.name, compact && styles.nameCompact]} numberOfLines={1}>
          {gift.name}
        </Text>
        <View style={styles.priceRow}>
          <GiftCoinIcon size={compact ? 11 : 13} />
          <Text style={[styles.price, !affordable && styles.priceLocked]}>{gift.price}</Text>
        </View>
        <View style={[styles.tier, tierStyle(gift.tier)]}>
          <Text style={styles.tierText}>{tierLabel(gift.tier)}</Text>
        </View>
      </Animated.View>
    </Pressable>
  );
});

function GiftBar({
  onSend,
  balance,
  disabled = false,
  selectedId = null,
  compact = false,
  showBalance = true,
  showTitle = true,
  style
}: GiftBarProps) {
  const [activeId, setActiveId] = useState<string | null>(selectedId);

  const sortedGifts = useMemo(() => GIFTS.slice().sort((a, b) => a.price - b.price), []);

  const handleSend = useCallback(
    (gift: Gift) => {
      setActiveId(gift.id);
      onSend?.(gift.id, gift.price, gift);
    },
    [onSend]
  );

  const balanceValue = typeof balance === 'number' ? Math.max(0, balance) : null;

  return (
    <View style={[styles.container, compact && styles.containerCompact, style]}>
      {(showTitle || showBalance) && (
        <View style={styles.header}>
          {showTitle && (
            <View style={styles.titleWrap}>
              <SparkIcon size={15} />
              <Text style={styles.title}>Gift Studio</Text>
            </View>
          )}
          {showBalance && (
            <View style={styles.balancePill}>
              <GiftCoinIcon size={14} />
              <Text style={styles.balanceText}>{balanceValue === null ? 'Coins' : balanceValue.toLocaleString()}</Text>
            </View>
          )}
        </View>
      )}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.scrollContent, compact && styles.scrollCompact]}
        keyboardShouldPersistTaps="handled"
      >
        {sortedGifts.map(gift => {
          const affordable = balanceValue === null || balanceValue >= gift.price;
          return (
            <GiftItem
              key={gift.id}
              gift={gift}
              selected={activeId === gift.id}
              disabled={disabled}
              compact={compact}
              affordable={affordable}
              onPress={handleSend}
            />
          );
        })}
      </ScrollView>
    </View>
  );
}

export default memo(GiftBar);

export { GIFTS, RoseIcon, StarIcon, CrownIcon, RocketIcon, DiamondIcon, PhoenixIcon, GiftCoinIcon, SparkIcon };

const shadow = {
  shadowColor: '#000',
  shadowOpacity: 0.08,
  shadowRadius: 14,
  shadowOffset: { width: 0, height: 8 },
  elevation: 4
};

const textShadow: TextStyle = {
  textShadowColor: 'rgba(0,0,0,0.08)',
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 2
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    minHeight: 92,
    marginRight: 8,
    paddingVertical: 6
  },
  containerCompact: {
    minHeight: 72,
    paddingVertical: 2
  },
  header: {
    paddingHorizontal: 2,
    marginBottom: 7,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  titleWrap: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  title: {
    marginLeft: 6,
    fontSize: 12,
    fontWeight: '900',
    color: '#171717',
    letterSpacing: 0.35,
    textTransform: 'uppercase'
  },
  balancePill: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 5,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.94)',
    borderWidth: 1,
    borderColor: 'rgba(212,168,87,0.24)'
  },
  balanceText: {
    marginLeft: 5,
    fontSize: 11,
    fontWeight: '900',
    color: gold
  },
  scrollContent: {
    paddingRight: 10,
    paddingLeft: 1
  },
  scrollCompact: {
    paddingRight: 6
  },
  gift: {
    width: 78,
    height: 82,
    marginRight: 10,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.96)',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.055)',
    overflow: 'hidden',
    ...shadow
  },
  giftCompact: {
    width: 66,
    height: 68,
    borderRadius: 18,
    marginRight: 8
  },
  giftSelected: {
    borderColor: gold,
    borderWidth: 1.5,
    shadowColor: gold,
    shadowOpacity: 0.25,
    shadowRadius: 16
  },
  giftLocked: {
    opacity: 0.48
  },
  pulse: {
    position: 'absolute',
    width: 86,
    height: 86,
    borderRadius: 43
  },
  iconShell: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    marginTop: 2
  },
  name: {
    marginTop: 4,
    fontSize: 10,
    fontWeight: '900',
    color: '#1F1F1F',
    letterSpacing: 0.15,
    maxWidth: 68,
    ...textShadow
  },
  nameCompact: {
    fontSize: 9,
    marginTop: 2,
    maxWidth: 58
  },
  priceRow: {
    marginTop: 2,
    flexDirection: 'row',
    alignItems: 'center'
  },
  price: {
    marginLeft: 3,
    fontSize: 10,
    fontWeight: '900',
    color: gold
  },
  priceLocked: {
    color: '#8E8E8E'
  },
  tier: {
    position: 'absolute',
    top: 6,
    right: 6,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 999
  },
  tierBasic: {
    backgroundColor: 'rgba(0,0,0,0.06)'
  },
  tierPremium: {
    backgroundColor: 'rgba(212,168,87,0.18)'
  },
  tierLegendary: {
    backgroundColor: 'rgba(0,224,255,0.18)'
  },
  tierMythic: {
    backgroundColor: 'rgba(255,107,44,0.18)'
  },
  tierText: {
    fontSize: 6.5,
    fontWeight: '900',
    color: '#161616',
    letterSpacing: 0.25
  }
});
