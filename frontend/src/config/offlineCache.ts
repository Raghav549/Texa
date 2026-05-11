import * as FileSystem from 'expo-file-system';
import AsyncStorage from '@react-native-async-storage/async-storage';
const CACHE_DIR = FileSystem.cacheDirectory + 'texa_offline/';
export async function cacheAsset(uri: string) {
  try {
    if (!uri) return;
    const name = uri.split('/').pop();
    const local = CACHE_DIR + name;
    const info = await FileSystem.getInfoAsync(local);
    if (!info.exists) await FileSystem.downloadAsync(uri, local);
    return local;
  } catch { return uri; }
}
export async function queueOfflineAction(action: string, payload: any) {
  const queue = JSON.parse(await AsyncStorage.getItem('offline_queue') || '[]');
  queue.push({ action, payload, ts: Date.now() });
  await AsyncStorage.setItem('offline_queue', JSON.stringify(queue));
}
export async function flushOfflineQueue() {
  const queue = JSON.parse(await AsyncStorage.getItem('offline_queue') || '[]');
  if (queue.length === 0) return [];
  const pending = [...queue];
  await AsyncStorage.removeItem('offline_queue');
  return pending;
}
