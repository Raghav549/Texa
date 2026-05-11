import React, { useRef, useState, useEffect } from 'react';
import { View, FlatList, Dimensions, Text, TouchableOpacity, Image, Animated, Share, StyleSheet } from 'react-native';
import { Video } from 'expo-av';
import { theme } from '../theme';
import { api } from '../api/client';
export default function ReelFeedVertical({ data }: any) {
  const [viewable, setViewable] = useState<any | null>(null);
  const onViewRef = useRef(({ viewableItems }: any) => { if (viewableItems[0]) setViewable(viewableItems[0].item); });
  const like = async (id: string) => await api.post(`/reels/${id}/like`);
  const share = async (reel: any) => {
    try { await Share.share({ message: `Check this reel on Texa: @${reel.author.username}`, url: reel.videoUrl }); } catch {}
  };
  return (
    <FlatList
      data={data} keyExtractor={r => r.id} pagingEnabled showsVerticalScrollIndicator={false}
      onViewableItemsChanged={onViewRef} viewabilityConfig={{ itemVisiblePercentThreshold: 70 }}
      renderItem={({ item }) => (
        <View style={styles.reel}>
          <Video source={{ uri: item.videoUrl }} style={styles.video} shouldPlay={viewable?.id === item.id} isLooping isMuted={false} resizeMode="cover" />
          <View style={styles.overlay}>
            <Image source={{ uri: item.author.avatarUrl }} style={styles.avatar} />
            <Text style={styles.name}>@{item.author.username}</Text>
            <Text style={styles.caption}>{item.caption}</Text>
            <View style={styles.actions}>
              <TouchableOpacity onPress={() => like(item.id)}><Text style={styles.action}>❤️ {item.likes?.length || 0}</Text></TouchableOpacity>
              <TouchableOpacity><Text style={styles.action}>💬</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => share(item)}><Text style={styles.action}>↗️</Text></TouchableOpacity>
              <Text style={styles.insight}>{item.views} views</Text>
            </View>
          </View>
        </View>
      )}
    />
  );
}
const styles = StyleSheet.create({ reel: { width: Dimensions.get('window').width, height: Dimensions.get('window').height, backgroundColor: '#000' }, video: { width: '100%', height: '100%' }, overlay: { position: 'absolute', bottom: 80, left: 20, right: 80 }, avatar: { width: 40, height: 40, borderRadius: 20, marginBottom: 5 }, name: { color: '#fff', fontWeight: '800' }, caption: { color: '#eee', marginVertical: 5 }, actions: { flexDirection: 'row', gap: 20, alignItems: 'center' }, action: { fontSize: 20 }, insight: { color: theme.colors.neon, marginLeft: 'auto', fontSize: 14 } });
