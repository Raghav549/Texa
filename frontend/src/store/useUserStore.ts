import { create } from 'zustand';

interface UserState {
  user: any | null;
  token: string | null;
  setUser: (u: any) => void;
  setToken: (t: string) => void;
  clear: () => void;
}

export const useUserStore = create<UserState>((set) => ({
  user: null, token: null,
  setUser: (u) => set({ user: u }),
  setToken: (t) => set({ token: t }),
  clear: () => set({ user: null, token: null })
}));
