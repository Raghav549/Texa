import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { theme } from '../theme';

export default function Logo({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    setTimeout(() => setLoaded(true), 50); // Instant preload cache trigger
  }, []);
  
  const dim = size === 'sm' ? 40 : size === 'md' ? 60 : 100;
  return (
    <View style={[styles.wrap, { width: dim, height: dim, opacity: loaded ? 1 : 0 }]}>
      <View style={styles.logo}>
        <Text style={[styles.text, { fontSize: dim * 0.3 }]}>TEXA</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', transitionDuration: 200 },
  logo: { backgroundColor: theme.colors.gold, borderRadius: 16, width: '100%', height: '100%', justifyContent: 'center', alignItems: 'center', shadowColor: theme.colors.neon, shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } },
  text: { color: '#fff', fontWeight: '900', letterSpacing: 2 }
});
