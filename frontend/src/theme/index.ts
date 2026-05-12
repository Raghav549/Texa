import { Platform, StyleSheet } from "react-native";

type FontWeight =
  | "100"
  | "200"
  | "300"
  | "400"
  | "500"
  | "600"
  | "700"
  | "800"
  | "900"
  | "normal"
  | "bold";

type ShadowStyle = {
  shadowColor: string;
  shadowOffset: { width: number; height: number };
  shadowOpacity: number;
  shadowRadius: number;
  elevation: number;
};

type TypographyStyle = {
  fontSize: number;
  fontWeight: FontWeight;
  lineHeight?: number;
  letterSpacing?: number;
  color?: string;
  fontFamily?: string;
};

const fontFamily = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: "System"
});

const createShadow = (
  shadowColor: string,
  height: number,
  shadowOpacity: number,
  shadowRadius: number,
  elevation: number
): ShadowStyle => ({
  shadowColor,
  shadowOffset: { width: 0, height },
  shadowOpacity,
  shadowRadius,
  elevation
});

export const theme = {
  colors: {
    pureWhite: "#FFFFFF",
    glassWhite: "rgba(255,255,255,0.88)",
    softWhite: "#F8F9FC",
    iceWhite: "#F1F3F9",
    cloudWhite: "#FAFBFF",
    pearlWhite: "#FDFDFE",
    frostWhite: "rgba(255,255,255,0.72)",
    deepCharcoal: "#1A1A2E",
    ink: "#10111A",
    graphite: "#24263A",
    slate: "#4B5163",
    softGray: "#8E94A3",
    mutedGray: "#A8AFBF",
    border: "#E6EAF2",
    divider: "rgba(26,26,46,0.08)",
    overlay: "rgba(10,12,24,0.55)",
    backdrop: "rgba(10,12,24,0.35)",
    neonCyan: "#00F5D4",
    aqua: "#2EEBFF",
    skyBlue: "#38BDF8",
    electricBlue: "#2563EB",
    electricViolet: "#7B61FF",
    royalPurple: "#5B21B6",
    magenta: "#EC4899",
    hotPink: "#FF4FD8",
    premiumGold: "#D4AF37",
    amber: "#F59E0B",
    orange: "#FB923C",
    successGreen: "#2ED573",
    emerald: "#10B981",
    lime: "#A3E635",
    warningYellow: "#FACC15",
    errorRed: "#FF4757",
    danger: "#EF4444",
    info: "#3B82F6",
    transparent: "transparent",
    black: "#000000",
    white: "#FFFFFF"
  },
  gradients: {
    whiteToCyan: ["#FFFFFF", "#F0FDF9", "#E0FFFF"],
    glassCard: ["rgba(255,255,255,0.94)", "rgba(255,255,255,0.72)"],
    neonGlow: ["rgba(0,245,212,0.35)", "rgba(255,255,255,0)"],
    cyanViolet: ["#00F5D4", "#38BDF8", "#7B61FF"],
    violetPink: ["#7B61FF", "#EC4899", "#FF4FD8"],
    goldPremium: ["#FFF7CC", "#D4AF37", "#A97913"],
    successGlow: ["#2ED573", "#10B981", "#A3E635"],
    dangerGlow: ["#FF4757", "#FB7185", "#F97316"],
    darkLuxury: ["#10111A", "#1A1A2E", "#24263A"],
    appBackground: ["#FFFFFF", "#F8F9FC", "#F1F3F9"],
    creator: ["#7B61FF", "#00F5D4"],
    business: ["#D4AF37", "#FB923C"],
    verified: ["#38BDF8", "#2563EB"],
    premium: ["#D4AF37", "#7B61FF", "#00F5D4"]
  },
  spacing: {
    none: 0,
    xxs: 2,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    xxxl: 48,
    huge: 64,
    screen: 20
  },
  radius: {
    none: 0,
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
    card: 28,
    sheet: 36,
    pill: 999
  },
  shadows: {
    none: createShadow("#000000", 0, 0, 0, 0),
    soft: createShadow("#000000", 4, 0.04, 12, 2),
    medium: createShadow("#000000", 8, 0.08, 18, 4),
    floating: createShadow("#00F5D4", 8, 0.15, 20, 6),
    neon: createShadow("#7B61FF", 0, 0.25, 15, 8),
    gold: createShadow("#D4AF37", 8, 0.18, 24, 7),
    danger: createShadow("#FF4757", 8, 0.16, 20, 6),
    card: createShadow("#10111A", 10, 0.08, 24, 5),
    modal: createShadow("#10111A", 16, 0.16, 36, 12)
  },
  typography: {
    display: {
      fontSize: 36,
      fontWeight: "900",
      lineHeight: 42,
      letterSpacing: -1,
      color: "#10111A",
      fontFamily
    } as TypographyStyle,
    h1: {
      fontSize: 30,
      fontWeight: "800",
      lineHeight: 36,
      letterSpacing: -0.7,
      color: "#10111A",
      fontFamily
    } as TypographyStyle,
    h2: {
      fontSize: 24,
      fontWeight: "800",
      lineHeight: 30,
      letterSpacing: -0.4,
      color: "#10111A",
      fontFamily
    } as TypographyStyle,
    h3: {
      fontSize: 20,
      fontWeight: "700",
      lineHeight: 26,
      letterSpacing: -0.1,
      color: "#10111A",
      fontFamily
    } as TypographyStyle,
    title: {
      fontSize: 18,
      fontWeight: "700",
      lineHeight: 24,
      color: "#10111A",
      fontFamily
    } as TypographyStyle,
    subtitle: {
      fontSize: 16,
      fontWeight: "600",
      lineHeight: 22,
      color: "#4B5163",
      fontFamily
    } as TypographyStyle,
    body: {
      fontSize: 15,
      fontWeight: "400",
      lineHeight: 22,
      color: "#24263A",
      fontFamily
    } as TypographyStyle,
    bodyStrong: {
      fontSize: 15,
      fontWeight: "700",
      lineHeight: 22,
      color: "#10111A",
      fontFamily
    } as TypographyStyle,
    small: {
      fontSize: 13,
      fontWeight: "500",
      lineHeight: 18,
      color: "#4B5163",
      fontFamily
    } as TypographyStyle,
    caption: {
      fontSize: 12,
      fontWeight: "500",
      lineHeight: 16,
      color: "#8E94A3",
      letterSpacing: 0.3,
      fontFamily
    } as TypographyStyle,
    micro: {
      fontSize: 10,
      fontWeight: "700",
      lineHeight: 12,
      color: "#8E94A3",
      letterSpacing: 0.7,
      fontFamily
    } as TypographyStyle,
    button: {
      fontSize: 14,
      fontWeight: "800",
      lineHeight: 18,
      letterSpacing: 0.6,
      color: "#FFFFFF",
      fontFamily
    } as TypographyStyle,
    tab: {
      fontSize: 12,
      fontWeight: "700",
      lineHeight: 16,
      letterSpacing: 0.2,
      color: "#4B5163",
      fontFamily
    } as TypographyStyle
  },
  transitions: {
    fast: { duration: 160, useNativeDriver: true },
    smooth: { duration: 280, useNativeDriver: true },
    slow: { duration: 420, useNativeDriver: true },
    spring: { tension: 70, friction: 12, useNativeDriver: true },
    bounce: { tension: 130, friction: 8, useNativeDriver: true },
    softSpring: { tension: 45, friction: 14, useNativeDriver: true }
  },
  layout: {
    screenPadding: 20,
    cardPadding: 16,
    headerHeight: 56,
    bottomTabHeight: 72,
    buttonHeight: 52,
    inputHeight: 50,
    avatar: {
      xs: 24,
      sm: 32,
      md: 44,
      lg: 64,
      xl: 96
    },
    icon: {
      xs: 14,
      sm: 18,
      md: 22,
      lg: 28,
      xl: 36
    }
  },
  zIndex: {
    base: 1,
    card: 5,
    header: 20,
    tab: 30,
    overlay: 50,
    modal: 100,
    toast: 200,
    loader: 300
  },
  opacity: {
    disabled: 0.45,
    muted: 0.65,
    pressed: 0.82,
    overlay: 0.55,
    glass: 0.88
  },
  borders: {
    hairline: StyleSheet.hairlineWidth,
    thin: 1,
    medium: 1.5,
    thick: 2
  }
} as const;

export type Theme = typeof theme;
export type ThemeColors = keyof typeof theme.colors;
export type ThemeGradients = keyof typeof theme.gradients;
export type ThemeSpacing = keyof typeof theme.spacing;
export type ThemeRadius = keyof typeof theme.radius;
export type ThemeTypography = keyof typeof theme.typography;
export type ThemeShadow = keyof typeof theme.shadows;

export const createThemedStyles = <T extends StyleSheet.NamedStyles<T>>(
  styles: (themeValue: typeof theme) => T
) => StyleSheet.create(styles(theme));

export const hexToRgba = (hex: string, alpha = 1) => {
  const cleanHex = hex.replace("#", "");
  const bigint = parseInt(cleanHex.length === 3 ? cleanHex.split("").map((x) => x + x).join("") : cleanHex, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
};

export const withOpacity = (color: string, opacity: number) => {
  if (color.startsWith("rgba")) return color;
  if (color.startsWith("#")) return hexToRgba(color, opacity);
  return color;
};
