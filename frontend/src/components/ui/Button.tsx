import React, { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ActivityIndicator,
  Animated,
  GestureResponderEvent,
  Platform,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextStyle,
  View,
  ViewStyle,
  AccessibilityRole
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { theme } from '../../theme';
import Icon, { IconName } from './Icon';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'glass'
  | 'neon'
  | 'ghost'
  | 'danger'
  | 'premium'
  | 'success'
  | 'warning'
  | 'dark'
  | 'light';

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'pill' | 'icon';

export type ButtonShape = 'soft' | 'round' | 'pill' | 'square';

export type ButtonTone = 'auto' | 'dark' | 'light';

export type ButtonHaptic = boolean | 'light' | 'medium' | 'heavy' | 'selection' | 'success' | 'warning' | 'error';

export interface ButtonProps {
  title?: string;
  children?: React.ReactNode;
  icon?: IconName;
  rightIcon?: IconName;
  iconPosition?: 'left' | 'right';
  variant?: ButtonVariant;
  size?: ButtonSize;
  shape?: ButtonShape;
  tone?: ButtonTone;
  loading?: boolean;
  disabled?: boolean;
  active?: boolean;
  fullWidth?: boolean;
  compact?: boolean;
  uppercase?: boolean;
  badge?: string | number | boolean;
  loadingText?: string;
  onPress?: (event?: GestureResponderEvent) => void;
  onLongPress?: (event?: GestureResponderEvent) => void;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  iconColor?: string;
  color?: string;
  backgroundColor?: string;
  borderColor?: string;
  testID?: string;
  accessibilityLabel?: string;
  accessibilityRole?: AccessibilityRole;
  haptic?: ButtonHaptic;
  debounceMs?: number;
  hitSlop?: number | { top?: number; left?: number; right?: number; bottom?: number };
}

const fallbackColors = {
  ink: '#111827',
  muted: '#6B7280',
  white: '#FFFFFF',
  black: '#000000',
  cyan: '#00E0FF',
  neon: '#00F5D4',
  gold: '#D4A857',
  premiumGold: '#F5C76B',
  violet: '#7C3AED',
  danger: '#EF4444',
  success: '#22C55E',
  warning: '#F59E0B',
  glass: 'rgba(255,255,255,0.86)',
  glassDark: 'rgba(17,24,39,0.72)',
  border: 'rgba(255,255,255,0.22)',
  borderDark: 'rgba(17,24,39,0.1)'
};

const palette = {
  ink: theme.colors?.ink || theme.colors?.black || fallbackColors.ink,
  muted: theme.colors?.gray || theme.colors?.softGray || fallbackColors.muted,
  white: theme.colors?.white || fallbackColors.white,
  black: theme.colors?.black || fallbackColors.black,
  cyan: theme.colors?.neonCyan || theme.colors?.neon || fallbackColors.cyan,
  neon: theme.colors?.neon || theme.colors?.neonCyan || fallbackColors.neon,
  gold: theme.colors?.gold || theme.colors?.premiumGold || fallbackColors.gold,
  premiumGold: theme.colors?.premiumGold || theme.colors?.gold || fallbackColors.premiumGold,
  violet: theme.colors?.electricViolet || theme.colors?.violet || fallbackColors.violet,
  danger: theme.colors?.errorRed || theme.colors?.danger || fallbackColors.danger,
  success: theme.colors?.success || fallbackColors.success,
  warning: theme.colors?.warning || fallbackColors.warning
};

const variantConfig: Record<ButtonVariant, {
  backgroundColor: string;
  borderColor: string;
  textColor: string;
  iconColor: string;
  shadowColor: string;
  shadowOpacity: number;
  borderWidth: number;
}> = {
  primary: {
    backgroundColor: palette.cyan,
    borderColor: 'rgba(255,255,255,0.18)',
    textColor: '#061014',
    iconColor: '#061014',
    shadowColor: palette.cyan,
    shadowOpacity: 0.28,
    borderWidth: 1
  },
  secondary: {
    backgroundColor: 'rgba(17,24,39,0.06)',
    borderColor: 'rgba(17,24,39,0.1)',
    textColor: palette.ink,
    iconColor: palette.ink,
    shadowColor: palette.black,
    shadowOpacity: 0.06,
    borderWidth: 1
  },
  glass: {
    backgroundColor: fallbackColors.glass,
    borderColor: 'rgba(255,255,255,0.52)',
    textColor: palette.ink,
    iconColor: palette.ink,
    shadowColor: palette.black,
    shadowOpacity: 0.08,
    borderWidth: 1
  },
  neon: {
    backgroundColor: 'rgba(0,224,255,0.12)',
    borderColor: 'rgba(0,224,255,0.48)',
    textColor: palette.cyan,
    iconColor: palette.cyan,
    shadowColor: palette.cyan,
    shadowOpacity: 0.22,
    borderWidth: 1.2
  },
  ghost: {
    backgroundColor: 'transparent',
    borderColor: 'transparent',
    textColor: palette.ink,
    iconColor: palette.ink,
    shadowColor: palette.black,
    shadowOpacity: 0,
    borderWidth: 0
  },
  danger: {
    backgroundColor: palette.danger,
    borderColor: 'rgba(255,255,255,0.18)',
    textColor: palette.white,
    iconColor: palette.white,
    shadowColor: palette.danger,
    shadowOpacity: 0.22,
    borderWidth: 1
  },
  premium: {
    backgroundColor: palette.premiumGold,
    borderColor: 'rgba(255,255,255,0.22)',
    textColor: '#1B1202',
    iconColor: '#1B1202',
    shadowColor: palette.premiumGold,
    shadowOpacity: 0.28,
    borderWidth: 1
  },
  success: {
    backgroundColor: palette.success,
    borderColor: 'rgba(255,255,255,0.18)',
    textColor: palette.white,
    iconColor: palette.white,
    shadowColor: palette.success,
    shadowOpacity: 0.2,
    borderWidth: 1
  },
  warning: {
    backgroundColor: palette.warning,
    borderColor: 'rgba(255,255,255,0.18)',
    textColor: '#1F1300',
    iconColor: '#1F1300',
    shadowColor: palette.warning,
    shadowOpacity: 0.22,
    borderWidth: 1
  },
  dark: {
    backgroundColor: '#111827',
    borderColor: 'rgba(255,255,255,0.12)',
    textColor: palette.white,
    iconColor: palette.white,
    shadowColor: palette.black,
    shadowOpacity: 0.18,
    borderWidth: 1
  },
  light: {
    backgroundColor: palette.white,
    borderColor: 'rgba(17,24,39,0.08)',
    textColor: palette.ink,
    iconColor: palette.ink,
    shadowColor: palette.black,
    shadowOpacity: 0.07,
    borderWidth: 1
  }
};

const sizeConfig: Record<ButtonSize, {
  minHeight: number;
  paddingVertical: number;
  paddingHorizontal: number;
  fontSize: number;
  iconSize: number;
  gap: number;
  radius: number;
}> = {
  xs: {
    minHeight: 30,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 11,
    iconSize: 14,
    gap: 5,
    radius: 10
  },
  sm: {
    minHeight: 36,
    paddingVertical: 8,
    paddingHorizontal: 14,
    fontSize: 12,
    iconSize: 16,
    gap: 6,
    radius: 12
  },
  md: {
    minHeight: 46,
    paddingVertical: 12,
    paddingHorizontal: 18,
    fontSize: 14,
    iconSize: 19,
    gap: 8,
    radius: 15
  },
  lg: {
    minHeight: 54,
    paddingVertical: 15,
    paddingHorizontal: 22,
    fontSize: 15,
    iconSize: 21,
    gap: 9,
    radius: 18
  },
  xl: {
    minHeight: 62,
    paddingVertical: 18,
    paddingHorizontal: 26,
    fontSize: 16,
    iconSize: 23,
    gap: 10,
    radius: 20
  },
  pill: {
    minHeight: 48,
    paddingVertical: 12,
    paddingHorizontal: 22,
    fontSize: 14,
    iconSize: 19,
    gap: 8,
    radius: 999
  },
  icon: {
    minHeight: 44,
    paddingVertical: 0,
    paddingHorizontal: 0,
    fontSize: 0,
    iconSize: 22,
    gap: 0,
    radius: 16
  }
};

function getRadius(size: ButtonSize, shape: ButtonShape) {
  if (shape === 'pill') return 999;
  if (shape === 'round') return Math.max(sizeConfig[size].minHeight / 2, 999);
  if (shape === 'square') return 12;
  return sizeConfig[size].radius;
}

function getHapticStyle(haptic: ButtonHaptic) {
  if (haptic === 'medium') return Haptics.ImpactFeedbackStyle.Medium;
  if (haptic === 'heavy') return Haptics.ImpactFeedbackStyle.Heavy;
  return Haptics.ImpactFeedbackStyle.Light;
}

function runHaptic(haptic: ButtonHaptic) {
  if (!haptic) return;
  if (haptic === 'selection') {
    Haptics.selectionAsync().catch(() => {});
    return;
  }
  if (haptic === 'success') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    return;
  }
  if (haptic === 'warning') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
    return;
  }
  if (haptic === 'error') {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
    return;
  }
  Haptics.impactAsync(getHapticStyle(haptic)).catch(() => {});
}

const Button: React.FC<ButtonProps> = ({
  title,
  children,
  icon,
  rightIcon,
  iconPosition = 'left',
  variant = 'primary',
  size = 'md',
  shape = 'soft',
  tone = 'auto',
  loading = false,
  disabled = false,
  active = false,
  fullWidth = false,
  compact = false,
  uppercase = true,
  badge,
  loadingText,
  onPress,
  onLongPress,
  style,
  contentStyle,
  textStyle,
  iconColor,
  color,
  backgroundColor,
  borderColor,
  testID,
  accessibilityLabel,
  accessibilityRole = 'button',
  haptic = true,
  debounceMs = 450,
  hitSlop = 8
}) => {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const glowAnim = useRef(new Animated.Value(active ? 1 : 0)).current;
  const lastPressRef = useRef(0);

  const safeVariant = variantConfig[variant] ? variant : 'primary';
  const safeSize = sizeConfig[size] ? size : 'md';

  const config = variantConfig[safeVariant];
  const sizing = sizeConfig[safeSize];

  const isBlocked = disabled || loading;

  const resolvedTextColor = color || iconColor || config.textColor;
  const resolvedIconColor = iconColor || color || config.iconColor;
  const resolvedBackground = backgroundColor || config.backgroundColor;
  const resolvedBorder = borderColor || config.borderColor;

  const finalTextColor = tone === 'dark' ? palette.ink : tone === 'light' ? palette.white : resolvedTextColor;
  const finalIconColor = tone === 'dark' ? palette.ink : tone === 'light' ? palette.white : resolvedIconColor;

  useEffect(() => {
    Animated.timing(glowAnim, {
      toValue: active ? 1 : 0,
      duration: 220,
      useNativeDriver: false
    }).start();
  }, [active, glowAnim]);

  const animatedShadowOpacity = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [config.shadowOpacity, Math.min(config.shadowOpacity + 0.18, 0.42)]
  });

  const animatedBorderColor = glowAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [resolvedBorder, palette.gold]
  });

  const handlePressIn = useCallback(() => {
    if (isBlocked) return;
    runHaptic(haptic);
    Animated.spring(scaleAnim, {
      toValue: 0.955,
      speed: 24,
      bounciness: 7,
      useNativeDriver: true
    }).start();
  }, [haptic, isBlocked, scaleAnim]);

  const handlePressOut = useCallback(() => {
    Animated.spring(scaleAnim, {
      toValue: 1,
      speed: 22,
      bounciness: 8,
      useNativeDriver: true
    }).start();
  }, [scaleAnim]);

  const handlePress = useCallback((event: GestureResponderEvent) => {
    if (isBlocked || !onPress) return;
    const current = Date.now();
    if (debounceMs > 0 && current - lastPressRef.current < debounceMs) return;
    lastPressRef.current = current;
    onPress(event);
  }, [debounceMs, isBlocked, onPress]);

  const buttonStyle = useMemo(() => {
    const radius = getRadius(safeSize, shape);
    const iconOnly = safeSize === 'icon' || (!title && !children && (icon || rightIcon));
    const widthHeight = iconOnly ? sizing.minHeight : undefined;

    return {
      minHeight: sizing.minHeight,
      width: widthHeight,
      height: widthHeight,
      paddingVertical: compact || iconOnly ? Math.max(0, sizing.paddingVertical - 3) : sizing.paddingVertical,
      paddingHorizontal: iconOnly ? 0 : compact ? Math.max(10, sizing.paddingHorizontal - 5) : sizing.paddingHorizontal,
      borderRadius: radius,
      backgroundColor: resolvedBackground,
      borderWidth: config.borderWidth,
      borderColor: active ? animatedBorderColor : resolvedBorder,
      shadowColor: config.shadowColor,
      shadowOpacity: animatedShadowOpacity,
      opacity: disabled ? 0.48 : 1,
      alignSelf: fullWidth ? 'stretch' : undefined
    } as any;
  }, [
    active,
    animatedBorderColor,
    animatedShadowOpacity,
    children,
    compact,
    config.borderWidth,
    config.shadowColor,
    disabled,
    fullWidth,
    icon,
    resolvedBackground,
    resolvedBorder,
    rightIcon,
    safeSize,
    shape,
    sizing.minHeight,
    sizing.paddingHorizontal,
    sizing.paddingVertical,
    title
  ]);

  const label = loading && loadingText ? loadingText : title;
  const showLeftIcon = !!icon && iconPosition === 'left';
  const showRightIcon = !!rightIcon || (!!icon && iconPosition === 'right');
  const finalRightIcon = rightIcon || icon;

  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel || title || 'Button'}
      accessibilityState={{ disabled: isBlocked, busy: loading, selected: active }}
      disabled={isBlocked}
      onPress={handlePress}
      onLongPress={onLongPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        styles.pressable,
        fullWidth && styles.fullWidth,
        Platform.OS === 'web' && styles.webCursor,
        pressed && !isBlocked && styles.pressed,
        style
      ]}
    >
      <Animated.View style={[styles.base, buttonStyle, { transform: [{ scale: scaleAnim }] }]}>
        <View style={[styles.content, { gap: sizing.gap }, contentStyle]}>
          {loading ? (
            <>
              <ActivityIndicator size={safeSize === 'xs' || safeSize === 'sm' ? 'small' : 'small'} color={finalIconColor} />
              {!!loadingText && safeSize !== 'icon' && (
                <Text
                  numberOfLines={1}
                  style={[
                    styles.text,
                    {
                      color: finalTextColor,
                      fontSize: sizing.fontSize,
                      textTransform: uppercase ? 'uppercase' : 'none'
                    },
                    textStyle
                  ]}
                >
                  {loadingText}
                </Text>
              )}
            </>
          ) : (
            <>
              {showLeftIcon && <Icon name={icon as IconName} size={sizing.iconSize} color={finalIconColor} strokeWidth={2.15} active={active} />}
              {!!children ? (
                children
              ) : (
                !!label && safeSize !== 'icon' && (
                  <Text
                    numberOfLines={1}
                    style={[
                      styles.text,
                      {
                        color: finalTextColor,
                        fontSize: sizing.fontSize,
                        textTransform: uppercase ? 'uppercase' : 'none'
                      },
                      textStyle
                    ]}
                  >
                    {label}
                  </Text>
                )
              )}
              {showRightIcon && <Icon name={finalRightIcon as IconName} size={sizing.iconSize} color={finalIconColor} strokeWidth={2.15} active={active} />}
            </>
          )}
        </View>

        {!!badge && (
          <View style={styles.badge}>
            {badge !== true && (
              <Text numberOfLines={1} style={styles.badgeText}>
                {String(badge)}
              </Text>
            )}
          </View>
        )}
      </Animated.View>
    </Pressable>
  );
};

const styles = StyleSheet.create({
  pressable: {
    alignSelf: 'flex-start'
  },
  fullWidth: {
    alignSelf: 'stretch',
    width: '100%'
  },
  webCursor: {
    cursor: 'pointer'
  } as any,
  pressed: {
    opacity: 0.96
  },
  base: {
    position: 'relative',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    borderCurve: 'continuous' as any,
    shadowOffset: { width: 0, height: 10 },
    shadowRadius: 18,
    elevation: 4
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center'
  },
  text: {
    fontWeight: '900',
    letterSpacing: 0.58,
    includeFontPadding: false,
    textAlignVertical: 'center'
  },
  badge: {
    position: 'absolute',
    top: -2,
    right: -2,
    minWidth: 16,
    height: 16,
    paddingHorizontal: 4,
    borderRadius: 8,
    backgroundColor: '#FF3B5F',
    borderWidth: 1.5,
    borderColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center'
  },
  badgeText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '900',
    includeFontPadding: false
  }
});

export default memo(Button);
