import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, Image, StyleSheet } from 'react-native';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { theme } from '../theme';
import * as ImagePicker from 'expo-image-picker';
export default function DMScreen({ route }: any) {
  const { userId } = route.params;
  const [msgs, setMsgs] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    api.get(`/dm/${userId}`).then(res => setMsgs(res.data));
    (async () => {
      const s = await ws();
      s.emit('join', `dm:${userId}`);
      s.on('dm:new', (m: any) => setMsgs(prev => [...prev, m]));
      s.on('typing', (d: any) => setTyping(d.typing));
    })();
  }, [userId]);
  const send = async (media?: string) => {
    const fd = new FormData();
    fd.append('receiverId', userId);
    fd.append('content', input);
    if (media) fd.append('media', { uri: media, name: 'img.jpg', type: 'image/jpeg' } as any);
    await api.post('/dm', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    setInput('');
  };
  const pickImg = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!res.canceled) send(res.assets[0].uri);
  };
  return (
    <View style={styles.container}>
      <FlatList data={msgs} keyExtractor={m => m.id} inverted renderItem={({ item }) => (
        <View style={[styles.bubble, item.senderId === userId ? styles.them : styles.me]}>
          {item.mediaUrl ? <Image source={{ uri: item.mediaUrl }} style={styles.img} /> : null}
          {item.content && <Text style={{ color: '#fff' }}>{item.content}</Text>}
          <Text style={styles.status}>{item.status === 'SEEN' ? '✓✓' : '✓'}</Text>
        </View>
      )} />
      {typing && <Text style={styles.typing}>Typing...</Text>}
      <View style={styles.row}>
        <TouchableOpacity onPress={pickImg}><Text style={styles.icon}>📷</Text></TouchableOpacity>
        <TextInput style={styles.input} value={input} onChangeText={setInput} onFocus={() => (async () => (await ws()).emit('typing', { toId: userId }))()} onBlur={() => (async () => (await ws()).emit('stopTyping', { toId: userId }))()} />
        <TouchableOpacity onPress={() => send()} style={styles.btn}><Text style={styles.btnText}>Send</Text></TouchableOpacity>
      </View>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#f0f2f5' }, bubble: { maxWidth: '80%', padding: 10, borderRadius: 15, marginBottom: 8, marginHorizontal: 10 }, me: { backgroundColor: theme.colors.neon, alignSelf: 'flex-end' }, them: { backgroundColor: '#333', alignSelf: 'flex-start' }, img: { width: 150, height: 150, borderRadius: 10, marginBottom: 5 }, status: { fontSize: 10, color: '#ccc', textAlign: 'right' }, typing: { paddingHorizontal: 20, color: '#888' }, row: { flexDirection: 'row', padding: 10, backgroundColor: '#fff' }, input: { flex: 1, padding: 10 }, btn: { backgroundColor: theme.colors.gold, paddingHorizontal: 15, justifyContent: 'center', borderRadius: 20 }, btnText: { color: '#fff' }, icon: { fontSize: 24, marginRight: 10 } });
