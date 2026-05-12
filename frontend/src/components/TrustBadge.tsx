import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, ViewStyle, TextStyle } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Path, Circle, Rect } from 'react-native-svg';

type TrustBadgeSize = 'xs' | 'sm' | 'md' | 'lg';
type TrustTier = 'DIAMOND' | 'PLATINUM' | 'GOLD' | 'SILVER' | 'BRONZE' | 'NEW';

interface Props {
  score?: number | null;
  size?: TrustBadgeSize;
  showScore?: boolean;
  compact?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
}

const TIERS: Record<TrustTier, { min: number; label: TrustTier; short: string; colors: string[]; glow: string; text: string }> = {
  DIAMOND: { min: 97, label: 'DIAMOND', short: 'DMND', colors: ['#EFFFFF', '#7DF9FF', '#00B8FF', '#6A5CFF'], glow: '#7DF9FF', text: '#03131A' },
  PLATINUM: { min: 90, label: 'PLATINUM', short: 'PLTN', colors: ['#F8FFFF', '#B7F4FF', '#49D8FF', '#7B8CFF'], glow: '#49D8FF', text: '#06131F' },
  GOLD: { min: 75, label: 'GOLD', short: 'GOLD', colors: ['#FFF8D7', '#FFD66B', '#D4A857', '#8A5A12'], glow: '#FFD66B', text: '#1B1202' },
  SILVER: { min: 60, label: 'SILVER', short: 'SLVR', colors: ['#FFFFFF', '#DDE4EF', '#AEB8C8', '#6E7A8C'], glow: '#DDE4EF', text: '#111827' },
  BRONZE: { min: 35, label: 'BRONZE', short: 'BRNZ', colors: ['#FFE4C4', '#D79A52', '#9A5A20', '#5C3514'], glow: '#D79A52', text: '#160B03' },
  NEW: { min: 0, label: 'NEW', short: 'NEW', colors: ['#F3F4F6', '#D1D5DB', '#9CA3AF', '#4B5563'], glow: '#D1D5DB', text: '#111827' }
};

const SIZE_MAP: Record<TrustBadgeSize, { height: number; radius: number; icon: number; font: number; scoreFont: number; px: number; gap: number; stroke: number }> = {
  xs: { height: 20, radius: 8, icon: 14, font: 8, scoreFont: 8, px: 6, gap: 4, stroke: 1 },
  sm: { height: 24, radius: 9, icon: 16, font: 9, scoreFont: 9, px: 7, gap: 5, stroke: 1.2 },
  md: { height: 30, radius: 11, icon: 20, font: 11, scoreFont: 10, px: 9, gap: 6, stroke: 1.4 },
  lg: { height: 38, radius: 14, icon: 26, font: 13, scoreFont: 12, px: 12, gap: 8, stroke: 1.7 }
};

function normalizeScore(value?: number | null) {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function getTier(score: number): TrustTier {
  if (score >= TIERS.DIAMOND.min) return 'DIAMOND';
  if (score >= TIERS.PLATINUM.min) return 'PLATINUM';
  if (score >= TIERS.GOLD.min) return 'GOLD';
  if (score >= TIERS.SILVER.min) return 'SILVER';
  if (score >= TIERS.BRONZE.min) return 'BRONZE';
  return 'NEW';
}

function TrustMark({ tier, size }: { tier: TrustTier; size: number }) {
  const t = TIERS[tier];
  const strokeWidth = Math.max(0.9, size / 16);
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id={`trustGradient-${tier}`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={t.colors[0]} />
          <Stop offset="0.36" stopColor={t.colors[1]} />
          <Stop offset="0.7" stopColor={t.colors[2]} />
          <Stop offset="1" stopColor={t.colors[3]} />
        </LinearGradient>
        <LinearGradient id={`trustInner-${tier}`} x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#FFFFFF" stopOpacity="0.92" />
          <Stop offset="1" stopColor="#FFFFFF" stopOpacity="0.18" />
        </LinearGradient>
      </Defs>
      <Path d="M32 4.8L53.8 13.2V29.6C53.8 43.7 44.6 56.1 32 60C19.4 56.1 10.2 43.7 10.2 29.6V13.2L32 4.8Z" fill={`url(#trustGradient-${tier})`} />
      <Path d="M32 9.2L49.6 16V30.1C49.6 41.5 42.2 51.5 32 55.2C21.8 51.5 14.4 41.5 14.4 30.1V16L32 9.2Z" fill="rgba(0,0,0,0.14)" />
      <Path d="M32 12.2L46.4 17.8V30.2C46.4 39.8 40.5 48.1 32 51.6C23.5 48.1 17.6 39.8 17.6 30.2V17.8L32 12.2Z" fill={`url(#trustInner-${tier})`} />
      <Circle cx="32" cy="30" r="13.4" fill="rgba(255,255,255,0.22)" stroke="rgba(255,255,255,0.72)" strokeWidth={strokeWidth} />
      <Path d="M25.2 30.7L29.7 35.2L39.4 24.8" fill="none" stroke={t.text} strokeWidth={5.2} strokeLinecap="round" strokeLinejoin="round" />
      <Rect x="22" y="43.5" width="20" height="4.2" rx="2.1" fill={t.text} opacity="0.72" />
    </Svg>
  );
}

function TrustBadge({ score = 0, size = 'md', showScore = true, compact = false, style, textStyle }: Props) {
  const safeScore = normalizeScore(score);
  const tier = getTier(safeScore);
  const t = TIERS[tier];
  const s = SIZE_MAP[size];

  const containerStyle = useMemo(
    () => [
      styles.badge,
      {
        minHeight: s.height,
        borderRadius: s.radius,
        paddingHorizontal: compact ? s.px - 2 : s.px,
        gap: compact ? s.gap - 2 : s.gap,
        backgroundColor: t.colors[2],
        borderColor: t.colors[1],
        shadowColor: t.glow
      },
      style
    ],
    [compact, s, style, t]
  );

  return (
    <View style={containerStyle}>
      <View style={[styles.iconShell, { width: s.icon, height: s.icon, borderRadius: s.icon / 2 }]}>
        <TrustMark tier={tier} size={s.icon} />
      </View>
      <Text style={[styles.label, { color: t.text, fontSize: s.font }, textStyle]} numberOfLines={1}>
        {compact ? t.short : t.label}
      </Text>
      {showScore && (
        <View style={[styles.scorePill, { borderRadius: s.radius - 2, paddingHorizontal: Math.max(4, s.px - 3) }]}>
          <Text style={[styles.score, { color: t.text, fontSize: s.scoreFont }]}>{safeScore}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5
  },
  iconShell: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  label: {
    fontWeight: '900',
    letterSpacing: 0.75
  },
  scorePill: {
    backgroundColor: 'rgba(255,255,255,0.32)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.38)',
    paddingVertical: 1
  },
  score: {
    fontWeight: '900',
    letterSpacing: 0.25
  }
});

export default memo(TrustBadge);
