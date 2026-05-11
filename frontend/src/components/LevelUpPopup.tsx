import React, { useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet, TouchableOpacity } from 'react-native';
import { theme } from '../theme';
export default function LevelUpPopup({ level, visible, onClose }: any) {
  const translateY = useRef(new Animated.Value(-100)).current;
  useEffect(() => { if (visible) Animated.spring(translateY, { toValue: 0, tension: 50, friction: 8, useNativeDriver: true }).start(); }, [visible]);
  if (!visible) return null;
  return (
    <View style={styles.overlay}>
      <Animated.View style={[styles.card, { transform: [{ translateY }] }]}>
        <Text style={styles.badge}>LEVEL UP</Text>
        <Text style={styles.lvl}>{level.toUpperCase()}</Text>
        <TouchableOpacity onPress={onClose} style={styles.close}><Text style={styles.closeText}>CONTINUE</Text></TouchableOpacity>
      </Animated.View>
    </View>
  );
}
const styles = StyleSheet.create({ overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', alignItems: 'center' }, card: { backgroundColor: '#fff', padding: 30, borderRadius: 20, alignItems: 'center', width: 250, shadowColor: theme.colors.gold, shadowOpacity: 0.3, shadowRadius: 15 }, badge: { backgroundColor: theme.colors.gold, paddingHorizontal: 15, paddingVertical: 5, borderRadius: 20, color: '#000', fontWeight: '800', marginBottom: 15 }, lvl: { fontSize: 32, fontWeight: '900', color: theme.colors.neon, marginBottom: 20 }, close: { backgroundColor: theme.colors.neon, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 }, closeText: { color: '#000', fontWeight: '700' } });
