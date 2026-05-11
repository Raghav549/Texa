import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, FlatList } from 'react-native';
import { io } from 'socket.io-client';
import { theme } from '../theme';
import api from '../api/client';
import { useUserStore } from '../store/useUserStore';

const socket = io('wss://your-real-server.com', { transports: ['websocket'] });

export default function TradingScreen() {
  const [choices, setChoices] = useState<any[]>([]);
  const [countdown, setCountdown] = useState('00:00:00');
  const { user } = useUserStore();

  useEffect(() => {
    api.get('/trading/active').then(res => setChoices(res.data.choices));
    socket.on('trading:update', ( any) => setChoices(data));
    return () => socket.off('trading:update');
  }, []);

  const vote = (choiceId: string) => {
    socket.emit('trade:vote', { choiceId, userId: user?.id });
  };

  const invest = (choiceId: string) => {
    if (!user || user.coins < 50) return;
    socket.emit('trade:invest', { choiceId, userId: user?.id, amount: 50 });
  };

  return (
    <View style={styles.container}>
      <Text style={styles.header}>REAL-TIME CHOICE TRADING</Text>
      <Text style={styles.timer}>LOCK: {countdown}</Text>
      <FlatList
        data={choices}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.label}>{item.label}</Text>
            <View style={styles.bar}><View style={[styles.fill, { width: `${(item.votes + item.invested) / 200 * 100}%` }]} /></View>
            <Text style={styles.count}>{item.votes}v | {item.invested}c</Text>
            <TouchableOpacity style={styles.voteBtn} onPress={() => vote(item.id)}><Text style={styles.voteText}>VOTE</Text></TouchableOpacity>
            <TouchableOpacity style={styles.invBtn} onPress={() => invest(item.id)}><Text style={styles.invText}>INVEST</Text></TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.softWhite },
  header: { fontSize: 20, fontWeight: '800', color: theme.colors.neonBlue, marginBottom: 5 },
  timer: { fontSize: 16, color: theme.colors.muted, marginBottom: 15 },
  row: { flexDirection: 'row', alignItems: 'center', backgroundColor: theme.colors.white, padding: 12, marginBottom: 10, borderRadius: 10, shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 5 },
  label: { flex: 1, fontWeight: '600', fontSize: 16 },
  bar: { flex: 2, height: 8, backgroundColor: theme.colors.lightSilver, borderRadius: 4, overflow: 'hidden', marginHorizontal: 10 },
  fill: { height: 8, backgroundColor: theme.colors.gold },
  count: { width: 60, fontSize: 12, color: theme.colors.muted },
  voteBtn: { backgroundColor: theme.colors.neonBlue, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6, marginRight: 8 },
  invBtn: { backgroundColor: theme.colors.gold, paddingHorizontal: 10, paddingVertical: 6, borderRadius: 6 },
  voteText: { color: '#fff', fontWeight: '600' },
  invText: { color: '#fff', fontWeight: '600' }
});
