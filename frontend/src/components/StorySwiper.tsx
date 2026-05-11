import React, { useState, useEffect, useRef } from 'react';
import { View, Image, Text, StyleSheet, TouchableOpacity, FlatList, Animated } from 'react-native';
import { theme } from '../theme';
import { ws } from '../api/ws';
import { api } from '../api/client';
export default function StorySwiper({ stories, onEnd }: any) {
  const [idx, setIdx] = useState(0);
  const [progress] = useState(new Animated.Value(0));
  const timer = useRef<Animated.CompositeAnimation | null>(null);
  useEffect(() => { if (!stories?.length) return; startProgress(); return () => timer.current?.stop(); }, [idx]);
  const startProgress = () => { progress.setValue(0); timer.current = Animated.timing(progress, { toValue: 1, duration: 8000, useNativeDriver: false }); timer.current.start(({ finished }) => { if (finished) next(); }); };
  const next = () => idx < stories.length - 1 ? setIdx(idx + 1) : onEnd();
  const react = async (emoji: string) => { await api.post(`/stories/${stories[idx].id}/react`, { emoji }); };
  const current = stories[idx];
  return (
    <View style={styles.container}>
      <Image source={{ uri: current.mediaUrl }} style={styles.media} resizeMode="cover" />
      <View style={styles.progress}><Animated.View style={[styles.bar, { width: progress }]} /></View>
      <View style={styles.header}>
        <Image source={{ uri: current.author.avatarUrl }} style={[styles.avatar, current.author.isVerified && styles.verifiedRing]} />
        <Text style={styles.name}>@{current.author.username}</Text>
        <TouchableOpacity onPress={next}><Text style={styles.close}>X</Text></TouchableOpacity>
      </View>
      <Text style={styles.caption}>{current.caption}</Text>
      <View style={styles.reactions}>
        {['❤️','🔥','😂','😊'].map(e => <TouchableOpacity key={e} onPress={() => react(e)} style={styles.emoji}><Text>{e}</Text></TouchableOpacity>)}
      </View>
    </View>
  );
}
const styles = StyleSheet.create({ container: { flex: 1, backgroundColor: '#000' }, media: { width: '100%', height: '100%' }, progress: { position: 'absolute', top: 50, left: 20, right: 20, height: 3, backgroundColor: '#444', borderRadius: 2 }, bar: { height: 3, backgroundColor: '#fff', borderRadius: 2 }, header: { position: 'absolute', top: 60, left: 20, right: 20, flexDirection: 'row', alignItems: 'center' }, avatar: { width: 40, height: 40, borderRadius: 20, borderWidth: 2, borderColor: '#fff' }, verifiedRing: { borderColor: theme.colors.neon }, name: { color: '#fff', fontWeight: '700', marginLeft: 10, flex: 1 }, close: { color: '#fff', fontSize: 20, padding: 5 }, caption: { position: 'absolute', bottom: 80, left: 20, right: 20, color: '#fff', fontSize: 16, fontWeight: '500' }, reactions: { position: 'absolute', bottom: 30, left: 20, flexDirection: 'row', gap: 20 }, emoji: { fontSize: 28 } });
