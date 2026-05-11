import React, { useEffect } from 'react';
import { View, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { useAuth } from './store/auth';
import AppNavigator from './navigation/AppNavigator';
import Login from './screens/auth/Login';
import { theme } from './theme';

export default function App() {
  const { token } = useAuth();
  return (
    <SafeAreaProvider>
      {token ? <AppNavigator /> : <Login />}
    </SafeAreaProvider>
  );
}
