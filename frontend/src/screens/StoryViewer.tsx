import React, { useState, useEffect } from 'react';
import { View, Image, Text, StyleSheet, TouchableOpacity, FlatList, Animated } from 'react-native';
import { api } from '../api/client';
import { theme } from '../theme';
export default function StoryViewer({ route }: any) {
  const [stories, setStories] = useState<any[]>([]);
  const [idx, setIdx] = useState(0);
  const [progress] = useState(new Animated.Value(0));
  useEffect(() => {
    api.get('/stories').then(res => {
      setStories(res.data);
      Animated.timing(progress, { toValue: 1, duration: 10000, useNativeDriver: false }).start();
    });
  }, []);
  if (!stories.length) return <Text style={styles.empty}>No active stories</Text>;
  const current = stories[idx];
  const next = () => setIdx(prev => Math.min(prev + 1, stories.length - 1));
  const react = async (emoji: string) => await api.post(`/stories/${current.id}/react`, { emoji });
  return (
    <View style={styles.container}>
      <Image source={{ uri: current.mediaUrl }} style={styles.media} />
      <View style={styles.overlay}>
        <View style={styles.bar}><Animated.View style={[styles.fill, { width: progress.interpolate({ inputRange: [0,1], outputRange: ['0%','100%'] }) as any }]} /></View>
        <Text style={styles.author}>@{current.author.username}</Text>
        <Text style={styles.caption}>{current.caption}</Text>
        <View style={styles.actions}>
          <TouchableOpacity onPress={() => react('❤️')}><Text style={styles.btn}>❤️</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => react('🔥')}><Text style={styles.btn}>🔥</Text></TouchableOpacity>
          <TouchableOpacity onPress={() => react('😂')}><Text style={styles.btn}>😂</Text></TouchableOpacity>
        </View>
      </View>
      <TouchableOpacity style={styles.next} onPress={next} />
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#000' }, media: { width: '100%', height: '100%' }, overlay: { position: 'absolute', top: 50, left: 20, right: 20 }, bar: { height: 4, backgroundColor: '#555', borderRadius: 2, marginBottom: 10 }, fill: { height: 4, backgroundColor: theme.colors.neon, borderRadius: 2 }, author: { color: '#fff', fontWeight: '800', fontSize: 18 }, caption: { color: '#eee', fontSize: 16, marginTop: 5 }, actions: { flexDirection: 'row', marginTop: 20, gap: 20 }, btn: { fontSize: 28 }, next: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 40 }, empty: { flex: 1, justifyContent: 'center', alignItems: 'center', color: '#888' } });
