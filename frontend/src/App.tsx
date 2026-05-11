import React, { useState, useEffect } from 'react';
import { View, StatusBar, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { theme } from './theme';
import SplashScreen from './screens/SplashScreen';
import Login from './screens/auth/Login';
import AppNavigator from './navigation/AppNavigator';
import AdminPanel from './screens/AdminPanel';
import { useAuth } from './store/auth';
import { ws } from './api/ws';
import { cacheResponse, getCachedResponse } from './utils/offlineCache';
export default function App() {
  const [ready, setReady] = useState(false);
  const { token, user } = useAuth();
  const [route, setRoute] = useState<'login' | 'app' | 'admin'>('login');
  useEffect(() => {
    if (token) {
      ws(); // Init WS on auth
      if (user?.role === 'SUPERADMIN') setRoute('admin');
      else setRoute('app');
    }
  }, [token]);
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="dark-content" backgroundColor={theme.colors.white} />
      {ready ? (
        <NavigationContainer>
          {route === 'admin' ? <AdminPanel /> : route === 'app' ? <AppNavigator /> : <Login />}
        </NavigationContainer>
      ) : <SplashScreen onFinish={() => setReady(true)} />}
    </SafeAreaProvider>
  );
}
const styles = StyleSheet.create({ container: { flex: 1 } });
