import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { theme } from '../theme';
import { useAuth } from '../store/auth';
export default function TradingArena() {
  const [choices, setChoices] = useState<any[]>([]);
  const [timeLeft, setTimeLeft] = useState('');
  const { user } = useAuth();
  useEffect(() => {
    api.get('/trade/active').then(res => setChoices(res.data?.choices || []));
    const wsRef = setInterval(async () => {
      const now = new Date();
      const end = new Date(now); end.setHours(23, 55, 0, 0);
      const diff = end.getTime() - now.getTime();
      if (diff <= 0) setTimeLeft('RESOLVING...');
      else {
        const h = String(Math.floor(diff/3600000)).padStart(2,'0');
        const m = String(Math.floor((diff%3600000)/60000)).padStart(2,'0');
        const s = String(Math.floor((diff%60000)/1000)).padStart(2,'0');
        setTimeLeft(`${h}:${m}:${s}`);
      }
    }, 1000);
    return () => clearInterval(wsRef);
  }, []);
  const action = async (choiceId: string, isInvest: boolean) => {
    if (!user) return;
    await api.post('/trade/vote', { choiceId, isInvest: isInvest ? true : false, amount: isInvest ? 50 : 0 });
  };
  return (
    <View style={styles.container}>
      <Text style={styles.timer}>LOCK: {timeLeft}</Text>
      <FlatList data={choices} keyExtractor={c => c.id} renderItem={({ item }) => {
        const total = item.votes + item.invested;
        const pct = Math.min((total / 200) * 100, 100);
        return (
          <View style={styles.row}>
            <Text style={styles.label}>{item.label}</Text>
            <View style={styles.barWrap}><View style={[styles.bar, { width: `${pct}%` }]} /></View>
            <Text style={styles.count}>{item.votes}v | {item.invested}c</Text>
            <View style={styles.btns}>
              <TouchableOpacity onPress={() => action(item.id, false)} style={styles.vote}><Text style={styles.btnText}>Vote</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => action(item.id, true)} style={styles.invest}><Text style={styles.btnText}>Invest</Text></TouchableOpacity>
            </View>
          </View>
        );
      }} />
    </View>
  );
}
const styles = StyleSheet.create({ container: { padding: 15, backgroundColor: '#f9f9f9', borderRadius: 16, margin: 10 }, timer: { fontSize: 18, fontWeight: '800', color: theme.colors.neon, textAlign: 'center', marginBottom: 15 }, row: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 12, borderRadius: 12, marginBottom: 8, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 4 }, label: { width: 100, fontWeight: '700' }, barWrap: { flex: 1, height: 8, backgroundColor: '#eee', borderRadius: 4, overflow: 'hidden', marginHorizontal: 10 }, bar: { height: 8, backgroundColor: theme.colors.gold }, count: { width: 60, fontSize: 12, color: '#666' }, btns: { flexDirection: 'row', gap: 6 }, vote: { backgroundColor: theme.colors.neon, padding: 6, borderRadius: 6 }, invest: { backgroundColor: theme.colors.gold, padding: 6, borderRadius: 6 }, btnText: { color: '#fff', fontSize: 11, fontWeight: '700' } });
