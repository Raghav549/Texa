import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, Image, StyleSheet, RefreshControl, ActivityIndicator, Animated, Platform } from 'react-native';
import Svg, { Path, Circle, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { theme } from '../theme';

type CartItem = {
  id: string;
  quantity: number;
  attributes?: Record<string, any>;
  product: {
    id: string;
    name: string;
    slug?: string;
    price: number;
    compareAtPrice?: number | null;
    inventory?: number;
    primaryMediaUrl?: string;
    status?: string;
    store?: {
      id?: string;
      name?: string;
      slug?: string;
      logoUrl?: string;
      isVerified?: boolean;
    };
  };
};

type CartPayload = {
  id?: string;
  items: CartItem[];
  total: number;
  itemCount?: number;
};

type IconProps = {
  size?: number;
  color?: string;
  accent?: string;
};

const money = (value: number) => {
  const safe = Number.isFinite(Number(value)) ? Number(value) : 0;
  return `$${safe.toFixed(2)}`;
};

const clampQty = (value: number, max?: number) => {
  const safeMax = typeof max === 'number' && max > 0 ? max : 999;
  return Math.max(1, Math.min(safeMax, Math.floor(Number(value) || 1)));
};

function CartMark({ size = 28, color = '#111827', accent = theme.colors.gold }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Defs>
        <LinearGradient id="cartMarkGradient" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor={accent} />
          <Stop offset="1" stopColor="#00E5FF" />
        </LinearGradient>
      </Defs>
      <Path d="M15 16.5H9.5C7.6 16.5 6 14.9 6 13C6 11.1 7.6 9.5 9.5 9.5H18C20.1 9.5 21.9 10.9 22.4 12.9L23.2 16.5H52.4C55.9 16.5 58.4 19.9 57.4 23.3L52.7 39.2C52.1 41.4 50 43 47.7 43H27.1C24.7 43 22.6 41.3 22.1 39L15 16.5Z" fill="url(#cartMarkGradient)" />
      <Path d="M25.5 22.5H50.5L46.7 35.5H29L25.5 22.5Z" fill="rgba(255,255,255,0.72)" />
      <Circle cx="29.5" cy="52" r="5.5" fill={color} />
      <Circle cx="47" cy="52" r="5.5" fill={color} />
      <Circle cx="29.5" cy="52" r="2.1" fill="#FFFFFF" opacity="0.45" />
      <Circle cx="47" cy="52" r="2.1" fill="#FFFFFF" opacity="0.45" />
    </Svg>
  );
}

function MinusMark({ size = 18, color = '#111827' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect x="10" y="21" width="28" height="6" rx="3" fill={color} />
    </Svg>
  );
}

function PlusMark({ size = 18, color = '#111827' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Rect x="10" y="21" width="28" height="6" rx="3" fill={color} />
      <Rect x="21" y="10" width="6" height="28" rx="3" fill={color} />
    </Svg>
  );
}

function TrashMark({ size = 20, color = '#EF4444' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Path d="M22 13.5C22 10.5 24.5 8 27.5 8H36.5C39.5 8 42 10.5 42 13.5V16H52C53.7 16 55 17.3 55 19C55 20.7 53.7 22 52 22H49.6L46.7 51.2C46.4 54.4 43.7 57 40.5 57H23.5C20.3 57 17.6 54.4 17.3 51.2L14.4 22H12C10.3 22 9 20.7 9 19C9 17.3 10.3 16 12 16H22V13.5Z" fill={color} />
      <Path d="M28 14H36V16H28V14Z" fill="#FFFFFF" opacity="0.82" />
      <Path d="M26 28V47M38 28V47" stroke="#FFFFFF" strokeWidth="4" strokeLinecap="round" opacity="0.9" />
    </Svg>
  );
}

function ShieldCheckMark({ size = 14, color = '#0EA5E9' }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 64 64">
      <Path d="M32 5L53 13V29C53 43 44.2 55.3 32 59C19.8 55.3 11 43 11 29V13L32 5Z" fill={color} />
      <Path d="M24.5 31.5L29.4 36.4L40.2 25.3" fill="none" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

function EmptyCartIllustration() {
  return (
    <View style={styles.emptyArt}>
      <Svg width={120} height={120} viewBox="0 0 160 160">
        <Defs>
          <LinearGradient id="emptyCartGradient" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={theme.colors.gold} />
            <Stop offset="1" stopColor={theme.colors.neon} />
          </LinearGradient>
        </Defs>
        <Circle cx="80" cy="80" r="70" fill="rgba(212,168,87,0.12)" />
        <Path d="M45 50H35C31.7 50 29 47.3 29 44C29 40.7 31.7 38 35 38H50C53.7 38 56.9 40.5 57.8 44.1L59 50H121C126.5 50 130.4 55.3 128.8 60.6L119.9 90.5C118.8 94.9 114.8 98 110.3 98H68.5C63.9 98 59.9 94.8 58.9 90.3L45 50Z" fill="url(#emptyCartGradient)" />
        <Path d="M65 62H115L109 84H70.8L65 62Z" fill="#FFFFFF" opacity="0.72" />
        <Circle cx="73" cy="116" r="9" fill="#111827" />
        <Circle cx="109" cy="116" r="9" fill="#111827" />
      </Svg>
    </View>
  );
}

const QuantityButton = memo(({ type, disabled, onPress }: { type: 'minus' | 'plus'; disabled?: boolean; onPress: () => void }) => (
  <TouchableOpacity activeOpacity={0.82} style={[styles.qtyBtn, disabled && styles.qtyBtnDisabled]} onPress={onPress} disabled={disabled}>
    {type === 'minus' ? <MinusMark size={15} color={disabled ? '#9CA3AF' : '#111827'} /> : <PlusMark size={15} color={disabled ? '#9CA3AF' : '#111827'} />}
  </TouchableOpacity>
));

const CartRow = memo(
  ({
    item,
    updating,
    removing,
    onUpdateQty,
    onRemove,
    onOpenProduct,
    onOpenStore
  }: {
    item: CartItem;
    updating: boolean;
    removing: boolean;
    onUpdateQty: (item: CartItem, qty: number) => void;
    onRemove: (item: CartItem) => void;
    onOpenProduct: (item: CartItem) => void;
    onOpenStore: (item: CartItem) => void;
  }) => {
    const inventory = typeof item.product.inventory === 'number' ? item.product.inventory : 999;
    const isUnavailable = item.product.status && item.product.status !== 'active';
    const lineTotal = Number(item.product.price || 0) * Number(item.quantity || 0);
    const hasCompare = typeof item.product.compareAtPrice === 'number' && item.product.compareAtPrice > item.product.price;

    return (
      <TouchableOpacity activeOpacity={0.9} style={[styles.item, isUnavailable && styles.itemUnavailable]} onPress={() => onOpenProduct(item)}>
        <View style={styles.thumbWrap}>
          {item.product.primaryMediaUrl ? <Image source={{ uri: item.product.primaryMediaUrl }} style={styles.thumb} /> : <View style={styles.thumbFallback}><CartMark size={32} /></View>}
          {isUnavailable && <View style={styles.unavailableOverlay}><Text style={styles.unavailableText}>OFF</Text></View>}
        </View>

        <View style={styles.details}>
          <View style={styles.nameRow}>
            <Text style={styles.name} numberOfLines={2}>{item.product.name || 'Untitled Product'}</Text>
          </View>

          <TouchableOpacity activeOpacity={0.8} style={styles.storeRow} onPress={() => onOpenStore(item)}>
            <Text style={styles.store} numberOfLines={1}>@{item.product.store?.name || 'store'}</Text>
            {item.product.store?.isVerified ? <ShieldCheckMark size={13} color={theme.colors.neon} /> : null}
          </TouchableOpacity>

          {item.attributes && Object.keys(item.attributes).length > 0 ? (
            <Text style={styles.attrs} numberOfLines={1}>
              {Object.entries(item.attributes).map(([k, v]) => `${k}: ${String(v)}`).join(' • ')}
            </Text>
          ) : null}

          <View style={styles.qtyRow}>
            <QuantityButton type="minus" disabled={updating || removing || item.quantity <= 1} onPress={() => onUpdateQty(item, item.quantity - 1)} />
            <View style={styles.qtyPill}>
              {updating ? <ActivityIndicator size="small" color={theme.colors.gold} /> : <Text style={styles.qty}>{item.quantity}</Text>}
            </View>
            <QuantityButton type="plus" disabled={updating || removing || item.quantity >= inventory || isUnavailable} onPress={() => onUpdateQty(item, item.quantity + 1)} />
            <TouchableOpacity activeOpacity={0.82} style={styles.remove} onPress={() => onRemove(item)} disabled={removing}>
              {removing ? <ActivityIndicator size="small" color="#EF4444" /> : <TrashMark size={19} />}
            </TouchableOpacity>
          </View>

          {inventory <= 5 && !isUnavailable ? <Text style={styles.stockWarning}>{inventory <= 0 ? 'Out of stock' : `Only ${inventory} left`}</Text> : null}
        </View>

        <View style={styles.priceBlock}>
          <Text style={styles.price}>{money(lineTotal)}</Text>
          {hasCompare ? <Text style={styles.compare}>{money(Number(item.product.compareAtPrice) * item.quantity)}</Text> : null}
        </View>
      </TouchableOpacity>
    );
  }
);

export default function CartScreen({ navigation }: any) {
  const [cart, setCart] = useState<CartPayload>({ items: [], total: 0, itemCount: 0 });
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const socketRef = useRef<any>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  const subtotal = useMemo(() => {
    return (cart.items || []).reduce((sum, item) => sum + Number(item.product?.price || 0) * Number(item.quantity || 0), 0);
  }, [cart.items]);

  const totalItems = useMemo(() => {
    return (cart.items || []).reduce((sum, item) => sum + Number(item.quantity || 0), 0);
  }, [cart.items]);

  const savings = useMemo(() => {
    return (cart.items || []).reduce((sum, item) => {
      const compare = Number(item.product?.compareAtPrice || 0);
      const price = Number(item.product?.price || 0);
      if (compare > price) return sum + (compare - price) * Number(item.quantity || 0);
      return sum;
    }, 0);
  }, [cart.items]);

  const loadCart = useCallback(async () => {
    const res = await api.get('/cart');
    const payload = res.data || { items: [], total: 0 };
    setCart({
      ...payload,
      items: Array.isArray(payload.items) ? payload.items : [],
      total: Number(payload.total || 0),
      itemCount: Number(payload.itemCount || 0)
    });
  }, []);

  useEffect(() => {
    let mounted = true;

    const boot = async () => {
      try {
        await loadCart();
        if (!mounted) return;
        Animated.timing(fadeAnim, { toValue: 1, duration: 360, useNativeDriver: true }).start();
      } finally {
        if (mounted) setLoading(false);
      }
    };

    const connect = async () => {
      const socket = await ws();
      if (!mounted) return;
      socketRef.current = socket;
      socket.emit?.('cart:sync');
      socket.on?.('cart:updated', (data: CartPayload) => {
        setCart({
          ...data,
          items: Array.isArray(data?.items) ? data.items : [],
          total: Number(data?.total || 0),
          itemCount: Number(data?.itemCount || 0)
        });
      });
      socket.on?.('cart:synced', (data: CartPayload) => {
        setCart({
          ...data,
          items: Array.isArray(data?.items) ? data.items : [],
          total: Number(data?.total || 0),
          itemCount: Number(data?.itemCount || 0)
        });
      });
    };

    boot();
    connect().catch(() => null);

    return () => {
      mounted = false;
      socketRef.current?.off?.('cart:updated');
      socketRef.current?.off?.('cart:synced');
    };
  }, [fadeAnim, loadCart]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await loadCart();
      socketRef.current?.emit?.('cart:sync');
    } finally {
      setRefreshing(false);
    }
  }, [loadCart]);

  const updateQty = useCallback(async (item: CartItem, qty: number) => {
    const nextQty = clampQty(qty, item.product.inventory);
    if (nextQty === item.quantity) return;
    setUpdatingId(item.id);
    setCart(prev => ({
      ...prev,
      items: prev.items.map(row => (row.id === item.id ? { ...row, quantity: nextQty } : row)),
      total: prev.items.reduce((sum, row) => sum + Number(row.product?.price || 0) * Number(row.id === item.id ? nextQty : row.quantity || 0), 0)
    }));
    try {
      const res = await api.post(`/cart/${item.id}`, { quantity: nextQty });
      if (res?.data) setCart({ ...res.data, items: Array.isArray(res.data.items) ? res.data.items : [], total: Number(res.data.total || 0) });
    } catch {
      await loadCart();
    } finally {
      setUpdatingId(null);
    }
  }, [loadCart]);

  const removeItem = useCallback(async (item: CartItem) => {
    setRemovingId(item.id);
    const oldCart = cart;
    setCart(prev => {
      const items = prev.items.filter(row => row.id !== item.id);
      const total = items.reduce((sum, row) => sum + Number(row.product?.price || 0) * Number(row.quantity || 0), 0);
      return { ...prev, items, total };
    });
    try {
      const res = await api.delete(`/cart/${item.id}`);
      if (res?.data) setCart({ ...res.data, items: Array.isArray(res.data.items) ? res.data.items : [], total: Number(res.data.total || 0) });
    } catch {
      setCart(oldCart);
    } finally {
      setRemovingId(null);
    }
  }, [cart]);

  const openProduct = useCallback((item: CartItem) => {
    if (item.product?.id) navigation.navigate('ProductDetail', { id: item.product.id });
  }, [navigation]);

  const openStore = useCallback((item: CartItem) => {
    const slug = item.product?.store?.slug;
    if (slug) navigation.navigate('StoreDetail', { slug });
  }, [navigation]);

  const renderItem = useCallback(({ item }: { item: CartItem }) => (
    <CartRow
      item={item}
      updating={updatingId === item.id}
      removing={removingId === item.id}
      onUpdateQty={updateQty}
      onRemove={removeItem}
      onOpenProduct={openProduct}
      onOpenStore={openStore}
    />
  ), [openProduct, openStore, removeItem, removingId, updateQty, updatingId]);

  const keyExtractor = useCallback((item: CartItem) => item.id, []);

  if (loading) {
    return (
      <View style={styles.loader}>
        <CartMark size={46} />
        <ActivityIndicator size="small" color={theme.colors.gold} style={styles.loaderSpin} />
        <Text style={styles.loaderText}>Loading your cart</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Animated.View style={[styles.top, { opacity: fadeAnim }]}>
        <View style={styles.titleRow}>
          <View style={styles.titleIcon}>
            <CartMark size={28} />
          </View>
          <View style={styles.titleTextWrap}>
            <Text style={styles.header}>Shopping Cart</Text>
            <Text style={styles.subHeader}>{totalItems} {totalItems === 1 ? 'item' : 'items'} ready for checkout</Text>
          </View>
        </View>
      </Animated.View>

      <FlatList
        data={cart.items || []}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        contentContainerStyle={[styles.list, !(cart.items || []).length && styles.emptyList]}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.gold} />}
        ListEmptyComponent={
          <View style={styles.emptyWrap}>
            <EmptyCartIllustration />
            <Text style={styles.emptyTitle}>Your cart is empty</Text>
            <Text style={styles.emptyText}>Add premium products from trusted stores and they will appear here instantly.</Text>
            <TouchableOpacity activeOpacity={0.86} style={styles.exploreBtn} onPress={() => navigation.navigate('StoreBrowse')}>
              <Text style={styles.exploreText}>EXPLORE STORES</Text>
            </TouchableOpacity>
          </View>
        }
      />

      {(cart.items || []).length > 0 ? (
        <View style={styles.footer}>
          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Subtotal</Text>
              <Text style={styles.summaryValue}>{money(subtotal)}</Text>
            </View>
            {savings > 0 ? (
              <View style={styles.summaryRow}>
                <Text style={styles.savingsLabel}>You saved</Text>
                <Text style={styles.savingsValue}>{money(savings)}</Text>
              </View>
            ) : null}
            <View style={styles.divider} />
            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>Total</Text>
              <Text style={styles.totalPrice}>{money(Number(cart.total || subtotal))}</Text>
            </View>
          </View>

          <TouchableOpacity activeOpacity={0.9} style={styles.checkout} onPress={() => navigation.navigate('Checkout')} disabled={!cart.items?.length}>
            <Text style={styles.checkoutText}>PROCEED TO CHECKOUT</Text>
            <View style={styles.checkoutIcon}>
              <PlusMark size={14} color="#000" />
            </View>
          </TouchableOpacity>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F6F7FB'
  },
  loader: {
    flex: 1,
    backgroundColor: '#F6F7FB',
    alignItems: 'center',
    justifyContent: 'center'
  },
  loaderSpin: {
    marginTop: 18
  },
  loaderText: {
    marginTop: 10,
    color: '#6B7280',
    fontWeight: '700'
  },
  top: {
    paddingHorizontal: 18,
    paddingTop: Platform.OS === 'ios' ? 58 : 26,
    paddingBottom: 14,
    backgroundColor: '#F6F7FB'
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center'
  },
  titleIcon: {
    width: 48,
    height: 48,
    borderRadius: 18,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
    shadowColor: theme.colors.gold,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 5
  },
  titleTextWrap: {
    flex: 1
  },
  header: {
    fontSize: 25,
    fontWeight: '900',
    color: '#111827',
    letterSpacing: -0.4
  },
  subHeader: {
    marginTop: 3,
    fontSize: 13,
    color: '#6B7280',
    fontWeight: '600'
  },
  list: {
    paddingHorizontal: 15,
    paddingBottom: 20
  },
  emptyList: {
    flexGrow: 1,
    justifyContent: 'center'
  },
  item: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    padding: 12,
    marginBottom: 12,
    borderRadius: 22,
    shadowColor: '#111827',
    shadowOpacity: 0.07,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
    borderWidth: 1,
    borderColor: 'rgba(17,24,39,0.04)'
  },
  itemUnavailable: {
    opacity: 0.68
  },
  thumbWrap: {
    width: 78,
    height: 78,
    borderRadius: 18,
    overflow: 'hidden',
    backgroundColor: '#EEF2F7'
  },
  thumb: {
    width: '100%',
    height: '100%'
  },
  thumbFallback: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center'
  },
  unavailableOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.42)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  unavailableText: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 11,
    letterSpacing: 1
  },
  details: {
    flex: 1,
    marginLeft: 12,
    minWidth: 0
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'flex-start'
  },
  name: {
    flex: 1,
    fontWeight: '900',
    fontSize: 15,
    color: '#111827',
    lineHeight: 19
  },
  storeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 4,
    gap: 4,
    alignSelf: 'flex-start'
  },
  store: {
    color: '#6B7280',
    fontSize: 12,
    fontWeight: '700',
    maxWidth: 145
  },
  attrs: {
    color: '#9CA3AF',
    fontSize: 11,
    fontWeight: '600',
    marginTop: 3
  },
  qtyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 9
  },
  qtyBtn: {
    width: 29,
    height: 29,
    borderRadius: 12,
    backgroundColor: '#F3F4F6',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E5E7EB'
  },
  qtyBtnDisabled: {
    backgroundColor: '#F9FAFB'
  },
  qtyPill: {
    minWidth: 36,
    height: 29,
    marginHorizontal: 7,
    borderRadius: 12,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8
  },
  qty: {
    color: '#FFFFFF',
    fontWeight: '900',
    fontSize: 13
  },
  remove: {
    marginLeft: 9,
    width: 32,
    height: 32,
    borderRadius: 13,
    backgroundColor: 'rgba(239,68,68,0.09)',
    alignItems: 'center',
    justifyContent: 'center'
  },
  stockWarning: {
    color: '#EF4444',
    fontSize: 11,
    fontWeight: '800',
    marginTop: 5
  },
  priceBlock: {
    alignItems: 'flex-end',
    justifyContent: 'center',
    marginLeft: 8,
    minWidth: 72
  },
  price: {
    fontWeight: '900',
    fontSize: 16,
    color: '#111827',
    textAlign: 'right'
  },
  compare: {
    marginTop: 3,
    color: '#9CA3AF',
    fontSize: 12,
    fontWeight: '700',
    textDecorationLine: 'line-through'
  },
  emptyWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 28,
    paddingBottom: 70
  },
  emptyArt: {
    marginBottom: 8
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '900',
    color: '#111827',
    marginTop: 4
  },
  emptyText: {
    marginTop: 8,
    color: '#6B7280',
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    fontWeight: '600'
  },
  exploreBtn: {
    marginTop: 20,
    backgroundColor: '#111827',
    paddingHorizontal: 24,
    paddingVertical: 14,
    borderRadius: 16,
    shadowColor: '#111827',
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 4
  },
  exploreText: {
    color: '#FFFFFF',
    fontWeight: '900',
    letterSpacing: 0.6
  },
  footer: {
    backgroundColor: '#FFFFFF',
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: Platform.OS === 'ios' ? 28 : 18,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    shadowColor: '#111827',
    shadowOpacity: 0.12,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: -8 },
    elevation: 12
  },
  summaryCard: {
    backgroundColor: '#F9FAFB',
    borderRadius: 20,
    padding: 14,
    borderWidth: 1,
    borderColor: '#EEF2F7',
    marginBottom: 12
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8
  },
  summaryLabel: {
    color: '#6B7280',
    fontSize: 14,
    fontWeight: '700'
  },
  summaryValue: {
    color: '#111827',
    fontSize: 14,
    fontWeight: '900'
  },
  savingsLabel: {
    color: '#059669',
    fontSize: 13,
    fontWeight: '800'
  },
  savingsValue: {
    color: '#059669',
    fontSize: 13,
    fontWeight: '900'
  },
  divider: {
    height: 1,
    backgroundColor: '#E5E7EB',
    marginVertical: 5
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  totalLabel: {
    fontSize: 17,
    fontWeight: '900',
    color: '#111827'
  },
  totalPrice: {
    fontSize: 22,
    fontWeight: '900',
    color: theme.colors.gold,
    letterSpacing: -0.4
  },
  checkout: {
    backgroundColor: theme.colors.neon,
    paddingVertical: 16,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    shadowColor: theme.colors.neon,
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
    elevation: 6
  },
  checkoutText: {
    color: '#000000',
    fontWeight: '900',
    fontSize: 15,
    letterSpacing: 0.5
  },
  checkoutIcon: {
    width: 24,
    height: 24,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10
  }
});
