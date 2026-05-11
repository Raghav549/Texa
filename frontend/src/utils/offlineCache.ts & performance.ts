// performance.ts
import { Image } from 'react-native';
import * as FileSystem from 'expo-file-system';
const CACHE = FileSystem.cacheDirectory + 'texa_media/';
export const preloadImage = async (uri: string) => {
  try {
    const name = uri.split('/').pop() || 'img';
    const local = CACHE + name;
    const info = await FileSystem.getInfoAsync(local);
    if (!info.exists) await FileSystem.downloadAsync(uri, local);
    Image.prefetch(local);
    return local;
  } catch { return uri; }
};

// apiCache.ts
import AsyncStorage from '@react-native-async-storage/async-storage';
export const cacheResponse = async (key: string, data: any, ttl = 300000) => {
  const payload = { data, ts: Date.now() + ttl };
  await AsyncStorage.setItem(`cache:${key}`, JSON.stringify(payload));
};
export const getCachedResponse = async (key: string) => {
  const raw = await AsyncStorage.getItem(`cache:${key}`);
  if (!raw) return null;
  const { data, ts } = JSON.parse(raw);
  return ts > Date.now() ? data : null;
};
