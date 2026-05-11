import axios from 'axios';
import AsyncStorage from '@react-native-async-storage/async-storage';

const api = axios.create({ baseURL: 'https://your-real-server.com/api' });

api.interceptors.request.use(async (config) => {
  const token = await AsyncStorage.getItem('texa_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(res => res, err => Promise.reject(err.response.data));

export default api;
