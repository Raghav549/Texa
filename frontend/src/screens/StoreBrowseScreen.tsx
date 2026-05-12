import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  Image,
  StyleSheet,
  RefreshControl,
  ActivityIndicator,
  Animated,
  Easing,
  Dimensions,
  Platform,
  StatusBar
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api/client';
import { theme } from '../theme';
import TrustBadge from '../components/TrustBadge';

const { width } = Dimensions.get('window');

type StoreItem = {
  id: string;
  name: string;
  slug: string;
  description?: string;
  bannerUrl?: string;
  logoUrl?: string;
  trustScore?: number;
  rating?: number;
  category?: string;
  isVerified?: boolean;
  isFeatured?: boolean;
  address?: any;
  _count?: {
    products?: number;
    orders?: number;
    reviews?: number;
  };
};

type IconProps = {
  size?: number;
  color?: string;
  active?: boolean;
};

function SearchIcon({ size = 20, color = '#6B7280' }: IconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size * 0.68,
          height: size * 0.68,
          borderRadius: size,
          borderWidth: Math.max(2, size * 0.1),
          borderColor: color,
          position: 'absolute',
          left: 1,
          top: 1
        }}
      />
      <View
        style={{
          width: size * 0.42,
          height: Math.max(2, size * 0.1),
          borderRadius: 99,
          backgroundColor: color,
          position: 'absolute',
          right: 0,
          bottom: size * 0.12,
          transform: [{ rotate: '45deg' }]
        }}
      />
    </View>
  );
}

function StoreIcon({ size = 20, color = '#111827' }: IconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size * 0.9,
          height: size * 0.42,
          borderRadius: size * 0.08,
          backgroundColor: color,
          opacity: 0.18,
          position: 'absolute',
          top: size * 0.18,
          left: size * 0.05
        }}
      />
      <View
        style={{
          width: size * 0.76,
          height: size * 0.46,
          borderRadius: size * 0.08,
          borderWidth: Math.max(1.5, size * 0.08),
          borderColor: color,
          position: 'absolute',
          bottom: size * 0.04,
          left: size * 0.12
        }}
      />
      <View
        style={{
          width: size * 0.24,
          height: size * 0.25,
          borderRadius: size * 0.04,
          backgroundColor: color,
          position: 'absolute',
          bottom: size * 0.04,
          left: size * 0.38
        }}
      />
    </View>
  );
}

function StarIcon({ size = 16, color = '#F5B301' }: IconProps) {
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View
        style={{
          width: size * 0.74,
          height: size * 0.74,
          backgroundColor: color,
          transform: [{ rotate: '45deg' }],
          borderRadius: size * 0.12
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: size * 0.74,
          height: size * 0.74,
          backgroundColor: color,
          transform: [{ rotate: '0deg' }],
          borderRadius: size * 0.12
        }}
      />
    </View>
  );
}

function ShieldIcon({ size = 18, color = '#10B981' }: IconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size * 0.78,
          height: size * 0.9,
          borderRadius: size * 0.18,
          backgroundColor: color,
          position: 'absolute',
          top: size * 0.02,
          left: size * 0.11,
          transform: [{ rotate: '45deg' }],
          opacity: 0.22
        }}
      />
      <View
        style={{
          width: size * 0.62,
          height: size * 0.32,
          borderLeftWidth: Math.max(2, size * 0.12),
          borderBottomWidth: Math.max(2, size * 0.12),
          borderColor: color,
          position: 'absolute',
          top: size * 0.34,
          left: size * 0.22,
          transform: [{ rotate: '-45deg' }]
        }}
      />
    </View>
  );
}

function ArrowIcon({ size = 18, color = '#FFFFFF' }: IconProps) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'center' }}>
      <View
        style={{
          width: size * 0.75,
          height: Math.max(2, size * 0.12),
          backgroundColor: color,
          borderRadius: 99,
          alignSelf: 'center'
        }}
      />
      <View
        style={{
          width: size * 0.38,
          height: size * 0.38,
          borderRightWidth: Math.max(2, size * 0.12),
          borderTopWidth: Math.max(2, size * 0.12),
          borderColor: color,
          position: 'absolute',
          right: size * 0.12,
          transform: [{ rotate: '45deg' }]
        }}
      />
    </View>
  );
}

function FilterIcon({ size = 18, color = '#111827' }: IconProps) {
  return (
    <View style={{ width: size, height: size, justifyContent: 'space-around' }}>
      {[0.2, 0.55, 0.35].map((w, i) => (
        <View
          key={i}
          style={{
            height: Math.max(2, size * 0.1),
            width: size * (0.55 + w),
            borderRadius: 99,
            backgroundColor: color,
            alignSelf: i === 1 ? 'flex-end' : 'flex-start',
            opacity: i === 1 ? 0.65 : 1
          }}
        />
      ))}
    </View>
  );
}

function EmptyIcon({ size = 64, color = '#CBD5E1' }: IconProps) {
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size * 0.86,
          height: size * 0.6,
          borderRadius: size * 0.14,
          borderWidth: 2,
          borderColor: color,
          position: 'absolute',
          bottom: size * 0.08,
          left: size * 0.07
        }}
      />
      <View
        style={{
          width: size * 0.52,
          height: size * 0.24,
          borderRadius: size * 0.08,
          backgroundColor: color,
          opacity: 0.32,
          position: 'absolute',
          top: size * 0.16,
          left: size * 0.24
        }}
      />
      <View
        style={{
          width: size * 0.24,
          height: size * 0.24,
          borderRadius: size,
          backgroundColor: color,
          opacity: 0.7,
          position: 'absolute',
          bottom: size * 0.26,
          left: size * 0.38
        }}
      />
    </View>
  );
}

function SkeletonCard() {
  const pulse = useRef(new Animated.Value(0.35)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.9, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.35, duration: 650, easing: Easing.inOut(Easing.ease), useNativeDriver: true })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <Animated.View style={[styles.card, styles.skeletonCard, { opacity: pulse }]}>
      <View style={styles.skeletonBanner} />
      <View style={styles.skeletonBody}>
        <View style={styles.skeletonLogo} />
        <View style={{ flex: 1 }}>
          <View style={styles.skeletonLineLarge} />
          <View style={styles.skeletonLineSmall} />
        </View>
      </View>
      <View style={styles.skeletonDesc} />
      <View style={styles.skeletonButton} />
    </Animated.View>
  );
}

export default function StoreBrowseScreen({ navigation }: any) {
  const [stores, setStores] = useState<StoreItem[]>([]);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'trustScore' | 'rating' | 'createdAt'>('trustScore');
  const [minTrust, setMinTrust] = useState(70);
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const slideAnim = useRef(new Animated.Value(16)).current;

  const trustedCount = useMemo(() => stores.filter(s => Number(s.trustScore || 0) >= 80).length, [stores]);
  const totalProducts = useMemo(() => stores.reduce((sum, s) => sum + Number(s._count?.products || 0), 0), [stores]);

  const fetchStores = useCallback(async (q = query, silent = false) => {
    if (!silent) setLoading(true);
    setSearching(!!q.trim());
    setError('');

    try {
      const response = await api.get('/store/search', {
        params: {
          q: q.trim(),
          minTrust,
          sort,
          limit: 30
        }
      });

      const payload = Array.isArray(response.data) ? response.data : response.data?.stores || [];
      if (!mountedRef.current) return;
      setStores(payload);
      Animated.parallel([
        Animated.timing(fadeAnim, { toValue: 1, duration: 320, easing: Easing.out(Easing.ease), useNativeDriver: true }),
        Animated.timing(slideAnim, { toValue: 0, duration: 320, easing: Easing.out(Easing.ease), useNativeDriver: true })
      ]).start();
    } catch (err: any) {
      if (!mountedRef.current) return;
      setError(err?.response?.data?.error || 'Unable to load stores');
    } finally {
      if (!mountedRef.current) return;
      setLoading(false);
      setSearching(false);
    }
  }, [query, minTrust, sort, fadeAnim, slideAnim]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  useFocusEffect(
    useCallback(() => {
      fetchStores('', false);
    }, [fetchStores])
  );

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchStores(query, true);
    }, 450);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, sort, minTrust, fetchStores]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchStores(query, true);
    setRefreshing(false);
  };

  const openStore = (item: StoreItem) => {
    navigation.navigate('StoreDetail', { slug: item.slug, storeId: item.id });
  };

  const renderStore = ({ item, index }: { item: StoreItem; index: number }) => {
    const trust = Number(item.trustScore || 0);
    const rating = Number(item.rating || 0);
    const products = Number(item._count?.products || 0);
    const reviews = Number(item._count?.reviews || 0);
    const isElite = trust >= 90;
    const isTrusted = trust >= 80;

    return (
      <Animated.View
        style={{
          opacity: fadeAnim,
          transform: [{ translateY: slideAnim }]
        }}
      >
        <TouchableOpacity activeOpacity={0.88} style={styles.card} onPress={() => openStore(item)}>
          <View style={styles.bannerWrap}>
            <Image source={{ uri: item.bannerUrl || 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&q=80' }} style={styles.banner} />
            <LinearGradient colors={['rgba(0,0,0,0.04)', 'rgba(0,0,0,0.72)']} style={styles.bannerGradient} />
            <View style={styles.topPills}>
              <View style={[styles.rankPill, isElite && styles.elitePill]}>
                <Text style={[styles.rankText, isElite && styles.eliteText]}>{isElite ? 'ELITE' : isTrusted ? 'TRUSTED' : 'VERIFIED'}</Text>
              </View>
              {item.isFeatured ? (
                <View style={styles.featuredPill}>
                  <Text style={styles.featuredText}>FEATURED</Text>
                </View>
              ) : null}
            </View>
            <View style={styles.bannerBottom}>
              <View style={styles.logoRing}>
                <Image source={{ uri: item.logoUrl || 'https://images.unsplash.com/photo-1560472354-b33ff0c44a43?w=300&q=80' }} style={styles.logo} />
              </View>
              <View style={styles.bannerInfo}>
                <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                <View style={styles.categoryRow}>
                  <StoreIcon size={14} color="#FFFFFF" />
                  <Text style={styles.categoryText} numberOfLines={1}>{item.category || 'Premium Store'}</Text>
                </View>
              </View>
            </View>
          </View>

          <View style={styles.content}>
            <View style={styles.metaGrid}>
              <View style={styles.metaBox}>
                <ShieldIcon size={18} color={trust >= 80 ? '#10B981' : '#F59E0B'} />
                <View style={styles.metaTextWrap}>
                  <Text style={styles.metaValue}>{trust.toFixed(0)}</Text>
                  <Text style={styles.metaLabel}>Trust</Text>
                </View>
              </View>

              <View style={styles.metaBox}>
                <StarIcon size={15} color="#F5B301" />
                <View style={styles.metaTextWrap}>
                  <Text style={styles.metaValue}>{rating > 0 ? rating.toFixed(1) : 'New'}</Text>
                  <Text style={styles.metaLabel}>Rating</Text>
                </View>
              </View>

              <View style={styles.metaBox}>
                <StoreIcon size={17} color="#6366F1" />
                <View style={styles.metaTextWrap}>
                  <Text style={styles.metaValue}>{products}</Text>
                  <Text style={styles.metaLabel}>Items</Text>
                </View>
              </View>
            </View>

            <View style={styles.trustRow}>
              <TrustBadge score={trust} />
              <Text style={styles.reviewText}>{reviews} reviews</Text>
            </View>

            <Text style={styles.desc} numberOfLines={2}>
              {item.description || 'Premium curated products with trusted seller quality, secure ordering, and fast store updates.'}
            </Text>

            <View style={styles.footer}>
              <TouchableOpacity activeOpacity={0.86} style={styles.outlineBtn} onPress={() => openStore(item)}>
                <Text style={styles.outlineText}>Preview</Text>
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.9} style={styles.shopBtn} onPress={() => openStore(item)}>
                <LinearGradient colors={[theme.colors.gold || '#D4AF37', '#F7D774', '#B8871F']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.shopGradient}>
                  <Text style={styles.shopText}>Visit Store</Text>
                  <ArrowIcon size={17} color="#111827" />
                </LinearGradient>
              </TouchableOpacity>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    );
  };

  const renderHeader = () => (
    <View style={styles.headerWrap}>
      <LinearGradient colors={['#0B1020', '#111827', '#1F2937']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
        <View style={styles.heroTop}>
          <View>
            <Text style={styles.heroKicker}>Marketplace</Text>
            <Text style={styles.heroTitle}>Trusted Stores</Text>
          </View>
          <TouchableOpacity activeOpacity={0.85} style={styles.filterButton} onPress={() => setMinTrust(prev => (prev >= 90 ? 50 : prev + 10))}>
            <FilterIcon size={18} color="#111827" />
          </TouchableOpacity>
        </View>

        <View style={styles.searchBox}>
          <SearchIcon size={21} color="#94A3B8" />
          <TextInput
            placeholder="Search stores, brands, products..."
            placeholderTextColor="#94A3B8"
            value={query}
            onChangeText={setQuery}
            onSubmitEditing={() => fetchStores(query, true)}
            style={styles.searchInput}
            returnKeyType="search"
            autoCapitalize="none"
            autoCorrect={false}
          />
          {searching ? <ActivityIndicator size="small" color={theme.colors.gold || '#D4AF37'} /> : null}
          {query.length > 0 ? (
            <TouchableOpacity onPress={() => setQuery('')} style={styles.clearBtn}>
              <Text style={styles.clearText}>×</Text>
            </TouchableOpacity>
          ) : null}
        </View>

        <View style={styles.statsRow}>
          <View style={styles.statChip}>
            <Text style={styles.statValue}>{stores.length}</Text>
            <Text style={styles.statLabel}>Stores</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statValue}>{trustedCount}</Text>
            <Text style={styles.statLabel}>High Trust</Text>
          </View>
          <View style={styles.statChip}>
            <Text style={styles.statValue}>{totalProducts}</Text>
            <Text style={styles.statLabel}>Items</Text>
          </View>
        </View>
      </LinearGradient>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sortRow}>
        {[
          { key: 'trustScore', label: 'Trust Score' },
          { key: 'rating', label: 'Top Rated' },
          { key: 'createdAt', label: 'Newest' }
        ].map(item => {
          const active = sort === item.key;
          return (
            <TouchableOpacity key={item.key} activeOpacity={0.86} onPress={() => setSort(item.key as any)} style={[styles.sortPill, active && styles.sortPillActive]}>
              <Text style={[styles.sortText, active && styles.sortTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          );
        })}
        <TouchableOpacity activeOpacity={0.86} onPress={() => setMinTrust(prev => (prev === 70 ? 80 : prev === 80 ? 90 : 70))} style={styles.minTrustPill}>
          <ShieldIcon size={14} color="#10B981" />
          <Text style={styles.minTrustText}>Min {minTrust}</Text>
        </TouchableOpacity>
      </ScrollView>
    </View>
  );

  const renderEmpty = () => {
    if (loading) return null;

    return (
      <View style={styles.emptyWrap}>
        <EmptyIcon size={76} color="#CBD5E1" />
        <Text style={styles.emptyTitle}>{error ? 'Something went wrong' : 'No stores found'}</Text>
        <Text style={styles.emptyText}>{error || 'Try a different search keyword or lower the trust filter.'}</Text>
        <TouchableOpacity activeOpacity={0.86} style={styles.retryBtn} onPress={() => fetchStores(query, false)}>
          <Text style={styles.retryText}>Reload Stores</Text>
        </TouchableOpacity>
      </View>
    );
  };

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor="#0B1020" />
      <FlatList
        data={loading ? [] : stores}
        keyExtractor={item => item.id}
        renderItem={renderStore}
        ListHeaderComponent={renderHeader}
        ListEmptyComponent={loading ? (
          <View style={styles.loadingWrap}>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : renderEmpty}
        contentContainerStyle={styles.listContent}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.gold || '#D4AF37'} colors={[theme.colors.gold || '#D4AF37']} />}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={9}
        removeClippedSubviews={Platform.OS === 'android'}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F6FB'
  },
  listContent: {
    paddingBottom: 28
  },
  headerWrap: {
    backgroundColor: '#F3F6FB'
  },
  hero: {
    paddingTop: Platform.OS === 'android' ? 26 : 54,
    paddingHorizontal: 18,
    paddingBottom: 18,
    borderBottomLeftRadius: 28,
    borderBottomRightRadius: 28
  },
  heroTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 18
  },
  heroKicker: {
    color: '#C9A94A',
    fontSize: 12,
    fontWeight: '900',
    letterSpacing: 1.4,
    textTransform: 'uppercase'
  },
  heroTitle: {
    color: '#FFFFFF',
    fontSize: 31,
    fontWeight: '900',
    letterSpacing: -0.8,
    marginTop: 2
  },
  filterButton: {
    width: 46,
    height: 46,
    borderRadius: 18,
    backgroundColor: '#F8E7A1',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#F8E7A1',
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 6
  },
  searchBox: {
    height: 54,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 15
  },
  searchInput: {
    flex: 1,
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
    paddingHorizontal: 12
  },
  clearBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8
  },
  clearText: {
    color: '#FFFFFF',
    fontSize: 22,
    lineHeight: 24,
    fontWeight: '600'
  },
  statsRow: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 16
  },
  statChip: {
    flex: 1,
    paddingVertical: 12,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.09)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center'
  },
  statValue: {
    color: '#FFFFFF',
    fontSize: 18,
    fontWeight: '900'
  },
  statLabel: {
    color: '#CBD5E1',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2
  },
  sortRow: {
    paddingHorizontal: 15,
    paddingTop: 15,
    paddingBottom: 5,
    gap: 9
  },
  sortPill: {
    paddingHorizontal: 15,
    height: 38,
    borderRadius: 999,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB'
  },
  sortPillActive: {
    backgroundColor: '#111827',
    borderColor: '#111827'
  },
  sortText: {
    color: '#475569',
    fontSize: 13,
    fontWeight: '800'
  },
  sortTextActive: {
    color: '#FFFFFF'
  },
  minTrustPill: {
    paddingHorizontal: 14,
    height: 38,
    borderRadius: 999,
    backgroundColor: '#ECFDF5',
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 7,
    borderWidth: 1,
    borderColor: '#A7F3D0'
  },
  minTrustText: {
    color: '#047857',
    fontSize: 13,
    fontWeight: '900'
  },
  card: {
    marginHorizontal: 15,
    marginTop: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 24,
    overflow: 'hidden',
    shadowColor: '#0F172A',
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6
  },
  bannerWrap: {
    height: Math.min(210, width * 0.48),
    backgroundColor: '#111827'
  },
  banner: {
    width: '100%',
    height: '100%'
  },
  bannerGradient: {
    ...StyleSheet.absoluteFillObject
  },
  topPills: {
    position: 'absolute',
    top: 14,
    left: 14,
    right: 14,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  rankPill: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(255,255,255,0.92)'
  },
  elitePill: {
    backgroundColor: '#111827',
    borderWidth: 1,
    borderColor: '#F8E7A1'
  },
  rankText: {
    color: '#111827',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1
  },
  eliteText: {
    color: '#F8E7A1'
  },
  featuredPill: {
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: 'rgba(248,231,161,0.94)'
  },
  featuredText: {
    color: '#111827',
    fontSize: 10,
    fontWeight: '900',
    letterSpacing: 1
  },
  bannerBottom: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 14,
    flexDirection: 'row',
    alignItems: 'center'
  },
  logoRing: {
    width: 66,
    height: 66,
    borderRadius: 22,
    backgroundColor: 'rgba(255,255,255,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.55)'
  },
  logo: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: '#E5E7EB'
  },
  bannerInfo: {
    flex: 1,
    marginLeft: 12
  },
  name: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 21,
    letterSpacing: -0.4
  },
  categoryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4
  },
  categoryText: {
    color: '#E5E7EB',
    fontSize: 12,
    fontWeight: '700'
  },
  content: {
    padding: 15
  },
  metaGrid: {
    flexDirection: 'row',
    gap: 9
  },
  metaBox: {
    flex: 1,
    minHeight: 58,
    borderRadius: 18,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#EEF2F7',
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  metaTextWrap: {
    flex: 1
  },
  metaValue: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900'
  },
  metaLabel: {
    color: '#64748B',
    fontSize: 10,
    fontWeight: '800',
    marginTop: 1
  },
  trustRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 13,
    gap: 10
  },
  reviewText: {
    color: '#64748B',
    fontSize: 12,
    fontWeight: '700'
  },
  desc: {
    color: '#475569',
    fontSize: 14,
    lineHeight: 20,
    marginTop: 11,
    fontWeight: '500'
  },
  footer: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 15
  },
  outlineBtn: {
    height: 48,
    paddingHorizontal: 18,
    borderRadius: 16,
    backgroundColor: '#F8FAFC',
    borderWidth: 1,
    borderColor: '#E5E7EB',
    alignItems: 'center',
    justifyContent: 'center'
  },
  outlineText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900'
  },
  shopBtn: {
    flex: 1,
    height: 48,
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#D4AF37',
    shadowOpacity: 0.26,
    shadowRadius: 12,
    elevation: 4
  },
  shopGradient: {
    flex: 1,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 8
  },
  shopText: {
    color: '#111827',
    fontWeight: '900',
    fontSize: 14,
    letterSpacing: 0.2,
    textTransform: 'uppercase'
  },
  loadingWrap: {
    paddingTop: 2
  },
  skeletonCard: {
    height: 338
  },
  skeletonBanner: {
    height: 170,
    backgroundColor: '#E2E8F0'
  },
  skeletonBody: {
    flexDirection: 'row',
    padding: 15,
    alignItems: 'center',
    gap: 12
  },
  skeletonLogo: {
    width: 54,
    height: 54,
    borderRadius: 18,
    backgroundColor: '#CBD5E1'
  },
  skeletonLineLarge: {
    width: '75%',
    height: 16,
    borderRadius: 999,
    backgroundColor: '#CBD5E1'
  },
  skeletonLineSmall: {
    width: '45%',
    height: 12,
    borderRadius: 999,
    backgroundColor: '#E2E8F0',
    marginTop: 10
  },
  skeletonDesc: {
    height: 36,
    borderRadius: 12,
    backgroundColor: '#E2E8F0',
    marginHorizontal: 15
  },
  skeletonButton: {
    height: 48,
    borderRadius: 16,
    backgroundColor: '#CBD5E1',
    margin: 15
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 34,
    paddingTop: 70
  },
  emptyTitle: {
    color: '#111827',
    fontSize: 21,
    fontWeight: '900',
    marginTop: 18
  },
  emptyText: {
    color: '#64748B',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginTop: 7
  },
  retryBtn: {
    marginTop: 18,
    height: 46,
    paddingHorizontal: 22,
    borderRadius: 16,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center'
  },
  retryText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '900'
  }
});
