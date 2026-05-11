import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, TextInput } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
export default function AdminPanel() {
  const [users, setUsers] = useState<any[]>([]);
  const [selected, setSelected] = useState('');
  const [coins, setCoins] = useState('');
  useEffect(() => { api.get('/admin/users').then(res => setUsers(res.data)); }, []);
  const action = async (type: string) => {
    try {
      await api.post('/admin/users/manage', { userId: selected, action: type });
      Alert.alert('Done');
    } catch { Alert.alert('Error'); }
  };
  const updateCoins = async () => { await api.post('/admin/users/coins', { userId: selected, coins: parseInt(coins) }); Alert.alert('Updated'); };
  return (
    <View style={styles.container}>
      <Text style={styles.title}>ADMIN DASHBOARD</Text>
      <View style={styles.controls}>
        <TextInput placeholder="User ID" value={selected} onChangeText={setSelected} style={styles.input} />
        <TextInput placeholder="New Coins" value={coins} onChangeText={setCoins} keyboardType="numeric" style={styles.input} />
        <TouchableOpacity onPress={updateCoins} style={styles.btn}><Text style={styles.btnText}>Update Coins</Text></TouchableOpacity>
        <View style={styles.row}><TouchableOpacity onPress={() => action('ban')} style={[styles.btn, { backgroundColor: 'red' }]}><Text style={styles.btnText}>Ban</Text></TouchableOpacity><TouchableOpacity onPress={() => action('delete')} style={[styles.btn, { backgroundColor: '#555' }]}><Text style={styles.btnText}>Delete</Text></TouchableOpacity></View>
      </View>
      <FlatList data={users} keyExtractor={u => u.id} renderItem={({ item }) => (
        <TouchableOpacity onPress={() => setSelected(item.id)} style={styles.row}>
          <Text>@{item.username} ({item.coins}c | {item.role})</Text>
        </TouchableOpacity>
      )} />
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 20, backgroundColor: '#fff' }, title: { fontSize: 22, fontWeight: '800', color: theme.colors.gold, marginBottom: 20 }, controls: { marginBottom: 20 }, input: { backgroundColor: '#f5f5f5', padding: 12, borderRadius: 8, marginBottom: 10 }, btn: { backgroundColor: theme.colors.neon, padding: 12, borderRadius: 8, alignItems: 'center', marginVertical: 5 }, btnText: { color: '#fff', fontWeight: '700' }, row: { flexDirection: 'row', justifyContent: 'space-between', padding: 10, backgroundColor: '#eee', marginBottom: 5, borderRadius: 6 } });
