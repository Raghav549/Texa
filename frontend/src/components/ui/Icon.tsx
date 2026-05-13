import React, { memo, useEffect, useMemo, useRef } from 'react';
import { Animated, Easing, StyleProp, ViewStyle } from 'react-native';
import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  RadialGradient,
  Rect,
  Stop
} from 'react-native-svg';
import { theme } from '../../theme';

export type IconName =
  | 'home'
  | 'voice'
  | 'reels'
  | 'chat'
  | 'profile'
  | 'search'
  | 'bell'
  | 'mic'
  | 'micOff'
  | 'hand'
  | 'gift'
  | 'crown'
  | 'star'
  | 'rocket'
  | 'cart'
  | 'store'
  | 'settings'
  | 'logout'
  | 'shield'
  | 'chart'
  | 'close'
  | 'shop'
  | 'heart'
  | 'plus'
  | 'minus'
  | 'trash'
  | 'back'
  | 'send'
  | 'lock'
  | 'unlock'
  | 'users'
  | 'spark'
  | 'analytics'
  | 'dashboard'
  | 'wallet'
  | 'order'
  | 'product'
  | 'camera'
  | 'video'
  | 'play'
  | 'pause'
  | 'music'
  | 'poll'
  | 'pin'
  | 'invite'
  | 'kick'
  | 'muteAll'
  | 'unmuteAll'
  | 'transfer'
  | 'notice'
  | 'live'
  | 'verified'
  | 'location'
  | 'filter'
  | 'sort'
  | 'refresh'
  | 'chevronRight'
  | 'chevronLeft'
  | 'chevronUp'
  | 'chevronDown'
  | 'more'
  | 'eye'
  | 'eyeOff'
  | 'edit'
  | 'save'
  | 'calendar'
  | 'clock'
  | 'warning'
  | 'info'
  | 'success'
  | 'error'
  | 'wifi'
  | 'wifiOff'
  | 'globe'
  | 'language'
  | 'support'
  | 'call'
  | 'mail'
  | 'copy'
  | 'share'
  | 'download'
  | 'upload'
  | 'coin'
  | 'diamond'
  | 'premium'
  | 'badge';

export type IconAnimation = 'pulse' | 'spin' | 'bounce' | 'float' | 'blink' | 'none';

export type IconVariant = 'line' | 'duo' | 'solid' | 'glass';

export interface IconProps {
  name: IconName;
  size?: number;
  color?: string;
  secondaryColor?: string;
  accentColor?: string;
  strokeWidth?: number;
  animate?: IconAnimation;
  variant?: IconVariant;
  active?: boolean;
  disabled?: boolean;
  badge?: boolean | number | string;
  style?: StyleProp<ViewStyle>;
}

type IconPath = {
  d: string;
  fill?: boolean;
  opacity?: number;
};

const AnimatedSvg = Animated.createAnimatedComponent(Svg);

const fallbackTheme = {
  ink: '#111827',
  muted: '#8A8A8A',
  gold: '#D4A857',
  cyan: '#00E0FF',
  violet: '#7C3DFF',
  red: '#FF3B5F',
  green: '#18C37E',
  white: '#FFFFFF'
};

const palette = {
  ink: theme.colors?.ink || theme.colors?.black || fallbackTheme.ink,
  muted: theme.colors?.gray || theme.colors?.softGray || fallbackTheme.muted,
  gold: theme.colors?.premiumGold || theme.colors?.gold || fallbackTheme.gold,
  cyan: theme.colors?.neonCyan || theme.colors?.neon || fallbackTheme.cyan,
  violet: theme.colors?.electricViolet || fallbackTheme.violet,
  red: theme.colors?.danger || fallbackTheme.red,
  green: theme.colors?.success || fallbackTheme.green,
  white: fallbackTheme.white
};

const ICON_PATHS: Record<IconName, IconPath[]> = {
  home: [
    { d: 'M3.4 11.6L12 4l8.6 7.6' },
    { d: 'M5.4 10.2v9.1c0 .6.5 1.1 1.1 1.1h3.2v-5.3c0-.6.5-1.1 1.1-1.1h2.4c.6 0 1.1.5 1.1 1.1v5.3h3.2c.6 0 1.1-.5 1.1-1.1v-9.1' },
    { d: 'M9.1 20.4h5.8' }
  ],
  voice: [
    { d: 'M12 2.4a3.2 3.2 0 00-3.2 3.2v5.8a3.2 3.2 0 006.4 0V5.6A3.2 3.2 0 0012 2.4z' },
    { d: 'M5.7 10.6v1.1a6.3 6.3 0 0012.6 0v-1.1' },
    { d: 'M12 18v3.6' },
    { d: 'M8.6 21.6h6.8' }
  ],
  reels: [
    { d: 'M5.6 4.2h12.8a2.2 2.2 0 012.2 2.2v11.2a2.2 2.2 0 01-2.2 2.2H5.6a2.2 2.2 0 01-2.2-2.2V6.4a2.2 2.2 0 012.2-2.2z' },
    { d: 'M8 4.2l3.2 5.2' },
    { d: 'M14.1 4.2l3.2 5.2' },
    { d: 'M3.7 9.4h16.6' },
    { d: 'M10.2 12.3v4.2l4.2-2.1-4.2-2.1z', fill: true, opacity: 0.95 }
  ],
  chat: [
    { d: 'M4 6.4a7.5 7.5 0 0115.9 5.1c0 4.2-3.8 7.6-8.5 7.6-1.1 0-2.1-.2-3.1-.5L4 20l1.2-3.3A7.1 7.1 0 014 11.5V6.4z' },
    { d: 'M8.2 11.7h.1M12 11.7h.1M15.8 11.7h.1' }
  ],
  profile: [
    { d: 'M12 11.5a4.1 4.1 0 100-8.2 4.1 4.1 0 000 8.2z' },
    { d: 'M4.8 20.7a7.2 7.2 0 0114.4 0' }
  ],
  search: [
    { d: 'M10.7 18.2a7.5 7.5 0 100-15 7.5 7.5 0 000 15z' },
    { d: 'M16.1 16.1l4.5 4.5' }
  ],
  bell: [
    { d: 'M18.2 10.3a6.2 6.2 0 00-12.4 0v3.2c0 .8-.3 1.5-.9 2.1L4 16.5h16l-.9-.9a3 3 0 01-.9-2.1v-3.2z' },
    { d: 'M9.2 19a2.9 2.9 0 005.6 0' },
    { d: 'M12 3.1V2' }
  ],
  mic: [
    { d: 'M12 2.5a3 3 0 00-3 3v6.3a3 3 0 006 0V5.5a3 3 0 00-3-3z' },
    { d: 'M5.6 10.8v1.2a6.4 6.4 0 0012.8 0v-1.2' },
    { d: 'M12 18.4v3.1' },
    { d: 'M8.6 21.5h6.8' }
  ],
  micOff: [
    { d: 'M4 4l16 16' },
    { d: 'M9.1 5.8v5.9a2.9 2.9 0 004.4 2.5' },
    { d: 'M14.9 10.6V5.5a2.9 2.9 0 00-5.1-1.9' },
    { d: 'M5.6 10.8v1.2a6.4 6.4 0 009.4 5.7' },
    { d: 'M18.4 10.8v1.2c0 1.1-.3 2.1-.8 3' },
    { d: 'M12 18.4v3.1M8.6 21.5h6.8' }
  ],
  hand: [
    { d: 'M8.2 12.2V5.8a1.6 1.6 0 013.2 0v5.1' },
    { d: 'M11.4 11V4.7a1.6 1.6 0 013.2 0v6.5' },
    { d: 'M14.6 11.5V6.2a1.5 1.5 0 013 0v7.1' },
    { d: 'M17.6 13.2V9.1a1.5 1.5 0 013 0v5.8c0 4.3-2.9 6.8-7 6.8h-1.3c-2.4 0-4.1-1.2-5.4-3.2L3.7 13a1.7 1.7 0 013-1.6l1.5 2.4' }
  ],
  gift: [
    { d: 'M4.2 10h15.6v10.2H4.2V10z' },
    { d: 'M3.2 7h17.6v3H3.2V7z' },
    { d: 'M12 7v13.2' },
    { d: 'M12 7c-1.2-2.7-4.8-3.1-5.2-.9C6.5 7.9 9.3 7 12 7z' },
    { d: 'M12 7c1.2-2.7 4.8-3.1 5.2-.9.3 1.8-2.5.9-5.2.9z' }
  ],
  crown: [
    { d: 'M3.2 6.2l4.2 5.2L12 4l4.6 7.4 4.2-5.2-2.2 11.2H5.4L3.2 6.2z' },
    { d: 'M5.8 20h12.4' }
  ],
  star: [
    { d: 'M12 2.8l2.8 5.7 6.3.9-4.6 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2-4.6-4.4 6.3-.9L12 2.8z' }
  ],
  rocket: [
    { d: 'M12.2 14.9l-3.1-3.1c.7-2.1 1.9-4.2 3.5-5.8 2.4-2.4 5.4-3.4 8.2-3.5-.1 2.8-1.1 5.8-3.5 8.2-1.6 1.6-3.7 2.8-5.1 4.2z' },
    { d: 'M9.1 11.8H4.3s.4-2.8 1.7-4c1.5-1.4 5.1-1 5.1-1' },
    { d: 'M12.2 14.9v4.8s2.8-.4 4-1.7c1.4-1.5 1-5.1 1-5.1' },
    { d: 'M7.2 16.8c-1.6 1.2-2.2 4.6-2.2 4.6s3.4-.6 4.6-2.2c.7-.9.6-2.1-.2-2.8-.7-.8-2-.8-2.2.4z' }
  ],
  cart: [
    { d: 'M3.2 3.8h2.1l1.7 10.4a2.1 2.1 0 002.1 1.8h7.8a2.1 2.1 0 002-1.5l1.5-5.7H6.1' },
    { d: 'M9.2 20.2a1.5 1.5 0 100-3 1.5 1.5 0 000 3zM17.2 20.2a1.5 1.5 0 100-3 1.5 1.5 0 000 3z' }
  ],
  store: [
    { d: 'M4.2 10.1h15.6l-1-4.7H5.2l-1 4.7z' },
    { d: 'M5.4 10.1v10h13.2v-10' },
    { d: 'M8.1 20.1v-5.5h3.3v5.5' },
    { d: 'M14.1 14.6h2.7v2.7h-2.7z' },
    { d: 'M4.2 10.1c0 1.3 1 2.3 2.3 2.3s2.3-1 2.3-2.3M8.8 10.1c0 1.3 1 2.3 2.3 2.3s2.3-1 2.3-2.3M13.4 10.1c0 1.3 1 2.3 2.3 2.3s2.3-1 2.3-2.3M18 10.1c0 1.3.8 2.3 1.8 2.3' }
  ],
  settings: [
    { d: 'M12 15.4a3.4 3.4 0 100-6.8 3.4 3.4 0 000 6.8z' },
    { d: 'M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.5-2.4 1a8.4 8.4 0 00-2.6-1.5L14.1 2h-4.2l-.4 2.5A8.4 8.4 0 006.9 6L4.5 5 2.5 8.5l2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5 2 3.5 2.4-1a8.4 8.4 0 002.6 1.5l.4 2.5h4.2l.4-2.5a8.4 8.4 0 002.6-1.5l2.4 1 2-3.5-2.1-1.5z' }
  ],
  logout: [
    { d: 'M9.4 20.4H5.6a2 2 0 01-2-2V5.6a2 2 0 012-2h3.8' },
    { d: 'M15.4 16.5L20 12l-4.6-4.5' },
    { d: 'M20 12H9.2' }
  ],
  shield: [
    { d: 'M12 2.8l7.6 3v5.8c0 4.8-3.2 8.4-7.6 9.8-4.4-1.4-7.6-5-7.6-9.8V5.8l7.6-3z' },
    { d: 'M8.5 12l2.3 2.3 4.9-5' }
  ],
  chart: [
    { d: 'M4.4 19.8V5.2' },
    { d: 'M4.4 19.8h15.2' },
    { d: 'M7.5 16.8v-4.5' },
    { d: 'M12 16.8V8.4' },
    { d: 'M16.5 16.8v-7' }
  ],
  close: [
    { d: 'M6.2 6.2l11.6 11.6' },
    { d: 'M17.8 6.2L6.2 17.8' }
  ],
  shop: [
    { d: 'M5 10.3h14v9.5H5v-9.5z' },
    { d: 'M4 10.3l1.4-5.7h13.2l1.4 5.7' },
    { d: 'M8.3 19.8v-5h7.4v5' },
    { d: 'M4.1 10.3c.2 1.2 1.1 2 2.3 2s2.1-.8 2.3-2c.2 1.2 1.1 2 2.3 2s2.1-.8 2.3-2c.2 1.2 1.1 2 2.3 2s2.1-.8 2.3-2c.2 1.2 1.1 2 2.1 2' }
  ],
  heart: [
    { d: 'M20.3 5.7a5 5 0 00-7.1 0L12 6.9l-1.2-1.2a5 5 0 00-7.1 7.1L12 21.1l8.3-8.3a5 5 0 000-7.1z' }
  ],
  plus: [
    { d: 'M12 5v14' },
    { d: 'M5 12h14' }
  ],
  minus: [
    { d: 'M5 12h14' }
  ],
  trash: [
    { d: 'M4.5 7h15' },
    { d: 'M9.5 7V4.8h5V7' },
    { d: 'M6.5 7l.8 13h9.4l.8-13' },
    { d: 'M10 10.4v6.4M14 10.4v6.4' }
  ],
  back: [
    { d: 'M15.5 5.5L9 12l6.5 6.5' },
    { d: 'M9.4 12H21' }
  ],
  send: [
    { d: 'M3.4 20.2L21 12 3.4 3.8l2.2 6.4L14 12l-8.4 1.8-2.2 6.4z' }
  ],
  lock: [
    { d: 'M7.2 10.2V7.6a4.8 4.8 0 019.6 0v2.6' },
    { d: 'M6.2 10.2h11.6v10H6.2v-10z' },
    { d: 'M12 14.1v2.3' }
  ],
  unlock: [
    { d: 'M7.2 10.2V7.6a4.8 4.8 0 018.2-3.4' },
    { d: 'M6.2 10.2h11.6v10H6.2v-10z' },
    { d: 'M12 14.1v2.3' }
  ],
  users: [
    { d: 'M9.2 11.2a3.6 3.6 0 100-7.2 3.6 3.6 0 000 7.2z' },
    { d: 'M2.8 20.2a6.4 6.4 0 0112.8 0' },
    { d: 'M17 11a3 3 0 10-1.2-5.8' },
    { d: 'M16.4 14.2a5.4 5.4 0 014.8 5.8' }
  ],
  spark: [
    { d: 'M12 2.8l1.4 5.3L18.7 10l-5.3 1.9L12 17.2l-1.4-5.3L5.3 10l5.3-1.9L12 2.8z' },
    { d: 'M19.5 14.5l.7 2.4 2.3.8-2.3.8-.7 2.4-.7-2.4-2.3-.8 2.3-.8.7-2.4z' },
    { d: 'M4.5 14.5l.5 1.8 1.8.6-1.8.6-.5 1.8-.5-1.8-1.8-.6 1.8-.6.5-1.8z' }
  ],
  analytics: [
    { d: 'M4 19.5h16' },
    { d: 'M6.5 16.5v-5' },
    { d: 'M12 16.5v-9' },
    { d: 'M17.5 16.5v-12' },
    { d: 'M5.8 7.8l4 3.1 4.1-5 4.3 2.7' }
  ],
  dashboard: [
    { d: 'M4 4.5h6.8v6.8H4V4.5z' },
    { d: 'M13.2 4.5H20v4.8h-6.8V4.5z' },
    { d: 'M13.2 11.7H20v7.8h-6.8v-7.8z' },
    { d: 'M4 13.7h6.8v5.8H4v-5.8z' }
  ],
  wallet: [
    { d: 'M4 7.2h15.2a1.8 1.8 0 011.8 1.8v9.2a1.8 1.8 0 01-1.8 1.8H4.8A2.8 2.8 0 012 17.2V6.8A2.8 2.8 0 014.8 4h12.4' },
    { d: 'M16.2 12h4.8v4.2h-4.8a2.1 2.1 0 010-4.2z' },
    { d: 'M17.4 14.1h.1' }
  ],
  order: [
    { d: 'M6 3.5h12v17H6v-17z' },
    { d: 'M8.8 7.5h6.4M8.8 11.5h6.4M8.8 15.5h3.4' }
  ],
  product: [
    { d: 'M12 2.8l8 4.4v9.6l-8 4.4-8-4.4V7.2l8-4.4z' },
    { d: 'M4.4 7.4L12 12l7.6-4.6' },
    { d: 'M12 12v9' }
  ],
  camera: [
    { d: 'M4.5 7.2h3l1.4-2h6.2l1.4 2h3a2 2 0 012 2v8.8a2 2 0 01-2 2h-15a2 2 0 01-2-2V9.2a2 2 0 012-2z' },
    { d: 'M12 16.8a4 4 0 100-8 4 4 0 000 8z' }
  ],
  video: [
    { d: 'M4 6.5h11.2a2 2 0 012 2v7a2 2 0 01-2 2H4a2 2 0 01-2-2v-7a2 2 0 012-2z' },
    { d: 'M17.2 10l4.8-2.8v9.6L17.2 14v-4z' }
  ],
  play: [
    { d: 'M8.2 5.2v13.6L19 12 8.2 5.2z', fill: true }
  ],
  pause: [
    { d: 'M7.2 5h3.6v14H7.2V5z', fill: true },
    { d: 'M13.2 5h3.6v14h-3.6V5z', fill: true }
  ],
  music: [
    { d: 'M9 18.2a2.8 2.8 0 11-2.8-2.8A2.8 2.8 0 019 18.2z' },
    { d: 'M20 16.2a2.8 2.8 0 11-2.8-2.8 2.8 2.8 0 012.8 2.8z' },
    { d: 'M9 18.2V6.2l11-2v12' },
    { d: 'M9 8.8l11-2' }
  ],
  poll: [
    { d: 'M5 19V9' },
    { d: 'M12 19V5' },
    { d: 'M19 19v-7' },
    { d: 'M3.5 19.5h17' }
  ],
  pin: [
    { d: 'M14.8 3.8l5.4 5.4-3.1 1.2-3.9 3.9.5 4.6-1.4 1.4-3.7-5.1-5.1-3.7 1.4-1.4 4.6.5 3.9-3.9 1.4-2.9z' },
    { d: 'M9.2 14.8L4 20' }
  ],
  invite: [
    { d: 'M9.2 11.2a3.6 3.6 0 100-7.2 3.6 3.6 0 000 7.2z' },
    { d: 'M2.8 20.2a6.4 6.4 0 0112.8 0' },
    { d: 'M18 8v6' },
    { d: 'M15 11h6' }
  ],
  kick: [
    { d: 'M7.4 18.8l3.2-7.2 3.7 1.6 2.5-5.7' },
    { d: 'M14.3 13.2l4.2 1.9a2 2 0 011 2.6l-.4.9a2 2 0 01-2.6 1l-5.8-2.6' },
    { d: 'M6.2 20.4h5.5' }
  ],
  muteAll: [
    { d: 'M4 9.5h3.2l4.1-3.4v11.8l-4.1-3.4H4V9.5z' },
    { d: 'M15.5 9l5 5' },
    { d: 'M20.5 9l-5 5' }
  ],
  unmuteAll: [
    { d: 'M4 9.5h3.2l4.1-3.4v11.8l-4.1-3.4H4V9.5z' },
    { d: 'M15.2 9.2a4.2 4.2 0 010 5.6' },
    { d: 'M17.8 6.8a7.8 7.8 0 010 10.4' }
  ],
  transfer: [
    { d: 'M3.5 7.5l3.6 4.3L12 5l4.9 6.8 3.6-4.3-1.9 9.2H5.4L3.5 7.5z' },
    { d: 'M7 20h10' },
    { d: 'M17.8 3.5l2.7 2.7-2.7 2.7' },
    { d: 'M20.5 6.2h-5.2' }
  ],
  notice: [
    { d: 'M4.2 10.2v3.6l3.8.8 7.2 4.1V5.3L8 9.4l-3.8.8z' },
    { d: 'M18.2 9.2a4.4 4.4 0 010 5.6' },
    { d: 'M20.5 7.2a7.7 7.7 0 010 9.6' }
  ],
  live: [
    { d: 'M12 15.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7z', fill: true },
    { d: 'M5.5 8.2a7.7 7.7 0 000 7.6' },
    { d: 'M18.5 8.2a7.7 7.7 0 010 7.6' },
    { d: 'M2.8 5.5a12.3 12.3 0 000 13' },
    { d: 'M21.2 5.5a12.3 12.3 0 010 13' }
  ],
  verified: [
    { d: 'M12 2.8l2.2 2.1 3-.3.4 3 2.1 2.2-1.4 2.7.7 2.9-2.8 1.2-1.2 2.8-3-.7-2.6 1.4-2.2-2.1-3 .3-.4-3-2.1-2.2 1.4-2.7-.7-2.9 2.8-1.2 1.2-2.8 3 .7L12 2.8z' },
    { d: 'M8.4 12.2l2.2 2.2 5-5' }
  ],
  location: [
    { d: 'M12 21s7-5.1 7-11.2a7 7 0 10-14 0C5 15.9 12 21 12 21z' },
    { d: 'M12 12.2a2.4 2.4 0 100-4.8 2.4 2.4 0 000 4.8z' }
  ],
  filter: [
    { d: 'M4 6h16' },
    { d: 'M7 12h10' },
    { d: 'M10 18h4' }
  ],
  sort: [
    { d: 'M7 5v14' },
    { d: 'M4.5 7.5L7 5l2.5 2.5' },
    { d: 'M17 19V5' },
    { d: 'M14.5 16.5L17 19l2.5-2.5' }
  ],
  refresh: [
    { d: 'M20 6v5h-5' },
    { d: 'M4 18v-5h5' },
    { d: 'M18.1 9A6.8 6.8 0 006.4 6.4L4 9' },
    { d: 'M5.9 15a6.8 6.8 0 0011.7 2.6L20 15' }
  ],
  chevronRight: [{ d: 'M9 5l7 7-7 7' }],
  chevronLeft: [{ d: 'M15 5l-7 7 7 7' }],
  chevronUp: [{ d: 'M5 15l7-7 7 7' }],
  chevronDown: [{ d: 'M5 9l7 7 7-7' }],
  more: [
    { d: 'M5 12h.1' },
    { d: 'M12 12h.1' },
    { d: 'M19 12h.1' }
  ],
  eye: [
    { d: 'M2.8 12s3.4-6.2 9.2-6.2 9.2 6.2 9.2 6.2-3.4 6.2-9.2 6.2S2.8 12 2.8 12z' },
    { d: 'M12 14.8a2.8 2.8 0 100-5.6 2.8 2.8 0 000 5.6z' }
  ],
  eyeOff: [
    { d: 'M3 3l18 18' },
    { d: 'M10.6 5.9c.5-.1.9-.1 1.4-.1 5.8 0 9.2 6.2 9.2 6.2a16.3 16.3 0 01-3.1 3.8' },
    { d: 'M14.1 14.1A2.8 2.8 0 019.9 9.9' },
    { d: 'M6.2 6.8A16.2 16.2 0 002.8 12s3.4 6.2 9.2 6.2c1.6 0 3-.4 4.2-1' }
  ],
  edit: [
    { d: 'M4.2 16.8v3h3l10.8-10.8-3-3L4.2 16.8z' },
    { d: 'M14.7 6.3l3 3' }
  ],
  save: [
    { d: 'M5 4h12l2 2v14H5V4z' },
    { d: 'M8 4v6h8V4' },
    { d: 'M8 20v-6h8v6' }
  ],
  calendar: [
    { d: 'M5.2 5.2h13.6a2 2 0 012 2v11.6a2 2 0 01-2 2H5.2a2 2 0 01-2-2V7.2a2 2 0 012-2z' },
    { d: 'M8 3.2v4M16 3.2v4M3.2 9.5h17.6' }
  ],
  clock: [
    { d: 'M12 21a9 9 0 100-18 9 9 0 000 18z' },
    { d: 'M12 7.2v5.1l3.4 2' }
  ],
  warning: [
    { d: 'M12 3.2l9 16H3l9-16z' },
    { d: 'M12 8.5v5.2M12 17h.1' }
  ],
  info: [
    { d: 'M12 21a9 9 0 100-18 9 9 0 000 18z' },
    { d: 'M12 10.5v6M12 7.2h.1' }
  ],
  success: [
    { d: 'M12 21a9 9 0 100-18 9 9 0 000 18z' },
    { d: 'M8 12.2l2.6 2.6 5.6-5.7' }
  ],
  error: [
    { d: 'M12 21a9 9 0 100-18 9 9 0 000 18z' },
    { d: 'M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4' }
  ],
  wifi: [
    { d: 'M4.2 9.2a12.2 12.2 0 0115.6 0' },
    { d: 'M7.2 12.4a7.4 7.4 0 019.6 0' },
    { d: 'M10.2 15.6a2.8 2.8 0 013.6 0' },
    { d: 'M12 19h.1' }
  ],
  wifiOff: [
    { d: 'M3 3l18 18' },
    { d: 'M4.2 9.2a12.2 12.2 0 0110.1-2.7' },
    { d: 'M7.2 12.4a7.4 7.4 0 015.5-1.9' },
    { d: 'M10.2 15.6a2.8 2.8 0 013.6 0' },
    { d: 'M18.2 9.2c.6.4 1.1.8 1.6 1.3' },
    { d: 'M12 19h.1' }
  ],
  globe: [
    { d: 'M12 21a9 9 0 100-18 9 9 0 000 18z' },
    { d: 'M3.4 12h17.2' },
    { d: 'M12 3c2.2 2.4 3.2 5.4 3.2 9s-1 6.6-3.2 9c-2.2-2.4-3.2-5.4-3.2-9s1-6.6 3.2-9z' }
  ],
  language: [
    { d: 'M4 5h9' },
    { d: 'M8.5 3v2' },
    { d: 'M6.5 5c.7 3.6 2.9 6.3 6.5 7.5' },
    { d: 'M12.5 5c-.8 3.6-3.1 6.5-7.5 8.4' },
    { d: 'M14 21l4.2-10h1.6L24 21' },
    { d: 'M15.3 18h5.4' }
  ],
  support: [
    { d: 'M4.2 12a7.8 7.8 0 0115.6 0v4.5a2.5 2.5 0 01-2.5 2.5h-2.1' },
    { d: 'M6.2 12h-1a2 2 0 00-2 2v1.2a2 2 0 002 2h1V12z' },
    { d: 'M17.8 12h1a2 2 0 012 2v1.2a2 2 0 01-2 2h-1V12z' },
    { d: 'M10.2 20h3.6' }
  ],
  call: [
    { d: 'M6.4 4.2l3 3-2.1 2.1c1.1 2.3 2.9 4.1 5.2 5.2l2.1-2.1 3 3-1.8 3.2c-.3.6-1 .9-1.7.7C8.5 18 4 13.5 2.7 7.9c-.2-.7.1-1.4.7-1.7l3-2z' }
  ],
  mail: [
    { d: 'M4.2 6.2h15.6a2 2 0 012 2v9.6a2 2 0 01-2 2H4.2a2 2 0 01-2-2V8.2a2 2 0 012-2z' },
    { d: 'M3 8l9 6 9-6' }
  ],
  copy: [
    { d: 'M8.2 8.2h11.6v11.6H8.2V8.2z' },
    { d: 'M4.2 15.8V4.2h11.6' }
  ],
  share: [
    { d: 'M18 8.2a3 3 0 100-6 3 3 0 000 6zM6 15a3 3 0 100-6 3 3 0 000 6zM18 21.8a3 3 0 100-6 3 3 0 000 6z' },
    { d: 'M8.7 13.5l6.6 3.8M15.3 6.7l-6.6 3.8' }
  ],
  download: [
    { d: 'M12 3v11' },
    { d: 'M7.5 10.5L12 15l4.5-4.5' },
    { d: 'M4.5 20.5h15' }
  ],
  upload: [
    { d: 'M12 21V10' },
    { d: 'M7.5 13.5L12 9l4.5 4.5' },
    { d: 'M4.5 3.5h15' }
  ],
  coin: [
    { d: 'M12 8.2c4.4 0 8-1.4 8-3.1S16.4 2 12 2 4 3.4 4 5.1s3.6 3.1 8 3.1z' },
    { d: 'M4 5.1v5.1c0 1.7 3.6 3.1 8 3.1s8-1.4 8-3.1V5.1' },
    { d: 'M4 10.2v5.1c0 1.7 3.6 3.1 8 3.1s8-1.4 8-3.1v-5.1' },
    { d: 'M4 15.3v3.6C4 20.6 7.6 22 12 22s8-1.4 8-3.1v-3.6' }
  ],
  diamond: [
    { d: 'M6.2 4.5h11.6l3.2 5.2L12 21 3 9.7l3.2-5.2z' },
    { d: 'M3 9.7h18' },
    { d: 'M8.2 4.5L12 21l3.8-16.5' }
  ],
  premium: [
    { d: 'M12 2.5l2.7 5.5 6.1.9-4.4 4.3 1 6.1L12 16.4l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 2.5z' },
    { d: 'M8.5 21h7' }
  ],
  badge: [
    { d: 'M12 2.8l2.2 2.1 3-.3.4 3 2.1 2.2-1.4 2.7.7 2.9-2.8 1.2-1.2 2.8-3-.7-2.6 1.4-2.2-2.1-3 .3-.4-3-2.1-2.2 1.4-2.7-.7-2.9 2.8-1.2 1.2-2.8 3 .7L12 2.8z' }
  ]
};

function getColor(name: IconName, color?: string, active?: boolean, disabled?: boolean) {
  if (disabled) return palette.muted;
  if (color) return color;
  if (active) return palette.gold;
  if (name === 'live' || name === 'error' || name === 'warning') return palette.red;
  if (name === 'success' || name === 'verified') return palette.green;
  if (name === 'voice' || name === 'mic' || name === 'chat') return palette.cyan;
  if (name === 'crown' || name === 'premium' || name === 'badge' || name === 'coin') return palette.gold;
  return palette.ink;
}

function getSecondaryColor(name: IconName, secondaryColor?: string, active?: boolean) {
  if (secondaryColor) return secondaryColor;
  if (active) return palette.cyan;
  if (name === 'crown' || name === 'premium' || name === 'badge' || name === 'coin') return palette.violet;
  if (name === 'warning' || name === 'error') return palette.gold;
  if (name === 'success' || name === 'verified') return palette.cyan;
  return palette.gold;
}

function getAnimationStyle(
  animate: IconAnimation,
  scaleAnim: Animated.Value,
  rotateAnim: Animated.Value,
  translateAnim: Animated.Value,
  opacityAnim: Animated.Value
) {
  if (animate === 'pulse') return { transform: [{ scale: scaleAnim }] };
  if (animate === 'spin') {
    return {
      transform: [
        {
          rotate: rotateAnim.interpolate({
            inputRange: [0, 1],
            outputRange: ['0deg', '360deg']
          })
        }
      ]
    };
  }
  if (animate === 'bounce' || animate === 'float') return { transform: [{ translateY: translateAnim }] };
  if (animate === 'blink') return { opacity: opacityAnim };
  return null;
}

function useIconAnimation(animate: IconAnimation) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const translateAnim = useRef(new Animated.Value(0)).current;
  const opacityAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    scaleAnim.stopAnimation();
    rotateAnim.stopAnimation();
    translateAnim.stopAnimation();
    opacityAnim.stopAnimation();

    scaleAnim.setValue(1);
    rotateAnim.setValue(0);
    translateAnim.setValue(0);
    opacityAnim.setValue(1);

    let animation: Animated.CompositeAnimation | null = null;

    if (animate === 'pulse') {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(scaleAnim, {
            toValue: 1.14,
            duration: 620,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true
          }),
          Animated.timing(scaleAnim, {
            toValue: 1,
            duration: 620,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true
          })
        ])
      );
    }

    if (animate === 'spin') {
      animation = Animated.loop(
        Animated.timing(rotateAnim, {
          toValue: 1,
          duration: 900,
          easing: Easing.linear,
          useNativeDriver: true
        })
      );
    }

    if (animate === 'bounce') {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(translateAnim, {
            toValue: -3,
            duration: 360,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true
          }),
          Animated.timing(translateAnim, {
            toValue: 0,
            duration: 360,
            easing: Easing.in(Easing.quad),
            useNativeDriver: true
          })
        ])
      );
    }

    if (animate === 'float') {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(translateAnim, {
            toValue: -2,
            duration: 900,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true
          }),
          Animated.timing(translateAnim, {
            toValue: 2,
            duration: 900,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true
          }),
          Animated.timing(translateAnim, {
            toValue: 0,
            duration: 900,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true
          })
        ])
      );
    }

    if (animate === 'blink') {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(opacityAnim, {
            toValue: 0.35,
            duration: 520,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true
          }),
          Animated.timing(opacityAnim, {
            toValue: 1,
            duration: 520,
            easing: Easing.inOut(Easing.quad),
            useNativeDriver: true
          })
        ])
      );
    }

    animation?.start();

    return () => {
      animation?.stop();
    };
  }, [animate, opacityAnim, rotateAnim, scaleAnim, translateAnim]);

  return { scaleAnim, rotateAnim, translateAnim, opacityAnim };
}

function Icon({
  name,
  size = 24,
  color,
  secondaryColor,
  accentColor,
  strokeWidth = 2,
  animate = 'none',
  variant = 'line',
  active = false,
  disabled = false,
  badge = false,
  style
}: IconProps) {
  const paths = ICON_PATHS[name] || ICON_PATHS.info;
  const primary = getColor(name, color, active, disabled);
  const secondary = getSecondaryColor(name, secondaryColor, active);
  const accent = accentColor || palette.white;
  const opacity = disabled ? 0.45 : 1;
  const id = useMemo(() => `${name}_${Math.random().toString(36).slice(2, 10)}`, [name]);
  const { scaleAnim, rotateAnim, translateAnim, opacityAnim } = useIconAnimation(disabled ? 'none' : animate);
  const animatedStyle = getAnimationStyle(animate, scaleAnim, rotateAnim, translateAnim, opacityAnim);

  const showDuo = variant === 'duo' || variant === 'solid' || variant === 'glass';
  const showGlass = variant === 'glass';
  const showSolid = variant === 'solid';

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          width: size,
          height: size,
          opacity
        },
        animatedStyle,
        style
      ]}
    >
      <AnimatedSvg width={size} height={size} viewBox="0 0 24 24">
        <Defs>
          <LinearGradient id={`${id}_grad`} x1="2" y1="2" x2="22" y2="22">
            <Stop offset="0" stopColor={primary} stopOpacity="1" />
            <Stop offset="1" stopColor={secondary} stopOpacity="1" />
          </LinearGradient>
          <RadialGradient id={`${id}_glow`} cx="50%" cy="35%" r="70%">
            <Stop offset="0" stopColor={accent} stopOpacity="0.85" />
            <Stop offset="0.45" stopColor={primary} stopOpacity="0.18" />
            <Stop offset="1" stopColor={secondary} stopOpacity="0.04" />
          </RadialGradient>
        </Defs>

        {showGlass && (
          <Rect
            x="1.2"
            y="1.2"
            width="21.6"
            height="21.6"
            rx="7"
            fill={`url(#${id}_glow)`}
            stroke={primary}
            strokeOpacity={0.14}
            strokeWidth={1}
          />
        )}

        {showDuo && !showSolid && !showGlass && (
          <Circle cx="12" cy="12" r="10.2" fill={secondary} opacity={0.08} />
        )}

        {showSolid && (
          <Circle cx="12" cy="12" r="10.4" fill={`url(#${id}_grad)`} opacity={0.95} />
        )}

        <G
          fill="none"
          stroke={showSolid ? accent : showDuo ? `url(#${id}_grad)` : primary}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          {paths.map((path, index) =>
            path.fill ? (
              <Path
                key={`${name}_${index}`}
                d={path.d}
                fill={showSolid ? accent : showDuo ? `url(#${id}_grad)` : primary}
                stroke="none"
                opacity={typeof path.opacity === 'number' ? path.opacity : 1}
              />
            ) : (
              <Path
                key={`${name}_${index}`}
                d={path.d}
                opacity={typeof path.opacity === 'number' ? path.opacity : 1}
              />
            )
          )}
        </G>

        {badge !== false && badge !== undefined && badge !== null && (
          <G>
            <Circle cx="18.5" cy="5.5" r="4.1" fill={palette.red} stroke={palette.white} strokeWidth="1.2" />
            {typeof badge === 'boolean' ? (
              <Circle cx="18.5" cy="5.5" r="1.2" fill={palette.white} />
            ) : null}
          </G>
        )}
      </AnimatedSvg>
    </Animated.View>
  );
}

export const AppIcon = memo(Icon);
export const ProIcon = memo(Icon);
export const VoiceIcon = memo(Icon);
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

export default memo(Icon);
