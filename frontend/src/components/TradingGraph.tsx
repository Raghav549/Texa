import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Animated, Dimensions } from 'react-native';
import { theme } from '../theme';
export default function TradingGraph({ choices, timeLeft }: any) {
  const [bars, setBars] = useState<Animated.Value[]>([]);
  useEffect(() => {
    const newBars = choices.map(c => new Animated.Value(c.invested || 5));
    setBars(newBars);
    Animated.parallel(newBars.map((b, i) => Animated.timing(b, { toValue: choices[i].invested || 5, duration: 600, useNativeDriver: false }))).start();
  }, [choices]);
  const maxVal = Math.max(...choices.map(c => c.votes + c.invested), 1);
  return (
    <View style={styles.container}>
      <Text style={styles.timer}>LOCK: {timeLeft}</Text>
      <View style={styles.graph}>
        {choices.map((c: any, i: number) => (
          <View key={c.id} style={styles.col}>
            <Text style={styles.val}>{c.invested}c</Text>
            <Animated.View style={[styles.bar, { height: bars[i], backgroundColor: theme.colors.gold }]} />
            <Text style={styles.label}>{c.label.substring(0, 6)}</Text>
          </View>
        ))}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({ container: { padding: 10, backgroundColor: '#f9f9f9', borderRadius: 12, marginBottom: 15 }, timer: { fontSize: 16, fontWeight: '800', color: theme.colors.neon, textAlign: 'center', marginBottom: 10 }, graph: { flexDirection: 'row', alignItems: 'flex-end', height: 150, gap: 2 }, col: { flex: 1, alignItems: 'center' }, val: { fontSize: 10, marginBottom: 2 }, bar: { width: '100%', borderRadius: 4, minHeight: 4 }, label: { fontSize: 8, marginTop: 4, color: '#666' } });
