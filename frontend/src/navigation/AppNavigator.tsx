import React, { memo, useMemo } from 'react';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator, NativeStackNavigationOptions } from '@react-navigation/native-stack';
import { View, Text, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { theme } from '../theme';
import HomeScreen from '../screens/HomeScreen';
import VoiceScreen from '../screens/VoiceScreen';
import ReelsScreen from '../screens/ReelsScreen';
import MessagesScreen from '../screens/MessagesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import StoreBrowseScreen from '../screens/StoreBrowseScreen';
import StoreDetailScreen from '../screens/StoreDetailScreen';
import ProductDetailScreen from '../screens/ProductDetailScreen';
import CartScreen from '../screens/CartScreen';
import BusinessDashboard from '../screens/BusinessDashboard';
import SearchBar from '../components/SearchBar';
import { useAuth } from '../store/auth';

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

type IconName = 'home' | 'voice' | 'reels' | 'shop' | 'chat' | 'profile' | 'back' | 'cart' | 'dashboard' | 'search';

const C = {
  neon: theme?.colors?.neon || '#00E0FF',
  gold: theme?.colors?.gold || '#D4A857',
  gray: theme?.colors?.gray || '#8B8F98',
  dark: '#050505',
  ink: '#111111',
  white: '#FFFFFF',
  soft: '#F6F7FB'
};

const Icon = memo(({ name, focused = false, size = 24 }: { name: IconName; focused?: boolean; size?: number }) => {
  const color = focused ? C.neon : C.gray;
  const bg = focused ? 'rgba(0,224,255,0.13)' : 'transparent';

  if (name === 'home') {
    return (
      <View style={[styles.iconBox, { width: size + 10, height: size + 10, backgroundColor: bg }]}>
        <View style={[styles.homeRoof, { borderBottomColor: color }]} />
        <View style={[styles.homeBase, { borderColor: color }]}>
          <View style={[styles.homeDoor, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }

  if (name === 'voice') {
    return (
      <View style={[styles.iconBox, { width: size + 10, height: size + 10, backgroundColor: bg }]}>
        <View style={[styles.micHead, { borderColor: color }]} />
        <View style={[styles.micStem, { backgroundColor: color }]} />
        <View style={[styles.micBase, { backgroundColor: color }]} />
      </View>
    );
  }

  if (name === 'reels') {
    return (
      <View style={[styles.iconBox, { width: size + 10, height: size + 10, backgroundColor: bg }]}>
        <View style={[styles.reelFrame, { borderColor: color }]}>
          <View style={[styles.playTriangle, { borderLeftColor: color }]} />
        </View>
        <View style={[styles.reelSpark, { backgroundColor: color }]} />
      </View>
    );
  }

  if (name === 'shop') {
    return (
      <View style={[styles.iconBox, { width: size + 10, height: size + 10, backgroundColor: bg }]}>
        <View style={[styles.shopTop, { backgroundColor: color }]} />
        <View style={[styles.shopBody, { borderColor: color }]}>
          <View style={[styles.shopDoor, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }

  if (name === 'chat') {
    return (
      <View style={[styles.iconBox, { width: size + 10, height: size + 10, backgroundColor: bg }]}>
        <View style={[styles.chatBubble, { borderColor: color }]}>
          <View style={[styles.chatDot, { backgroundColor: color }]} />
          <View style={[styles.chatDot, { backgroundColor: color }]} />
          <View style={[styles.chatDot, { backgroundColor: color }]} />
        </View>
      </View>
    );
  }

  if (name === 'profile') {
    return (
      <View style={[styles.iconBox, { width: size + 10, height: size + 10, backgroundColor: bg }]}>
        <View style={[styles.userHead, { borderColor: color }]} />
        <View style={[styles.userBody, { borderColor: color }]} />
      </View>
    );
  }

  if (name === 'cart') {
    return (
      <View style={[styles.headerIconBox, { borderColor: color }]}>
        <View style={[styles.cartBasket, { borderColor: color }]} />
        <View style={[styles.cartWheelLeft, { backgroundColor: color }]} />
        <View style={[styles.cartWheelRight, { backgroundColor: color }]} />
      </View>
    );
  }

  if (name === 'dashboard') {
    return (
      <View style={[styles.headerIconBox, { borderColor: color }]}>
        <View style={[styles.dashBarOne, { backgroundColor: color }]} />
        <View style={[styles.dashBarTwo, { backgroundColor: color }]} />
        <View style={[styles.dashBarThree, { backgroundColor: color }]} />
      </View>
    );
  }

  if (name === 'search') {
    return (
      <View style={[styles.headerIconBox, { borderColor: color }]}>
        <View style={[styles.searchCircle, { borderColor: color }]} />
        <View style={[styles.searchHandle, { backgroundColor: color }]} />
      </View>
    );
  }

  return (
    <View style={[styles.headerIconBox, { borderColor: color }]}>
      <Text style={[styles.backText, { color }]}>‹</Text>
    </View>
  );
});

const HeaderSearch = memo(() => (
  <View style={styles.headerSearch}>
    <SearchBar />
  </View>
));

const HeaderButton = memo(({ name, onPress }: { name: IconName; onPress: () => void }) => (
  <TouchableOpacity activeOpacity={0.82} onPress={onPress} style={styles.headerButton}>
    <Icon name={name} focused size={22} />
  </TouchableOpacity>
));

function HomeStack() {
  return (
    <Stack.Navigator screenOptions={stackOptions}>
      <Stack.Screen
        name="HomeMain"
        component={HomeScreen}
        options={({ navigation }) => ({
          title: 'Texa',
          headerTitle: () => (
            <View>
              <Text style={styles.brand}>Texa</Text>
              <Text style={styles.brandSub}>Social Commerce OS</Text>
            </View>
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              <HeaderButton name="search" onPress={() => navigation.navigate('Search' as never)} />
              <HeaderButton name="cart" onPress={() => navigation.navigate('Cart' as never)} />
            </View>
          )
        })}
      />
      <Stack.Screen name="StoreDetail" component={StoreDetailScreen} options={{ title: 'Store', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Product', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Cart', presentation: 'card', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="BusinessDashboard" component={BusinessDashboard} options={{ title: 'Business Dashboard', headerBackTitle: '', headerTintColor: C.ink }} />
    </Stack.Navigator>
  );
}

function ShopStack() {
  return (
    <Stack.Navigator screenOptions={stackOptions}>
      <Stack.Screen
        name="ShopMain"
        component={StoreBrowseScreen}
        options={({ navigation }) => ({
          title: 'Shop',
          headerTitle: () => (
            <View>
              <Text style={styles.brand}>Shop</Text>
              <Text style={styles.brandSub}>Trusted premium stores</Text>
            </View>
          ),
          headerRight: () => (
            <View style={styles.headerRight}>
              <HeaderButton name="dashboard" onPress={() => navigation.navigate('BusinessDashboard' as never)} />
              <HeaderButton name="cart" onPress={() => navigation.navigate('Cart' as never)} />
            </View>
          )
        })}
      />
      <Stack.Screen name="StoreDetail" component={StoreDetailScreen} options={{ title: 'Store', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Product', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Cart', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="BusinessDashboard" component={BusinessDashboard} options={{ title: 'Business Dashboard', headerBackTitle: '', headerTintColor: C.ink }} />
    </Stack.Navigator>
  );
}

function VoiceStack() {
  return (
    <Stack.Navigator screenOptions={stackOptions}>
      <Stack.Screen name="VoiceMain" component={VoiceScreen} options={{ title: 'Voice' }} />
    </Stack.Navigator>
  );
}

function ReelsStack() {
  return (
    <Stack.Navigator screenOptions={stackOptions}>
      <Stack.Screen name="ReelsMain" component={ReelsScreen} options={{ title: 'Reels', headerShown: false }} />
      <Stack.Screen name="StoreDetail" component={StoreDetailScreen} options={{ title: 'Store', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Product', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Cart', headerBackTitle: '', headerTintColor: C.ink }} />
    </Stack.Navigator>
  );
}

function MessagesStack() {
  return (
    <Stack.Navigator screenOptions={stackOptions}>
      <Stack.Screen name="MessagesMain" component={MessagesScreen} options={{ title: 'Messages' }} />
    </Stack.Navigator>
  );
}

function ProfileStack() {
  return (
    <Stack.Navigator screenOptions={stackOptions}>
      <Stack.Screen
        name="ProfileMain"
        component={ProfileScreen}
        options={({ navigation }) => ({
          title: 'Profile',
          headerRight: () => (
            <View style={styles.headerRight}>
              <HeaderButton name="dashboard" onPress={() => navigation.navigate('BusinessDashboard' as never)} />
              <HeaderButton name="cart" onPress={() => navigation.navigate('Cart' as never)} />
            </View>
          )
        })}
      />
      <Stack.Screen name="StoreDetail" component={StoreDetailScreen} options={{ title: 'Store', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="ProductDetail" component={ProductDetailScreen} options={{ title: 'Product', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="Cart" component={CartScreen} options={{ title: 'Cart', headerBackTitle: '', headerTintColor: C.ink }} />
      <Stack.Screen name="BusinessDashboard" component={BusinessDashboard} options={{ title: 'Business Dashboard', headerBackTitle: '', headerTintColor: C.ink }} />
    </Stack.Navigator>
  );
}

const stackOptions: NativeStackNavigationOptions = {
  headerShadowVisible: false,
  headerStyle: { backgroundColor: C.white },
  headerTitleStyle: { color: C.ink, fontWeight: '900', fontSize: 18 },
  headerBackTitle: '',
  animation: Platform.OS === 'ios' ? 'default' : 'slide_from_right',
  contentStyle: { backgroundColor: C.soft }
};

export default function AppNavigator() {
  const { user } = useAuth();
  const navTheme = useMemo(() => ({
    ...DefaultTheme,
    colors: {
      ...DefaultTheme.colors,
      background: C.soft,
      card: C.white,
      text: C.ink,
      border: 'transparent',
      primary: C.neon
    }
  }), []);

  return (
    <NavigationContainer theme={navTheme}>
      <Tab.Navigator
        initialRouteName="Home"
        screenOptions={({ route }) => ({
          headerShown: false,
          tabBarHideOnKeyboard: true,
          tabBarActiveTintColor: C.neon,
          tabBarInactiveTintColor: C.gray,
          tabBarStyle: styles.tabBar,
          tabBarItemStyle: styles.tabItem,
          tabBarLabelStyle: styles.tabLabel,
          tabBarBackground: () => (
            <View style={styles.tabBackground}>
              <LinearGradient colors={['rgba(255,255,255,0.98)', 'rgba(246,247,251,0.98)']} style={StyleSheet.absoluteFill} />
            </View>
          ),
          tabBarIcon: ({ focused }) => {
            const iconName =
              route.name === 'Home' ? 'home' :
              route.name === 'Voice' ? 'voice' :
              route.name === 'Reels' ? 'reels' :
              route.name === 'Shop' ? 'shop' :
              route.name === 'Messages' ? 'chat' :
              'profile';
            return <Icon name={iconName as IconName} focused={focused} />;
          },
          tabBarLabel: ({ focused, color }) => (
            <Text style={[styles.tabText, { color, fontWeight: focused ? '900' : '700' }]}>
              {route.name === 'Messages' ? 'Chat' : route.name === 'Profile' ? 'You' : route.name}
            </Text>
          )
        })}
      >
        <Tab.Screen name="Home" component={HomeStack} />
        <Tab.Screen name="Voice" component={VoiceStack} />
        <Tab.Screen name="Reels" component={ReelsStack} />
        <Tab.Screen name="Shop" component={ShopStack} />
        <Tab.Screen name="Messages" component={MessagesStack} />
        <Tab.Screen name="Profile" component={ProfileStack} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: Platform.OS === 'ios' ? 22 : 12,
    height: 72,
    borderRadius: 28,
    borderTopWidth: 0,
    backgroundColor: 'transparent',
    elevation: 14,
    shadowColor: '#000',
    shadowOpacity: 0.13,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    paddingBottom: Platform.OS === 'ios' ? 12 : 8,
    paddingTop: 8
  },
  tabBackground: {
    flex: 1,
    borderRadius: 28,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: 'rgba(0,0,0,0.05)'
  },
  tabItem: {
    borderRadius: 22,
    marginHorizontal: 1
  },
  tabLabel: {
    fontSize: 10
  },
  tabText: {
    fontSize: 10,
    letterSpacing: -0.1,
    marginTop: -2
  },
  headerSearch: {
    marginRight: 12,
    width: 42,
    height: 42,
    justifyContent: 'center',
    alignItems: 'center'
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginRight: 4
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 16,
    backgroundColor: '#F3F5F9',
    alignItems: 'center',
    justifyContent: 'center'
  },
  brand: {
    fontSize: 21,
    fontWeight: '900',
    color: C.ink,
    letterSpacing: -0.8
  },
  brandSub: {
    fontSize: 11,
    color: C.gray,
    fontWeight: '700',
    marginTop: -2
  },
  iconBox: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 18
  },
  headerIconBox: {
    width: 28,
    height: 28,
    borderRadius: 12,
    borderWidth: 0,
    alignItems: 'center',
    justifyContent: 'center'
  },
  homeRoof: {
    width: 0,
    height: 0,
    borderLeftWidth: 9,
    borderRightWidth: 9,
    borderBottomWidth: 9,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    marginBottom: -1
  },
  homeBase: {
    width: 18,
    height: 14,
    borderWidth: 2.2,
    borderRadius: 4,
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 1
  },
  homeDoor: {
    width: 5,
    height: 7,
    borderRadius: 2
  },
  micHead: {
    width: 13,
    height: 18,
    borderWidth: 2.2,
    borderRadius: 8
  },
  micStem: {
    width: 2.4,
    height: 8,
    borderRadius: 2,
    marginTop: -1
  },
  micBase: {
    width: 14,
    height: 2.5,
    borderRadius: 2,
    marginTop: 1
  },
  reelFrame: {
    width: 22,
    height: 22,
    borderWidth: 2.2,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center'
  },
  playTriangle: {
    width: 0,
    height: 0,
    borderTopWidth: 5,
    borderBottomWidth: 5,
    borderLeftWidth: 8,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    marginLeft: 2
  },
  reelSpark: {
    position: 'absolute',
    right: 6,
    top: 6,
    width: 5,
    height: 5,
    borderRadius: 3
  },
  shopTop: {
    width: 23,
    height: 7,
    borderTopLeftRadius: 5,
    borderTopRightRadius: 5
  },
  shopBody: {
    width: 20,
    height: 16,
    borderWidth: 2.2,
    borderTopWidth: 0,
    borderBottomLeftRadius: 5,
    borderBottomRightRadius: 5,
    alignItems: 'center',
    justifyContent: 'flex-end'
  },
  shopDoor: {
    width: 6,
    height: 8,
    borderTopLeftRadius: 3,
    borderTopRightRadius: 3
  },
  chatBubble: {
    width: 24,
    height: 18,
    borderWidth: 2.2,
    borderRadius: 9,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2
  },
  chatDot: {
    width: 3.4,
    height: 3.4,
    borderRadius: 2
  },
  userHead: {
    width: 12,
    height: 12,
    borderWidth: 2.2,
    borderRadius: 7,
    marginBottom: 2
  },
  userBody: {
    width: 21,
    height: 11,
    borderWidth: 2.2,
    borderRadius: 10,
    borderBottomWidth: 0
  },
  cartBasket: {
    width: 20,
    height: 13,
    borderWidth: 2,
    borderTopWidth: 2,
    borderRadius: 4,
    transform: [{ skewX: '-8deg' }]
  },
  cartWheelLeft: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    bottom: 2,
    left: 8
  },
  cartWheelRight: {
    position: 'absolute',
    width: 4,
    height: 4,
    borderRadius: 2,
    bottom: 2,
    right: 7
  },
  dashBarOne: {
    width: 5,
    height: 14,
    borderRadius: 3,
    position: 'absolute',
    bottom: 6,
    left: 6
  },
  dashBarTwo: {
    width: 5,
    height: 20,
    borderRadius: 3,
    position: 'absolute',
    bottom: 6
  },
  dashBarThree: {
    width: 5,
    height: 10,
    borderRadius: 3,
    position: 'absolute',
    bottom: 6,
    right: 6
  },
  searchCircle: {
    width: 15,
    height: 15,
    borderWidth: 2.2,
    borderRadius: 8,
    marginTop: -3,
    marginLeft: -3
  },
  searchHandle: {
    width: 9,
    height: 2.4,
    borderRadius: 2,
    transform: [{ rotate: '45deg' }],
    position: 'absolute',
    right: 5,
    bottom: 6
  },
  backText: {
    fontSize: 28,
    fontWeight: '300',
    marginTop: -2
  }
});
