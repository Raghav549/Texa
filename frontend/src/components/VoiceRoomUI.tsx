import React, { useState, useEffect } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, ScrollView } from 'react-native';
import { ws } from '../api/ws';
import { theme } from '../theme';
export default function VoiceRoomUI({ roomId, userId, isHost }: any) {
  const [seats, setSeats] = useState<any[]>([]);
  const [chat, setChat] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [input, setInput] = useState('');
  useEffect(() => {
    (async () => {
      const s = await ws();
      s.emit('join', { roomId });
      s.on('room:sync', (d: any) => { setSeats(d.seats); setQueue(d.musicQueue); });
      s.on('chat:new', (m: any) => setChat(prev => [...prev, m]));
      s.on('seat:mic', (d: any) => setSeats(prev => prev.map(s => s.userId === d.userId ? { ...s, isMuted: d.isMuted } : s)));
      s.on('gift:trigger', (g: any) => setChat(prev => [...prev, { userId: 'system', text: `🎁 ${g.from} sent ${g.type} to ${g.to}` }]));
    })();
  }, [roomId]);
  const takeSeat = async () => (await ws()).emit('seat:take');
  const toggleMic = async () => (await ws()).emit('seat:mic', { isMuted: seats.find(s => s.userId === userId)?.isMuted === false });
  const sendChat = async () => { if (!input) return; (await ws()).emit('chat:send', { text: input }); setInput(''); };
  const hostControl = async (action: string, target: string) => (await ws()).emit('host:control', { action, targetUserId: target });
  const addSong = async () => (await ws()).emit('music:add', { track: 'Custom Track.mp3' });
  const sendGift = async () => (await ws()).emit('gift:send', { toId: 'any', type: 'Rose', amount: 5 });

  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.seats}>
        {Array(10).fill(null).map((_, i) => {
          const seat = seats[i];
          return <TouchableOpacity key={i} style={[styles.seat, seat?.isHost && styles.hostSeat]} onPress={seat ? undefined : takeSeat}>
            {seat ? <Text style={{ color: '#fff' }}>{seat.user.username} {seat.user.isVerified ? '✓' : ''}</Text> : <Text style={{ color: '#888' }}>Empty</Text>}
            {seat && <View style={styles.micBadge}><Text style={{ fontSize: 10 }}>{seat.isMuted ? '🔇' : '🎤'}</Text></View>}
          </TouchableOpacity>;
        })}
      </ScrollView>
      <View style={styles.controls}>
        {isHost && <TouchableOpacity onPress={() => addSong()} style={styles.ctrl}><Text style={styles.ctrlText}>+ Add Song</Text></TouchableOpacity>}
        <TouchableOpacity onPress={toggleMic} style={styles.ctrl}><Text style={styles.ctrlText}>Toggle Mic</Text></TouchableOpacity>
        <TouchableOpacity onPress={sendGift} style={styles.ctrl}><Text style={styles.ctrlText}>🎁 Send Gift</Text></TouchableOpacity>
      </View>
      <FlatList data={chat.slice(-20)} keyExtractor={(_, i) => i.toString()} renderItem={({ item }) => <Text style={[styles.msg, item.userId === 'system' && { color: theme.colors.gold }]}>{item.text}</Text>} style={styles.chat} />
      <View style={styles.inputRow}><TextInput style={styles.input} value={input} onChangeText={setInput} placeholder="Type..." /><TouchableOpacity onPress={sendChat} style={styles.send}><Text style={styles.sendText}>Send</Text></TouchableOpacity></View>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#111', padding: 10 }, seats: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, seat: { width: '30%', height: 60, backgroundColor: '#222', borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, hostSeat: { backgroundColor: theme.colors.gold }, micBadge: { position: 'absolute', right: 5, top: 5 }, controls: { flexDirection: 'row', justifyContent: 'space-around', padding: 10 }, ctrl: { backgroundColor: '#333', padding: 8, borderRadius: 6 }, ctrlText: { color: '#fff' }, chat: { flex: 1, padding: 10 }, msg: { color: '#eee', marginBottom: 4 }, inputRow: { flexDirection: 'row', gap: 10, padding: 10 }, input: { flex: 1, backgroundColor: '#333', color: '#fff', padding: 10, borderRadius: 20 }, send: { backgroundColor: theme.colors.neon, justifyContent: 'center', paddingHorizontal: 15, borderRadius: 20 }, sendText: { color: '#fff' } });
