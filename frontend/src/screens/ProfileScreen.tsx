import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  Image,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Animated,
  Dimensions,
  Linking,
  Alert,
  StatusBar,
  Platform
} from 'react-native';
import { createMaterialTopTabNavigator } from '@react-navigation/material-top-tabs';
import LinearGradient from 'react-native-linear-gradient';
import { api } from '../api/client';
import { useAuth } from '../store/auth';
import { theme } from '../theme';
import StoriesRow from '../components/StoriesRow';
import ReelsGrid from '../components/ReelsGrid';
import Highlights from '../components/Highlights';
import StatsCard from '../components/StatsCard';

const Tab = createMaterialTopTabNavigator();
const { width } = Dimensions.get('window');

type ProfileUser = {
  id: string;
  fullName?: string;
  displayName?: string;
  username?: string;
  bio?: string;
  bioLink?: string;
  avatarUrl?: string;
  coverUrl?: string;
  isVerified?: boolean;
  isFollowing?: boolean;
  followsViewer?: boolean;
  isBlocked?: boolean;
  followers?: string[];
  following?: string[];
  level?: string | number;
  xp?: number;
  coins?: number;
  trustScore?: number;
  trustLevel?: string;
  reels?: any[];
  stories?: any[];
  profileBadges?: any[];
  badges?: any[];
  _count?: {
    followers?: number;
    following?: number;
    reels?: number;
    stories?: number;
  };
};

const Icon = ({ name, size = 22, color = '#fff' }: { name: string; size?: number; color?: string }) => {
  const stroke = Math.max(1.7, size / 13);
  if (name === 'back') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center' }}>
        <View style={{ width: size * 0.62, height: size * 0.62, borderLeftWidth: stroke, borderBottomWidth: stroke, borderColor: color, transform: [{ rotate: '45deg' }], marginLeft: size * 0.25 }} />
      </View>
    );
  }
  if (name === 'shield') {
    return (
      <View style={{ width: size, height: size, alignItems: 'center' }}>
        <View style={{ width: size * 0.72, height: size * 0.86, borderWidth: stroke, borderColor: color, borderTopLeftRadius: size * 0.28, borderTopRightRadius: size * 0.28, borderBottomLeftRadius: size * 0.35, borderBottomRightRadius: size * 0.35, transform: [{ perspective: 100 }, { rotateX: '8deg' }] }} />
        <View style={{ position: 'absolute', top: size * 0.27, width: size * 0.3, height: size * 0.18, borderLeftWidth: stroke, borderBottomWidth: stroke, borderColor: color, transform: [{ rotate: '-45deg' }] }} />
      </View>
    );
  }
  if (name === 'crown') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center' }}>
        <View style={{ width: size * 0.88, height: size * 0.48, borderBottomWidth: stroke, borderLeftWidth: stroke, borderRightWidth: stroke, borderColor: color, borderBottomLeftRadius: size * 0.12, borderBottomRightRadius: size * 0.12, alignSelf: 'center' }} />
        <View style={{ position: 'absolute', left: size * 0.08, top: size * 0.25, width: size * 0.22, height: size * 0.22, borderLeftWidth: stroke, borderTopWidth: stroke, borderColor: color, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', left: size * 0.39, top: size * 0.12, width: size * 0.24, height: size * 0.24, borderLeftWidth: stroke, borderTopWidth: stroke, borderColor: color, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', right: size * 0.08, top: size * 0.25, width: size * 0.22, height: size * 0.22, borderLeftWidth: stroke, borderTopWidth: stroke, borderColor: color, transform: [{ rotate: '45deg' }] }} />
      </View>
    );
  }
  if (name === 'message') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.86, height: size * 0.62, borderWidth: stroke, borderColor: color, borderRadius: size * 0.18 }} />
        <View style={{ position: 'absolute', bottom: size * 0.14, left: size * 0.24, width: size * 0.18, height: size * 0.18, borderLeftWidth: stroke, borderBottomWidth: stroke, borderColor: color, transform: [{ rotate: '-35deg' }] }} />
      </View>
    );
  }
  if (name === 'settings') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.62, height: size * 0.62, borderWidth: stroke, borderColor: color, borderRadius: size }} />
        <View style={{ position: 'absolute', width: size * 0.16, height: size * 0.16, borderWidth: stroke, borderColor: color, borderRadius: size }} />
        {[0, 45, 90, 135].map((r) => (
          <View key={r} style={{ position: 'absolute', width: size * 0.92, height: stroke, backgroundColor: color, transform: [{ rotate: `${r}deg` }] }} />
        ))}
      </View>
    );
  }
  if (name === 'edit') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.68, height: stroke * 1.5, backgroundColor: color, borderRadius: stroke, transform: [{ rotate: '-42deg' }] }} />
        <View style={{ position: 'absolute', right: size * 0.15, top: size * 0.18, width: size * 0.18, height: size * 0.18, borderWidth: stroke, borderColor: color, transform: [{ rotate: '-42deg' }] }} />
      </View>
    );
  }
  if (name === 'plus') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.72, height: stroke, backgroundColor: color, borderRadius: stroke }} />
        <View style={{ position: 'absolute', height: size * 0.72, width: stroke, backgroundColor: color, borderRadius: stroke }} />
      </View>
    );
  }
  if (name === 'link') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.46, height: size * 0.28, borderWidth: stroke, borderColor: color, borderRadius: size, transform: [{ rotate: '-35deg' }], marginRight: size * 0.25 }} />
        <View style={{ position: 'absolute', width: size * 0.46, height: size * 0.28, borderWidth: stroke, borderColor: color, borderRadius: size, transform: [{ rotate: '-35deg' }], marginLeft: size * 0.25 }} />
      </View>
    );
  }
  if (name === 'spark') {
    return (
      <View style={{ width: size, height: size, justifyContent: 'center', alignItems: 'center' }}>
        <View style={{ width: size * 0.16, height: size * 0.82, backgroundColor: color, borderRadius: size, transform: [{ rotate: '45deg' }] }} />
        <View style={{ position: 'absolute', width: size * 0.16, height: size * 0.82, backgroundColor: color, borderRadius: size, transform: [{ rotate: '-45deg' }] }} />
        <View style={{ position: 'absolute', width: size * 0.72, height: size * 0.16, backgroundColor: color, borderRadius: size }} />
      </View>
    );
  }
  if (name === 'grid') {
    return (
      <View style={{ width: size, height: size, flexDirection: 'row', flexWrap: 'wrap', gap: size * 0.08 }}>
        {[0, 1, 2, 3].map((i) => <View key={i} style={{ width: size * 0.42, height: size * 0.42, borderRadius: size * 0.1, borderWidth: stroke, borderColor: color }} />)}
      </View>
    );
  }
  if (name === 'analytics') {
    return (
      <View style={{ width: size, height: size, flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-around' }}>
        {[0.42, 0.72, 0.55, 0.9].map((h, i) => <View key={i} style={{ width: size * 0.13, height: size * h, borderRadius: size, backgroundColor: color }} />)}
      </View>
    );
  }
  return <View style={{ width: size, height: size, borderWidth: stroke, borderColor: color, borderRadius: size }} />;
};

const formatCompact = (value: any) => {
  const num = Number(value || 0);
  if (num >= 1000000000) return `${(num / 1000000000).toFixed(num % 1000000000 === 0 ? 0 : 1)}B`;
  if (num >= 1000000) return `${(num / 1000000).toFixed(num % 1000000 === 0 ? 0 : 1)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(num % 1000 === 0 ? 0 : 1)}K`;
  return `${num}`;
};

const safeImage = (uri?: string) => uri && uri.trim().length > 5 ? { uri } : undefined;

function AnalyticsTab({ route }: any) {
  const profile = route.params?.profile as ProfileUser | undefined;
  const totalReels = profile?._count?.reels ?? profile?.reels?.length ?? 0;
  const totalStories = profile?._count?.stories ?? profile?.stories?.length ?? 0;
  const followers = profile?._count?.followers ?? profile?.followers?.length ?? 0;
  const following = profile?._count?.following ?? profile?.following?.length ?? 0;
  const trustScore = profile?.trustScore ?? 0;
  const xp = profile?.xp ?? 0;

  return (
    <ScrollView style={styles.tabPage} contentContainerStyle={styles.analyticsContent} showsVerticalScrollIndicator={false}>
      <View style={styles.analyticsGrid}>
        <StatsCard title="Followers" value={formatCompact(followers)} subtitle="Audience strength" />
        <StatsCard title="Following" value={formatCompact(following)} subtitle="Network reach" />
        <StatsCard title="Reels" value={formatCompact(totalReels)} subtitle="Creator output" />
        <StatsCard title="Stories" value={formatCompact(totalStories)} subtitle="Active moments" />
      </View>
      <LinearGradient colors={['#151515', '#26210f', '#0d0d0d']} style={styles.powerCard}>
        <View style={styles.powerTop}>
          <View style={styles.powerIcon}>
            <Icon name="analytics" size={24} color={theme.colors?.gold || '#FFD76A'} />
          </View>
          <View style={styles.powerInfo}>
            <Text style={styles.powerTitle}>Creator Power Index</Text>
            <Text style={styles.powerSub}>XP, trust, content and social reach combined</Text>
          </View>
        </View>
        <View style={styles.powerMeter}>
          <View style={[styles.powerFill, { width: `${Math.min(100, Math.max(4, (trustScore || xp / 100 || 25)))}%` }]} />
        </View>
        <View style={styles.powerStats}>
          <Text style={styles.powerStat}>Trust {formatCompact(trustScore)}</Text>
          <Text style={styles.powerStat}>XP {formatCompact(xp)}</Text>
          <Text style={styles.powerStat}>{profile?.trustLevel || profile?.level || 'Rising'}</Text>
        </View>
      </LinearGradient>
    </ScrollView>
  );
}

function ReelsTab({ route }: any) {
  return <ReelsGrid route={route} profile={route.params?.profile} userId={route.params?.userId} />;
}

function StoriesTab({ route }: any) {
  return <StoriesRow route={route} profile={route.params?.profile} userId={route.params?.userId} />;
}

function HighlightsTab({ route }: any) {
  return <Highlights route={route} profile={route.params?.profile} userId={route.params?.userId} />;
}

export default function ProfileScreen({ navigation, route }: any) {
  const { user } = useAuth();
  const requestedUserId = route.params?.userId || user?.id;
  const isOwn = requestedUserId === user?.id;
  const [profile, setProfile] = useState<ProfileUser | null>(isOwn ? user : null);
  const [loading, setLoading] = useState(!isOwn);
  const [refreshing, setRefreshing] = useState(false);
  const [followBusy, setFollowBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const fade = useRef(new Animated.Value(0)).current;
  const rise = useRef(new Animated.Value(18)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  const activeProfile = profile || user || {};
  const avatarSource = safeImage(activeProfile?.avatarUrl);
  const coverSource = safeImage(activeProfile?.coverUrl);
  const badges = activeProfile?.profileBadges || activeProfile?.badges || [];
  const followersCount = activeProfile?._count?.followers ?? activeProfile?.followers?.length ?? 0;
  const followingCount = activeProfile?._count?.following ?? activeProfile?.following?.length ?? 0;
  const reelsCount = activeProfile?._count?.reels ?? activeProfile?.reels?.length ?? 0;
  const storiesCount = activeProfile?._count?.stories ?? activeProfile?.stories?.length ?? 0;

  const loadProfile = useCallback(async (silent = false) => {
    if (!requestedUserId) return;
    if (!silent) setLoading(true);
    try {
      const { data } = await api.get(`/profile/${requestedUserId}`);
      setProfile(data);
      setBlocked(!!data?.isBlocked);
    } catch (err: any) {
      if (!silent) Alert.alert('Profile Error', err?.response?.data?.error || 'Unable to load profile');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [requestedUserId]);

  useEffect(() => {
    loadProfile(true);
  }, [loadProfile]);

  useEffect(() => {
    Animated.parallel([
      Animated.timing(fade, { toValue: 1, duration: 420, useNativeDriver: true }),
      Animated.spring(rise, { toValue: 0, damping: 16, stiffness: 120, useNativeDriver: true })
    ]).start();

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.045, duration: 1300, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 1300, useNativeDriver: true })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [fade, rise, pulse]);

  const onRefresh = () => {
    setRefreshing(true);
    loadProfile(true);
  };

  const openLink = async () => {
    const raw = activeProfile?.bioLink;
    if (!raw) return;
    const url = raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`;
    const supported = await Linking.canOpenURL(url);
    if (supported) Linking.openURL(url);
  };

  const toggleFollow = async () => {
    if (!requestedUserId || isOwn || followBusy) return;
    setFollowBusy(true);
    const currentlyFollowing = !!activeProfile?.isFollowing;
    try {
      await api.post(`/users/${requestedUserId}/${currentlyFollowing ? 'unfollow' : 'follow'}`);
      setProfile((prev: any) => ({
        ...prev,
        isFollowing: !currentlyFollowing,
        _count: {
          ...(prev?._count || {}),
          followers: Math.max(0, (prev?._count?.followers ?? prev?.followers?.length ?? 0) + (currentlyFollowing ? -1 : 1))
        }
      }));
    } catch (err: any) {
      Alert.alert('Action failed', err?.response?.data?.error || 'Please try again');
    } finally {
      setFollowBusy(false);
    }
  };

  const handleBlock = async () => {
    if (!requestedUserId || isOwn) return;
    try {
      await api.post(blocked ? '/profile/unblock' : '/profile/block', { targetId: requestedUserId });
      setBlocked(!blocked);
      setProfile((prev: any) => ({ ...prev, isBlocked: !blocked }));
    } catch (err: any) {
      Alert.alert('Action failed', err?.response?.data?.error || 'Please try again');
    }
  };

  const reportUser = async () => {
    if (!requestedUserId || isOwn) return;
    try {
      await api.post('/profile/report', { targetId: requestedUserId, reason: 'profile_report', details: 'Reported from profile screen' });
      Alert.alert('Report sent', 'Thanks. Our safety team will review it.');
    } catch (err: any) {
      Alert.alert('Report failed', err?.response?.data?.error || 'Please try again');
    }
  };

  const headerStats = useMemo(() => [
    { label: 'Followers', value: formatCompact(followersCount) },
    { label: 'Following', value: formatCompact(followingCount) },
    { label: 'Reels', value: formatCompact(reelsCount) },
    { label: 'XP', value: formatCompact(activeProfile?.xp || 0) }
  ], [followersCount, followingCount, reelsCount, activeProfile?.xp]);

  if (loading && !activeProfile?.id) {
    return (
      <View style={styles.loader}>
        <StatusBar barStyle="light-content" backgroundColor="#050505" />
        <ActivityIndicator size="large" color={theme.colors?.gold || '#FFD76A'} />
        <Text style={styles.loaderText}>Loading profile</Text>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" backgroundColor="#050505" />
      <ScrollView
        style={styles.container}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors?.gold || '#FFD76A'} />}
      >
        <Animated.View style={[styles.hero, { opacity: fade, transform: [{ translateY: rise }] }]}>
          <LinearGradient colors={['#050505', '#17130a', '#050505']} style={styles.cover}>
            {coverSource && <Image source={coverSource} style={styles.coverImage} />}
            <LinearGradient colors={['rgba(0,0,0,0.15)', 'rgba(0,0,0,0.78)', '#050505']} style={styles.coverShade} />
            <View style={styles.topBar}>
              <TouchableOpacity style={styles.topButton} onPress={() => navigation.canGoBack() ? navigation.goBack() : navigation.navigate('Home')}>
                <Icon name="back" size={21} color="#fff" />
              </TouchableOpacity>
              <View style={styles.topTitleWrap}>
                <Text style={styles.topTitle} numberOfLines={1}>{activeProfile?.displayName || activeProfile?.fullName || activeProfile?.username || 'Profile'}</Text>
                <Text style={styles.topSub}>{isOwn ? 'Your creator identity' : activeProfile?.followsViewer ? 'Follows you' : 'Public profile'}</Text>
              </View>
              <TouchableOpacity style={styles.topButton} onPress={() => isOwn ? navigation.navigate('Settings') : Alert.alert('Profile options', '', [{ text: blocked ? 'Unblock' : 'Block', onPress: handleBlock }, { text: 'Report', onPress: reportUser }, { text: 'Cancel', style: 'cancel' }])}>
                <Icon name={isOwn ? 'settings' : 'shield'} size={21} color="#fff" />
              </TouchableOpacity>
            </View>

            <View style={styles.identityBlock}>
              <Animated.View style={[styles.avatarRing, { transform: [{ scale: pulse }] }]}>
                <LinearGradient colors={[theme.colors?.gold || '#FFD76A', theme.colors?.neon || '#33FFD1', '#FF4FD8']} style={styles.avatarGradient}>
                  {avatarSource ? <Image source={avatarSource} style={styles.avatar} /> : <View style={styles.avatarFallback}><Text style={styles.avatarLetter}>{String(activeProfile?.username || activeProfile?.fullName || 'U').charAt(0).toUpperCase()}</Text></View>}
                </LinearGradient>
              </Animated.View>

              <View style={styles.nameBlock}>
                <View style={styles.nameRow}>
                  <Text style={styles.name} numberOfLines={1}>{activeProfile?.displayName || activeProfile?.fullName || 'Unnamed Creator'}</Text>
                  {activeProfile?.isVerified && (
                    <View style={styles.verifiedBadge}>
                      <Icon name="shield" size={14} color="#050505" />
                    </View>
                  )}
                </View>
                <Text style={styles.username}>@{activeProfile?.username || 'username'}</Text>
                <View style={styles.levelPill}>
                  <Icon name="crown" size={14} color={theme.colors?.gold || '#FFD76A'} />
                  <Text style={styles.levelText}>{activeProfile?.trustLevel || activeProfile?.level || 'Bronze'} Level</Text>
                </View>
              </View>
            </View>
          </LinearGradient>

          <View style={styles.profileBody}>
            <View style={styles.statsRow}>
              {headerStats.map((item) => (
                <View key={item.label} style={styles.stat}>
                  <Text style={styles.statNum}>{item.value}</Text>
                  <Text style={styles.statLabel}>{item.label}</Text>
                </View>
              ))}
            </View>

            {!!activeProfile?.bio && <Text style={styles.bio}>{activeProfile.bio}</Text>}

            {!!activeProfile?.bioLink && (
              <TouchableOpacity style={styles.linkPill} onPress={openLink} activeOpacity={0.8}>
                <Icon name="link" size={16} color={theme.colors?.neon || '#33FFD1'} />
                <Text style={styles.link} numberOfLines={1}>{activeProfile.bioLink}</Text>
              </TouchableOpacity>
            )}

            <View style={styles.actions}>
              {isOwn ? (
                <>
                  <TouchableOpacity style={styles.primaryBtn} onPress={() => navigation.navigate('PrestigeCard')}>
                    <Icon name="crown" size={18} color="#050505" />
                    <Text style={styles.primaryBtnText}>Prestige Card</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryBtn} onPress={() => navigation.navigate('EditProfile')}>
                    <Icon name="edit" size={17} color="#fff" />
                    <Text style={styles.secondaryBtnText}>Edit</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.iconBtn} onPress={() => navigation.navigate('Settings')}>
                    <Icon name="settings" size={18} color="#fff" />
                  </TouchableOpacity>
                </>
              ) : (
                <>
                  <TouchableOpacity style={activeProfile?.isFollowing ? styles.secondaryBtnWide : styles.primaryBtn} onPress={toggleFollow} disabled={followBusy || blocked}>
                    {followBusy ? <ActivityIndicator size="small" color={activeProfile?.isFollowing ? '#fff' : '#050505'} /> : <Icon name={activeProfile?.isFollowing ? 'shield' : 'plus'} size={18} color={activeProfile?.isFollowing ? '#fff' : '#050505'} />}
                    <Text style={activeProfile?.isFollowing ? styles.secondaryBtnText : styles.primaryBtnText}>{activeProfile?.isFollowing ? 'Following' : 'Follow'}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.secondaryBtnWide} onPress={() => navigation.navigate('Message', { userId: requestedUserId, participant: activeProfile })} disabled={blocked}>
                    <Icon name="message" size={18} color="#fff" />
                    <Text style={styles.secondaryBtnText}>Message</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={styles.iconBtn} onPress={() => Alert.alert('Profile options', '', [{ text: blocked ? 'Unblock' : 'Block', onPress: handleBlock }, { text: 'Report', onPress: reportUser }, { text: 'Cancel', style: 'cancel' }])}>
                    <Icon name="shield" size={18} color={blocked ? '#FF5A6A' : '#fff'} />
                  </TouchableOpacity>
                </>
              )}
            </View>

            <View style={styles.badgesSection}>
              <View style={styles.sectionHead}>
                <Text style={styles.sectionTitle}>Badges</Text>
                <Text style={styles.sectionMeta}>{badges.length ? `${badges.length} earned` : 'No badges yet'}</Text>
              </View>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.badgesList}>
                {badges.length ? badges.map((b: any, index: number) => (
                  <LinearGradient key={b.id || index} colors={['#191919', '#2a220d']} style={styles.badgeCard}>
                    {b.iconUrl ? <Image source={{ uri: b.iconUrl }} style={styles.badgeIcon} /> : <View style={styles.badgeIconCustom}><Icon name={index % 2 === 0 ? 'spark' : 'crown'} size={18} color={theme.colors?.gold || '#FFD76A'} /></View>}
                    <Text style={styles.badgeName} numberOfLines={1}>{b.name || b.title || 'Elite Badge'}</Text>
                  </LinearGradient>
                )) : (
                  <View style={styles.emptyBadge}>
                    <Icon name="spark" size={22} color={theme.colors?.gold || '#FFD76A'} />
                    <Text style={styles.empty}>Start earning profile badges</Text>
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
        </Animated.View>

        <View style={styles.tabsShell}>
          <Tab.Navigator
            initialLayout={{ width }}
            screenOptions={{
              tabBarStyle: styles.tabBar,
              tabBarLabelStyle: styles.tabLabel,
              tabBarActiveTintColor: theme.colors?.gold || '#FFD76A',
              tabBarInactiveTintColor: '#8D8D8D',
              tabBarIndicatorStyle: styles.tabIndicator,
              tabBarPressColor: 'rgba(255,215,106,0.12)',
              lazy: true,
              swipeEnabled: true
            }}
          >
            <Tab.Screen name="Reels" component={ReelsTab} initialParams={{ userId: requestedUserId, profile: activeProfile }} options={{ tabBarIcon: ({ color }) => <Icon name="grid" size={18} color={color} /> }} />
            <Tab.Screen name="Stories" component={StoriesTab} initialParams={{ userId: requestedUserId, profile: activeProfile }} options={{ tabBarIcon: ({ color }) => <Icon name="spark" size={18} color={color} /> }} />
            <Tab.Screen name="Highlights" component={HighlightsTab} initialParams={{ userId: requestedUserId, profile: activeProfile }} options={{ tabBarIcon: ({ color }) => <Icon name="crown" size={18} color={color} /> }} />
            <Tab.Screen name="Analytics" component={AnalyticsTab} initialParams={{ userId: requestedUserId, profile: activeProfile }} options={{ tabBarIcon: ({ color }) => <Icon name="analytics" size={18} color={color} /> }} />
          </Tab.Navigator>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#050505'
  },
  container: {
    flex: 1,
    backgroundColor: '#050505'
  },
  loader: {
    flex: 1,
    backgroundColor: '#050505',
    alignItems: 'center',
    justifyContent: 'center'
  },
  loaderText: {
    color: '#CFCFCF',
    marginTop: 14,
    fontWeight: '700',
    letterSpacing: 0.4
  },
  hero: {
    backgroundColor: '#050505'
  },
  cover: {
    minHeight: 315,
    paddingTop: Platform.OS === 'android' ? 18 : 48,
    overflow: 'hidden'
  },
  coverImage: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%',
    opacity: 0.48
  },
  coverShade: {
    ...StyleSheet.absoluteFillObject
  },
  topBar: {
    paddingHorizontal: 16,
    paddingTop: 8,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  topButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  topTitleWrap: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 12
  },
  topTitle: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '900',
    maxWidth: width * 0.58
  },
  topSub: {
    color: '#A8A8A8',
    fontSize: 11,
    marginTop: 2,
    fontWeight: '700'
  },
  identityBlock: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 18,
    paddingTop: 76,
    paddingBottom: 28
  },
  avatarRing: {
    width: 118,
    height: 118,
    borderRadius: 59,
    shadowColor: '#FFD76A',
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 14
  },
  avatarGradient: {
    width: 118,
    height: 118,
    borderRadius: 59,
    padding: 4,
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatar: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: '#151515'
  },
  avatarFallback: {
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: '#151515',
    alignItems: 'center',
    justifyContent: 'center'
  },
  avatarLetter: {
    color: '#fff',
    fontSize: 42,
    fontWeight: '900'
  },
  nameBlock: {
    flex: 1,
    paddingLeft: 16,
    paddingBottom: 4
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  name: {
    color: '#fff',
    fontSize: 24,
    fontWeight: '950',
    letterSpacing: -0.5,
    maxWidth: width - 190
  },
  verifiedBadge: {
    marginLeft: 8,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: theme.colors?.neon || '#33FFD1',
    alignItems: 'center',
    justifyContent: 'center'
  },
  username: {
    color: '#B9B9B9',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 3
  },
  levelPill: {
    marginTop: 10,
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,215,106,0.11)',
    borderWidth: 1,
    borderColor: 'rgba(255,215,106,0.25)'
  },
  levelText: {
    color: theme.colors?.gold || '#FFD76A',
    fontWeight: '900',
    fontSize: 12
  },
  profileBody: {
    marginTop: -10,
    backgroundColor: '#080808',
    borderTopLeftRadius: 30,
    borderTopRightRadius: 30,
    paddingHorizontal: 16,
    paddingTop: 18,
    paddingBottom: 14
  },
  statsRow: {
    flexDirection: 'row',
    backgroundColor: '#101010',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    paddingVertical: 14,
    marginBottom: 16
  },
  stat: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  statNum: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '950'
  },
  statLabel: {
    color: '#8F8F8F',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 4
  },
  bio: {
    color: '#E8E8E8',
    fontSize: 14,
    lineHeight: 21,
    fontWeight: '600',
    marginBottom: 12
  },
  linkPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    maxWidth: '100%',
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: 999,
    backgroundColor: 'rgba(51,255,209,0.08)',
    borderWidth: 1,
    borderColor: 'rgba(51,255,209,0.18)',
    marginBottom: 16
  },
  link: {
    color: theme.colors?.neon || '#33FFD1',
    fontSize: 13,
    fontWeight: '800',
    maxWidth: width - 80
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginBottom: 20
  },
  primaryBtn: {
    flex: 1.25,
    height: 48,
    borderRadius: 18,
    backgroundColor: theme.colors?.gold || '#FFD76A',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    shadowColor: theme.colors?.gold || '#FFD76A',
    shadowOpacity: 0.25,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 8
  },
  primaryBtnText: {
    color: '#050505',
    fontSize: 14,
    fontWeight: '950'
  },
  secondaryBtn: {
    flex: 0.72,
    height: 48,
    borderRadius: 18,
    backgroundColor: '#171717',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  secondaryBtnWide: {
    flex: 1,
    height: 48,
    borderRadius: 18,
    backgroundColor: '#171717',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7
  },
  secondaryBtnText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '900'
  },
  iconBtn: {
    width: 48,
    height: 48,
    borderRadius: 18,
    backgroundColor: '#171717',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  badgesSection: {
    marginTop: 2
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '950'
  },
  sectionMeta: {
    color: '#8E8E8E',
    fontSize: 12,
    fontWeight: '800'
  },
  badgesList: {
    paddingRight: 16
  },
  badgeCard: {
    width: 112,
    height: 104,
    borderRadius: 22,
    padding: 12,
    marginRight: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,215,106,0.14)',
    justifyContent: 'space-between'
  },
  badgeIcon: {
    width: 42,
    height: 42,
    borderRadius: 16,
    backgroundColor: '#0D0D0D'
  },
  badgeIconCustom: {
    width: 42,
    height: 42,
    borderRadius: 16,
    backgroundColor: 'rgba(255,215,106,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,215,106,0.22)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  badgeName: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '900'
  },
  emptyBadge: {
    minWidth: width - 32,
    height: 78,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.09)',
    backgroundColor: '#111',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    gap: 12
  },
  empty: {
    color: '#AFAFAF',
    fontSize: 13,
    fontWeight: '800'
  },
  tabsShell: {
    height: Math.max(560, Dimensions.get('window').height * 0.72),
    backgroundColor: '#050505'
  },
  tabBar: {
    backgroundColor: '#080808',
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)',
    elevation: 0,
    shadowOpacity: 0
  },
  tabLabel: {
    fontSize: 11,
    fontWeight: '950',
    textTransform: 'none'
  },
  tabIndicator: {
    backgroundColor: theme.colors?.gold || '#FFD76A',
    height: 3,
    borderRadius: 3
  },
  tabPage: {
    flex: 1,
    backgroundColor: '#050505'
  },
  analyticsContent: {
    padding: 14,
    paddingBottom: 36
  },
  analyticsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10
  },
  powerCard: {
    marginTop: 14,
    borderRadius: 26,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,215,106,0.16)'
  },
  powerTop: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 18
  },
  powerIcon: {
    width: 48,
    height: 48,
    borderRadius: 18,
    backgroundColor: 'rgba(255,215,106,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12
  },
  powerInfo: {
    flex: 1
  },
  powerTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '950'
  },
  powerSub: {
    color: '#9A9A9A',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 3
  },
  powerMeter: {
    height: 12,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.09)',
    overflow: 'hidden'
  },
  powerFill: {
    height: '100%',
    borderRadius: 999,
    backgroundColor: theme.colors?.gold || '#FFD76A'
  },
  powerStats: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 12
  },
  powerStat: {
    color: '#DCDCDC',
    fontSize: 12,
    fontWeight: '900'
  }
});
