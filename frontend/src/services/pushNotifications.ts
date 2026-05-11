import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { api } from '../api/client';
import { ws } from '../api/ws';
import { useAuth } from '../store/auth';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowAlert: true, shouldPlaySound: true, shouldSetBadge: true }),
});

export async function registerForPushNotificationsAsync() {
  let token;
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('default', {
      name: 'default', importance: Notifications.AndroidImportance.MAX, vibrationPattern: [0, 250, 250, 250], lightColor: '#FF231F7C'
    });
  }
  if (Device.isDevice) {
    const { status: existingStatus } = await Notifications.getPermissionsAsync();
    let finalStatus = existingStatus;
    if (existingStatus !== 'granted') {
      const { status } = await Notifications.requestPermissionsAsync();
      finalStatus = status;
    }
    if (finalStatus !== 'granted') return null;
    token = (await Notifications.getExpoPushTokenAsync({ projectId: 'your-expo-project-id' })).data;
  }
  return token;
}

export async function syncPushToken() {
  const { user } = useAuth.getState();
  if (!user) return;
  const token = await registerForPushNotificationsAsync();
  if (token) {
    await api.post('/notifications/register', { token, platform: Platform.OS });
    console.log('Push token synced to server');
  }
}

export function initNotificationListeners(onNew: (notif: any) => void) {
  Notifications.addNotificationReceivedListener(notification => { onNew(notification.request.content.data); });
  Notifications.addNotificationResponseReceivedListener(response => { onNew(response.notification.request.content.data); });
}
