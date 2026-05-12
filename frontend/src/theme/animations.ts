import { Animated, Easing, Vibration } from "react-native";

export type SwipeDirection = "left" | "right" | "up" | "down";

export type AnimationConfig = {
  delay?: number;
  duration?: number;
  useNativeDriver?: boolean;
};

export type SpringConfig = {
  tension?: number;
  friction?: number;
  speed?: number;
  bounciness?: number;
  useNativeDriver?: boolean;
};

const native = true;

const ease = {
  premium: Easing.bezier(0.32, 0.72, 0, 1),
  soft: Easing.bezier(0.22, 1, 0.36, 1),
  sharp: Easing.bezier(0.4, 0, 0.2, 1),
  elastic: Easing.out(Easing.back(1.4)),
  cubicOut: Easing.out(Easing.cubic),
  cubicIn: Easing.in(Easing.cubic),
  quadInOut: Easing.inOut(Easing.quad)
};

const start = (animation: Animated.CompositeAnimation, callback?: Animated.EndCallback) => {
  animation.start(callback);
  return animation;
};

export const microInteractions = {
  tap: (value: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.sequence([
        Animated.spring(value, {
          toValue: 0.92,
          tension: 170,
          friction: 9,
          useNativeDriver: native
        }),
        Animated.spring(value, {
          toValue: 1,
          tension: 120,
          friction: 10,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  softTap: (value: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.sequence([
        Animated.timing(value, {
          toValue: 0.96,
          duration: 80,
          easing: ease.sharp,
          useNativeDriver: native
        }),
        Animated.spring(value, {
          toValue: 1,
          tension: 90,
          friction: 8,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  pressIn: (value: Animated.Value) =>
    start(
      Animated.spring(value, {
        toValue: 0.94,
        tension: 180,
        friction: 10,
        useNativeDriver: native
      })
    ),

  pressOut: (value: Animated.Value) =>
    start(
      Animated.spring(value, {
        toValue: 1,
        tension: 120,
        friction: 9,
        useNativeDriver: native
      })
    ),

  likePop: (scale: Animated.Value, opacity?: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.parallel([
        Animated.sequence([
          Animated.spring(scale, {
            toValue: 1.35,
            tension: 220,
            friction: 7,
            useNativeDriver: native
          }),
          Animated.spring(scale, {
            toValue: 1,
            tension: 140,
            friction: 9,
            useNativeDriver: native
          })
        ]),
        opacity
          ? Animated.sequence([
              Animated.timing(opacity, {
                toValue: 1,
                duration: 90,
                easing: ease.sharp,
                useNativeDriver: native
              }),
              Animated.delay(260),
              Animated.timing(opacity, {
                toValue: 0,
                duration: 180,
                easing: ease.cubicOut,
                useNativeDriver: native
              })
            ])
          : Animated.delay(0)
      ]),
      callback
    ),

  doubleTapHeart: (
    scale: Animated.Value,
    opacity: Animated.Value,
    translateY?: Animated.Value,
    callback?: Animated.EndCallback
  ) =>
    start(
      Animated.parallel([
        Animated.sequence([
          Animated.parallel([
            Animated.spring(scale, {
              toValue: 1.25,
              tension: 220,
              friction: 7,
              useNativeDriver: native
            }),
            Animated.timing(opacity, {
              toValue: 1,
              duration: 90,
              easing: ease.sharp,
              useNativeDriver: native
            }),
            translateY
              ? Animated.timing(translateY, {
                  toValue: -18,
                  duration: 260,
                  easing: ease.soft,
                  useNativeDriver: native
                })
              : Animated.delay(0)
          ]),
          Animated.delay(220),
          Animated.parallel([
            Animated.spring(scale, {
              toValue: 0.85,
              tension: 140,
              friction: 10,
              useNativeDriver: native
            }),
            Animated.timing(opacity, {
              toValue: 0,
              duration: 180,
              easing: ease.cubicOut,
              useNativeDriver: native
            }),
            translateY
              ? Animated.timing(translateY, {
                  toValue: -36,
                  duration: 180,
                  easing: ease.cubicOut,
                  useNativeDriver: native
                })
              : Animated.delay(0)
          ])
        ])
      ]),
      callback
    ),

  swipe: (value: Animated.Value, direction: SwipeDirection, callback?: Animated.EndCallback) => {
    const toValue = direction === "left" || direction === "up" ? -1 : 1;
    return start(
      Animated.timing(value, {
        toValue,
        duration: 280,
        easing: ease.premium,
        useNativeDriver: native
      }),
      callback
    );
  },

  swipeBack: (value: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.spring(value, {
        toValue: 0,
        tension: 120,
        friction: 12,
        useNativeDriver: native
      }),
      callback
    ),

  enter: (value: Animated.Value, delay = 0, callback?: Animated.EndCallback) =>
    start(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(value, {
          toValue: 1,
          duration: 420,
          easing: ease.cubicOut,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  fadeIn: (value: Animated.Value, delay = 0, duration = 260, callback?: Animated.EndCallback) =>
    start(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(value, {
          toValue: 1,
          duration,
          easing: ease.cubicOut,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  fadeOut: (value: Animated.Value, duration = 220, callback?: Animated.EndCallback) =>
    start(
      Animated.timing(value, {
        toValue: 0,
        duration,
        easing: ease.cubicIn,
        useNativeDriver: native
      }),
      callback
    ),

  slideIn: (
    translate: Animated.Value,
    from: SwipeDirection = "up",
    distance = 24,
    delay = 0,
    callback?: Animated.EndCallback
  ) => {
    translate.setValue(from === "left" || from === "up" ? -distance : distance);
    return start(
      Animated.sequence([
        Animated.delay(delay),
        Animated.spring(translate, {
          toValue: 0,
          tension: 90,
          friction: 12,
          useNativeDriver: native
        })
      ]),
      callback
    );
  },

  slideOut: (
    translate: Animated.Value,
    to: SwipeDirection = "down",
    distance = 32,
    duration = 220,
    callback?: Animated.EndCallback
  ) =>
    start(
      Animated.timing(translate, {
        toValue: to === "left" || to === "up" ? -distance : distance,
        duration,
        easing: ease.sharp,
        useNativeDriver: native
      }),
      callback
    ),

  scaleIn: (value: Animated.Value, delay = 0, callback?: Animated.EndCallback) => {
    value.setValue(0.88);
    return start(
      Animated.sequence([
        Animated.delay(delay),
        Animated.spring(value, {
          toValue: 1,
          tension: 120,
          friction: 9,
          useNativeDriver: native
        })
      ]),
      callback
    );
  },

  scaleOut: (value: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.timing(value, {
        toValue: 0.88,
        duration: 180,
        easing: ease.cubicIn,
        useNativeDriver: native
      }),
      callback
    ),

  pulse: (value: Animated.Value) =>
    start(
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 800,
            easing: ease.quadInOut,
            useNativeDriver: native
          }),
          Animated.timing(value, {
            toValue: 0.95,
            duration: 800,
            easing: ease.quadInOut,
            useNativeDriver: native
          })
        ])
      )
    ),

  glowPulse: (value: Animated.Value) =>
    start(
      Animated.loop(
        Animated.sequence([
          Animated.timing(value, {
            toValue: 1,
            duration: 900,
            easing: ease.quadInOut,
            useNativeDriver: native
          }),
          Animated.timing(value, {
            toValue: 0.35,
            duration: 900,
            easing: ease.quadInOut,
            useNativeDriver: native
          })
        ])
      )
    ),

  shimmer: (value: Animated.Value, duration = 1300) => {
    value.setValue(0);
    return start(
      Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration,
          easing: Easing.linear,
          useNativeDriver: native
        })
      )
    );
  },

  shake: (value: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.sequence([
        Animated.timing(value, { toValue: -8, duration: 45, useNativeDriver: native }),
        Animated.timing(value, { toValue: 8, duration: 45, useNativeDriver: native }),
        Animated.timing(value, { toValue: -6, duration: 45, useNativeDriver: native }),
        Animated.timing(value, { toValue: 6, duration: 45, useNativeDriver: native }),
        Animated.timing(value, { toValue: 0, duration: 45, useNativeDriver: native })
      ]),
      callback
    ),

  bounce: (value: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.sequence([
        Animated.spring(value, {
          toValue: 1.12,
          tension: 180,
          friction: 7,
          useNativeDriver: native
        }),
        Animated.spring(value, {
          toValue: 1,
          tension: 120,
          friction: 8,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  rotatePop: (rotate: Animated.Value, scale: Animated.Value, callback?: Animated.EndCallback) => {
    rotate.setValue(0);
    scale.setValue(0.9);
    return start(
      Animated.parallel([
        Animated.timing(rotate, {
          toValue: 1,
          duration: 420,
          easing: ease.elastic,
          useNativeDriver: native
        }),
        Animated.spring(scale, {
          toValue: 1,
          tension: 120,
          friction: 8,
          useNativeDriver: native
        })
      ]),
      callback
    );
  },

  modalIn: (opacity: Animated.Value, translateY: Animated.Value, callback?: Animated.EndCallback) => {
    opacity.setValue(0);
    translateY.setValue(28);
    return start(
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 220,
          easing: ease.cubicOut,
          useNativeDriver: native
        }),
        Animated.spring(translateY, {
          toValue: 0,
          tension: 90,
          friction: 12,
          useNativeDriver: native
        })
      ]),
      callback
    );
  },

  modalOut: (opacity: Animated.Value, translateY: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 180,
          easing: ease.cubicIn,
          useNativeDriver: native
        }),
        Animated.timing(translateY, {
          toValue: 28,
          duration: 180,
          easing: ease.cubicIn,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  toastIn: (opacity: Animated.Value, translateY: Animated.Value, callback?: Animated.EndCallback) => {
    opacity.setValue(0);
    translateY.setValue(-18);
    return start(
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 180,
          easing: ease.cubicOut,
          useNativeDriver: native
        }),
        Animated.spring(translateY, {
          toValue: 0,
          tension: 100,
          friction: 11,
          useNativeDriver: native
        })
      ]),
      callback
    );
  },

  toastOut: (opacity: Animated.Value, translateY: Animated.Value, callback?: Animated.EndCallback) =>
    start(
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 160,
          easing: ease.cubicIn,
          useNativeDriver: native
        }),
        Animated.timing(translateY, {
          toValue: -18,
          duration: 160,
          easing: ease.cubicIn,
          useNativeDriver: native
        })
      ]),
      callback
    ),

  skeleton: (value: Animated.Value) => {
    value.setValue(0);
    return start(
      Animated.loop(
        Animated.timing(value, {
          toValue: 1,
          duration: 1200,
          easing: Easing.linear,
          useNativeDriver: native
        })
      )
    );
  },

  hapticLight: () => Vibration.vibrate(8),

  hapticMedium: () => Vibration.vibrate(16),

  hapticSuccess: () => Vibration.vibrate([0, 12, 30, 12]),

  stop: (value: Animated.Value) => value.stopAnimation(),

  reset: (value: Animated.Value, toValue = 0) => {
    value.stopAnimation();
    value.setValue(toValue);
  }
};

export const createSprings = (count: number, initialValue = 0) =>
  Array.from({ length: count }, () => new Animated.Value(initialValue));

export const createAnimatedValues = (keys: string[], initialValue = 0) =>
  keys.reduce<Record<string, Animated.Value>>((acc, key) => {
    acc[key] = new Animated.Value(initialValue);
    return acc;
  }, {});

export const interpolateOpacity = (value: Animated.Value, inputRange = [0, 1], outputRange = [0, 1]) =>
  value.interpolate({ inputRange, outputRange, extrapolate: "clamp" });

export const interpolateScale = (value: Animated.Value, inputRange = [0, 1], outputRange = [0.95, 1]) =>
  value.interpolate({ inputRange, outputRange, extrapolate: "clamp" });

export const interpolateTranslateY = (value: Animated.Value, distance = 24) =>
  value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0], extrapolate: "clamp" });

export const interpolateTranslateX = (value: Animated.Value, distance = 24) =>
  value.interpolate({ inputRange: [0, 1], outputRange: [distance, 0], extrapolate: "clamp" });

export const interpolateRotate = (value: Animated.Value, degrees = 12) =>
  value.interpolate({ inputRange: [0, 1], outputRange: [`-${degrees}deg`, `${degrees}deg`], extrapolate: "clamp" });

export const composeTransform = ({
  scale,
  translateX,
  translateY,
  rotate
}: {
  scale?: Animated.AnimatedInterpolation<string | number> | Animated.Value | number;
  translateX?: Animated.AnimatedInterpolation<string | number> | Animated.Value | number;
  translateY?: Animated.AnimatedInterpolation<string | number> | Animated.Value | number;
  rotate?: Animated.AnimatedInterpolation<string | number> | string;
}) => {
  const transform: any[] = [];
  if (translateX !== undefined) transform.push({ translateX });
  if (translateY !== undefined) transform.push({ translateY });
  if (scale !== undefined) transform.push({ scale });
  if (rotate !== undefined) transform.push({ rotate });
  return transform;
};

export { ease };
