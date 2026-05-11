import React, { useState } from 'react';
import { View, Text, TextInput, FlatList, StyleSheet, TouchableOpacity } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
export default function Messages() {
  const [input, setInput] = useState('');
  const [msgs, setMsgs] = useState<any[]>([]);
  const send = async () => { if (!input) return; const res = await api.post('/dm/send', { content: input, receiverId: 'global' }); setMsgs([...msgs, res.data]); setInput(''); };
  return (
    <View style={styles.container}><FlatList data={msgs} keyExtractor={m => m.id} renderItem={({ item }) => <Text style={[styles.bubble, item.senderId !== 'me' ? { alignSelf: 'flex-end', backgroundColor: theme.colors.gold } : { backgroundColor: '#eee' }]}>{item.content}</Text>} /><View style={styles.inputRow}><TextInput style={styles.input} value={input} onChangeText={setInput} placeholder="Message..." /><TouchableOpacity onPress={send} style={styles.send}><Text style={{ color: '#fff' }}>Send</Text></TouchableOpacity></View></View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 20, backgroundColor: theme.colors.softWhite }, bubble: { padding: 10, borderRadius: 15, marginVertical: 5, maxWidth: '80%' }, inputRow: { flexDirection: 'row', gap: 10 }, input: { flex: 1, backgroundColor: '#fff', padding: 10, borderRadius: 20 }, send: { backgroundColor: theme.colors.neon, padding: 10, borderRadius: 20, justifyContent: 'center' } });
