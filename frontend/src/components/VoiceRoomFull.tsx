import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, TextInput, StyleSheet, ScrollView, Alert } from 'react-native';
import { ws } from '../api/ws';
import { theme } from '../theme';
import { useAuth } from '../store/auth';
import GiftOverlay from './GiftOverlay';
import VoiceAudioSync from './VoiceAudioSync';
export default function VoiceRoomFull({ roomId, hostId }: { roomId: string; hostId: string }) {
  const { user } = useAuth();
  const [seats, setSeats] = useState<any[]>(Array(10).fill(null));
  const [chat, setChat] = useState<any[]>([]);
  const [queue, setQueue] = useState<any[]>([]);
  const [giftAnim, setGiftAnim] = useState<any>(null);
  const [input, setInput] = useState('');
  const isHost = user?.id === hostId;
  useEffect(() => {
    (async () => {
      const s = await ws();
      s.emit('room:join', { roomId });
      s.on('room:sync', (d: any) => {
        const occupied = d.seats || [];
        setSeats(Array(10).fill(null).map((_, i) => occupied[i] || null));
        setQueue(d.musicQueue || []);
      });
      s.on('chat:new', (m: any) => setChat(p => [...p, m]));
      s.on('gift:trigger', (g: any) => setGiftAnim(g));
    })();
  }, [roomId]);
  const takeSeat = () => (ws() as Promise<any>).then(s => s.emit('seat:take'));
  const toggleMic = (muted: boolean) => (ws() as Promise<any>).then(s => s.emit('seat:mic', { isMuted: muted }));
  const sendChat = () => { if (!input) return; (ws() as Promise<any>).then(s => s.emit('chat:send', { text: input })); setInput(''); };
  const hostAct = (act: string, target?: string) => (ws() as Promise<any>).then(s => s.emit('room:control', { roomId, action: act, targetId: target }));
  const sendGift = (type: string, amount: number) => (ws() as Promise<any>).then(s => s.emit('gift:send', { toId: hostId, type, amount }));
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.seats}>
        {seats.map((s, i) => (
          <TouchableOpacity key={i} style={[styles.seat, s?.isHost ? styles.hostSeat : s ? styles.taken : styles.empty]} onPress={() => !s && takeSeat()}>
            <Text style={{ color: s ? '#fff' : '#888' }}>{s?.user?.username || `Seat ${i+1}`}</Text>
            {s && <View style={styles.mic}><Text>{s.isMuted ? '🔇' : '🎤'}</Text></View>}
          </TouchableOpacity>
        ))}
      </ScrollView>
      {isHost && <VoiceAudioSync roomId={roomId} queue={queue} isHost={true} />}
      <View style={styles.ctrls}>
        {isHost && <>
          <TouchableOpacity onPress={() => hostAct('pause_music')} style={styles.ctrl}><Text style={styles.ctrlText}>⏸️ Pause</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => hostAct('next_music')} style={styles.ctrl}><Text style={styles.ctrlText}>⏭️ Next</Text></TouchableOpacity>
        </>}
        <TouchableOpacity onPress={() => toggleMic(true)} style={styles.ctrl}><Text style={styles.ctrlText}>🔇 Mute</Text></TouchableOpacity>
        <TouchableOpacity onPress={() => sendGift('Rose', 10)} style={styles.ctrl}><Text style={styles.ctrlText}>🌹 Gift</Text></TouchableOpacity>
      </View>
      <FlatList data={chat} keyExtractor={(_, i) => i.toString()} renderItem={({ item }) => <Text style={styles.msg}><Text style={{ fontWeight: '700' }}>{item.userId === user?.id ? 'You' : 'User'}:</Text> {item.text}</Text>} style={styles.chat} />
      <View style={styles.inputRow}><TextInput style={styles.input} value={input} onChangeText={setInput} placeholder="Type in room..." /><TouchableOpacity onPress={sendChat} style={styles.send}><Text style={styles.sendText}>Send</Text></TouchableOpacity></View>
      {giftAnim && <GiftOverlay gift={giftAnim} onDone={() => setGiftAnim(null)} />}
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#111' }, seats: { flexDirection: 'row', flexWrap: 'wrap', padding: 10, gap: 10 }, seat: { width: '30%', height: 70, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }, hostSeat: { backgroundColor: theme.colors.gold }, taken: { backgroundColor: '#333' }, empty: { backgroundColor: '#222' }, mic: { position: 'absolute', right: 5, top: 5 }, ctrls: { flexDirection: 'row', justifyContent: 'space-around', padding: 10, backgroundColor: '#222' }, ctrl: { padding: 10, borderRadius: 8, backgroundColor: '#444' }, ctrlText: { color: '#fff' }, chat: { flex: 1, padding: 10 }, msg: { color: '#eee', marginBottom: 5 }, inputRow: { flexDirection: 'row', padding: 10, backgroundColor: '#222' }, input: { flex: 1, color: '#fff', padding: 10, backgroundColor: '#333', borderRadius: 20 }, send: { backgroundColor: theme.colors.neon, padding: 10, borderRadius: 20, marginLeft: 10, justifyContent: 'center' }, sendText: { color: '#fff' } });
