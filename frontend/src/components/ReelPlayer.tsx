import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle
} from 'react-native';
import { ResizeMode, Video, VideoProps, AVPlaybackStatus } from 'expo-av';
import { theme } from '../theme';

interface Props extends Omit<VideoProps, 'source' | 'resizeMode' | 'onPlaybackStatusUpdate'> {
  videoUrl: string;
  thumbnailUrl?: string;
  resizeMode?: ResizeMode;
  autoPlay?: boolean;
  muted?: boolean;
  loop?: boolean;
  showControls?: boolean;
  showProgress?: boolean;
  showThumbnail?: boolean;
  containerStyle?: ViewStyle;
  onPlay?: () => void;
  onPause?: () => void;
  onReplay?: () => void;
  onReady?: () => void;
  onBuffer?: (isBuffering: boolean) => void;
  onProgress?: (progress: number, positionMillis: number, durationMillis: number) => void;
  onFinish?: () => void;
  onError?: (error: string) => void;
}

function PlayMark({ paused }: { paused: boolean }) {
  if (!paused) {
    return (
      <View style={styles.pauseMark}>
        <View style={styles.pauseBar} />
        <View style={styles.pauseBar} />
      </View>
    );
  }

  return (
    <View style={styles.playMark}>
      <View style={styles.playTriangle} />
    </View>
  );
}

function SoundMark({ muted }: { muted: boolean }) {
  return (
    <View style={styles.soundMark}>
      <View style={styles.soundBox} />
      <View style={styles.soundCone} />
      {!muted && (
        <View style={styles.soundWaves}>
          <View style={styles.waveSmall} />
          <View style={styles.waveLarge} />
        </View>
      )}
      {muted && <View style={styles.muteSlash} />}
    </View>
  );
}

function ReplayMark() {
  return (
    <View style={styles.replayMark}>
      <View style={styles.replayArc} />
      <View style={styles.replayHead} />
    </View>
  );
}

export default function ReelPlayer({
  videoUrl,
  thumbnailUrl,
  onPlay,
  onPause,
  onProgress,
  onReplay,
  onReady,
  onBuffer,
  onFinish,
  onError,
  autoPlay = false,
  muted = false,
  loop = true,
  showControls = true,
  showProgress = true,
  showThumbnail = true,
  resizeMode = ResizeMode.COVER,
  containerStyle,
  shouldPlay,
  isMuted,
  isLooping,
  ...props
}: Props) {
  const videoRef = useRef<Video>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [paused, setPaused] = useState(!autoPlay && !shouldPlay);
  const [localMuted, setLocalMuted] = useState(isMuted ?? muted);
  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [finished, setFinished] = useState(false);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [thumbnailVisible, setThumbnailVisible] = useState(!!thumbnailUrl && showThumbnail);

  const finalShouldPlay = useMemo(() => {
    if (typeof shouldPlay === 'boolean') return shouldPlay && !paused;
    return autoPlay && !paused;
  }, [shouldPlay, autoPlay, paused]);

  const finalLooping = typeof isLooping === 'boolean' ? isLooping : loop;

  const showOverlay = useCallback(() => {
    if (!showControls) return;

    setControlsVisible(true);

    Animated.timing(fadeAnim, {
      toValue: 1,
      duration: 140,
      useNativeDriver: true
    }).start();

    if (hideTimer.current) clearTimeout(hideTimer.current);

    hideTimer.current = setTimeout(() => {
      Animated.timing(fadeAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true
      }).start(({ finished: done }) => {
        if (done) setControlsVisible(false);
      });
    }, 1100);
  }, [fadeAnim, showControls]);

  const play = useCallback(async () => {
    try {
      if (finished) {
        await videoRef.current?.setPositionAsync(0);
        setFinished(false);
        onReplay?.();
      }

      await videoRef.current?.playAsync();
      setPaused(false);
      setThumbnailVisible(false);
      onPlay?.();
    } catch (err: any) {
      onError?.(err?.message || 'Unable to play video');
    }
  }, [finished, onError, onPlay, onReplay]);

  const pause = useCallback(async () => {
    try {
      await videoRef.current?.pauseAsync();
      setPaused(true);
      onPause?.();
    } catch (err: any) {
      onError?.(err?.message || 'Unable to pause video');
    }
  }, [onError, onPause]);

  const togglePlayback = useCallback(async () => {
    const status = await videoRef.current?.getStatusAsync();

    if (status?.isLoaded && status.isPlaying) {
      await pause();
    } else {
      await play();
    }

    showOverlay();
  }, [pause, play, showOverlay]);

  const toggleMute = useCallback(async () => {
    const next = !localMuted;
    setLocalMuted(next);
    await videoRef.current?.setIsMutedAsync(next);
    showOverlay();
  }, [localMuted, showOverlay]);

  const handleStatus = useCallback((status: AVPlaybackStatus) => {
    if (!status.isLoaded) {
      if ('error' in status && status.error) onError?.(status.error);
      return;
    }

    const nextDuration = status.durationMillis || 0;
    const nextPosition = status.positionMillis || 0;
    const nextProgress = nextDuration > 0 ? Math.min(1, Math.max(0, nextPosition / nextDuration)) : 0;

    setLoading(false);
    setBuffering(!!status.isBuffering);
    setDuration(nextDuration);
    setPosition(nextPosition);
    setPaused(!status.isPlaying);

    onBuffer?.(!!status.isBuffering);
    onProgress?.(nextProgress, nextPosition, nextDuration);

    progressAnim.setValue(nextProgress);

    if (status.didJustFinish) {
      setFinished(true);
      onFinish?.();

      if (!finalLooping) {
        setPaused(true);
        showOverlay();
      }
    }
  }, [finalLooping, onBuffer, onError, onFinish, onProgress, progressAnim, showOverlay]);

  useEffect(() => {
    if (autoPlay || shouldPlay) {
      setPaused(false);
      setThumbnailVisible(false);
    }
  }, [autoPlay, shouldPlay]);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
      videoRef.current?.unloadAsync?.();
    };
  }, []);

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
    extrapolate: 'clamp'
  });

  const timeText = useMemo(() => {
    const format = (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const min = Math.floor(total / 60);
      const sec = total % 60;
      return `${min}:${sec.toString().padStart(2, '0')}`;
    };

    if (!duration) return '0:00';
    return `${format(position)} / ${format(duration)}`;
  }, [duration, position]);

  return (
    <View style={[styles.container, containerStyle]}>
      <Video
        ref={videoRef}
        source={{ uri: videoUrl }}
        style={styles.video}
        resizeMode={resizeMode}
        shouldPlay={finalShouldPlay}
        isLooping={finalLooping}
        isMuted={localMuted}
        useNativeControls={false}
        onReadyForDisplay={() => {
          setLoading(false);
          onReady?.();
        }}
        onPlaybackStatusUpdate={handleStatus}
        {...props}
      />

      {thumbnailVisible && thumbnailUrl ? (
        <Image source={{ uri: thumbnailUrl }} style={styles.thumbnail} resizeMode="cover" />
      ) : null}

      <Pressable style={styles.touchLayer} onPress={togglePlayback}>
        {loading || buffering ? (
          <View style={styles.loaderWrap}>
            <ActivityIndicator size="large" color={theme.colors?.gold || '#D8B45A'} />
          </View>
        ) : null}

        {showControls && controlsVisible ? (
          <Animated.View style={[styles.centerControl, { opacity: fadeAnim }]}>
            {finished && !finalLooping ? <ReplayMark /> : <PlayMark paused={paused} />}
          </Animated.View>
        ) : null}
      </Pressable>

      {showControls ? (
        <View style={styles.topControls}>
          <Pressable style={styles.soundButton} onPress={toggleMute}>
            <SoundMark muted={localMuted} />
          </Pressable>
        </View>
      ) : null}

      {showProgress ? (
        <View style={styles.bottomWrap}>
          <View style={styles.timePill}>
            <Text style={styles.timeText}>{timeText}</Text>
          </View>
          <View style={styles.progressTrack}>
            <Animated.View style={[styles.progressFill, { width: progressWidth }]} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

const gold = theme.colors?.gold || '#D8B45A';
const neon = theme.colors?.neon || '#35F2C2';

const styles = StyleSheet.create({
  container: {
    width: '100%',
    aspectRatio: 9 / 16,
    backgroundColor: '#050505',
    overflow: 'hidden',
    borderRadius: 0
  },
  video: {
    width: '100%',
    height: '100%',
    backgroundColor: '#050505'
  },
  thumbnail: {
    ...StyleSheet.absoluteFillObject,
    width: '100%',
    height: '100%'
  },
  touchLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center'
  },
  loaderWrap: {
    width: 74,
    height: 74,
    borderRadius: 37,
    backgroundColor: 'rgba(0,0,0,0.38)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)'
  },
  centerControl: {
    width: 82,
    height: 82,
    borderRadius: 41,
    backgroundColor: 'rgba(0,0,0,0.46)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)'
  },
  playMark: {
    width: 42,
    height: 42,
    justifyContent: 'center',
    alignItems: 'center'
  },
  playTriangle: {
    width: 0,
    height: 0,
    marginLeft: 6,
    borderTopWidth: 14,
    borderBottomWidth: 14,
    borderLeftWidth: 23,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderLeftColor: '#FFFFFF'
  },
  pauseMark: {
    width: 42,
    height: 42,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 8
  },
  pauseBar: {
    width: 9,
    height: 30,
    borderRadius: 5,
    backgroundColor: '#FFFFFF'
  },
  replayMark: {
    width: 42,
    height: 42,
    justifyContent: 'center',
    alignItems: 'center'
  },
  replayArc: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 4,
    borderLeftColor: '#FFFFFF',
    borderTopColor: '#FFFFFF',
    borderRightColor: '#FFFFFF',
    borderBottomColor: 'transparent',
    transform: [{ rotate: '-35deg' }]
  },
  replayHead: {
    position: 'absolute',
    right: 7,
    top: 5,
    width: 0,
    height: 0,
    borderLeftWidth: 8,
    borderRightWidth: 8,
    borderBottomWidth: 12,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#FFFFFF',
    transform: [{ rotate: '30deg' }]
  },
  topControls: {
    position: 'absolute',
    top: 14,
    right: 14
  },
  soundButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.38)',
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.14)'
  },
  soundMark: {
    width: 25,
    height: 25,
    justifyContent: 'center'
  },
  soundBox: {
    position: 'absolute',
    left: 2,
    top: 8,
    width: 8,
    height: 9,
    borderRadius: 2,
    backgroundColor: '#FFFFFF'
  },
  soundCone: {
    position: 'absolute',
    left: 8,
    top: 5,
    width: 0,
    height: 0,
    borderTopWidth: 8,
    borderBottomWidth: 8,
    borderRightWidth: 10,
    borderTopColor: 'transparent',
    borderBottomColor: 'transparent',
    borderRightColor: '#FFFFFF',
    transform: [{ rotate: '180deg' }]
  },
  soundWaves: {
    position: 'absolute',
    left: 16,
    top: 5,
    width: 12,
    height: 16
  },
  waveSmall: {
    position: 'absolute',
    left: 0,
    top: 4,
    width: 7,
    height: 8,
    borderRightWidth: 2,
    borderRightColor: '#FFFFFF',
    borderRadius: 8
  },
  waveLarge: {
    position: 'absolute',
    left: 4,
    top: 1,
    width: 9,
    height: 14,
    borderRightWidth: 2,
    borderRightColor: '#FFFFFF',
    borderRadius: 10
  },
  muteSlash: {
    position: 'absolute',
    left: 2,
    top: 11,
    width: 24,
    height: 3,
    borderRadius: 2,
    backgroundColor: '#FFFFFF',
    transform: [{ rotate: '-42deg' }]
  },
  bottomWrap: {
    position: 'absolute',
    left: 12,
    right: 12,
    bottom: 12
  },
  timePill: {
    alignSelf: 'flex-end',
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: 'rgba(0,0,0,0.42)',
    marginBottom: 8,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)'
  },
  timeText: {
    color: '#FFFFFF',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2
  },
  progressTrack: {
    height: 4,
    borderRadius: 99,
    backgroundColor: 'rgba(255,255,255,0.24)',
    overflow: 'hidden'
  },
  progressFill: {
    height: '100%',
    borderRadius: 99,
    backgroundColor: neon || gold
  }
});
