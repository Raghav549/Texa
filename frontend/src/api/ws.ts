import { io } from 'socket.io-client';
import AsyncStorage from '@react-native-async-storage/async-storage';
export const ws = async () => {
  const token = await AsyncStorage.getItem('token');
  return io(process.env.EXPO_PUBLIC_WS_URL || 'https://api.texa.app', { auth: { token }, transports: ['websocket'] });
};
