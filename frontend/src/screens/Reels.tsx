import React, { useEffect, useState } from 'react';
import { View, Text, FlatList, StyleSheet, Image, TouchableOpacity } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
export default function Reels() {
  const [reels, setReels] = useState<any[]>([]);
  useEffect(() => { api.get('/reels').then(res => setReels(res.data)); }, []);
  return (
    <View style={styles.container}><Text style={styles.header}>REELS</Text><FlatList data={reels} keyExtractor={r => r.id} renderItem={({ item }) => (
      <View style={styles.card}><Image source={{ uri: item.videoUrl }} style={{ height: 500 }} /><Text style={styles.caption}>{item.caption}</Text><View style={styles.actions}><Text>❤️ {item.likes?.length || 0}</Text><TouchableOpacity><Text style={styles.share}>Share</Text></TouchableOpacity></View></View>
    )} /></View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#000' }, header: { color: '#fff', padding: 20, fontWeight: '800' }, card: { backgroundColor: '#111', marginBottom: 1 }, caption: { color: '#fff', padding: 10 }, actions: { flexDirection: 'row', padding: 10, gap: 15 }, share: { color: theme.colors.neon } });
