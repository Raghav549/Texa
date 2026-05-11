import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, Dimensions } from 'react-native';
import { theme } from '../theme';
export default function GiftOverlay({ gift, onDone }: any) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.parallel([
      Animated.spring(scale, { toValue: 1.2, tension: 60, friction: 6, useNativeDriver: true }),
      Animated.delay(2000).start(() => Animated.timing(opacity, { toValue: 0, duration: 500, useNativeDriver: true }).start(() => onDone()))
    ]);
  }, [gift]);
  if (!gift) return null;
  return (
    <View style={styles.overlay}>
      <Animated.View style={[styles.card, { transform: [{ scale }], opacity }]}>
        <Text style={styles.icon}>🎁</Text>
        <Text style={styles.from}>@{gift.from} → @{gift.to}</Text>
        <Text style={styles.type}>{gift.type} ({gift.amount}c)</Text>
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create({ overlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.3)' }, card: { backgroundColor: '#fff', padding: 20, borderRadius: 20, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.2, shadowRadius: 15 }, icon: { fontSize: 40, marginBottom: 5 }, from: { fontWeight: '700', fontSize: 16, color: theme.colors.neon }, type: { marginTop: 5, color: theme.colors.gold, fontWeight: '800' } });
