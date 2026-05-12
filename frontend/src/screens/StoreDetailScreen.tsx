import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  Image,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  FlatList,
  RefreshControl,
  ActivityIndicator,
  Animated,
  Share,
  StatusBar,
  Platform
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api/client';
import { theme } from '../theme';
import TrustBadge from '../components/TrustBadge';
import ProductCard from '../components/ProductCard';
import AdBanner from '../components/AdBanner';

const { width, height } = Dimensions.get('window');

type StoreDetailRoute = {
  params: {
    slug: string;
    storeId?: string;
  };
};

type StoreDetailProps = {
  route: StoreDetailRoute;
  navigation: any;
};

type StoreMetric = {
  label: string;
  value: string;
  icon: React.ReactNode;
};

const fallbackBanner = 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=1200&q=80';
const fallbackLogo = 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=300&q=80';
const fallbackAvatar = 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=200&q=80';

const formatNumber = (value: any) => {
  const num = Number(value || 0);
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num % 1_000 === 0 ? 0 : 1)}K`;
  return `${num}`;
};

const safeRating = (rating: any) => {
  const value = Number(rating || 0);
  return Number.isFinite(value) ? value : 0;
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const normalizeStore = (payload: any) => {
  if (!payload) return null;
  return payload.store || payload.data || payload;
};

const normalizeProducts = (payload: any) => {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.products)) return payload.products;
  if (Array.isArray(payload?.data)) return payload.data;
  return [];
};

const IconBag = ({ size = 20, color = '#fff' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.iconBagBody, { borderColor: color }]} />
    <View style={[styles.iconBagHandle, { borderColor: color }]} />
  </View>
);

const IconStar = ({ size = 20, color = '#F6C453' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.starCore, { backgroundColor: color, transform: [{ rotate: '45deg' }] }]} />
    <View style={[styles.starCore, { backgroundColor: color, transform: [{ rotate: '0deg' }] }]} />
  </View>
);

const IconShield = ({ size = 20, color = '#72F7C5' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.shieldTop, { borderColor: color }]} />
    <View style={[styles.shieldBottom, { borderTopColor: color }]} />
  </View>
);

const IconArrow = ({ size = 18, color = '#111' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.arrowLine, { backgroundColor: color }]} />
    <View style={[styles.arrowHead, { borderTopColor: color, borderRightColor: color }]} />
  </View>
);

const IconHeart = ({ active = false, size = 22 }: { active?: boolean; size?: number }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.heartCircleLeft, { backgroundColor: active ? '#FF3F6C' : 'transparent', borderColor: active ? '#FF3F6C' : '#fff' }]} />
    <View style={[styles.heartCircleRight, { backgroundColor: active ? '#FF3F6C' : 'transparent', borderColor: active ? '#FF3F6C' : '#fff' }]} />
    <View style={[styles.heartDiamond, { backgroundColor: active ? '#FF3F6C' : 'transparent', borderColor: active ? '#FF3F6C' : '#fff' }]} />
  </View>
);

const IconShare = ({ size = 21, color = '#fff' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.shareNodeA, { borderColor: color }]} />
    <View style={[styles.shareNodeB, { borderColor: color }]} />
    <View style={[styles.shareNodeC, { borderColor: color }]} />
    <View style={[styles.shareLineA, { backgroundColor: color, transform: [{ rotate: '-24deg' }] }]} />
    <View style={[styles.shareLineB, { backgroundColor: color, transform: [{ rotate: '24deg' }] }]} />
  </View>
);

const IconBack = ({ size = 22, color = '#fff' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.backLine, { backgroundColor: color }]} />
    <View style={[styles.backHead, { borderLeftColor: color, borderBottomColor: color }]} />
  </View>
);

const IconGrid = ({ size = 20, color = '#111' }: { size?: number; color?: string }) => (
  <View style={[styles.iconGrid, { width: size, height: size }]}>
    {[0, 1, 2, 3].map(i => <View key={i} style={[styles.gridDot, { borderColor: color }]} />)}
  </View>
);

const IconMessage = ({ size = 20, color = '#111' }: { size?: number; color?: string }) => (
  <View style={[styles.iconBox, { width: size, height: size }]}>
    <View style={[styles.msgBubble, { borderColor: color }]} />
    <View style={[styles.msgTail, { borderTopColor: color }]} />
  </View>
);

const StoreSkeleton = () => {
  const pulse = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 720, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.45, duration: 720, useNativeDriver: true })
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={styles.skeletonContainer}>
      <Animated.View style={[styles.skeletonBanner, { opacity: pulse }]} />
      <View style={styles.skeletonBody}>
        <Animated.View style={[styles.skeletonLogo, { opacity: pulse }]} />
        <View style={styles.skeletonInfo}>
          <Animated.View style={[styles.skeletonLineLarge, { opacity: pulse }]} />
          <Animated.View style={[styles.skeletonLineSmall, { opacity: pulse }]} />
          <Animated.View style={[styles.skeletonLineMedium, { opacity: pulse }]} />
        </View>
      </View>
      <View style={styles.skeletonStats}>
        {[0, 1, 2].map(i => <Animated.View key={i} style={[styles.skeletonStat, { opacity: pulse }]} />)}
      </View>
    </View>
  );
};

export default function StoreDetailScreen({ route, navigation }: StoreDetailProps) {
  const { slug, storeId } = route.params || {};
  const [store, setStore] = useState<any>(null);
  const [products, setProducts] = useState<any[]>([]);
  const [featuredProducts, setFeaturedProducts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [productsLoading, setProductsLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [following, setFollowing] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [error, setError] = useState('');
  const [selectedTab, setSelectedTab] = useState<'featured' | 'all' | 'reviews'>('featured');

  const scrollY = useRef(new Animated.Value(0)).current;
  const mountedRef = useRef(true);

  const headerOpacity = scrollY.interpolate({
    inputRange: [80, 180],
    outputRange: [0, 1],
    extrapolate: 'clamp'
  });

  const bannerScale = scrollY.interpolate({
    inputRange: [-120, 0],
    outputRange: [1.35, 1],
    extrapolateRight: 'clamp'
  });

  const bannerTranslate = scrollY.interpolate({
    inputRange: [-120, 0, 180],
    outputRange: [-30, 0, 70],
    extrapolate: 'clamp'
  });

  const fetchStore = useCallback(async (silent = false) => {
    if (!slug) return;
    if (!silent) setLoading(true);
    setError('');

    try {
      const response = await api.get(`/store/${slug}`);
      const nextStore = normalizeStore(response.data);

      if (!mountedRef.current) return;

      setStore(nextStore);
      setFollowing(Boolean(nextStore?.isFollowing || nextStore?.followed));
      setFavorite(Boolean(nextStore?.isFavorite || nextStore?.saved));

      const id = nextStore?.id || nextStore?._id || storeId;
      if (id) {
        setProductsLoading(true);
        const productResponse = await api.get(`/product/store/${id}`, {
          params: {
            limit: 24,
            sort: 'createdAt'
          }
        });

        if (!mountedRef.current) return;

        const list = normalizeProducts(productResponse.data);
        setProducts(list);
        setFeaturedProducts(list.filter((p: any) => p?.isFeatured || p?.featured || p?.salesCount > 0).slice(0, 10).length ? list.filter((p: any) => p?.isFeatured || p?.featured || p?.salesCount > 0).slice(0, 10) : list.slice(0, 10));
      }
    } catch (err: any) {
      if (!mountedRef.current) return;
      setError(err?.response?.data?.error || err?.message || 'Unable to load store');
    } finally {
      if (!mountedRef.current) return;
      setLoading(false);
      setProductsLoading(false);
      setRefreshing(false);
    }
  }, [slug, storeId]);

  useEffect(() => {
    mountedRef.current = true;
    fetchStore();
    return () => {
      mountedRef.current = false;
    };
  }, [fetchStore]);

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchStore(true);
  };

  const rating = useMemo(() => safeRating(store?.rating), [store]);
  const reviewCount = Number(store?._count?.reviews || store?.reviews?.length || 0);
  const productCount = Number(store?._count?.products || products.length || 0);
  const orderCount = Number(store?._count?.orders || store?.ordersCount || 0);
  const trustScore = clamp(Number(store?.trustScore || 0), 0, 100);

  const metrics: StoreMetric[] = useMemo(() => [
    { label: 'Trust', value: `${Math.round(trustScore)}%`, icon: <IconShield size={18} color="#72F7C5" /> },
    { label: 'Rating', value: rating ? rating.toFixed(1) : 'New', icon: <IconStar size={18} color="#F6C453" /> },
    { label: 'Products', value: formatNumber(productCount), icon: <IconBag size={18} color="#A7F3FF" /> },
    { label: 'Orders', value: formatNumber(orderCount), icon: <IconGrid size={18} color="#F8D47A" /> }
  ], [trustScore, rating, productCount, orderCount]);

  const handleFollow = async () => {
    const previous = following;
    setFollowing(!previous);

    try {
      await api.post(`/store/${store?.id || store?._id}/follow`, { remove: previous });
    } catch {
      setFollowing(previous);
    }
  };

  const handleFavorite = async () => {
    const previous = favorite;
    setFavorite(!previous);

    try {
      await api.post(`/store/${store?.id || store?._id}/save`, { remove: previous });
    } catch {
      setFavorite(previous);
    }
  };

  const handleShare = async () => {
    try {
      await Share.share({
        title: store?.name || 'Store',
        message: `Check out ${store?.name || 'this store'}${store?.slug ? `: ${store.slug}` : ''}`
      });
    } catch {}
  };

  const openProduct = (product: any) => {
    navigation.navigate('ProductDetail', { id: product.id || product._id });
  };

  const renderProduct = ({ item }: { item: any }) => (
    <TouchableOpacity activeOpacity={0.86} style={styles.productWrap} onPress={() => openProduct(item)}>
      <ProductCard product={item} />
    </TouchableOpacity>
  );

  const renderMiniProduct = ({ item }: { item: any }) => (
    <TouchableOpacity activeOpacity={0.88} style={styles.miniProduct} onPress={() => openProduct(item)}>
      <Image source={{ uri: item.primaryMediaUrl || item.mediaUrls?.[0] || fallbackLogo }} style={styles.miniProductImage} />
      <LinearGradient colors={['transparent', 'rgba(0,0,0,0.72)']} style={styles.miniProductOverlay} />
      <Text style={styles.miniProductName} numberOfLines={1}>{item.name || 'Premium Product'}</Text>
      <Text style={styles.miniProductPrice}>₹{Number(item.price || 0).toLocaleString('en-IN')}</Text>
    </TouchableOpacity>
  );

  if (loading && !store) {
    return (
      <View style={styles.container}>
        <StatusBar barStyle="light-content" />
        <StoreSkeleton />
      </View>
    );
  }

  if (error && !store) {
    return (
      <View style={styles.errorScreen}>
        <View style={styles.errorIcon}>
          <IconBag size={42} color="#F8D47A" />
        </View>
        <Text style={styles.errorTitle}>Store not available</Text>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity activeOpacity={0.85} style={styles.retryButton} onPress={() => fetchStore()}>
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const visibleProducts = selectedTab === 'featured' ? featuredProducts : products;

  return (
    <View style={styles.container}>
      <StatusBar barStyle="light-content" translucent backgroundColor="transparent" />

      <Animated.View style={[styles.floatingHeader, { opacity: headerOpacity }]}>
        <LinearGradient colors={['rgba(8,10,18,0.98)', 'rgba(8,10,18,0.86)']} style={styles.floatingHeaderBg}>
          <TouchableOpacity activeOpacity={0.82} style={styles.headerCircle} onPress={() => navigation.goBack()}>
            <IconBack size={22} color="#fff" />
          </TouchableOpacity>
          <Text style={styles.floatingTitle} numberOfLines={1}>{store?.name || 'Store'}</Text>
          <TouchableOpacity activeOpacity={0.82} style={styles.headerCircle} onPress={handleShare}>
            <IconShare size={20} color="#fff" />
          </TouchableOpacity>
        </LinearGradient>
      </Animated.View>

      <Animated.ScrollView
        style={styles.scroll}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.gold || '#F8D47A'} />}
        onScroll={Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true })}
        scrollEventThrottle={16}
      >
        <View style={styles.hero}>
          <Animated.Image
            source={{ uri: store?.bannerUrl || fallbackBanner }}
            style={[
              styles.banner,
              {
                transform: [
                  { scale: bannerScale },
                  { translateY: bannerTranslate }
                ]
              }
            ]}
          />
          <LinearGradient colors={['rgba(0,0,0,0.08)', 'rgba(0,0,0,0.34)', '#080A12']} style={styles.bannerShade} />

          <View style={styles.heroTop}>
            <TouchableOpacity activeOpacity={0.82} style={styles.heroButton} onPress={() => navigation.goBack()}>
              <IconBack size={22} color="#fff" />
            </TouchableOpacity>
            <View style={styles.heroActions}>
              <TouchableOpacity activeOpacity={0.82} style={styles.heroButton} onPress={handleFavorite}>
                <IconHeart active={favorite} size={22} />
              </TouchableOpacity>
              <TouchableOpacity activeOpacity={0.82} style={styles.heroButton} onPress={handleShare}>
                <IconShare size={21} color="#fff" />
              </TouchableOpacity>
            </View>
          </View>

          <View style={styles.heroContent}>
            <View style={styles.logoFrame}>
              <Image source={{ uri: store?.logoUrl || fallbackLogo }} style={styles.logo} />
              {store?.isVerified ? (
                <View style={styles.verifiedDot}>
                  <IconShield size={14} color="#07110D" />
                </View>
              ) : null}
            </View>

            <View style={styles.heroInfo}>
              <View style={styles.titleLine}>
                <Text style={styles.name} numberOfLines={1}>{store?.name || 'Premium Store'}</Text>
              </View>
              <Text style={styles.slug} numberOfLines={1}>@{store?.slug || slug}</Text>
              <View style={styles.badgeLine}>
                <TrustBadge score={trustScore} />
                {store?.isVerified ? <Text style={styles.proBadge}>Verified Seller</Text> : <Text style={styles.proBadgeMuted}>Under Review</Text>}
              </View>
            </View>
          </View>
        </View>

        <View style={styles.mainCard}>
          <View style={styles.actionRow}>
            <TouchableOpacity activeOpacity={0.88} style={styles.followButton} onPress={handleFollow}>
              <LinearGradient colors={following ? ['#1F2937', '#111827'] : ['#F8D47A', '#F1B84B']} style={styles.followGradient}>
                <Text style={[styles.followText, following && styles.followingText]}>{following ? 'Following' : 'Follow Store'}</Text>
              </LinearGradient>
            </TouchableOpacity>

            <TouchableOpacity activeOpacity={0.88} style={styles.messageButton} onPress={() => navigation.navigate('StoreChat', { storeId: store?.id || store?._id, slug: store?.slug })}>
              <IconMessage size={20} color="#111827" />
              <Text style={styles.messageText}>Message</Text>
            </TouchableOpacity>
          </View>

          <Text style={styles.desc}>
            {store?.description || 'Premium curated products, trusted seller experience, fast support, and quality-focused marketplace collection.'}
          </Text>

          <View style={styles.metricGrid}>
            {metrics.map(item => (
              <View key={item.label} style={styles.metricCard}>
                <View style={styles.metricIcon}>{item.icon}</View>
                <Text style={styles.metricValue}>{item.value}</Text>
                <Text style={styles.metricLabel}>{item.label}</Text>
              </View>
            ))}
          </View>

          <View style={styles.infoStrip}>
            <View style={styles.infoPill}>
              <Text style={styles.infoPillText}>{store?.category || store?.businessCategory || 'Lifestyle'}</Text>
            </View>
            <View style={styles.infoPill}>
              <Text style={styles.infoPillText}>{store?.address?.city || store?.location || 'Global Delivery'}</Text>
            </View>
            <View style={styles.infoPill}>
              <Text style={styles.infoPillText}>{store?.status === 'active' || !store?.status ? 'Open' : store?.status}</Text>
            </View>
          </View>
        </View>

        <View style={styles.adWrap}>
          <AdBanner type="store_detail" storeId={store?.id || store?._id} />
        </View>

        {featuredProducts.length > 0 ? (
          <View style={styles.featuredSection}>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionKicker}>Curated Picks</Text>
                <Text style={styles.sectionTitle}>Featured Products</Text>
              </View>
              <TouchableOpacity activeOpacity={0.8} onPress={() => setSelectedTab('all')} style={styles.seeAllButton}>
                <Text style={styles.seeAllText}>View All</Text>
                <IconArrow size={15} color="#F8D47A" />
              </TouchableOpacity>
            </View>

            <FlatList
              horizontal
              data={featuredProducts}
              keyExtractor={(item, index) => String(item.id || item._id || index)}
              renderItem={renderMiniProduct}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.featuredList}
            />
          </View>
        ) : null}

        <View style={styles.tabs}>
          {[
            { key: 'featured', label: 'Featured' },
            { key: 'all', label: 'All Products' },
            { key: 'reviews', label: 'Reviews' }
          ].map(tab => (
            <TouchableOpacity
              key={tab.key}
              activeOpacity={0.82}
              style={[styles.tab, selectedTab === tab.key && styles.activeTab]}
              onPress={() => setSelectedTab(tab.key as any)}
            >
              <Text style={[styles.tabText, selectedTab === tab.key && styles.activeTabText]}>{tab.label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        {selectedTab !== 'reviews' ? (
          <View style={styles.productsSection}>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionKicker}>{selectedTab === 'featured' ? 'Best Selection' : 'Full Catalog'}</Text>
                <Text style={styles.sectionTitle}>{selectedTab === 'featured' ? 'Top Store Items' : 'All Products'}</Text>
              </View>
              {productsLoading ? <ActivityIndicator color={theme.colors.gold || '#F8D47A'} /> : <Text style={styles.countText}>{formatNumber(visibleProducts.length)} items</Text>}
            </View>

            {visibleProducts.length > 0 ? (
              <FlatList
                data={visibleProducts}
                keyExtractor={(item, index) => String(item.id || item._id || index)}
                renderItem={renderProduct}
                scrollEnabled={false}
                numColumns={2}
                columnWrapperStyle={styles.productRow}
                contentContainerStyle={styles.productList}
              />
            ) : (
              <View style={styles.emptyProducts}>
                <View style={styles.emptyIcon}>
                  <IconBag size={38} color="#F8D47A" />
                </View>
                <Text style={styles.emptyTitle}>No products yet</Text>
                <Text style={styles.emptyText}>This store has not published active products right now.</Text>
              </View>
            )}
          </View>
        ) : (
          <View style={styles.reviewsSection}>
            <View style={styles.sectionHeader}>
              <View>
                <Text style={styles.sectionKicker}>Customer Voice</Text>
                <Text style={styles.sectionTitle}>Recent Reviews</Text>
              </View>
              <Text style={styles.countText}>{formatNumber(reviewCount)} reviews</Text>
            </View>

            {store?.reviews?.length ? store.reviews.map((r: any, index: number) => {
              const stars = clamp(Number(r.rating || 0), 0, 5);
              return (
                <View key={r.id || index} style={styles.review}>
                  <Image source={{ uri: r?.buyer?.avatarUrl || fallbackAvatar }} style={styles.avatar} />
                  <View style={styles.reviewContent}>
                    <View style={styles.reviewTop}>
                      <View>
                        <Text style={styles.reviewer} numberOfLines={1}>@{r?.buyer?.username || 'customer'}</Text>
                        <Text style={styles.reviewDate}>{r?.createdAt ? new Date(r.createdAt).toLocaleDateString() : 'Recent'}</Text>
                      </View>
                      <View style={styles.reviewStars}>
                        {Array.from({ length: 5 }).map((_, i) => (
                          <IconStar key={i} size={12} color={i < stars ? '#F6C453' : '#D7DCE6'} />
                        ))}
                      </View>
                    </View>
                    <Text style={styles.reviewText} numberOfLines={3}>{r.comment || 'Highly recommended. Smooth buying experience and premium quality.'}</Text>
                  </View>
                </View>
              );
            }) : (
              <View style={styles.emptyProducts}>
                <View style={styles.emptyIcon}>
                  <IconStar size={38} color="#F8D47A" />
                </View>
                <Text style={styles.emptyTitle}>No reviews yet</Text>
                <Text style={styles.emptyText}>First buyers will see their feedback here.</Text>
              </View>
            )}
          </View>
        )}

        <View style={styles.bottomSpace} />
      </Animated.ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#080A12'
  },
  scroll: {
    flex: 1
  },
  floatingHeader: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20
  },
  floatingHeaderBg: {
    paddingTop: Platform.OS === 'android' ? 34 : 48,
    paddingHorizontal: 14,
    paddingBottom: 12,
    flexDirection: 'row',
    alignItems: 'center'
  },
  headerCircle: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)'
  },
  floatingTitle: {
    flex: 1,
    color: '#fff',
    fontSize: 17,
    fontWeight: '900',
    marginHorizontal: 12,
    textAlign: 'center'
  },
  hero: {
    height: height * 0.43,
    minHeight: 330,
    overflow: 'hidden',
    backgroundColor: '#080A12'
  },
  banner: {
    width: '100%',
    height: '100%',
    position: 'absolute'
  },
  bannerShade: {
    position: 'absolute',
    inset: 0
  },
  heroTop: {
    position: 'absolute',
    top: Platform.OS === 'android' ? 34 : 52,
    left: 14,
    right: 14,
    zIndex: 4,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  heroActions: {
    flexDirection: 'row',
    gap: 10
  },
  heroButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.36)',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)'
  },
  heroContent: {
    position: 'absolute',
    left: 18,
    right: 18,
    bottom: 24,
    flexDirection: 'row',
    alignItems: 'center'
  },
  logoFrame: {
    width: 88,
    height: 88,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.12)',
    padding: 4,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.28)'
  },
  logo: {
    width: '100%',
    height: '100%',
    borderRadius: 24,
    backgroundColor: '#161A24'
  },
  verifiedDot: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#72F7C5',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    borderColor: '#080A12'
  },
  heroInfo: {
    flex: 1,
    marginLeft: 14
  },
  titleLine: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  name: {
    color: '#fff',
    fontSize: 27,
    fontWeight: '950',
    letterSpacing: -0.7,
    flex: 1
  },
  slug: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 3
  },
  badgeLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 9,
    flexWrap: 'wrap'
  },
  proBadge: {
    color: '#07110D',
    backgroundColor: '#72F7C5',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden'
  },
  proBadgeMuted: {
    color: '#D7DCE6',
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 999,
    fontSize: 11,
    fontWeight: '900',
    overflow: 'hidden'
  },
  mainCard: {
    marginTop: -12,
    marginHorizontal: 14,
    backgroundColor: '#111521',
    borderRadius: 28,
    padding: 16,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    shadowColor: '#000',
    shadowOpacity: 0.28,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 10
  },
  actionRow: {
    flexDirection: 'row',
    gap: 10
  },
  followButton: {
    flex: 1,
    borderRadius: 18,
    overflow: 'hidden'
  },
  followGradient: {
    height: 50,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  followText: {
    color: '#111827',
    fontSize: 15,
    fontWeight: '950'
  },
  followingText: {
    color: '#fff'
  },
  messageButton: {
    height: 50,
    paddingHorizontal: 16,
    borderRadius: 18,
    backgroundColor: '#fff',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8
  },
  messageText: {
    color: '#111827',
    fontWeight: '900',
    fontSize: 14
  },
  desc: {
    color: '#C9D0DD',
    fontSize: 14,
    lineHeight: 21,
    marginTop: 15,
    fontWeight: '500'
  },
  metricGrid: {
    flexDirection: 'row',
    gap: 9,
    marginTop: 16
  },
  metricCard: {
    flex: 1,
    backgroundColor: '#171C2A',
    borderRadius: 18,
    paddingVertical: 13,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.06)'
  },
  metricIcon: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8
  },
  metricValue: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '950'
  },
  metricLabel: {
    color: '#8E98AA',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 2
  },
  infoStrip: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
    marginTop: 15
  },
  infoPill: {
    backgroundColor: 'rgba(248,212,122,0.1)',
    borderColor: 'rgba(248,212,122,0.22)',
    borderWidth: 1,
    paddingHorizontal: 11,
    paddingVertical: 7,
    borderRadius: 999
  },
  infoPillText: {
    color: '#F8D47A',
    fontSize: 12,
    fontWeight: '850'
  },
  adWrap: {
    marginTop: 18,
    marginHorizontal: 14,
    borderRadius: 22,
    overflow: 'hidden'
  },
  featuredSection: {
    paddingTop: 22
  },
  sectionHeader: {
    paddingHorizontal: 16,
    marginBottom: 13,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  sectionKicker: {
    color: '#F8D47A',
    fontSize: 11,
    fontWeight: '950',
    textTransform: 'uppercase',
    letterSpacing: 1.2,
    marginBottom: 3
  },
  sectionTitle: {
    color: '#fff',
    fontSize: 21,
    fontWeight: '950',
    letterSpacing: -0.4
  },
  seeAllButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: 'rgba(248,212,122,0.1)'
  },
  seeAllText: {
    color: '#F8D47A',
    fontSize: 12,
    fontWeight: '900'
  },
  featuredList: {
    paddingHorizontal: 16,
    gap: 12
  },
  miniProduct: {
    width: width * 0.43,
    height: 210,
    borderRadius: 24,
    overflow: 'hidden',
    backgroundColor: '#151A26',
    marginRight: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)'
  },
  miniProductImage: {
    width: '100%',
    height: '100%'
  },
  miniProductOverlay: {
    position: 'absolute',
    inset: 0
  },
  miniProductName: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 34,
    color: '#fff',
    fontSize: 14,
    fontWeight: '900'
  },
  miniProductPrice: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 13,
    color: '#F8D47A',
    fontSize: 13,
    fontWeight: '950'
  },
  tabs: {
    marginTop: 24,
    marginHorizontal: 14,
    backgroundColor: '#111521',
    borderRadius: 20,
    padding: 5,
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)'
  },
  tab: {
    flex: 1,
    height: 42,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center'
  },
  activeTab: {
    backgroundColor: '#F8D47A'
  },
  tabText: {
    color: '#9AA4B6',
    fontSize: 12,
    fontWeight: '900'
  },
  activeTabText: {
    color: '#111827'
  },
  productsSection: {
    paddingTop: 22
  },
  countText: {
    color: '#9AA4B6',
    fontSize: 12,
    fontWeight: '850'
  },
  productList: {
    paddingHorizontal: 14
  },
  productRow: {
    justifyContent: 'space-between'
  },
  productWrap: {
    width: (width - 42) / 2,
    marginBottom: 14
  },
  reviewsSection: {
    paddingTop: 22,
    paddingHorizontal: 14
  },
  review: {
    flexDirection: 'row',
    padding: 14,
    backgroundColor: '#111521',
    borderRadius: 22,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)'
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#202638'
  },
  reviewContent: {
    flex: 1,
    marginLeft: 12
  },
  reviewTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    gap: 10
  },
  reviewer: {
    color: '#fff',
    fontWeight: '900',
    fontSize: 14,
    maxWidth: width * 0.38
  },
  reviewDate: {
    color: '#7D8798',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 2
  },
  reviewStars: {
    flexDirection: 'row',
    gap: 2,
    marginTop: 2
  },
  reviewText: {
    color: '#C9D0DD',
    fontSize: 13,
    lineHeight: 19,
    marginTop: 9,
    fontWeight: '500'
  },
  emptyProducts: {
    marginHorizontal: 14,
    padding: 28,
    borderRadius: 28,
    backgroundColor: '#111521',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.07)'
  },
  emptyIcon: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: 'rgba(248,212,122,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14
  },
  emptyTitle: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '950'
  },
  emptyText: {
    color: '#8E98AA',
    fontSize: 13,
    textAlign: 'center',
    marginTop: 6,
    lineHeight: 19
  },
  bottomSpace: {
    height: 42
  },
  errorScreen: {
    flex: 1,
    backgroundColor: '#080A12',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 26
  },
  errorIcon: {
    width: 86,
    height: 86,
    borderRadius: 43,
    backgroundColor: 'rgba(248,212,122,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 18
  },
  errorTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '950',
    marginBottom: 8
  },
  errorText: {
    color: '#9AA4B6',
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 21,
    marginBottom: 20
  },
  retryButton: {
    backgroundColor: '#F8D47A',
    paddingHorizontal: 24,
    paddingVertical: 13,
    borderRadius: 999
  },
  retryText: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '950'
  },
  skeletonContainer: {
    flex: 1,
    backgroundColor: '#080A12'
  },
  skeletonBanner: {
    height: height * 0.42,
    backgroundColor: '#151A26'
  },
  skeletonBody: {
    marginTop: -34,
    marginHorizontal: 14,
    backgroundColor: '#111521',
    borderRadius: 28,
    padding: 16,
    flexDirection: 'row'
  },
  skeletonLogo: {
    width: 82,
    height: 82,
    borderRadius: 24,
    backgroundColor: '#202638'
  },
  skeletonInfo: {
    flex: 1,
    marginLeft: 14,
    justifyContent: 'center'
  },
  skeletonLineLarge: {
    width: '76%',
    height: 18,
    borderRadius: 9,
    backgroundColor: '#202638',
    marginBottom: 12
  },
  skeletonLineSmall: {
    width: '46%',
    height: 12,
    borderRadius: 6,
    backgroundColor: '#202638',
    marginBottom: 12
  },
  skeletonLineMedium: {
    width: '62%',
    height: 14,
    borderRadius: 7,
    backgroundColor: '#202638'
  },
  skeletonStats: {
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 14,
    marginTop: 16
  },
  skeletonStat: {
    flex: 1,
    height: 88,
    borderRadius: 20,
    backgroundColor: '#111521'
  },
  iconBox: {
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative'
  },
  iconBagBody: {
    position: 'absolute',
    bottom: 2,
    width: '78%',
    height: '62%',
    borderWidth: 2,
    borderRadius: 4
  },
  iconBagHandle: {
    position: 'absolute',
    top: 1,
    width: '42%',
    height: '34%',
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderRightWidth: 2,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8
  },
  starCore: {
    position: 'absolute',
    width: '54%',
    height: '54%',
    borderRadius: 2
  },
  shieldTop: {
    position: 'absolute',
    top: 1,
    width: '70%',
    height: '54%',
    borderWidth: 2,
    borderBottomWidth: 0,
    borderTopLeftRadius: 8,
    borderTopRightRadius: 8
  },
  shieldBottom: {
    position: 'absolute',
    bottom: 0,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderTopWidth: 10,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent'
  },
  arrowLine: {
    position: 'absolute',
    width: '64%',
    height: 2,
    borderRadius: 2
  },
  arrowHead: {
    position: 'absolute',
    right: 2,
    width: 8,
    height: 8,
    borderTopWidth: 2,
    borderRightWidth: 2,
    transform: [{ rotate: '45deg' }]
  },
  heartCircleLeft: {
    position: 'absolute',
    top: 3,
    left: 3,
    width: '45%',
    height: '45%',
    borderRadius: 999,
    borderWidth: 2
  },
  heartCircleRight: {
    position: 'absolute',
    top: 3,
    right: 3,
    width: '45%',
    height: '45%',
    borderRadius: 999,
    borderWidth: 2
  },
  heartDiamond: {
    position: 'absolute',
    bottom: 3,
    width: '54%',
    height: '54%',
    borderRightWidth: 2,
    borderBottomWidth: 2,
    transform: [{ rotate: '45deg' }]
  },
  shareNodeA: {
    position: 'absolute',
    left: 1,
    top: 8,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 2
  },
  shareNodeB: {
    position: 'absolute',
    right: 1,
    top: 2,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 2
  },
  shareNodeC: {
    position: 'absolute',
    right: 1,
    bottom: 2,
    width: 7,
    height: 7,
    borderRadius: 4,
    borderWidth: 2
  },
  shareLineA: {
    position: 'absolute',
    left: 7,
    top: 8,
    width: 10,
    height: 2,
    borderRadius: 2
  },
  shareLineB: {
    position: 'absolute',
    left: 7,
    bottom: 8,
    width: 10,
    height: 2,
    borderRadius: 2
  },
  backLine: {
    position: 'absolute',
    width: '62%',
    height: 2,
    borderRadius: 2
  },
  backHead: {
    position: 'absolute',
    left: 3,
    width: 10,
    height: 10,
    borderLeftWidth: 2,
    borderBottomWidth: 2,
    transform: [{ rotate: '45deg' }]
  },
  iconGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 3,
    alignItems: 'center',
    justifyContent: 'center'
  },
  gridDot: {
    width: '38%',
    height: '38%',
    borderWidth: 2,
    borderRadius: 4
  },
  msgBubble: {
    width: '78%',
    height: '62%',
    borderRadius: 7,
    borderWidth: 2
  },
  msgTail: {
    position: 'absolute',
    bottom: 1,
    left: 5,
    width: 0,
    height: 0,
    borderTopWidth: 7,
    borderRightWidth: 6,
    borderRightColor: 'transparent'
  }
});
