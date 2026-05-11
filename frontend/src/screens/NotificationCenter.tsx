import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, RefreshControl } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
import { useAuth } from '../store/auth';
export default function NotificationCenter({ navigation }: any) {
  const [notifs, setNotifs] = useState<any[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const { user } = useAuth();
  const fetch = async () => { setRefreshing(true); const res = await api.get('/notifications'); setNotifs(res.data); setRefreshing(false); };
  useEffect(() => { fetch(); }, []);
  const markRead = async () => { await api.post('/notifications/read'); fetch(); };
  return (
    <View style={styles.container}>
      <View style={styles.header}><Text style={styles.title}>Notifications</Text><TouchableOpacity onPress={markRead}><Text style={styles.link}>Mark all read</Text></TouchableOpacity></View>
      <FlatList data={notifs} keyExtractor={n => n.id} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={fetch} tintColor={theme.colors.gold} />} renderItem={({ item }) => (
        <TouchableOpacity style={[styles.row, !item.isRead && styles.unread]} onPress={markRead}>
          <View><Text style={styles.titleText}>{item.title}</Text><Text style={styles.body}>{item.body}</Text></View>
          <Text style={styles.time}>{new Date(item.createdAt).toLocaleDateString()}</Text>
        </TouchableOpacity>
      )} />
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#fff' }, header: { flexDirection: 'row', justifyContent: 'space-between', padding: 20, borderBottomWidth: 1, borderColor: '#eee' }, title: { fontSize: 22, fontWeight: '900' }, link: { color: theme.colors.neon, fontWeight: '600' }, row: { padding: 15, borderBottomWidth: 1, borderColor: '#f5f5f5' }, unread: { backgroundColor: '#f9f9f9' }, titleText: { fontWeight: '700', fontSize: 15 }, body: { color: '#555', marginTop: 4 }, time: { color: '#999', fontSize: 12, marginTop: 6 } });
