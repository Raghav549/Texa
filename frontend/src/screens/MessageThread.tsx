import React, { useEffect, useState, useRef } from 'react';
import { View, Text, FlatList, TextInput, TouchableOpacity, Image, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { api } from '../api/client';
import { ws } from '../api/ws';
import * as ImagePicker from 'expo-image-picker';
import { theme } from '../theme';
import { useAuth } from '../store/auth';
export default function MessageThread({ route }: any) {
  const { receiverId, receiver } = route.params;
  const { user } = useAuth();
  const [msgs, setMsgs] = useState<any[]>([]);
  const [input, setInput] = useState('');
  const [typing, setTyping] = useState(false);
  const flatRef = useRef<FlatList>(null);
  useEffect(() => {
    api.get(`/dm/${receiverId}`).then(res => setMsgs(res.data));
    (async () => {
      const s = await ws();
      s.on('dm:new', (m: any) => {
        setMsgs(p => [...p, m]);
        flatRef.current?.scrollToEnd();
      });
      s.on('dm:typing', () => setTyping(true));
      s.on('dm:stop_typing', () => setTyping(false));
    })();
  }, [receiverId]);
  const send = async (media?: string) => {
    const fd = new FormData();
    fd.append('receiverId', receiverId);
    if (input) fd.append('content', input);
    if (media) fd.append('media', { uri: media, name: 'img.jpg', type: 'image/jpeg' } as any);
    await api.post('/dm', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    setInput('');
  };
  const pickImg = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Images });
    if (!res.canceled) send(res.assets[0].uri);
  };
  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <View style={styles.header}>
        <Image source={{ uri: receiver.avatarUrl }} style={styles.avatar} />
        <Text style={styles.name}>{receiver.fullName} {receiver.isVerified ? '🔹' : ''}</Text>
      </View>
      <FlatList ref={flatRef} data={msgs} keyExtractor={m => m.id} contentContainerStyle={{ padding: 10, flexGrow: 1 }} renderItem={({ item }) => (
        <View style={[styles.bubble, item.senderId === user?.id ? styles.me : styles.them]}>
          {item.mediaUrl && <Image source={{ uri: item.mediaUrl }} style={styles.img} />}
          {item.content && <Text style={{ color: '#fff' }}>{item.content}</Text>}
          <Text style={styles.status}>{item.status === 'SEEN' ? '✓✓' : item.status === 'DELIVERED' ? '✓' : '⏳'}</Text>
        </View>
      )} />
      {typing && <Text style={styles.typing}>Typing...</Text>}
      <View style={styles.row}>
        <TouchableOpacity onPress={pickImg} style={styles.icon}><Text>📷</Text></TouchableOpacity>
        <TextInput style={styles.input} value={input} onChangeText={setInput} onFocus={async () => (await ws()).emit('dm:typing', { toId: receiverId })} onBlur={async () => (await ws()).emit('dm:stop_typing', { toId: receiverId })} placeholder="Message..." />
        <TouchableOpacity onPress={() => send()} style={styles.btn}><Text style={styles.btnText}>Send</Text></TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#f0f2f5' }, header: { flexDirection: 'row', alignItems: 'center', padding: 15, backgroundColor: '#fff', borderBottomWidth: 1, borderColor: '#eee' }, avatar: { width: 40, height: 40, borderRadius: 20 }, name: { fontSize: 16, fontWeight: '800', marginLeft: 10 }, bubble: { maxWidth: '80%', padding: 10, borderRadius: 15, marginBottom: 8 }, me: { backgroundColor: theme.colors.neon, alignSelf: 'flex-end' }, them: { backgroundColor: '#333', alignSelf: 'flex-start' }, img: { width: 150, height: 150, borderRadius: 10, marginBottom: 5 }, status: { fontSize: 10, color: '#ccc', textAlign: 'right', marginTop: 4 }, typing: { paddingHorizontal: 15, color: '#888', marginBottom: 5 }, row: { flexDirection: 'row', padding: 10, backgroundColor: '#fff', borderTopWidth: 1, borderColor: '#eee' }, input: { flex: 1, padding: 10 }, btn: { backgroundColor: theme.colors.gold, paddingHorizontal: 15, justifyContent: 'center', borderRadius: 20 }, btnText: { color: '#fff', fontWeight: '700' }, icon: { fontSize: 24, marginRight: 10, justifyContent: 'center' } });
