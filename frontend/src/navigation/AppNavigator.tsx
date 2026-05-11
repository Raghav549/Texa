import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
import HomeScreen from '../screens/HomeScreen';
import VoiceScreen from '../screens/VoiceScreen';
import ReelsScreen from '../screens/ReelsScreen';
import MessagesScreen from '../screens/MessagesScreen';
import ProfileScreen from '../screens/ProfileScreen';
import SearchBar from '../components/SearchBar';
import { useAuth } from '../store/auth';
const Tab = createBottomTabNavigator();
const HeaderSearch = () => <View style={styles.header}><SearchBar /></View>;
export default function AppNavigator() {
  return (
    <NavigationContainer>
      <Tab.Navigator screenOptions={{ headerShown: true, tabBarActiveTintColor: theme.colors.neon, tabBarInactiveTintColor: theme.colors.gray, tabBarStyle: { backgroundColor: '#fff', borderTopWidth: 0, elevation: 0 } }}>
        <Tab.Screen name="Home" component={HomeScreen} options={{ headerRight: () => <HeaderSearch />, tabBarLabel: () => <Text style={styles.tab}>Home</Text> }} />
        <Tab.Screen name="Voice" component={VoiceScreen} options={{ tabBarLabel: () => <Text style={styles.tab}>Voice</Text> }} />
        <Tab.Screen name="Reels" component={ReelsScreen} options={{ tabBarLabel: () => <Text style={styles.tab}>Reels</Text> }} />
        <Tab.Screen name="Messages" component={MessagesScreen} options={{ tabBarLabel: () => <Text style={styles.tab}>Chat</Text> }} />
        <Tab.Screen name="Profile" component={ProfileScreen} options={{ tabBarLabel: () => <Text style={styles.tab}>You</Text> }} />
      </Tab.Navigator>
    </NavigationContainer>
  );
}
const styles = StyleSheet.create({ header: { marginRight: 15, width: 40, height: 40, justifyContent: 'center', alignItems: 'center' }, tab: { fontSize: 10, fontWeight: '600' } });
