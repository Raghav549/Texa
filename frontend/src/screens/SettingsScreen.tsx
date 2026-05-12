import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  Switch,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  Alert,
  Animated,
  Easing,
  StatusBar,
  Platform,
  ActivityIndicator,
  Pressable,
} from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { theme } from '../theme';

type SettingsPayloadKey =
  | 'notificationSettings'
  | 'privacySettings'
  | 'safetySettings'
  | 'displaySettings'
  | 'theme'
  | 'twoFactorEnabled';

type IconName =
  | 'profile'
  | 'lock'
  | 'shield'
  | 'globe'
  | 'storage'
  | 'eye'
  | 'trash'
  | 'ban'
  | 'warning'
  | 'bell'
  | 'mail'
  | 'chat'
  | 'moon'
  | 'palette'
  | 'spark'
  | 'chart'
  | 'coin'
  | 'trend'
  | 'help'
  | 'info'
  | 'document'
  | 'logout'
  | 'chevron'
  | 'device'
  | 'download'
  | 'key'
  | 'crown';

const safeColors = {
  bg: '#07080D',
  card: '#10131D',
  card2: '#151927',
  card3: '#1B2133',
  text: '#F8FAFC',
  muted: '#9AA4B2',
  soft: '#CBD5E1',
  border: 'rgba(255,255,255,0.09)',
  gold: theme?.colors?.gold || '#F7C948',
  neon: theme?.colors?.neon || '#22F5C5',
  danger: '#FF4D67',
  warning: '#FFB020',
  blue: '#6EA8FF',
  purple: '#A78BFA',
};

function CustomIcon({ name, active, danger, size = 28 }: { name: IconName; active?: boolean; danger?: boolean; size?: number }) {
  const c = danger ? safeColors.danger : active ? safeColors.neon : safeColors.gold;
  const s = size;
  const stroke = Math.max(2, Math.round(size * 0.08));

  if (name === 'profile') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.iconHead, { borderColor: c, width: s * 0.28, height: s * 0.28, borderRadius: s * 0.14, borderWidth: stroke }]} />
        <View style={[styles.iconBody, { borderColor: c, width: s * 0.58, height: s * 0.32, borderRadius: s * 0.18, borderWidth: stroke }]} />
      </View>
    );
  }

  if (name === 'lock') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.lockArc, { borderColor: c, width: s * 0.48, height: s * 0.42, borderRadius: s * 0.22, borderWidth: stroke }]} />
        <View style={[styles.lockBase, { backgroundColor: c, width: s * 0.62, height: s * 0.45, borderRadius: s * 0.12 }]} />
        <View style={[styles.lockDot, { backgroundColor: safeColors.bg, width: s * 0.08, height: s * 0.18, borderRadius: s * 0.05 }]} />
      </View>
    );
  }

  if (name === 'shield') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.shield, { borderColor: c, width: s * 0.62, height: s * 0.72, borderWidth: stroke }]} />
        <View style={[styles.shieldLine, { backgroundColor: c, width: s * 0.28, height: stroke }]} />
      </View>
    );
  }

  if (name === 'globe') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.globeCircle, { borderColor: c, width: s * 0.7, height: s * 0.7, borderRadius: s * 0.35, borderWidth: stroke }]} />
        <View style={[styles.globeLineH, { backgroundColor: c, width: s * 0.58, height: stroke }]} />
        <View style={[styles.globeLineV, { backgroundColor: c, width: stroke, height: s * 0.58 }]} />
      </View>
    );
  }

  if (name === 'storage') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.diskTop, { borderColor: c, width: s * 0.68, height: s * 0.28, borderRadius: s * 0.15, borderWidth: stroke }]} />
        <View style={[styles.diskMid, { borderColor: c, width: s * 0.68, height: s * 0.28, borderRadius: s * 0.15, borderWidth: stroke }]} />
        <View style={[styles.diskBot, { borderColor: c, width: s * 0.68, height: s * 0.28, borderRadius: s * 0.15, borderWidth: stroke }]} />
      </View>
    );
  }

  if (name === 'eye') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.eyeOuter, { borderColor: c, width: s * 0.76, height: s * 0.44, borderRadius: s * 0.25, borderWidth: stroke }]} />
        <View style={[styles.eyeDot, { backgroundColor: c, width: s * 0.18, height: s * 0.18, borderRadius: s * 0.09 }]} />
      </View>
    );
  }

  if (name === 'trash') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.trashLid, { backgroundColor: c, width: s * 0.54, height: stroke }]} />
        <View style={[styles.trashBody, { borderColor: c, width: s * 0.5, height: s * 0.58, borderRadius: s * 0.08, borderWidth: stroke }]} />
        <View style={[styles.trashLine, { backgroundColor: c, height: s * 0.34, width: stroke, left: s * 0.38 }]} />
        <View style={[styles.trashLine, { backgroundColor: c, height: s * 0.34, width: stroke, right: s * 0.38 }]} />
      </View>
    );
  }

  if (name === 'ban') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.banCircle, { borderColor: c, width: s * 0.72, height: s * 0.72, borderRadius: s * 0.36, borderWidth: stroke }]} />
        <View style={[styles.banSlash, { backgroundColor: c, width: s * 0.58, height: stroke, transform: [{ rotate: '-38deg' }] }]} />
      </View>
    );
  }

  if (name === 'warning') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.warningTri, { borderBottomColor: c, borderLeftWidth: s * 0.34, borderRightWidth: s * 0.34, borderBottomWidth: s * 0.64 }]} />
        <View style={[styles.warningLine, { backgroundColor: safeColors.bg, width: stroke, height: s * 0.22 }]} />
        <View style={[styles.warningDot, { backgroundColor: safeColors.bg, width: stroke * 1.4, height: stroke * 1.4, borderRadius: stroke }]} />
      </View>
    );
  }

  if (name === 'bell') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.bellDome, { borderColor: c, width: s * 0.58, height: s * 0.58, borderTopLeftRadius: s * 0.3, borderTopRightRadius: s * 0.3, borderWidth: stroke }]} />
        <View style={[styles.bellBase, { backgroundColor: c, width: s * 0.68, height: stroke }]} />
        <View style={[styles.bellDot, { backgroundColor: c, width: s * 0.14, height: s * 0.14, borderRadius: s * 0.07 }]} />
      </View>
    );
  }

  if (name === 'mail') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.mailBox, { borderColor: c, width: s * 0.74, height: s * 0.52, borderRadius: s * 0.08, borderWidth: stroke }]} />
        <View style={[styles.mailFlapA, { backgroundColor: c, width: s * 0.42, height: stroke, transform: [{ rotate: '32deg' }] }]} />
        <View style={[styles.mailFlapB, { backgroundColor: c, width: s * 0.42, height: stroke, transform: [{ rotate: '-32deg' }] }]} />
      </View>
    );
  }

  if (name === 'chat') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.chatBubble, { borderColor: c, width: s * 0.72, height: s * 0.52, borderRadius: s * 0.16, borderWidth: stroke }]} />
        <View style={[styles.chatTail, { borderTopColor: c, borderLeftWidth: s * 0.12, borderRightWidth: s * 0.04, borderTopWidth: s * 0.14 }]} />
      </View>
    );
  }

  if (name === 'moon') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.moonOuter, { backgroundColor: c, width: s * 0.62, height: s * 0.62, borderRadius: s * 0.31 }]} />
        <View style={[styles.moonCut, { backgroundColor: safeColors.card, width: s * 0.54, height: s * 0.54, borderRadius: s * 0.27 }]} />
      </View>
    );
  }

  if (name === 'palette') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.palette, { borderColor: c, width: s * 0.72, height: s * 0.62, borderRadius: s * 0.28, borderWidth: stroke }]} />
        <View style={[styles.paletteDot, { backgroundColor: c, top: s * 0.24, left: s * 0.26 }]} />
        <View style={[styles.paletteDot, { backgroundColor: c, top: s * 0.2, right: s * 0.26 }]} />
        <View style={[styles.paletteDot, { backgroundColor: c, bottom: s * 0.24, left: s * 0.34 }]} />
      </View>
    );
  }

  if (name === 'spark') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.sparkV, { backgroundColor: c, height: s * 0.72, width: stroke }]} />
        <View style={[styles.sparkH, { backgroundColor: c, width: s * 0.72, height: stroke }]} />
        <View style={[styles.sparkD, { backgroundColor: c, width: s * 0.5, height: stroke, transform: [{ rotate: '45deg' }] }]} />
        <View style={[styles.sparkD, { backgroundColor: c, width: s * 0.5, height: stroke, transform: [{ rotate: '-45deg' }] }]} />
      </View>
    );
  }

  if (name === 'chart' || name === 'trend') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.chartBar, { backgroundColor: c, height: s * 0.34, left: s * 0.22 }]} />
        <View style={[styles.chartBar, { backgroundColor: c, height: s * 0.52, left: s * 0.42 }]} />
        <View style={[styles.chartBar, { backgroundColor: c, height: s * 0.72, left: s * 0.62 }]} />
      </View>
    );
  }

  if (name === 'coin') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.coinOuter, { borderColor: c, width: s * 0.68, height: s * 0.68, borderRadius: s * 0.34, borderWidth: stroke }]} />
        <View style={[styles.coinInner, { backgroundColor: c, width: s * 0.26, height: s * 0.26, borderRadius: s * 0.13 }]} />
      </View>
    );
  }

  if (name === 'help') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.helpCircle, { borderColor: c, width: s * 0.7, height: s * 0.7, borderRadius: s * 0.35, borderWidth: stroke }]} />
        <Text style={[styles.helpText, { color: c, fontSize: s * 0.58 }]}>?</Text>
      </View>
    );
  }

  if (name === 'info') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.helpCircle, { borderColor: c, width: s * 0.7, height: s * 0.7, borderRadius: s * 0.35, borderWidth: stroke }]} />
        <Text style={[styles.helpText, { color: c, fontSize: s * 0.54 }]}>i</Text>
      </View>
    );
  }

  if (name === 'document') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.doc, { borderColor: c, width: s * 0.58, height: s * 0.72, borderRadius: s * 0.08, borderWidth: stroke }]} />
        <View style={[styles.docLine, { backgroundColor: c, width: s * 0.34, top: s * 0.3 }]} />
        <View style={[styles.docLine, { backgroundColor: c, width: s * 0.28, top: s * 0.43 }]} />
      </View>
    );
  }

  if (name === 'logout') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.logoutDoor, { borderColor: c, width: s * 0.42, height: s * 0.64, borderWidth: stroke }]} />
        <View style={[styles.logoutArrow, { backgroundColor: c, width: s * 0.44, height: stroke }]} />
        <View style={[styles.logoutHead, { borderLeftColor: c, borderTopWidth: s * 0.1, borderBottomWidth: s * 0.1, borderLeftWidth: s * 0.14 }]} />
      </View>
    );
  }

  if (name === 'device') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.device, { borderColor: c, width: s * 0.48, height: s * 0.76, borderRadius: s * 0.1, borderWidth: stroke }]} />
        <View style={[styles.deviceDot, { backgroundColor: c, width: s * 0.1, height: s * 0.1, borderRadius: s * 0.05 }]} />
      </View>
    );
  }

  if (name === 'download') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.downloadStem, { backgroundColor: c, width: stroke, height: s * 0.46 }]} />
        <View style={[styles.downloadHead, { borderTopColor: c, borderLeftWidth: s * 0.16, borderRightWidth: s * 0.16, borderTopWidth: s * 0.18 }]} />
        <View style={[styles.downloadBase, { backgroundColor: c, width: s * 0.58, height: stroke }]} />
      </View>
    );
  }

  if (name === 'key') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.keyRing, { borderColor: c, width: s * 0.34, height: s * 0.34, borderRadius: s * 0.17, borderWidth: stroke }]} />
        <View style={[styles.keyStem, { backgroundColor: c, width: s * 0.42, height: stroke }]} />
        <View style={[styles.keyTooth, { backgroundColor: c, width: stroke, height: s * 0.16 }]} />
      </View>
    );
  }

  if (name === 'crown') {
    return (
      <View style={[styles.iconBox, { width: s, height: s }]}>
        <View style={[styles.crownBase, { backgroundColor: c, width: s * 0.66, height: stroke * 1.3 }]} />
        <View style={[styles.crownPeak, { borderBottomColor: c, borderLeftWidth: s * 0.12, borderRightWidth: s * 0.12, borderBottomWidth: s * 0.28, left: s * 0.2 }]} />
        <View style={[styles.crownPeak, { borderBottomColor: c, borderLeftWidth: s * 0.14, borderRightWidth: s * 0.14, borderBottomWidth: s * 0.38, left: s * 0.36 }]} />
        <View style={[styles.crownPeak, { borderBottomColor: c, borderLeftWidth: s * 0.12, borderRightWidth: s * 0.12, borderBottomWidth: s * 0.28, right: s * 0.2 }]} />
      </View>
    );
  }

  return (
    <View style={[styles.iconBox, { width: s, height: s }]}>
      <View style={[styles.chevron, { borderColor: c, width: s * 0.34, height: s * 0.34, borderRightWidth: stroke, borderTopWidth: stroke }]} />
    </View>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionCard}>{children}</View>
    </View>
  );
}

function Row({
  label,
  description,
  value,
  onToggle,
  onPress,
  icon,
  destructive,
  disabled,
  loading,
}: {
  label: string;
  description?: string;
  value?: boolean;
  onToggle?: (value: boolean) => void | Promise<void>;
  onPress?: () => void;
  icon: IconName;
  destructive?: boolean;
  disabled?: boolean;
  loading?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  const pressIn = () => {
    Animated.spring(scale, { toValue: 0.985, useNativeDriver: true, speed: 22, bounciness: 6 }).start();
  };

  const pressOut = () => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 7 }).start();
  };

  return (
    <Animated.View style={{ transform: [{ scale }], opacity: disabled ? 0.55 : 1 }}>
      <Pressable
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        disabled={disabled || (!onPress && !onToggle)}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      >
        <View style={[styles.iconShell, destructive && styles.iconShellDanger]}>
          <CustomIcon name={icon} active={!!value} danger={destructive} size={25} />
        </View>
        <View style={styles.rowContent}>
          <Text style={[styles.rowLabel, destructive && styles.rowLabelDanger]}>{label}</Text>
          {!!description && <Text style={styles.rowDesc}>{description}</Text>}
        </View>
        {loading ? (
          <ActivityIndicator size="small" color={safeColors.neon} />
        ) : onToggle ? (
          <Switch
            value={!!value}
            onValueChange={onToggle}
            disabled={disabled}
            trackColor={{ false: '#293044', true: safeColors.neon }}
            thumbColor={value ? '#FFFFFF' : '#D6DCE7'}
            ios_backgroundColor="#293044"
          />
        ) : (
          <CustomIcon name="chevron" size={22} danger={destructive} />
        )}
      </Pressable>
    </Animated.View>
  );
}

export default function SettingsScreen() {
  const navigation = useNavigation<any>();
  const { user } = useAuth();
  const [push, setPush] = useState(user?.notificationSettings?.push ?? true);
  const [email, setEmail] = useState(user?.notificationSettings?.email ?? false);
  const [dark, setDark] = useState((user?.theme || 'dark') === 'dark');
  const [privateAcc, setPrivateAcc] = useState(user?.privacySettings?.privateAccount ?? false);
  const [hideOnline, setHideOnline] = useState(user?.privacySettings?.hideOnline ?? false);
  const [filterSpam, setFilterSpam] = useState(user?.safetySettings?.filterSpam ?? true);
  const [reduceMotion, setReduceMotion] = useState(user?.displaySettings?.reduceMotion ?? false);
  const [twoFA, setTwoFA] = useState(user?.twoFactorEnabled ?? false);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [logoutLoading, setLogoutLoading] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(18)).current;
  const glow = useRef(new Animated.Value(0)).current;

  useFocusEffect(
    useCallback(() => {
      StatusBar.setBarStyle('light-content');
      if (Platform.OS === 'android') StatusBar.setBackgroundColor(safeColors.bg);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(rise, { toValue: 0, duration: 420, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      ]).start();
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(glow, { toValue: 1, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
          Animated.timing(glow, { toValue: 0, duration: 1600, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
        ])
      );
      loop.start();
      return () => loop.stop();
    }, [fade, rise, glow])
  );

  const glowOpacity = glow.interpolate({ inputRange: [0, 1], outputRange: [0.18, 0.42] });

  const profileCompletion = useMemo(() => {
    const checks = [
      !!user?.avatarUrl,
      !!user?.fullName,
      !!user?.username,
      !!user?.bio,
      !!user?.email,
      !!user?.phone,
      !!twoFA,
      privateAcc !== undefined,
    ];
    return Math.round((checks.filter(Boolean).length / checks.length) * 100);
  }, [user, twoFA, privateAcc]);

  const updateSettings = async (key: SettingsPayloadKey, value: any, localRollback?: () => void) => {
    setSavingKey(key);
    try {
      await api.post('/user/settings', { [key]: value });
    } catch (err: any) {
      localRollback?.();
      Alert.alert('Settings not saved', err?.response?.data?.error || 'Please check your connection and try again.');
    } finally {
      setSavingKey(null);
    }
  };

  const confirmLogout = () => {
    Alert.alert('Log out?', 'You will need to sign in again to access your account.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Log Out',
        style: 'destructive',
        onPress: async () => {
          setLogoutLoading(true);
          try {
            await api.post('/auth/logout');
          } catch {}
          useAuth.getState().logout();
          setLogoutLoading(false);
        },
      },
    ]);
  };

  const enableTwoFAFlow = async (value: boolean) => {
    if (value) {
      setTwoFA(true);
      try {
        setSavingKey('twoFactorEnabled');
        const { data } = await api.post('/user/2fa/enable');
        setSavingKey(null);
        navigation.navigate('TwoFactorSetup', { secret: data?.secret, qrCode: data?.qrCode });
      } catch (err: any) {
        setTwoFA(false);
        setSavingKey(null);
        Alert.alert('2FA setup failed', err?.response?.data?.error || 'Unable to start two-factor setup.');
      }
    } else {
      Alert.alert('Disable 2FA?', 'This reduces your account security.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disable',
          style: 'destructive',
          onPress: async () => {
            setTwoFA(false);
            await updateSettings('twoFactorEnabled', false, () => setTwoFA(true));
          },
        },
      ]);
    }
  };

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor={safeColors.bg} />
      <Animated.View style={[styles.topGlow, { opacity: glowOpacity }]} />
      <ScrollView style={styles.container} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Animated.View style={[styles.hero, { opacity: fade, transform: [{ translateY: rise }] }]}>
          <View style={styles.heroTop}>
            <View>
              <Text style={styles.kicker}>CONTROL CENTER</Text>
              <Text style={styles.header}>Settings</Text>
              <Text style={styles.subHeader}>Security, privacy, creator tools and premium account controls in one place.</Text>
            </View>
            <View style={styles.crownShell}>
              <CustomIcon name="crown" size={34} active />
            </View>
          </View>

          <View style={styles.profileCard}>
            <View style={styles.profileRing}>
              <Text style={styles.profileInitial}>{(user?.displayName || user?.fullName || user?.username || 'T').slice(0, 1).toUpperCase()}</Text>
            </View>
            <View style={styles.profileInfo}>
              <Text style={styles.profileName}>{user?.displayName || user?.fullName || 'Texa Creator'}</Text>
              <Text style={styles.profileUser}>@{user?.username || 'username'}</Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressFill, { width: `${profileCompletion}%` }]} />
              </View>
              <Text style={styles.progressText}>{profileCompletion}% profile power completed</Text>
            </View>
          </View>
        </Animated.View>

        <Animated.View style={{ opacity: fade, transform: [{ translateY: rise }] }}>
          <Section title="Account">
            <Row label="Edit Profile" description="Name, avatar, bio, links and identity details" onPress={() => navigation.navigate('EditProfile')} icon="profile" />
            <Row label="Change Password" description="Update your login password safely" onPress={() => navigation.navigate('ChangePassword')} icon="key" />
            <Row
              label="Two-Factor Authentication"
              description={twoFA ? 'Extra login protection is enabled' : 'Add a second security layer'}
              value={twoFA}
              onToggle={enableTwoFAFlow}
              icon="shield"
              loading={savingKey === 'twoFactorEnabled'}
            />
            <Row label="Language" description={user?.language ? `Current: ${user.language}` : 'Choose app language'} onPress={() => navigation.navigate('Language')} icon="globe" />
            <Row label="Data & Storage" description="Cache, uploads, downloads and media quality" onPress={() => navigation.navigate('Storage')} icon="storage" />
            <Row label="Device Sessions" description="Manage logged-in phones and browsers" onPress={() => navigation.navigate('DeviceSessions')} icon="device" />
          </Section>

          <Section title="Privacy & Safety">
            <Row
              label="Private Account"
              description="Only approved followers can see your content"
              value={privateAcc}
              onToggle={async v => {
                setPrivateAcc(v);
                await updateSettings('privacySettings', { privateAccount: v }, () => setPrivateAcc(!v));
              }}
              icon="lock"
              loading={savingKey === 'privacySettings'}
            />
            <Row
              label="Hide Online Status"
              description="People will not see when you are active"
              value={hideOnline}
              onToggle={async v => {
                setHideOnline(v);
                await updateSettings('privacySettings', { hideOnline: v }, () => setHideOnline(!v));
              }}
              icon="eye"
              loading={savingKey === 'privacySettings'}
            />
            <Row
              label="Filter Spam Comments"
              description="Auto-hide suspicious comments and bot replies"
              value={filterSpam}
              onToggle={async v => {
                setFilterSpam(v);
                await updateSettings('safetySettings', { filterSpam: v }, () => setFilterSpam(!v));
              }}
              icon="trash"
              loading={savingKey === 'safetySettings'}
            />
            <Row label="Blocked Users" description="View and manage blocked accounts" onPress={() => navigation.navigate('BlockedUsers')} icon="ban" />
            <Row label="Report a Problem" description="Send safety, bug or abuse reports" onPress={() => navigation.navigate('Report')} icon="warning" />
          </Section>

          <Section title="Notifications">
            <Row
              label="Push Notifications"
              description="Likes, comments, follows, DMs and creator alerts"
              value={push}
              onToggle={async v => {
                setPush(v);
                await updateSettings('notificationSettings', { push: v }, () => setPush(!v));
              }}
              icon="bell"
              loading={savingKey === 'notificationSettings'}
            />
            <Row
              label="Email Notifications"
              description="Security alerts and important account updates"
              value={email}
              onToggle={async v => {
                setEmail(v);
                await updateSettings('notificationSettings', { email: v }, () => setEmail(!v));
              }}
              icon="mail"
              loading={savingKey === 'notificationSettings'}
            />
            <Row label="Mentions & Replies" description="Fine-tune social notification types" onPress={() => navigation.navigate('NotificationTypes')} icon="chat" />
          </Section>

          <Section title="Appearance">
            <Row
              label="Dark Mode"
              description={dark ? 'Premium dark interface enabled' : 'Light interface enabled'}
              value={dark}
              onToggle={async v => {
                setDark(v);
                await updateSettings('theme', v ? 'dark' : 'light', () => setDark(!v));
              }}
              icon="moon"
              loading={savingKey === 'theme'}
            />
            <Row label="Accent Color" description="Customize gold, neon and app highlight color" onPress={() => navigation.navigate('ThemeColors')} icon="palette" />
            <Row
              label="Reduce Motion"
              description="Limit animations for a calmer interface"
              value={reduceMotion}
              onToggle={async v => {
                setReduceMotion(v);
                await updateSettings('displaySettings', { reduceMotion: v }, () => setReduceMotion(!v));
              }}
              icon="spark"
              loading={savingKey === 'displaySettings'}
            />
          </Section>

          <Section title="Creator Tools">
            <Row label="Creator Studio" description="Posts, reels, stories and audience dashboard" onPress={() => navigation.navigate('CreatorDashboard')} icon="chart" />
            <Row label="Monetization" description="Tips, payouts, creator fund and earnings" onPress={() => navigation.navigate('PayoutSettings')} icon="coin" />
            <Row label="Analytics" description="Growth, retention, reach and engagement reports" onPress={() => navigation.navigate('ProfileAnalytics')} icon="trend" />
            <Row label="Prestige Card" description="Download your premium creator identity card" onPress={() => navigation.navigate('PrestigeCard')} icon="download" />
          </Section>

          <Section title="Support">
            <Row label="Help Center" description="Guides, account help and creator support" onPress={() => navigation.navigate('Help')} icon="help" />
            <Row label="About Texa" description="Version, company info and app details" onPress={() => navigation.navigate('About')} icon="info" />
            <Row label="Terms & Privacy" description="Policies, privacy rules and legal documents" onPress={() => navigation.navigate('Legal')} icon="document" />
          </Section>

          <TouchableOpacity style={styles.logout} onPress={confirmLogout} activeOpacity={0.86} disabled={logoutLoading}>
            {logoutLoading ? <ActivityIndicator color="#FFFFFF" /> : <CustomIcon name="logout" size={24} danger />}
            <Text style={styles.logoutText}>{logoutLoading ? 'Logging out...' : 'Log Out'}</Text>
          </TouchableOpacity>

          <Text style={styles.footer}>Texa secure settings layer • Premium creator control system</Text>
        </Animated.View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: safeColors.bg },
  topGlow: {
    position: 'absolute',
    top: -120,
    alignSelf: 'center',
    width: 360,
    height: 360,
    borderRadius: 180,
    backgroundColor: safeColors.neon,
  },
  container: { flex: 1 },
  content: { padding: 16, paddingTop: Platform.OS === 'android' ? 24 : 18, paddingBottom: 36 },
  hero: {
    borderRadius: 28,
    padding: 18,
    backgroundColor: safeColors.card,
    borderWidth: 1,
    borderColor: safeColors.border,
    marginBottom: 22,
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 14 },
  kicker: { color: safeColors.neon, fontSize: 11, fontWeight: '900', letterSpacing: 1.8, marginBottom: 7 },
  header: { fontSize: 34, fontWeight: '900', color: safeColors.text, letterSpacing: -0.8 },
  subHeader: { color: safeColors.muted, fontSize: 13.5, lineHeight: 20, marginTop: 8, maxWidth: 265 },
  crownShell: {
    width: 58,
    height: 58,
    borderRadius: 22,
    backgroundColor: 'rgba(247,201,72,0.11)',
    borderWidth: 1,
    borderColor: 'rgba(247,201,72,0.28)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  profileCard: {
    marginTop: 18,
    borderRadius: 24,
    padding: 14,
    backgroundColor: safeColors.card2,
    borderWidth: 1,
    borderColor: safeColors.border,
    flexDirection: 'row',
    alignItems: 'center',
  },
  profileRing: {
    width: 62,
    height: 62,
    borderRadius: 24,
    backgroundColor: 'rgba(34,245,197,0.12)',
    borderWidth: 2,
    borderColor: safeColors.neon,
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 13,
  },
  profileInitial: { color: safeColors.text, fontSize: 25, fontWeight: '900' },
  profileInfo: { flex: 1 },
  profileName: { color: safeColors.text, fontSize: 17, fontWeight: '900' },
  profileUser: { color: safeColors.muted, fontSize: 13, marginTop: 2 },
  progressTrack: { height: 7, borderRadius: 10, backgroundColor: '#252B3E', marginTop: 10, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 10, backgroundColor: safeColors.neon },
  progressText: { color: safeColors.soft, fontSize: 11.5, marginTop: 7, fontWeight: '700' },
  section: { marginBottom: 22 },
  sectionTitle: {
    fontSize: 12,
    fontWeight: '900',
    color: safeColors.gold,
    marginBottom: 10,
    textTransform: 'uppercase',
    letterSpacing: 1.35,
    paddingHorizontal: 4,
  },
  sectionCard: {
    backgroundColor: safeColors.card,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: safeColors.border,
    overflow: 'hidden',
  },
  row: {
    minHeight: 74,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: safeColors.border,
    backgroundColor: 'rgba(255,255,255,0.015)',
  },
  rowPressed: { backgroundColor: 'rgba(255,255,255,0.045)' },
  iconShell: {
    width: 46,
    height: 46,
    borderRadius: 17,
    backgroundColor: 'rgba(247,201,72,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(247,201,72,0.18)',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  iconShellDanger: {
    backgroundColor: 'rgba(255,77,103,0.09)',
    borderColor: 'rgba(255,77,103,0.2)',
  },
  rowContent: { flex: 1, paddingRight: 10 },
  rowLabel: { fontSize: 15.5, fontWeight: '850', color: safeColors.text },
  rowLabelDanger: { color: '#FFD7DE' },
  rowDesc: { fontSize: 12.3, color: safeColors.muted, marginTop: 4, lineHeight: 17 },
  logout: {
    minHeight: 58,
    borderRadius: 20,
    backgroundColor: 'rgba(255,77,103,0.13)',
    borderWidth: 1,
    borderColor: 'rgba(255,77,103,0.35)',
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    marginTop: 4,
  },
  logoutText: { color: '#FFFFFF', fontWeight: '900', fontSize: 16 },
  footer: { color: safeColors.muted, textAlign: 'center', marginTop: 18, fontSize: 12 },
  iconBox: { justifyContent: 'center', alignItems: 'center' },
  iconHead: { position: 'absolute', top: '18%' },
  iconBody: { position: 'absolute', bottom: '16%' },
  lockArc: { position: 'absolute', top: '9%', borderBottomWidth: 0 },
  lockBase: { position: 'absolute', bottom: '14%' },
  lockDot: { position: 'absolute', bottom: '25%' },
  shield: { borderTopLeftRadius: 12, borderTopRightRadius: 12, borderBottomLeftRadius: 18, borderBottomRightRadius: 18, transform: [{ rotate: '45deg' }] },
  shieldLine: { position: 'absolute', transform: [{ rotate: '-45deg' }] },
  globeCircle: { position: 'absolute' },
  globeLineH: { position: 'absolute' },
  globeLineV: { position: 'absolute' },
  diskTop: { position: 'absolute', top: '12%' },
  diskMid: { position: 'absolute', top: '36%' },
  diskBot: { position: 'absolute', bottom: '12%' },
  eyeOuter: { position: 'absolute', transform: [{ rotate: '0deg' }] },
  eyeDot: { position: 'absolute' },
  trashLid: { position: 'absolute', top: '17%' },
  trashBody: { position: 'absolute', bottom: '15%' },
  trashLine: { position: 'absolute', bottom: '25%' },
  banCircle: { position: 'absolute' },
  banSlash: { position: 'absolute' },
  warningTri: { position: 'absolute', width: 0, height: 0, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  warningLine: { position: 'absolute', top: '39%' },
  warningDot: { position: 'absolute', bottom: '26%' },
  bellDome: { position: 'absolute', top: '14%', borderBottomWidth: 0 },
  bellBase: { position: 'absolute', bottom: '24%' },
  bellDot: { position: 'absolute', bottom: '13%' },
  mailBox: { position: 'absolute' },
  mailFlapA: { position: 'absolute', left: '20%', top: '44%' },
  mailFlapB: { position: 'absolute', right: '20%', top: '44%' },
  chatBubble: { position: 'absolute', top: '18%' },
  chatTail: { position: 'absolute', bottom: '16%', left: '30%', width: 0, height: 0, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  moonOuter: { position: 'absolute' },
  moonCut: { position: 'absolute', left: '38%', top: '12%' },
  palette: { position: 'absolute' },
  paletteDot: { position: 'absolute', width: 4, height: 4, borderRadius: 2 },
  sparkV: { position: 'absolute' },
  sparkH: { position: 'absolute' },
  sparkD: { position: 'absolute' },
  chartBar: { position: 'absolute', bottom: '16%', width: 5, borderRadius: 4 },
  coinOuter: { position: 'absolute' },
  coinInner: { position: 'absolute' },
  helpCircle: { position: 'absolute' },
  helpText: { position: 'absolute', fontWeight: '900', lineHeight: 30 },
  doc: { position: 'absolute' },
  docLine: { position: 'absolute', height: 2, borderRadius: 2 },
  logoutDoor: { position: 'absolute', left: '18%', borderRadius: 4 },
  logoutArrow: { position: 'absolute', right: '18%' },
  logoutHead: { position: 'absolute', right: '13%', width: 0, height: 0, borderTopColor: 'transparent', borderBottomColor: 'transparent' },
  device: { position: 'absolute' },
  deviceDot: { position: 'absolute', bottom: '17%' },
  downloadStem: { position: 'absolute', top: '16%' },
  downloadHead: { position: 'absolute', top: '48%', width: 0, height: 0, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  downloadBase: { position: 'absolute', bottom: '18%' },
  keyRing: { position: 'absolute', left: '15%' },
  keyStem: { position: 'absolute', left: '42%' },
  keyTooth: { position: 'absolute', right: '22%', top: '52%' },
  crownBase: { position: 'absolute', bottom: '26%' },
  crownPeak: { position: 'absolute', bottom: '30%', width: 0, height: 0, borderLeftColor: 'transparent', borderRightColor: 'transparent' },
  chevron: { transform: [{ rotate: '45deg' }] },
});
