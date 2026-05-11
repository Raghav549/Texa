import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, Image, ScrollView } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { theme } from '../theme';
import { api } from '../api/client';
export default function StoryCreator({ onClose }: { onClose: () => void }) {
  const [uri, setUri] = useState<string | null>(null);
  const [caption, setCaption] = useState('');
  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 1 });
    if (!res.canceled) setUri(res.assets[0].uri);
  };
  const upload = async () => {
    if (!uri) return Alert.alert('Select media');
    const fd = new FormData();
    fd.append('media', { uri, name: `story.${uri.split('.').pop()}`, type: uri.includes('mp4') ? 'video/mp4' : 'image/jpeg' } as any);
    fd.append('caption', caption);
    await api.post('/story', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    Alert.alert('Story Posted'); onClose();
  };
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <TouchableOpacity onPress={pick} style={styles.pick}><Text style={styles.btnText}>+ Upload Story</Text></TouchableOpacity>
      {uri && <Image source={{ uri }} style={styles.preview} />}
      <TextInput placeholder="Add caption..." value={caption} onChangeText={setCaption} style={styles.input} />
      <View style={styles.musicRow}>
        <Text style={styles.musicText}>🎵 Suggested: Trending 2024</Text>
      </View>
      <TouchableOpacity onPress={upload} style={styles.btn}><Text style={styles.btnText}>PUBLISH STORY</Text></TouchableOpacity>
    </ScrollView>
  );
}
const styles = StyleSheet.create({ container: { padding: 20, backgroundColor: '#fff' }, pick: { backgroundColor: theme.colors.gold, padding: 15, borderRadius: 12, alignItems: 'center', marginBottom: 15 }, preview: { width: '100%', height: 300, borderRadius: 12, marginBottom: 15 }, input: { backgroundColor: '#f5f5f5', padding: 12, borderRadius: 8, marginBottom: 15 }, musicRow: { padding: 10, backgroundColor: '#eee', borderRadius: 8, marginBottom: 15 }, musicText: { color: '#555', fontWeight: '600' }, btn: { backgroundColor: theme.colors.neon, padding: 15, borderRadius: 12, alignItems: 'center' }, btnText: { color: '#fff', fontWeight: '800' } });
