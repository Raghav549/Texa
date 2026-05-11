import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { api } from '../api/client';
export const useAuth = create((set: any) => ({
  user: null, token: null,
  login: async (email: string, pass: string) => {
    const { data } = await api.post('/auth/login', { email, password: pass });
    await AsyncStorage.setItem('token', data.token);
    set({ user: data.user, token: data.token });
  },
  register: async (form: any) => {
    const fd = new FormData();
    if (form.avatar) fd.append('avatar', form.avatar as any);
    Object.entries(form).forEach(([k,v]) => { if(k!=='avatar') fd.append(k, v as string) });
    const { data } = await api.post('/auth/register', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
    await AsyncStorage.setItem('token', data.token);
    set({ user: data.user, token: data.token });
  },
  logout: async () => { await AsyncStorage.removeItem('token'); set({ user: null, token: null }); }
}));
