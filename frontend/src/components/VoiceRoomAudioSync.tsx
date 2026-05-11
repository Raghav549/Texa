import React, { useState, useEffect, useRef } from 'react';
import { View, Text, Animated, StyleSheet } from 'react-native';
import { Audio } from 'expo-av';
import { theme } from '../theme';
import { ws } from '../api/ws';
export default function VoiceRoomAudioSync({ roomId, queue, isHost }: any) {
  const [sound, setSound] = useState<Audio.Sound | null>(null);
  const [waveform] = useState(Array(10).fill(0).map(() => new Animated.Value(0)));
  useEffect(() => { animateWaveform(); }, []);
  const animateWaveform = () => {
    Animated.loop(Animated.stagger(80, waveform.map(w => Animated.sequence([Animated.timing(w, { toValue: 20, duration: 300, useNativeDriver: true }), Animated.timing(w, { toValue: 0, duration: 300, useNativeDriver: true })])))).start();
  };
  const playTrack = async (uri: string, offset: number = 0) => {
    if (sound) await sound.stopAsync();
    const { sound: s } = await Audio.Sound.createAsync({ uri }, { shouldPlay: true, positionMillis: offset });
    setSound(s);
    if (isHost) (await ws()).emit('music:play', { track: uri, timestamp: Date.now() - offset });
  };
  const nextTrack = () => { if (queue.length > 1) playTrack(queue[1]); };
  return (
    <View style={styles.player}>
      <Text style={styles.title}>NOW PLAYING</Text>
      <View style={styles.wave}><WaveBars bars={waveform} /></View>
      <Text style={styles.track}>Synced for all users</Text>
      {isHost && <View style={styles.ctrls}><Text style={styles.ctrl} onPress={nextTrack}>NEXT</Text><Text style={styles.ctrl}>PAUSE</Text></View>}
    </View>
  );
}
const WaveBars = ({ bars }: any) => (
  <View style={styles.barWrap}>{bars.map((b: any, i: number) => <Animated.View key={i} style={[styles.wb, { height: b, transform: [{ translateY: Animated.add(b.interpolate({ inputRange: [0,20], outputRange: [10,-10] }), -10) }] }]} />)}</View>
);
const styles = StyleSheet.create({ player: { backgroundColor: '#222', padding: 15, borderRadius: 15, marginBottom: 10, alignItems: 'center' }, title: { color: theme.colors.gold, fontWeight: '800', marginBottom: 5 }, wave: { flexDirection: 'row', height: 30, gap: 4, alignItems: 'center' }, wb: { width: 4, backgroundColor: theme.colors.neon, borderRadius: 2 }, track: { color: '#aaa', fontSize: 12, marginTop: 5 }, ctrls: { flexDirection: 'row', gap: 20, marginTop: 10 }, ctrl: { color: '#fff', padding: 8, backgroundColor: '#444', borderRadius: 8 } });
