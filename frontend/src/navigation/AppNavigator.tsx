import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import HomeScreen from '../screens/HomeScreen';
import VoiceRoomScreen from '../screens/VoiceRoomScreen';
import ReelsFeedScreen from '../screens/ReelsFeedScreen';
import MessagesScreen from '../screens/MessagesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import { theme } from '../theme';
import { View, Text } from 'react-native';

const Tab = createBottomTabNavigator();

const TabIcon = ({ label, focused }) => (
  <View style={{ alignItems: 'center', justifyContent: 'center', width: 70 }}>
    <Text style={{ fontWeight: focused ? '800' : '400', color: focused ? theme.colors.neonBlue : theme.colors.muted, fontSize: 24 }}>{label.charAt(0)}</Text>
    <Text style={{ fontSize: 10, color: focused ? theme.colors.neonBlue : theme.colors.muted }}>{label}</Text>
  </View>
);

export default function AppNavigator() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerShown: true,
        tabBarActiveTintColor: theme.colors.neonBlue,
        tabBarInactiveTintColor: theme.colors.muted,
        tabBarStyle: { backgroundColor: theme.colors.white, borderTopWidth: 0, elevation: 0 }
      }}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ tabBarIcon: ({ focused }) => <TabIcon label="HOME" focused={focused} /> }} />
      <Tab.Screen name="Voice" component={VoiceRoomScreen} options={{ tabBarIcon: ({ focused }) => <TabIcon label="VOICE" focused={focused} /> }} />
      <Tab.Screen name="Reels" component={ReelsFeedScreen} options={{ tabBarIcon: ({ focused }) => <TabIcon label="REELS" focused={focused} /> }} />
      <Tab.Screen name="Messages" component={MessagesScreen} options={{ tabBarIcon: ({ focused }) => <TabIcon label="CHAT" focused={focused} /> }} />
      <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarIcon: ({ focused }) => <TabIcon label="YOU" focused={focused} /> }} />
    </Tab.Navigator>
  );
}
