import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, Alert } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
export default function AdminPanel() {
  const [users, setUsers] = useState<any[]>([]);
  const [selId, setSelId] = useState('');
  const [coins, setCoins] = useState('');
  const [xp, setXp] = useState('');
  useEffect(() => { api.get('/admin/users').then(res => setUsers(res.data)); }, []);
  const act = async (type: string) => {
    try { await api.post('/admin/users/manage', { userId: selId, action: type }); Alert.alert('Success'); api.get('/admin/users').then(res => setUsers(res.data)); } catch { Alert.alert('Error'); }
  };
  const updateStats = async () => {
    await api.post('/admin/users/stats', { userId: selId, coins: coins ? parseInt(coins) : undefined, xp: xp ? parseInt(xp) : undefined });
    Alert.alert('Updated'); api.get('/admin/users').then(res => setUsers(res.data));
  };
  return (
    <View style={styles.container}>
      <Text style={styles.title}>ADMIN DASHBOARD</Text>
      <View style={styles.ctrls}>
        <TextInput placeholder="User ID" value={selId} onChangeText={setSelId} style={styles.input} />
        <TextInput placeholder="Coins" value={coins} onChangeText={setCoins} keyboardType="numeric" style={styles.input} />
        <TextInput placeholder="XP" value={xp} onChangeText={setXp} keyboardType="numeric" style={styles.input} />
        <TouchableOpacity onPress={updateStats} style={styles.btn}><Text style={styles.btnText}>Update Stats</Text></TouchableOpacity>
        <View style={styles.row}><TouchableOpacity onPress={() => act('ban')} style={[styles.btn, { backgroundColor: '#ff4444' }]}><Text style={styles.btnText}>Ban</Text></TouchableOpacity><TouchableOpacity onPress={() => act('verify')} style={[styles.btn, { backgroundColor: theme.colors.gold }]}><Text style={styles.btnText}>Verify</Text></TouchableOpacity></View>
      </View>
      <FlatList data={users} keyExtractor={u => u.id} renderItem={({ item }) => (
        <TouchableOpacity onPress={() => setSelId(item.id)} style={styles.row}><Text>@{item.username} ({item.coins}c | {item.xp}xp)</Text><Text style={{ color: item.isVerified ? theme.colors.neon : '#888' }}>{item.isVerified ? '✓' : ''}</Text></TouchableOpacity>
      )} />
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 20, backgroundColor: '#fff' }, title: { fontSize: 22, fontWeight: '900', color: theme.colors.gold, marginBottom: 20 }, ctrls: { marginBottom: 20 }, input: { backgroundColor: '#f5f5f5', padding: 12, borderRadius: 8, marginBottom: 10 }, btn: { backgroundColor: theme.colors.neon, padding: 12, borderRadius: 8, alignItems: 'center', marginVertical: 5 }, btnText: { color: '#fff', fontWeight: '700' }, row: { flexDirection: 'row', justifyContent: 'space-between', padding: 12, backgroundColor: '#eee', marginBottom: 5, borderRadius: 6 } });
