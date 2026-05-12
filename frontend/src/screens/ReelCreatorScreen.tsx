import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  TextInput,
  Modal,
  FlatList,
  Alert,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Platform,
  Dimensions,
  ActivityIndicator,
  Pressable
} from 'react-native';
import { Video, ResizeMode, AVPlaybackStatus } from 'expo-av';
import * as ImagePicker from 'expo-image-picker';
import { LinearGradient } from 'expo-linear-gradient';
import { BlurView } from 'expo-blur';
import Svg, { Path, Circle, Rect, Line, Polyline, Polygon } from 'react-native-svg';
import { api } from '../api/client';
import { theme } from '../theme';
import { useAuth } from '../store/auth';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

type Visibility = 'public' | 'followers' | 'private';

type FilterItem = {
  id: string;
  name: string;
  tint: string;
  params: Record<string, number>;
};

type EffectItem = {
  id: string;
  name: string;
  description: string;
};

type MusicItem = {
  id?: string;
  title: string;
  artist: string;
  duration?: number;
};

type IconName =
  | 'back'
  | 'upload'
  | 'video'
  | 'spark'
  | 'music'
  | 'lock'
  | 'users'
  | 'globe'
  | 'close'
  | 'check'
  | 'hash'
  | 'magic'
  | 'timer'
  | 'coin'
  | 'shield'
  | 'eye'
  | 'save'
  | 'draft'
  | 'camera'
  | 'caption'
  | 'settings'
  | 'play'
  | 'pause'
  | 'trash'
  | 'plus';

const FILTERS: FilterItem[] = [
  { id: 'none', name: 'Normal', tint: 'rgba(255,255,255,0)', params: {} },
  { id: 'vivid', name: 'Vivid', tint: 'rgba(255,198,41,0.16)', params: { saturation: 1.32, contrast: 1.12, brightness: 1.02 } },
  { id: 'warm', name: 'Warm', tint: 'rgba(255,122,62,0.18)', params: { temperature: 15, saturation: 1.1, contrast: 1.05 } },
  { id: 'cool', name: 'Cool', tint: 'rgba(59,178,255,0.18)', params: { temperature: -15, contrast: 1.06 } },
  { id: 'mono', name: 'Mono', tint: 'rgba(0,0,0,0.28)', params: { saturation: 0, contrast: 1.16 } },
  { id: 'soft', name: 'Soft', tint: 'rgba(255,255,255,0.16)', params: { brightness: 1.08, contrast: 0.92 } },
  { id: 'cinema', name: 'Cinema', tint: 'rgba(7,7,18,0.24)', params: { contrast: 1.22, saturation: 0.92, vignette: 0.22 } },
  { id: 'neon', name: 'Neon', tint: 'rgba(0,255,204,0.14)', params: { saturation: 1.45, contrast: 1.18, glow: 0.2 } }
];

const EFFECTS: EffectItem[] = [
  { id: 'none', name: 'None', description: 'Clean original motion' },
  { id: 'slowmo', name: 'Slow Motion', description: 'Smooth dramatic speed' },
  { id: 'timelapse', name: 'Time Lapse', description: 'Fast cinematic motion' },
  { id: 'reverse', name: 'Reverse', description: 'Reverse playback effect' },
  { id: 'green_screen', name: 'Green Screen', description: 'Background replacement ready' },
  { id: 'stabilize', name: 'Stabilize', description: 'Reduce shaky movement' },
  { id: 'beauty_light', name: 'Beauty Light', description: 'Soft creator lighting' },
  { id: 'cinematic_crop', name: 'Cinematic Crop', description: 'Premium vertical framing' }
];

const VISIBILITY_OPTIONS: Array<{ id: Visibility; label: string; sub: string; icon: IconName }> = [
  { id: 'public', label: 'Public', sub: 'Everyone can watch', icon: 'globe' },
  { id: 'followers', label: 'Followers', sub: 'Only followers', icon: 'users' },
  { id: 'private', label: 'Private', sub: 'Only you', icon: 'lock' }
];

const MAX_CAPTION = 2200;
const MAX_HASHTAGS = 20;
const MAX_VIDEO_SECONDS = 180;
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

function AppIcon({ name, size = 22, color = '#fff', strokeWidth = 2.2 }: { name: IconName; size?: number; color?: string; strokeWidth?: number }) {
  const common = { stroke: color, strokeWidth, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  if (name === 'back') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M15 18l-6-6 6-6" {...common} /><Path d="M9 12h12" {...common} /></Svg>;
  if (name === 'upload') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M12 16V4" {...common} /><Path d="M7 9l5-5 5 5" {...common} /><Path d="M5 16v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3" {...common} /></Svg>;
  if (name === 'video') return <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="3" y="6" width="13" height="12" rx="3" {...common} /><Path d="M16 10l5-3v10l-5-3z" {...common} /></Svg>;
  if (name === 'spark') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M12 2l1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z" {...common} /><Path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" {...common} /></Svg>;
  if (name === 'music') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M9 18V5l11-2v13" {...common} /><Circle cx="6" cy="18" r="3" {...common} /><Circle cx="17" cy="16" r="3" {...common} /></Svg>;
  if (name === 'lock') return <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="5" y="10" width="14" height="11" rx="3" {...common} /><Path d="M8 10V7a4 4 0 0 1 8 0v3" {...common} /></Svg>;
  if (name === 'users') return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="9" cy="8" r="3" {...common} /><Path d="M3 21a6 6 0 0 1 12 0" {...common} /><Path d="M16 11a3 3 0 1 0 0-6" {...common} /><Path d="M18 21a5 5 0 0 0-3-4.6" {...common} /></Svg>;
  if (name === 'globe') return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="12" cy="12" r="9" {...common} /><Path d="M3 12h18" {...common} /><Path d="M12 3a14 14 0 0 1 0 18" {...common} /><Path d="M12 3a14 14 0 0 0 0 18" {...common} /></Svg>;
  if (name === 'close') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M6 6l12 12" {...common} /><Path d="M18 6L6 18" {...common} /></Svg>;
  if (name === 'check') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M20 6L9 17l-5-5" {...common} /></Svg>;
  if (name === 'hash') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M10 3L8 21" {...common} /><Path d="M16 3l-2 18" {...common} /><Path d="M4 9h17" {...common} /><Path d="M3 15h17" {...common} /></Svg>;
  if (name === 'magic') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 20L20 4" {...common} /><Path d="M14 4l6 6" {...common} /><Path d="M5 5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" {...common} /></Svg>;
  if (name === 'timer') return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="12" cy="13" r="8" {...common} /><Path d="M12 13l3-3" {...common} /><Path d="M9 2h6" {...common} /></Svg>;
  if (name === 'coin') return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="12" cy="12" r="8" {...common} /><Path d="M9 10.5c.6-1 1.6-1.5 3-1.5 1.8 0 3 1 3 2.5S13.8 14 12 14H9" {...common} /><Path d="M9 14h6" {...common} /></Svg>;
  if (name === 'shield') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M12 3l8 3v6c0 5-3.4 8.2-8 9-4.6-.8-8-4-8-9V6z" {...common} /><Path d="M9 12l2 2 4-5" {...common} /></Svg>;
  if (name === 'eye') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" {...common} /><Circle cx="12" cy="12" r="3" {...common} /></Svg>;
  if (name === 'save') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M6 3h12v18l-6-4-6 4z" {...common} /></Svg>;
  if (name === 'draft') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M5 4h10l4 4v12H5z" {...common} /><Path d="M15 4v5h5" {...common} /><Path d="M8 14h8" {...common} /><Path d="M8 17h5" {...common} /></Svg>;
  if (name === 'camera') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 8h4l2-3h4l2 3h4v11H4z" {...common} /><Circle cx="12" cy="14" r="4" {...common} /></Svg>;
  if (name === 'caption') return <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="3" y="5" width="18" height="14" rx="3" {...common} /><Path d="M7 10h10" {...common} /><Path d="M7 14h6" {...common} /></Svg>;
  if (name === 'settings') return <Svg width={size} height={size} viewBox="0 0 24 24"><Circle cx="12" cy="12" r="3" {...common} /><Path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.8 1.8 0 0 0-2.1.2 1.7 1.7 0 0 0-.8 1.7V22H9.3v-.2a1.7 1.7 0 0 0-.8-1.7 1.8 1.8 0 0 0-2.1-.2l-.2.1-2-3.4.1-.1A1.7 1.7 0 0 0 4.6 15 1.7 1.7 0 0 0 3 14H2v-4h1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3.4.2.1a1.8 1.8 0 0 0 2.1-.2 1.7 1.7 0 0 0 .8-1.7V2h5.4v.2a1.7 1.7 0 0 0 .8 1.7 1.8 1.8 0 0 0 2.1.2l.2-.1 2 3.4-.1.1A1.7 1.7 0 0 0 19.4 9 1.7 1.7 0 0 0 21 10h1v4h-1a1.7 1.7 0 0 0-1.6 1z" {...common} /></Svg>;
  if (name === 'play') return <Svg width={size} height={size} viewBox="0 0 24 24"><Polygon points="8,5 19,12 8,19" fill={color} /></Svg>;
  if (name === 'pause') return <Svg width={size} height={size} viewBox="0 0 24 24"><Rect x="7" y="5" width="4" height="14" rx="1" fill={color} /><Rect x="14" y="5" width="4" height="14" rx="1" fill={color} /></Svg>;
  if (name === 'trash') return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M4 7h16" {...common} /><Path d="M9 7V4h6v3" {...common} /><Path d="M7 7l1 14h8l1-14" {...common} /><Path d="M10 11v6" {...common} /><Path d="M14 11v6" {...common} /></Svg>;
  return <Svg width={size} height={size} viewBox="0 0 24 24"><Path d="M12 5v14" {...common} /><Path d="M5 12h14" {...common} /></Svg>;
}

function IconButton({
  icon,
  onPress,
  disabled,
  size = 44,
  iconSize = 21,
  color = '#fff',
  style
}: {
  icon: IconName;
  onPress?: () => void;
  disabled?: boolean;
  size?: number;
  iconSize?: number;
  color?: string;
  style?: any;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  const pressIn = () => Animated.spring(scale, { toValue: 0.92, useNativeDriver: true, speed: 28, bounciness: 8 }).start();
  const pressOut = () => Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 28, bounciness: 8 }).start();
  return (
    <Animated.View style={[{ transform: [{ scale }] }, disabled && { opacity: 0.45 }]}>
      <TouchableOpacity
        activeOpacity={0.88}
        disabled={disabled}
        onPress={onPress}
        onPressIn={pressIn}
        onPressOut={pressOut}
        style={[styles.iconButton, { width: size, height: size, borderRadius: size / 2 }, style]}
      >
        <AppIcon name={icon} size={iconSize} color={color} />
      </TouchableOpacity>
    </Animated.View>
  );
}

function SwitchControl({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const anim = useRef(new Animated.Value(value ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(anim, { toValue: value ? 1 : 0, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [value, anim]);
  const translateX = anim.interpolate({ inputRange: [0, 1], outputRange: [2, 22] });
  const bg = anim.interpolate({ inputRange: [0, 1], outputRange: ['#2A2A33', theme.colors.neon || '#00F5D4'] });
  return (
    <TouchableOpacity activeOpacity={0.9} onPress={() => onChange(!value)}>
      <Animated.View style={[styles.switchTrack, { backgroundColor: bg }]}>
        <Animated.View style={[styles.switchKnob, { transform: [{ translateX }] }]} />
      </Animated.View>
    </TouchableOpacity>
  );
}

function SectionTitle({ icon, title, right }: { icon: IconName; title: string; right?: React.ReactNode }) {
  return (
    <View style={styles.sectionTitleRow}>
      <View style={styles.sectionTitleLeft}>
        <View style={styles.sectionIconWrap}>
          <AppIcon name={icon} size={17} color={theme.colors.gold || '#FFD166'} />
        </View>
        <Text style={styles.sectionTitle}>{title}</Text>
      </View>
      {right}
    </View>
  );
}

export default function ReelCreatorScreen({ navigation, route }: any) {
  const { user } = useAuth();
  const [videoUri, setVideoUri] = useState<string | null>(null);
  const [videoAsset, setVideoAsset] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [caption, setCaption] = useState('');
  const [hashtagInput, setHashtagInput] = useState('');
  const [hashtags, setHashtags] = useState<string[]>([]);
  const [selectedFilter, setSelectedFilter] = useState<FilterItem>(FILTERS[0]);
  const [selectedEffect, setSelectedEffect] = useState<EffectItem>(EFFECTS[0]);
  const [music, setMusic] = useState<MusicItem | null>(route?.params?.music || null);
  const [visibility, setVisibility] = useState<Visibility>('public');
  const [allowDuets, setAllowDuets] = useState(true);
  const [allowStitches, setAllowStitches] = useState(true);
  const [allowComments, setAllowComments] = useState(true);
  const [tipEnabled, setTipEnabled] = useState(true);
  const [ageRestricted, setAgeRestricted] = useState(false);
  const [contentWarning, setContentWarning] = useState('');
  const [category, setCategory] = useState('entertainment');
  const [language, setLanguage] = useState('en');
  const [isDraft, setIsDraft] = useState(false);
  const [scheduledFor, setScheduledFor] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [processingVisible, setProcessingVisible] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const videoRef = useRef<Video | null>(null);
  const pulse = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 1200, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
      ])
    ).start();
  }, [pulse]);

  useEffect(() => {
    Animated.timing(progressAnim, { toValue: uploadProgress, duration: 250, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
  }, [uploadProgress, progressAnim]);

  useEffect(() => {
    if (route?.params?.music) setMusic(route.params.music);
  }, [route?.params?.music]);

  const derivedHashtags = useMemo(() => {
    const fromCaption = Array.from(new Set((caption.match(/#[\p{L}\p{N}_]+/gu) || []).map(t => t.replace('#', '').toLowerCase())));
    return Array.from(new Set([...hashtags, ...fromCaption])).slice(0, MAX_HASHTAGS);
  }, [caption, hashtags]);

  const qualityScore = useMemo(() => {
    let score = 0;
    if (videoUri) score += 30;
    if (caption.trim().length >= 12) score += 18;
    if (derivedHashtags.length >= 2) score += 14;
    if (music) score += 12;
    if (selectedFilter.id !== 'none') score += 8;
    if (selectedEffect.id !== 'none') score += 8;
    if (allowComments) score += 5;
    if (visibility === 'public') score += 5;
    return Math.min(100, score);
  }, [videoUri, caption, derivedHashtags.length, music, selectedFilter.id, selectedEffect.id, allowComments, visibility]);

  const uploadWidth = progressAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] });
  const pulseScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const pulseOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });

  const sanitizeTag = (value: string) => value.replace(/#/g, '').replace(/[^\p{L}\p{N}_]/gu, '').trim().toLowerCase();

  const validateVideoAsset = (asset: ImagePicker.ImagePickerAsset) => {
    const errors: string[] = [];
    if (asset.duration && asset.duration / 1000 > MAX_VIDEO_SECONDS) errors.push('Video duration max 3 minutes allowed');
    if (asset.fileSize && asset.fileSize > MAX_VIDEO_BYTES) errors.push('Video size max 500MB allowed');
    return errors;
  };

  const pickVideo = async () => {
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission required', 'Please allow gallery access to select a reel video.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Videos,
      quality: 1,
      allowsEditing: true,
      aspect: [9, 16],
      videoMaxDuration: MAX_VIDEO_SECONDS
    });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      const errors = validateVideoAsset(asset);
      setValidationErrors(errors);
      if (errors.length) {
        Alert.alert('Video check', errors.join('\n'));
        return;
      }
      setVideoAsset(asset);
      setVideoUri(asset.uri);
      setIsPlaying(true);
      setTimeout(() => videoRef.current?.playAsync?.(), 250);
    }
  };

  const togglePreview = async () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      await videoRef.current.pauseAsync();
      setIsPlaying(false);
    } else {
      await videoRef.current.playAsync();
      setIsPlaying(true);
    }
  };

  const addHashtag = (raw: string) => {
    const tag = sanitizeTag(raw);
    if (!tag) return;
    if (hashtags.includes(tag)) return setHashtagInput('');
    if (derivedHashtags.length >= MAX_HASHTAGS) return Alert.alert('Limit reached', `Maximum ${MAX_HASHTAGS} hashtags allowed.`);
    setHashtags(prev => [...prev, tag]);
    setHashtagInput('');
  };

  const removeHashtag = (tag: string) => setHashtags(prev => prev.filter(t => t !== tag));

  const autoImproveCaption = () => {
    const base = caption.trim();
    const tags = derivedHashtags.length ? derivedHashtags.slice(0, 4).map(t => `#${t}`).join(' ') : '#reels #viral';
    const improved = base.length ? `${base}\n\n${tags}` : `New drop is live. Watch till the end.\n\n${tags}`;
    setCaption(improved.slice(0, MAX_CAPTION));
  };

  const validateBeforeUpload = (draftMode = false) => {
    const errors: string[] = [];
    if (!videoUri) errors.push('Select a video first');
    if (!draftMode && caption.trim().length < 3) errors.push('Add a caption with at least 3 characters');
    if (caption.length > MAX_CAPTION) errors.push(`Caption max ${MAX_CAPTION} characters`);
    if (scheduledFor.trim()) {
      const date = new Date(scheduledFor);
      if (Number.isNaN(date.getTime()) || date.getTime() <= Date.now()) errors.push('Schedule time must be a valid future date');
    }
    setValidationErrors(errors);
    return errors;
  };

  const buildPayload = (draftMode = false) => {
    const fd = new FormData();
    fd.append('video', {
      uri: videoUri!,
      name: `reel_${user?.id || 'creator'}_${Date.now()}.mp4`,
      type: videoAsset?.mimeType || 'video/mp4'
    } as any);
    fd.append('caption', caption.trim());
    fd.append('hashtags', JSON.stringify(derivedHashtags));
    fd.append('filters', JSON.stringify(selectedFilter.params));
    fd.append('effects', JSON.stringify(selectedEffect.id === 'none' ? [] : [selectedEffect.id]));
    fd.append('visibility', visibility);
    fd.append('allowDuets', String(allowDuets));
    fd.append('allowStitches', String(allowStitches));
    fd.append('allowComments', String(allowComments));
    fd.append('tipEnabled', String(tipEnabled));
    fd.append('ageRestricted', String(ageRestricted));
    fd.append('contentWarning', contentWarning.trim());
    fd.append('category', category.trim() || 'entertainment');
    fd.append('language', language.trim() || 'en');
    fd.append('isDraft', String(draftMode || isDraft));
    if (scheduledFor.trim()) fd.append('scheduledFor', new Date(scheduledFor).toISOString());
    if (music) fd.append('music', JSON.stringify(music));
    return fd;
  };

  const uploadReel = async (draftMode = false) => {
    const errors = validateBeforeUpload(draftMode);
    if (errors.length) return Alert.alert('Fix these first', errors.join('\n'));
    setIsUploading(true);
    setProcessingVisible(false);
    setUploadProgress(0);
    try {
      const fd = buildPayload(draftMode);
      const { data } = await api.post('/reels', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (progress: any) => {
          if (progress.total) {
            const percent = Math.min(100, Math.round((progress.loaded * 100) / progress.total));
            setUploadProgress(percent);
            if (percent >= 100) setProcessingVisible(true);
          }
        }
      });
      if (data?.status === 'processing' || data?.reelId) {
        Alert.alert(draftMode ? 'Draft saved' : 'Reel processing', draftMode ? 'Your reel draft has been saved.' : 'Your reel is being processed. You will be notified when it goes live.');
        navigation.goBack();
      } else {
        Alert.alert('Done', draftMode ? 'Draft saved successfully.' : 'Reel published successfully.');
        navigation.goBack();
      }
    } catch (err: any) {
      Alert.alert('Upload failed', err?.response?.data?.error || err?.message || 'Please try again');
    } finally {
      setIsUploading(false);
      setProcessingVisible(false);
      setUploadProgress(0);
    }
  };

  const renderFilter = ({ item }: { item: FilterItem }) => {
    const active = selectedFilter.id === item.id;
    return (
      <TouchableOpacity activeOpacity={0.88} onPress={() => setSelectedFilter(item)} style={[styles.filterCard, active && styles.activeCard]}>
        <LinearGradient colors={['#20202A', '#111118']} style={styles.filterPreview}>
          <View style={[styles.filterTint, { backgroundColor: item.tint }]} />
          {active && <View style={styles.activeCheck}><AppIcon name="check" size={13} color="#000" strokeWidth={3} /></View>}
        </LinearGradient>
        <Text style={[styles.optionName, active && styles.activeText]}>{item.name}</Text>
      </TouchableOpacity>
    );
  };

  const renderEffect = ({ item }: { item: EffectItem }) => {
    const active = selectedEffect.id === item.id;
    return (
      <TouchableOpacity activeOpacity={0.88} onPress={() => setSelectedEffect(item)} style={[styles.effectCard, active && styles.activeCard]}>
        <View style={[styles.effectIcon, active && styles.effectIconActive]}>
          <AppIcon name={item.id === 'none' ? 'spark' : item.id === 'slowmo' || item.id === 'timelapse' ? 'timer' : item.id === 'green_screen' ? 'video' : 'magic'} size={18} color={active ? '#000' : theme.colors.gold || '#FFD166'} />
        </View>
        <Text style={[styles.effectTitle, active && styles.activeText]}>{item.name}</Text>
        <Text style={styles.effectSub} numberOfLines={2}>{item.description}</Text>
      </TouchableOpacity>
    );
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={styles.container}>
      <View style={styles.topBar}>
        <IconButton icon="back" onPress={() => navigation.goBack()} />
        <View style={styles.topTitleWrap}>
          <Text style={styles.topTitle}>Create Reel</Text>
          <Text style={styles.topSub}>{videoUri ? 'Preview and publish' : 'Select a vertical video'}</Text>
        </View>
        <IconButton icon="draft" onPress={() => uploadReel(true)} disabled={!videoUri || isUploading} />
      </View>

      <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollContent}>
        <View style={styles.previewShell}>
          <LinearGradient colors={['#181820', '#07070A']} style={styles.previewFrame}>
            {videoUri ? (
              <>
                <Video
                  ref={ref => {
                    videoRef.current = ref;
                  }}
                  source={{ uri: videoUri }}
                  style={styles.previewVideo}
                  resizeMode={ResizeMode.COVER}
                  useNativeControls={false}
                  isLooping
                  shouldPlay={isPlaying}
                  onPlaybackStatusUpdate={(status: AVPlaybackStatus) => {
                    if (!status.isLoaded) return;
                    if (status.didJustFinish) setIsPlaying(false);
                  }}
                />
                <View pointerEvents="none" style={[styles.filterOverlay, { backgroundColor: selectedFilter.tint }]} />
                <LinearGradient colors={['rgba(0,0,0,0.58)', 'rgba(0,0,0,0)', 'rgba(0,0,0,0.72)']} style={styles.previewGradient} />
                <TouchableOpacity activeOpacity={0.9} onPress={togglePreview} style={styles.playOverlay}>
                  <BlurView intensity={22} tint="dark" style={styles.playButton}>
                    <AppIcon name={isPlaying ? 'pause' : 'play'} size={24} color="#fff" />
                  </BlurView>
                </TouchableOpacity>
                <View style={styles.previewCaptionBox}>
                  <Text style={styles.previewUsername}>@{user?.username || 'creator'}</Text>
                  <Text style={styles.previewCaption} numberOfLines={2}>{caption.trim() || 'Your caption preview will appear here'}</Text>
                  {!!derivedHashtags.length && <Text style={styles.previewTags} numberOfLines={1}>{derivedHashtags.slice(0, 5).map(t => `#${t}`).join(' ')}</Text>}
                </View>
                <TouchableOpacity activeOpacity={0.9} onPress={pickVideo} style={styles.replaceButton}>
                  <AppIcon name="camera" size={16} color="#000" />
                  <Text style={styles.replaceText}>Replace</Text>
                </TouchableOpacity>
              </>
            ) : (
              <TouchableOpacity activeOpacity={0.92} onPress={pickVideo} style={styles.placeholder}>
                <Animated.View style={{ transform: [{ scale: pulseScale }], opacity: pulseOpacity }}>
                  <LinearGradient colors={[theme.colors.gold || '#FFD166', theme.colors.neon || '#00F5D4']} style={styles.selectOrb}>
                    <AppIcon name="upload" size={34} color="#000" strokeWidth={2.6} />
                  </LinearGradient>
                </Animated.View>
                <Text style={styles.placeholderText}>Select Video</Text>
                <Text style={styles.placeholderSub}>9:16 vertical • max 3 min • max 500MB</Text>
              </TouchableOpacity>
            )}
          </LinearGradient>
          <View style={styles.scoreCard}>
            <View>
              <Text style={styles.scoreLabel}>Creator Score</Text>
              <Text style={styles.scoreSub}>{qualityScore >= 80 ? 'Strong publish quality' : qualityScore >= 50 ? 'Good, add more details' : 'Add caption, music and tags'}</Text>
            </View>
            <View style={styles.scoreCircle}>
              <Text style={styles.scoreText}>{qualityScore}</Text>
            </View>
          </View>
        </View>

        {!!validationErrors.length && (
          <View style={styles.errorBox}>
            {validationErrors.map(err => <Text key={err} style={styles.errorText}>• {err}</Text>)}
          </View>
        )}

        <View style={styles.panel}>
          <SectionTitle icon="caption" title="Caption" right={<Text style={styles.counter}>{caption.length}/{MAX_CAPTION}</Text>} />
          <TextInput
            placeholder="Write a caption that hooks people..."
            placeholderTextColor="#777"
            value={caption}
            onChangeText={text => setCaption(text.slice(0, MAX_CAPTION))}
            style={styles.captionInput}
            multiline
          />
          <View style={styles.quickRow}>
            <TouchableOpacity activeOpacity={0.88} onPress={autoImproveCaption} style={styles.quickButton}>
              <AppIcon name="spark" size={15} color="#000" />
              <Text style={styles.quickText}>Auto polish</Text>
            </TouchableOpacity>
            <TouchableOpacity activeOpacity={0.88} onPress={() => setCaption('')} style={styles.ghostButton}>
              <AppIcon name="trash" size={15} color="#fff" />
              <Text style={styles.ghostText}>Clear</Text>
            </TouchableOpacity>
          </View>
        </View>

        <View style={styles.panel}>
          <SectionTitle icon="hash" title="Hashtags" right={<Text style={styles.counter}>{derivedHashtags.length}/{MAX_HASHTAGS}</Text>} />
          <View style={styles.tagInputWrap}>
            <TextInput
              placeholder="Add hashtag"
              placeholderTextColor="#777"
              value={hashtagInput}
              onChangeText={setHashtagInput}
              onSubmitEditing={() => addHashtag(hashtagInput)}
              style={styles.tagInput}
              autoCapitalize="none"
            />
            <IconButton icon="plus" size={36} iconSize={18} color="#000" onPress={() => addHashtag(hashtagInput)} style={styles.addTagButton} />
          </View>
          <View style={styles.tagsWrap}>
            {derivedHashtags.map(tag => (
              <TouchableOpacity key={tag} activeOpacity={0.86} onPress={() => removeHashtag(tag)} style={styles.tagChip}>
                <Text style={styles.tagChipText}>#{tag}</Text>
                <AppIcon name="close" size={12} color="#000" strokeWidth={3} />
              </TouchableOpacity>
            ))}
            {!derivedHashtags.length && <Text style={styles.emptyHint}>Caption hashtags are detected automatically.</Text>}
          </View>
        </View>

        <View style={styles.panel}>
          <SectionTitle icon="magic" title="Filters" />
          <FlatList horizontal data={FILTERS} keyExtractor={item => item.id} renderItem={renderFilter} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalList} />
        </View>

        <View style={styles.panel}>
          <SectionTitle icon="spark" title="Effects" />
          <FlatList horizontal data={EFFECTS} keyExtractor={item => item.id} renderItem={renderEffect} showsHorizontalScrollIndicator={false} contentContainerStyle={styles.horizontalList} />
        </View>

        <View style={styles.panel}>
          <SectionTitle icon="music" title="Soundtrack" />
          <TouchableOpacity activeOpacity={0.9} style={styles.musicCard} onPress={() => navigation.navigate('MusicPicker', { returnTo: 'ReelCreator' })}>
            <View style={styles.musicIconBox}>
              <AppIcon name="music" size={22} color="#000" />
            </View>
            <View style={styles.musicInfo}>
              <Text style={styles.musicTitle}>{music ? music.title : 'Add soundtrack'}</Text>
              <Text style={styles.musicSub}>{music ? music.artist : 'Choose music for better reach'}</Text>
            </View>
            {music ? (
              <TouchableOpacity onPress={() => setMusic(null)} style={styles.smallClose}>
                <AppIcon name="close" size={16} color="#fff" />
              </TouchableOpacity>
            ) : (
              <AppIcon name="back" size={18} color="#777" />
            )}
          </TouchableOpacity>
        </View>

        <View style={styles.panel}>
          <SectionTitle icon="eye" title="Visibility" />
          <View style={styles.visibilityGrid}>
            {VISIBILITY_OPTIONS.map(opt => {
              const active = visibility === opt.id;
              return (
                <TouchableOpacity key={opt.id} activeOpacity={0.9} onPress={() => setVisibility(opt.id)} style={[styles.visibilityCard, active && styles.visibilityActive]}>
                  <View style={[styles.visibilityIcon, active && styles.visibilityIconActive]}>
                    <AppIcon name={opt.icon} size={18} color={active ? '#000' : '#fff'} />
                  </View>
                  <Text style={[styles.visibilityTitle, active && styles.activeText]}>{opt.label}</Text>
                  <Text style={styles.visibilitySub}>{opt.sub}</Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.panel}>
          <TouchableOpacity activeOpacity={0.9} onPress={() => setShowAdvanced(!showAdvanced)} style={styles.advancedHeader}>
            <SectionTitle icon="settings" title="Advanced controls" />
            <AppIcon name={showAdvanced ? 'close' : 'plus'} size={18} color="#fff" />
          </TouchableOpacity>

          {showAdvanced && (
            <View style={styles.advancedBody}>
              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <AppIcon name="users" size={18} color={theme.colors.gold || '#FFD166'} />
                  <View>
                    <Text style={styles.settingTitle}>Allow Duets</Text>
                    <Text style={styles.settingSub}>Creators can remix side-by-side</Text>
                  </View>
                </View>
                <SwitchControl value={allowDuets} onChange={setAllowDuets} />
              </View>

              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <AppIcon name="video" size={18} color={theme.colors.gold || '#FFD166'} />
                  <View>
                    <Text style={styles.settingTitle}>Allow Stitches</Text>
                    <Text style={styles.settingSub}>Others can use a short clip</Text>
                  </View>
                </View>
                <SwitchControl value={allowStitches} onChange={setAllowStitches} />
              </View>

              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <AppIcon name="caption" size={18} color={theme.colors.gold || '#FFD166'} />
                  <View>
                    <Text style={styles.settingTitle}>Allow Comments</Text>
                    <Text style={styles.settingSub}>Enable public conversation</Text>
                  </View>
                </View>
                <SwitchControl value={allowComments} onChange={setAllowComments} />
              </View>

              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <AppIcon name="coin" size={18} color={theme.colors.gold || '#FFD166'} />
                  <View>
                    <Text style={styles.settingTitle}>Enable Tips</Text>
                    <Text style={styles.settingSub}>Let viewers support you</Text>
                  </View>
                </View>
                <SwitchControl value={tipEnabled} onChange={setTipEnabled} />
              </View>

              <View style={styles.settingRow}>
                <View style={styles.settingLeft}>
                  <AppIcon name="shield" size={18} color={theme.colors.gold || '#FFD166'} />
                  <View>
                    <Text style={styles.settingTitle}>Age Restricted</Text>
                    <Text style={styles.settingSub}>Limit sensitive content reach</Text>
                  </View>
                </View>
                <SwitchControl value={ageRestricted} onChange={setAgeRestricted} />
              </View>

              <View style={styles.formGrid}>
                <View style={styles.formField}>
                  <Text style={styles.fieldLabel}>Category</Text>
                  <TextInput value={category} onChangeText={setCategory} placeholder="entertainment" placeholderTextColor="#777" style={styles.smallInput} />
                </View>
                <View style={styles.formField}>
                  <Text style={styles.fieldLabel}>Language</Text>
                  <TextInput value={language} onChangeText={setLanguage} placeholder="en" placeholderTextColor="#777" style={styles.smallInput} autoCapitalize="none" />
                </View>
              </View>

              <Text style={styles.fieldLabel}>Content warning</Text>
              <TextInput value={contentWarning} onChangeText={setContentWarning} placeholder="Optional warning for viewers" placeholderTextColor="#777" style={styles.smallInput} />

              <Text style={styles.fieldLabel}>Schedule publish</Text>
              <TextInput value={scheduledFor} onChangeText={setScheduledFor} placeholder="2026-05-12T18:30:00" placeholderTextColor="#777" style={styles.smallInput} autoCapitalize="none" />
            </View>
          )}
        </View>

        <View style={styles.bottomSpacer} />
      </ScrollView>

      <BlurView intensity={28} tint="dark" style={styles.footer}>
        {isUploading && (
          <View style={styles.uploadProgressWrap}>
            <Animated.View style={[styles.uploadProgressFill, { width: uploadWidth }]} />
          </View>
        )}
        <View style={styles.footerRow}>
          <TouchableOpacity activeOpacity={0.9} disabled={!videoUri || isUploading} onPress={() => uploadReel(true)} style={[styles.footerSecondary, (!videoUri || isUploading) && styles.disabled]}>
            <AppIcon name="save" size={18} color="#fff" />
            <Text style={styles.footerSecondaryText}>Draft</Text>
          </TouchableOpacity>
          <TouchableOpacity activeOpacity={0.92} disabled={!videoUri || isUploading} onPress={() => uploadReel(false)} style={[styles.publishButton, (!videoUri || isUploading) && styles.disabled]}>
            <LinearGradient colors={[theme.colors.gold || '#FFD166', theme.colors.neon || '#00F5D4']} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={styles.publishGradient}>
              {isUploading ? <ActivityIndicator color="#000" /> : <AppIcon name="upload" size={19} color="#000" strokeWidth={2.6} />}
              <Text style={styles.publishText}>{isUploading ? `Uploading ${uploadProgress}%` : scheduledFor.trim() ? 'Schedule Reel' : 'Publish Reel'}</Text>
            </LinearGradient>
          </TouchableOpacity>
        </View>
      </BlurView>

      <Modal visible={processingVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalCard}>
            <LinearGradient colors={[theme.colors.gold || '#FFD166', theme.colors.neon || '#00F5D4']} style={styles.modalOrb}>
              <AppIcon name="spark" size={30} color="#000" />
            </LinearGradient>
            <Text style={styles.modalTitle}>Processing Your Reel</Text>
            <Text style={styles.modalText}>Applying effects, generating thumbnails, optimizing streaming quality and preparing moderation checks.</Text>
            <View style={styles.modalProgress}>
              <View style={styles.modalProgressFill} />
            </View>
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#050507' },
  topBar: { height: 74, paddingHorizontal: 14, paddingTop: Platform.OS === 'ios' ? 18 : 10, flexDirection: 'row', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.08)' },
  iconButton: { alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  topTitleWrap: { flex: 1, alignItems: 'center' },
  topTitle: { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 0.2 },
  topSub: { color: '#8D8D99', fontSize: 12, marginTop: 2 },
  scrollContent: { paddingBottom: 126 },
  previewShell: { padding: 14 },
  previewFrame: { height: 470, borderRadius: 30, overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  previewVideo: { width: '100%', height: '100%' },
  filterOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  previewGradient: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 },
  playOverlay: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' },
  playButton: { width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', overflow: 'hidden', borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)' },
  previewCaptionBox: { position: 'absolute', left: 18, right: 86, bottom: 20 },
  previewUsername: { color: '#fff', fontSize: 14, fontWeight: '900', marginBottom: 5 },
  previewCaption: { color: '#fff', fontSize: 14, lineHeight: 19, fontWeight: '600' },
  previewTags: { color: theme.colors.neon || '#00F5D4', fontSize: 13, marginTop: 6, fontWeight: '800' },
  replaceButton: { position: 'absolute', right: 16, top: 16, flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.gold || '#FFD166', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999 },
  replaceText: { color: '#000', fontSize: 12, fontWeight: '900' },
  placeholder: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  selectOrb: { width: 92, height: 92, borderRadius: 46, alignItems: 'center', justifyContent: 'center', marginBottom: 18 },
  placeholderText: { color: '#fff', fontSize: 22, fontWeight: '900' },
  placeholderSub: { color: '#8D8D99', marginTop: 8, fontSize: 13, textAlign: 'center' },
  scoreCard: { marginTop: 12, padding: 14, borderRadius: 22, backgroundColor: '#101018', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  scoreLabel: { color: '#fff', fontSize: 15, fontWeight: '900' },
  scoreSub: { color: '#8D8D99', fontSize: 12, marginTop: 3 },
  scoreCircle: { width: 48, height: 48, borderRadius: 24, backgroundColor: theme.colors.gold || '#FFD166', alignItems: 'center', justifyContent: 'center' },
  scoreText: { color: '#000', fontSize: 16, fontWeight: '900' },
  errorBox: { marginHorizontal: 14, marginBottom: 12, padding: 12, borderRadius: 16, backgroundColor: 'rgba(255,70,70,0.12)', borderWidth: 1, borderColor: 'rgba(255,70,70,0.25)' },
  errorText: { color: '#FF8A8A', fontSize: 12, fontWeight: '700', marginVertical: 2 },
  panel: { marginHorizontal: 14, marginBottom: 14, padding: 14, borderRadius: 24, backgroundColor: '#101018', borderWidth: 1, borderColor: 'rgba(255,255,255,0.08)' },
  sectionTitleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  sectionTitleLeft: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  sectionIconWrap: { width: 30, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  sectionTitle: { color: '#fff', fontSize: 15, fontWeight: '900' },
  counter: { color: '#777', fontSize: 12, fontWeight: '800' },
  captionInput: { minHeight: 96, maxHeight: 160, color: '#fff', backgroundColor: '#171721', borderRadius: 18, padding: 14, fontSize: 14, lineHeight: 20, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', textAlignVertical: 'top' },
  quickRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  quickButton: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: theme.colors.gold || '#FFD166', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 999 },
  quickText: { color: '#000', fontSize: 12, fontWeight: '900' },
  ghostButton: { flexDirection: 'row', alignItems: 'center', gap: 7, backgroundColor: 'rgba(255,255,255,0.08)', paddingHorizontal: 13, paddingVertical: 10, borderRadius: 999 },
  ghostText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  tagInputWrap: { flexDirection: 'row', alignItems: 'center', gap: 10, backgroundColor: '#171721', borderRadius: 18, paddingLeft: 14, paddingRight: 6, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  tagInput: { flex: 1, color: '#fff', paddingVertical: 12, fontSize: 14 },
  addTagButton: { backgroundColor: theme.colors.gold || '#FFD166', borderWidth: 0 },
  tagsWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  tagChip: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: theme.colors.neon || '#00F5D4', paddingHorizontal: 11, paddingVertical: 7, borderRadius: 999 },
  tagChipText: { color: '#000', fontSize: 12, fontWeight: '900' },
  emptyHint: { color: '#777', fontSize: 12, fontWeight: '700' },
  horizontalList: { paddingRight: 8 },
  filterCard: { width: 86, marginRight: 10, alignItems: 'center', padding: 8, borderRadius: 18, backgroundColor: '#171721', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  activeCard: { borderColor: theme.colors.gold || '#FFD166', backgroundColor: 'rgba(255,209,102,0.1)' },
  filterPreview: { width: 62, height: 82, borderRadius: 16, overflow: 'hidden', marginBottom: 8 },
  filterTint: { flex: 1 },
  activeCheck: { position: 'absolute', right: 5, top: 5, width: 20, height: 20, borderRadius: 10, backgroundColor: theme.colors.gold || '#FFD166', alignItems: 'center', justifyContent: 'center' },
  optionName: { color: '#BEBEC8', fontSize: 12, fontWeight: '800' },
  activeText: { color: theme.colors.gold || '#FFD166' },
  effectCard: { width: 132, minHeight: 118, marginRight: 10, padding: 12, borderRadius: 20, backgroundColor: '#171721', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)' },
  effectIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 10 },
  effectIconActive: { backgroundColor: theme.colors.gold || '#FFD166' },
  effectTitle: { color: '#fff', fontSize: 13, fontWeight: '900', marginBottom: 4 },
  effectSub: { color: '#777', fontSize: 11, lineHeight: 15, fontWeight: '600' },
  musicCard: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#171721', borderRadius: 20, padding: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)' },
  musicIconBox: { width: 46, height: 46, borderRadius: 23, backgroundColor: theme.colors.gold || '#FFD166', alignItems: 'center', justifyContent: 'center', marginRight: 12 },
  musicInfo: { flex: 1 },
  musicTitle: { color: '#fff', fontSize: 14, fontWeight: '900' },
  musicSub: { color: '#777', fontSize: 12, marginTop: 3, fontWeight: '700' },
  smallClose: { width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center' },
  visibilityGrid: { flexDirection: 'row', gap: 9 },
  visibilityCard: { flex: 1, padding: 10, borderRadius: 18, backgroundColor: '#171721', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', alignItems: 'center' },
  visibilityActive: { borderColor: theme.colors.gold || '#FFD166', backgroundColor: 'rgba(255,209,102,0.1)' },
  visibilityIcon: { width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.08)', alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  visibilityIconActive: { backgroundColor: theme.colors.gold || '#FFD166' },
  visibilityTitle: { color: '#fff', fontSize: 12, fontWeight: '900' },
  visibilitySub: { color: '#777', fontSize: 10, marginTop: 3, textAlign: 'center', fontWeight: '700' },
  advancedHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  advancedBody: { marginTop: 2 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 13, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.06)' },
  settingLeft: { flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1, paddingRight: 10 },
  settingTitle: { color: '#fff', fontSize: 13, fontWeight: '900' },
  settingSub: { color: '#777', fontSize: 11, marginTop: 2, fontWeight: '600' },
  switchTrack: { width: 48, height: 28, borderRadius: 14, justifyContent: 'center' },
  switchKnob: { width: 24, height: 24, borderRadius: 12, backgroundColor: '#fff' },
  formGrid: { flexDirection: 'row', gap: 10, marginTop: 14 },
  formField: { flex: 1 },
  fieldLabel: { color: '#9B9BA6', fontSize: 12, fontWeight: '800', marginTop: 12, marginBottom: 7 },
  smallInput: { color: '#fff', backgroundColor: '#171721', borderRadius: 16, paddingHorizontal: 13, paddingVertical: 12, borderWidth: 1, borderColor: 'rgba(255,255,255,0.07)', fontSize: 13, fontWeight: '700' },
  bottomSpacer: { height: 20 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingTop: 12, paddingBottom: Platform.OS === 'ios' ? 28 : 14, borderTopWidth: 1, borderTopColor: 'rgba(255,255,255,0.1)', overflow: 'hidden' },
  uploadProgressWrap: { height: 4, backgroundColor: 'rgba(255,255,255,0.1)', borderRadius: 4, overflow: 'hidden', marginBottom: 12 },
  uploadProgressFill: { height: '100%', backgroundColor: theme.colors.neon || '#00F5D4' },
  footerRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  footerSecondary: { height: 54, paddingHorizontal: 18, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.09)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  footerSecondaryText: { color: '#fff', fontSize: 14, fontWeight: '900' },
  publishButton: { flex: 1, height: 54, borderRadius: 18, overflow: 'hidden' },
  publishGradient: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9 },
  publishText: { color: '#000', fontSize: 15, fontWeight: '950' },
  disabled: { opacity: 0.48 },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.72)', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modalCard: { width: '100%', maxWidth: 340, backgroundColor: '#101018', borderRadius: 28, padding: 24, alignItems: 'center', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' },
  modalOrb: { width: 74, height: 74, borderRadius: 37, alignItems: 'center', justifyContent: 'center', marginBottom: 16 },
  modalTitle: { color: '#fff', fontSize: 19, fontWeight: '950', marginBottom: 8 },
  modalText: { color: '#9B9BA6', fontSize: 13, lineHeight: 19, textAlign: 'center', fontWeight: '700' },
  modalProgress: { marginTop: 20, width: '100%', height: 6, borderRadius: 6, overflow: 'hidden', backgroundColor: 'rgba(255,255,255,0.1)' },
  modalProgressFill: { width: '72%', height: '100%', backgroundColor: theme.colors.gold || '#FFD166' }
});
