import React, { useEffect, useState } from 'react';
import { View, Image, Animated, StyleSheet } from 'react-native';
import { theme } from '../theme';
import * as Font from 'expo-font';

export default function SplashScreen({ onFinish }: { onFinish: () => void }) {
  const [loaded, setLoaded] = useState(false);
  const scale = new Animated.Value(0.8);
  useEffect(() => {
    Font.loadAsync({ 'Inter-Bold': require('../../assets/fonts/Inter-Bold.ttf') }).then(() => setLoaded(true));
  }, []);
  useEffect(() => {
    if (!loaded) return;
    Animated.parallel([
      Animated.timing(scale, { toValue: 1, duration: 400, useNativeDriver: true }),
    ]).start(() => setTimeout(onFinish, 600));
  }, [loaded]);
  return (
    <View style={styles.container}>
      <Animated.View style={[styles.logoWrap, { transform: [{ scale }] }]}>
        <View style={styles.logo}><Text style={styles.text}>TEXA</Text></View>
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: theme.colors.white, justifyContent: 'center', alignItems: 'center' }, logo: { width: 120, height: 120, borderRadius: 30, backgroundColor: theme.colors.gold, justifyContent: 'center', alignItems: 'center', shadowColor: theme.colors.neon, shadowOpacity: 0.4, shadowRadius: 15, shadowOffset: { width: 0, height: 0 } }, text: { fontSize: 28, fontWeight: '900', color: '#fff', fontFamily: 'Inter-Bold' }, logoWrap: { alignItems: 'center' } });
