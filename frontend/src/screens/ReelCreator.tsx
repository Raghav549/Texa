import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Alert, TextInput, Slider } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { api } from '../api/client';
import { theme } from '../theme';
export default function ReelCreator() {
  const [uri, setUri] = useState('');
  const [caption, setCaption] = useState('');
  const [brightness, setBrightness] = useState(0);
  const pick = async () => {
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.Videos, quality: 0.8 });
    if (!res.canceled) setUri(res.assets[0].uri);
  };
  const upload = async () => {
    if (!uri) return Alert.alert('Select video');
    const fd = new FormData();
    fd.append('video', { uri, name: 'reel.mp4', type: 'video/mp4' } as any);
    fd.append('caption', caption);
    fd.append('filterData', JSON.stringify({ brightness }));
    await api.post('/reels', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    Alert.alert('Reel Published');
  };
  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={pick} style={styles.pickBtn}><Text style={styles.btnText}>+ Select Video</Text></TouchableOpacity>
      <TextInput placeholder="Caption..." value={caption} onChangeText={setCaption} style={styles.input} />
      <Text style={styles.label}>Brightness</Text>
      <Slider value={brightness} onValueChange={setBrightness} step={0.01} maximumValue={1} />
      <TouchableOpacity onPress={upload} style={styles.publish}><Text style={styles.btnText}>PUBLISH REEL</Text></TouchableOpacity>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, padding: 20, backgroundColor: '#fff' }, pickBtn: { backgroundColor: theme.colors.gold, padding: 15, borderRadius: 12, alignItems: 'center', marginBottom: 20 }, btnText: { color: '#fff', fontWeight: '700' }, input: { backgroundColor: '#f5f5f5', padding: 12, borderRadius: 8, marginBottom: 15 }, label: { fontWeight: '600', marginBottom: 5 }, publish: { backgroundColor: theme.colors.neon, padding: 15, borderRadius: 12, alignItems: 'center', marginTop: 20 } });
