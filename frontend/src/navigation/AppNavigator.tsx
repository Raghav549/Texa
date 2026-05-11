import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, StyleSheet } from 'react-native';
import { theme } from '../theme';
import Home from '../screens/Home';
import Voice from '../screens/VoiceRoom';
import Reels from '../screens/Reels';
import Messages from '../screens/Messages';
import Profile from '../screens/Profile';
import SearchBar from '../components/SearchBar';
const Tab = createBottomTabNavigator();
export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator screenOptions={{ headerShown: true, tabBarActiveTintColor: theme.colors.neon, tabBarInactiveTintColor: theme.colors.gray, tabBarStyle: { backgroundColor: '#fff', borderTopWidth: 0 } }}>
        <Tab.Screen name="Home" component={Home} options={{ headerRight: () => <SearchBar />, tabBarIcon: ({ focused }) => <Text style={[styles.tab, { color: focused ? theme.colors.neon : theme.colors.gray }]}>🏠</Text> }} />
        <Tab.Screen name="Voice" component={Voice} options={{ tabBarIcon: ({ focused }) => <Text style={[styles.tab, { color: focused ? theme.colors.neon : theme.colors.gray }]}>🎙️</Text> }} />
        <Tab.Screen name="Reels" component={Reels} options={{ tabBarIcon: ({ focused }) => <Text style={[styles.tab, { color: focused ? theme.colors.neon : theme.colors.gray }]}>🎬</Text> }} />
        <Tab.Screen name="Messages" component={Messages} options={{ tabBarIcon: ({ focused }) => <Text style={[styles.tab, { color: focused ? theme.colors.neon : theme.colors.gray }]}>💬</Text> }} />
        <Tab.Screen name="Profile" component={Profile} options={{ tabBarIcon: ({ focused }) => <Text style={[styles.tab, { color: focused ? theme.colors.neon : theme.colors.gray }]}>👤</Text> }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
const styles = StyleSheet.create({ tab: { fontSize: 22 } });
