import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { useAuth } from '../store/auth';
import { theme } from '../theme';

export default function VoiceRoom() {
  const [rooms, setRooms] = useState<any[]>([]);
  const { user } = useAuth();

  useEffect(() => { api.get('/rooms').then(res => setRooms(res.data)); }, []);
  const joinRoom = async (id: string) => {
    const socket = await ws();
    socket.emit('join', { roomId: id });
    socket.on('room:sync', (room: any) => console.log('Room synced', room));
  };

  return (
    <View style={styles.container}>
      <Text style={styles.title}>VOICE ROOMS</Text>
      <TouchableOpacity style={styles.createBtn}><Text style={styles.btnText}>+ Create Room</Text></TouchableOpacity>
      <FlatList data={rooms} keyExtractor={r => r.id} renderItem={({ item }) => (
        <View style={styles.row}><Text style={styles.roomTitle}>{item.title}</Text><TouchableOpacity onPress={() => joinRoom(item.id)} style={styles.join}><Text style={styles.joinText}>Join</Text></TouchableOpacity></View>
      )} />
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 20, backgroundColor: theme.colors.softWhite }, title: { fontSize: 22, fontWeight: '800', marginBottom: 20 }, createBtn: { backgroundColor: theme.colors.gold, padding: 15, borderRadius: 10, alignItems: 'center', marginBottom: 20 }, btnText: { color: '#fff', fontWeight: '700' }, row: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: '#fff', padding: 15, borderRadius: 10, marginBottom: 10 }, roomTitle: { fontSize: 16, fontWeight: '600' }, join: { backgroundColor: theme.colors.neon, padding: 8, borderRadius: 6 }, joinText: { color: '#fff' } });
