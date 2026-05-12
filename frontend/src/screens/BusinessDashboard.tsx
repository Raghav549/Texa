import React, { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, RefreshControl, ActivityIndicator, Dimensions, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { api } from '../api/client';
import { theme } from '../theme';

const { width } = Dimensions.get('window');

type Analytics = {
  revenue?: number;
  orderCount?: number;
  productCount?: number;
  avgRating?: number;
  productSales?: number;
  productViews?: number;
  adMetrics?: {
    impressions?: number;
    clicks?: number;
    conversions?: number;
  };
  store?: {
    id?: string;
    name?: string;
    trustScore?: number;
    rating?: number;
    isVerified?: boolean;
  };
};

type IconProps = {
  type: 'revenue' | 'orders' | 'products' | 'rating' | 'add' | 'manage' | 'ads' | 'settings' | 'views' | 'sales' | 'conversion' | 'trust' | 'refresh' | 'empty';
  size?: number;
};

const money = (value: number) => {
  if (!Number.isFinite(value)) return '$0.00';
  if (value >= 1000000) return `$${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `$${(value / 1000).toFixed(1)}K`;
  return `$${value.toFixed(2)}`;
};

const compact = (value: number) => {
  if (!Number.isFinite(value)) return '0';
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return `${Math.round(value)}`;
};

const percent = (value: number) => {
  if (!Number.isFinite(value)) return '0.0%';
  return `${value.toFixed(1)}%`;
};

const getSafeNumber = (value: any) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const getTrustTier = (score: number) => {
  if (score >= 90) return 'Diamond';
  if (score >= 75) return 'Gold';
  if (score >= 60) return 'Silver';
  return 'Bronze';
};

const Icon = memo(({ type, size = 26 }: IconProps) => {
  const iconStyle = useMemo(() => [styles.customIcon, { width: size, height: size, borderRadius: size / 2 }], [size]);

  if (type === 'revenue') {
    return (
      <View style={iconStyle}>
        <View style={styles.coinOuter}>
          <View style={styles.coinInner} />
        </View>
      </View>
    );
  }

  if (type === 'orders') {
    return (
      <View style={iconStyle}>
        <View style={styles.boxTop} />
        <View style={styles.boxBody} />
      </View>
    );
  }

  if (type === 'products') {
    return (
      <View style={iconStyle}>
        <View style={styles.tagShape} />
        <View style={styles.tagDot} />
      </View>
    );
  }

  if (type === 'rating') {
    return (
      <View style={iconStyle}>
        <Text style={[styles.iconGlyph, { fontSize: size * 0.7 }]}>✦</Text>
      </View>
    );
  }

  if (type === 'add') {
    return (
      <View style={iconStyle}>
        <View style={styles.plusVertical} />
        <View style={styles.plusHorizontal} />
      </View>
    );
  }

  if (type === 'manage') {
    return (
      <View style={iconStyle}>
        <View style={styles.listLineWide} />
        <View style={styles.listLine} />
        <View style={styles.listLineShort} />
      </View>
    );
  }

  if (type === 'ads') {
    return (
      <View style={iconStyle}>
        <View style={styles.megaphoneBody} />
        <View style={styles.megaphoneHandle} />
      </View>
    );
  }

  if (type === 'settings') {
    return (
      <View style={iconStyle}>
        <Text style={[styles.iconGlyph, { fontSize: size * 0.62 }]}>⚙</Text>
      </View>
    );
  }

  if (type === 'views') {
    return (
      <View style={iconStyle}>
        <View style={styles.eyeOuter} />
        <View style={styles.eyeInner} />
      </View>
    );
  }

  if (type === 'sales') {
    return (
      <View style={iconStyle}>
        <View style={styles.chartBarSmall} />
        <View style={styles.chartBarMid} />
        <View style={styles.chartBarTall} />
      </View>
    );
  }

  if (type === 'conversion') {
    return (
      <View style={iconStyle}>
        <View style={styles.targetOuter} />
        <View style={styles.targetInner} />
      </View>
    );
  }

  if (type === 'trust') {
    return (
      <View style={iconStyle}>
        <View style={styles.shieldTop} />
        <View style={styles.shieldBottom} />
      </View>
    );
  }

  if (type === 'refresh') {
    return (
      <View style={iconStyle}>
        <Text style={[styles.iconGlyph, { fontSize: size * 0.62 }]}>↻</Text>
      </View>
    );
  }

  return (
    <View style={iconStyle}>
      <Text style={[styles.iconGlyph, { fontSize: size * 0.62 }]}>◇</Text>
    </View>
  );
});

const MetricCard = memo(({ label, value, sub, type, tone }: any) => (
  <LinearGradient colors={tone} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.metricCard}>
    <View style={styles.metricTop}>
      <Icon type={type} size={34} />
      <View style={styles.metricPulse} />
    </View>
    <Text style={styles.metricValue} numberOfLines={1}>{value}</Text>
    <Text style={styles.metricLabel}>{label}</Text>
    {!!sub && <Text style={styles.metricSub}>{sub}</Text>}
  </LinearGradient>
));

const ActionButton = memo(({ title, subtitle, type, onPress }: any) => (
  <TouchableOpacity activeOpacity={0.86} style={styles.action} onPress={onPress}>
    <View style={styles.actionIconWrap}>
      <Icon type={type} size={30} />
    </View>
    <View style={styles.actionContent}>
      <Text style={styles.actionText}>{title}</Text>
      <Text style={styles.actionSub}>{subtitle}</Text>
    </View>
    <Text style={styles.actionArrow}>›</Text>
  </TouchableOpacity>
));

const PerformanceRow = memo(({ label, value, type, accent }: any) => (
  <View style={styles.performanceRow}>
    <View style={styles.performanceLeft}>
      <Icon type={type} size={28} />
      <Text style={styles.performanceLabel}>{label}</Text>
    </View>
    <Text style={[styles.performanceValue, { color: accent }]}>{value}</Text>
  </View>
));

export default function BusinessDashboard({ navigation }: any) {
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const loadAnalytics = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      setError('');
      const res = await api.get('/store/analytics');
      setAnalytics(res.data || {});
    } catch (e: any) {
      setError(e?.response?.data?.error || e?.message || 'Unable to load dashboard');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    loadAnalytics();
  }, [loadAnalytics]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await loadAnalytics(true);
  }, [loadAnalytics]);

  const revenue = getSafeNumber(analytics?.revenue);
  const orders = getSafeNumber(analytics?.orderCount);
  const products = getSafeNumber(analytics?.productCount);
  const rating = getSafeNumber(analytics?.avgRating);
  const sales = getSafeNumber(analytics?.productSales);
  const views = getSafeNumber(analytics?.productViews);
  const impressions = getSafeNumber(analytics?.adMetrics?.impressions);
  const clicks = getSafeNumber(analytics?.adMetrics?.clicks);
  const conversions = getSafeNumber(analytics?.adMetrics?.conversions);
  const ctr = impressions > 0 ? (clicks / impressions) * 100 : 0;
  const conversionRate = clicks > 0 ? (conversions / clicks) * 100 : 0;
  const avgOrderValue = orders > 0 ? revenue / orders : 0;
  const trustScore = getSafeNumber(analytics?.store?.trustScore);

  const metricCards = useMemo(() => [
    { label: 'Revenue', value: money(revenue), sub: `${money(avgOrderValue)} avg order`, type: 'revenue', tone: ['#17120A', '#3A270A', '#D4A857'] },
    { label: 'Orders', value: compact(orders), sub: `${compact(conversions)} ad conversions`, type: 'orders', tone: ['#08141A', '#08313B', '#00E0FF'] },
    { label: 'Products', value: compact(products), sub: `${compact(sales)} sold`, type: 'products', tone: ['#100B1C', '#31105C', '#A855F7'] },
    { label: 'Avg Rating', value: rating ? rating.toFixed(1) : '0.0', sub: `${getTrustTier(trustScore)} trust`, type: 'rating', tone: ['#1B1008', '#4A2607', '#FFB020'] }
  ], [revenue, avgOrderValue, orders, conversions, products, sales, rating, trustScore]);

  if (loading && !analytics) {
    return (
      <View style={styles.loadingContainer}>
        <LinearGradient colors={['#090909', '#17120A', '#000000']} style={styles.loadingCard}>
          <View style={styles.loadingOrb}>
            <ActivityIndicator size="large" color={theme.colors.gold || '#D4A857'} />
          </View>
          <Text style={styles.loadingTitle}>Loading Business Command Center</Text>
          <Text style={styles.loadingSub}>Preparing revenue, orders, ads and store intelligence</Text>
        </LinearGradient>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} showsVerticalScrollIndicator={false} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.gold || '#D4A857'} />}>
      <LinearGradient colors={['#050505', '#15110A', '#211604']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.hero}>
        <View style={styles.heroTop}>
          <View>
            <Text style={styles.kicker}>STORE OS</Text>
            <Text style={styles.header}>Business Dashboard</Text>
            <Text style={styles.subHeader}>{analytics?.store?.name || 'Your premium commerce control room'}</Text>
          </View>
          <TouchableOpacity activeOpacity={0.85} style={styles.refreshBtn} onPress={onRefresh}>
            <Icon type="refresh" size={28} />
          </TouchableOpacity>
        </View>

        <View style={styles.heroStats}>
          <View style={styles.heroStat}>
            <Text style={styles.heroStatValue}>{compact(views)}</Text>
            <Text style={styles.heroStatLabel}>Product Views</Text>
          </View>
          <View style={styles.heroDivider} />
          <View style={styles.heroStat}>
            <Text style={styles.heroStatValue}>{percent(ctr)}</Text>
            <Text style={styles.heroStatLabel}>Ad CTR</Text>
          </View>
          <View style={styles.heroDivider} />
          <View style={styles.heroStat}>
            <Text style={styles.heroStatValue}>{trustScore ? Math.round(trustScore) : 0}</Text>
            <Text style={styles.heroStatLabel}>Trust Score</Text>
          </View>
        </View>
      </LinearGradient>

      {!!error && (
        <TouchableOpacity activeOpacity={0.86} style={styles.errorBox} onPress={() => loadAnalytics()}>
          <Text style={styles.errorTitle}>Dashboard refresh failed</Text>
          <Text style={styles.errorText}>{error}</Text>
          <Text style={styles.errorAction}>Tap to retry</Text>
        </TouchableOpacity>
      )}

      <View style={styles.grid}>
        {metricCards.map((item: any) => (
          <MetricCard key={item.label} {...item} />
        ))}
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Quick Actions</Text>
          <Text style={styles.sectionHint}>Run your store faster</Text>
        </View>
        <ActionButton title="Add Product" subtitle="Upload item, price, media and inventory" type="add" onPress={() => navigation.navigate('AddProduct')} />
        <ActionButton title="Manage Orders" subtitle="Track, ship, cancel or update orders" type="manage" onPress={() => navigation.navigate('ManageOrders')} />
        <ActionButton title="Create Advertisement" subtitle="Boost products with targeted campaigns" type="ads" onPress={() => navigation.navigate('AdManager')} />
        <ActionButton title="Store Settings" subtitle="Branding, policies, shipping and profile" type="settings" onPress={() => navigation.navigate('StoreSettings')} />
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Ad Performance</Text>
          <Text style={styles.sectionHint}>{percent(conversionRate)} conversion rate</Text>
        </View>
        <View style={styles.performanceCard}>
          <PerformanceRow label="Impressions" value={compact(impressions)} type="views" accent="#00E0FF" />
          <PerformanceRow label="Clicks" value={compact(clicks)} type="ads" accent="#D4A857" />
          <PerformanceRow label="Conversions" value={compact(conversions)} type="conversion" accent="#22C55E" />
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Store Intelligence</Text>
          <Text style={styles.sectionHint}>Live business health</Text>
        </View>
        <LinearGradient colors={['#FFFFFF', '#FFF8E8']} style={styles.intelCard}>
          <View style={styles.intelTop}>
            <Icon type="trust" size={38} />
            <View style={styles.intelTextWrap}>
              <Text style={styles.intelTitle}>{getTrustTier(trustScore)} Seller Level</Text>
              <Text style={styles.intelText}>Keep ratings high, ship faster and reduce disputes to increase trust score.</Text>
            </View>
          </View>
          <View style={styles.progressTrack}>
            <View style={[styles.progressFill, { width: `${Math.max(0, Math.min(100, trustScore))}%` }]} />
          </View>
          <View style={styles.intelBottom}>
            <Text style={styles.intelScore}>{trustScore ? trustScore.toFixed(1) : '0.0'}/100</Text>
            <Text style={styles.intelVerified}>{analytics?.store?.isVerified ? 'Verified Store' : 'Verification Pending'}</Text>
          </View>
        </LinearGradient>
      </View>

      <View style={styles.bottomSpace} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F6FA' },
  loadingContainer: { flex: 1, backgroundColor: '#050505', alignItems: 'center', justifyContent: 'center', padding: 22 },
  loadingCard: { width: '100%', borderRadius: 28, padding: 26, alignItems: 'center', overflow: 'hidden' },
  loadingOrb: { width: 78, height: 78, borderRadius: 39, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  loadingTitle: { color: '#FFFFFF', fontSize: 19, fontWeight: '900', textAlign: 'center' },
  loadingSub: { color: 'rgba(255,255,255,0.62)', fontSize: 13, marginTop: 8, textAlign: 'center', lineHeight: 19 },
  hero: { margin: 15, padding: 18, borderRadius: 28, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 18, elevation: 8 },
  heroTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  kicker: { color: '#D4A857', fontSize: 11, fontWeight: '900', letterSpacing: 2, marginBottom: 6 },
  header: { fontSize: 28, fontWeight: '900', color: '#FFFFFF', letterSpacing: -0.7 },
  subHeader: { color: 'rgba(255,255,255,0.68)', fontSize: 13, marginTop: 6, maxWidth: width * 0.68 },
  refreshBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.10)', alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' },
  heroStats: { flexDirection: 'row', alignItems: 'center', marginTop: 22, backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 20, paddingVertical: 14 },
  heroStat: { flex: 1, alignItems: 'center' },
  heroStatValue: { color: '#FFFFFF', fontWeight: '900', fontSize: 17 },
  heroStatLabel: { color: 'rgba(255,255,255,0.58)', fontSize: 11, marginTop: 4 },
  heroDivider: { width: 1, height: 34, backgroundColor: 'rgba(255,255,255,0.14)' },
  errorBox: { marginHorizontal: 15, marginBottom: 14, backgroundColor: '#FFF1F2', borderRadius: 18, padding: 14, borderWidth: 1, borderColor: '#FECDD3' },
  errorTitle: { color: '#9F1239', fontWeight: '900', fontSize: 14 },
  errorText: { color: '#BE123C', fontSize: 12, marginTop: 4 },
  errorAction: { color: '#E11D48', fontWeight: '800', fontSize: 12, marginTop: 8 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 15, gap: 12, marginBottom: 22 },
  metricCard: { width: (width - 42) / 2, minHeight: 156, padding: 15, borderRadius: 24, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.16, shadowRadius: 12, elevation: 5 },
  metricTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  metricPulse: { width: 10, height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.82)' },
  metricValue: { color: '#FFFFFF', fontSize: 24, fontWeight: '900', marginTop: 20, letterSpacing: -0.8 },
  metricLabel: { color: 'rgba(255,255,255,0.76)', fontSize: 13, fontWeight: '800', marginTop: 4 },
  metricSub: { color: 'rgba(255,255,255,0.55)', fontSize: 11, marginTop: 7 },
  section: { paddingHorizontal: 15, marginBottom: 22 },
  sectionHeader: { flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitle: { fontWeight: '900', fontSize: 18, color: '#101114', letterSpacing: -0.3 },
  sectionHint: { color: '#8A8F98', fontSize: 12, fontWeight: '700' },
  action: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#FFFFFF', padding: 14, borderRadius: 20, marginBottom: 10, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  actionIconWrap: { width: 44, height: 44, borderRadius: 16, backgroundColor: '#111111', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  actionContent: { flex: 1 },
  actionText: { fontWeight: '900', color: '#121212', fontSize: 15 },
  actionSub: { color: '#858B94', fontSize: 12, marginTop: 3 },
  actionArrow: { fontSize: 32, color: '#C5CAD3', fontWeight: '300' },
  performanceCard: { backgroundColor: '#FFFFFF', borderRadius: 22, overflow: 'hidden', shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 2 },
  performanceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 15, borderBottomWidth: 1, borderBottomColor: '#F0F1F4' },
  performanceLeft: { flexDirection: 'row', alignItems: 'center' },
  performanceLabel: { marginLeft: 11, color: '#202329', fontSize: 14, fontWeight: '800' },
  performanceValue: { fontSize: 15, fontWeight: '900' },
  intelCard: { borderRadius: 24, padding: 16, shadowColor: '#000', shadowOpacity: 0.06, shadowRadius: 10, elevation: 2, borderWidth: 1, borderColor: '#F4E4BC' },
  intelTop: { flexDirection: 'row', alignItems: 'center' },
  intelTextWrap: { flex: 1, marginLeft: 13 },
  intelTitle: { fontSize: 16, fontWeight: '900', color: '#171717' },
  intelText: { fontSize: 12, color: '#6F737B', lineHeight: 18, marginTop: 4 },
  progressTrack: { height: 10, borderRadius: 8, backgroundColor: '#EEE3C8', marginTop: 18, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 8, backgroundColor: '#D4A857' },
  intelBottom: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 10 },
  intelScore: { fontSize: 13, color: '#171717', fontWeight: '900' },
  intelVerified: { fontSize: 12, color: '#8B6A22', fontWeight: '800' },
  bottomSpace: { height: Platform.OS === 'ios' ? 38 : 24 },
  customIcon: { backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  coinOuter: { width: 19, height: 19, borderRadius: 10, borderWidth: 3, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  coinInner: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#FFFFFF' },
  boxTop: { width: 18, height: 7, borderRadius: 3, backgroundColor: '#FFFFFF', transform: [{ rotate: '-8deg' }], marginBottom: -1 },
  boxBody: { width: 20, height: 15, borderRadius: 4, backgroundColor: '#FFFFFF' },
  tagShape: { width: 20, height: 15, borderRadius: 5, backgroundColor: '#FFFFFF', transform: [{ rotate: '-18deg' }] },
  tagDot: { position: 'absolute', width: 4, height: 4, borderRadius: 2, backgroundColor: '#111111', top: 10, right: 11 },
  iconGlyph: { color: '#FFFFFF', fontWeight: '900', textAlign: 'center' },
  plusVertical: { position: 'absolute', width: 4, height: 18, borderRadius: 2, backgroundColor: '#FFFFFF' },
  plusHorizontal: { position: 'absolute', width: 18, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF' },
  listLineWide: { width: 18, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF', marginBottom: 3 },
  listLine: { width: 15, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF', marginBottom: 3 },
  listLineShort: { width: 10, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF' },
  megaphoneBody: { width: 20, height: 13, borderRadius: 4, backgroundColor: '#FFFFFF', transform: [{ skewX: '-18deg' }] },
  megaphoneHandle: { position: 'absolute', width: 5, height: 12, borderRadius: 3, backgroundColor: '#FFFFFF', bottom: 5, left: 12, transform: [{ rotate: '-15deg' }] },
  eyeOuter: { width: 22, height: 13, borderRadius: 12, borderWidth: 3, borderColor: '#FFFFFF' },
  eyeInner: { position: 'absolute', width: 6, height: 6, borderRadius: 3, backgroundColor: '#FFFFFF' },
  chartBarSmall: { width: 5, height: 10, borderRadius: 3, backgroundColor: '#FFFFFF', marginHorizontal: 1, alignSelf: 'flex-end' },
  chartBarMid: { width: 5, height: 15, borderRadius: 3, backgroundColor: '#FFFFFF', marginHorizontal: 1, alignSelf: 'flex-end' },
  chartBarTall: { width: 5, height: 21, borderRadius: 3, backgroundColor: '#FFFFFF', marginHorizontal: 1, alignSelf: 'flex-end' },
  targetOuter: { width: 20, height: 20, borderRadius: 10, borderWidth: 3, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  targetInner: { width: 7, height: 7, borderRadius: 4, backgroundColor: '#FFFFFF' },
  shieldTop: { width: 20, height: 13, borderTopLeftRadius: 10, borderTopRightRadius: 10, backgroundColor: '#FFFFFF' },
  shieldBottom: { width: 14, height: 14, backgroundColor: '#FFFFFF', transform: [{ rotate: '45deg' }], marginTop: -8, borderBottomRightRadius: 3 }
});
