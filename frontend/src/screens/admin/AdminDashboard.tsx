import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert } from 'react-native';
import api from '../../api/client';
import { theme } from '../../theme';

export default function AdminDashboard() {
  const [users, setUsers] = useState<any[]>([]);

  useEffect(() => {
    api.get('/admin/users').then(res => setUsers(res.data)).catch(() => setUsers([]));
  }, []);

  const banUser = async (id: string) => {
    await api.post('/admin/ban', { userId: id });
    Alert.alert('Banned');
    api.get('/admin/users').then(res => setUsers(res.data));
  };

  const toggleVerify = async (id: string) => {
    await api.post('/admin/verify', { userId: id });
    api.get('/admin/users').then(res => setUsers(res.data));
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>ADMIN DASHBOARD</Text>
      <FlatList
        data={users}
        keyExtractor={u => u.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.text}>@{item.username} ({item.coins}c | Lvl {item.level})</Text>
            <TouchableOpacity onPress={() => toggleVerify(item.id)} style={styles.btn}><Text style={styles.btnText}>{item.isVerified ? 'UNVERIFY' : 'VERIFY'}</Text></TouchableOpacity>
            <TouchableOpacity onPress={() => banUser(item.id)} style={styles.btnRed}><Text style={styles.btnText}>BAN</Text></TouchableOpacity>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: theme.spacing.lg, backgroundColor: theme.colors.softWhite },
  title: { fontSize: 20, fontWeight: '800', color: theme.colors.gold, marginBottom: 20 },
  row: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: theme.colors.white, padding: 12, marginBottom: 10, borderRadius: 8 },
  text: { fontWeight: '600' },
  btn: { backgroundColor: theme.colors.neonBlue, paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, marginRight: 8 },
  btnRed: { backgroundColor: '#ff4444', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4 },
  btnText: { color: '#fff', fontSize: 12, fontWeight: '600' }
});
