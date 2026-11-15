import { useState } from "react";
import { Image, KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import Animated from "react-native-reanimated";
import { motion, useReduceMotion } from "../ui/motion";
import { haptic } from "../ui/haptics";
import { Action, Field, Icon, Notice, useTheme } from "../ui/theme";
import { parseOrigin } from "./session";

export function Pairing({
  onPair, initialError,
}: {
  onPair: (origin: string, token: string) => Promise<void>;
  initialError?: string;
}) {
  const { colors, styles } = useTheme();
  const reduced = useReduceMotion();
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  async function submit() {
    if (!address.trim() || !token.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await onPair(parseOrigin(address), token.trim());
      haptic("success");
    } catch (error) {
      haptic("error");
      setError(error instanceof Error ? error.message : "配对失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={local.scroll}>
        <Animated.View style={[local.content, !reduced && motion.fade]}>
          <View style={local.intro}>
            <Image accessible={false} source={require("../../assets/images/hermes-warm.png")} resizeMode="contain" style={local.mascot} />
            <Text accessibilityElementsHidden importantForAccessibility="no" style={[styles.wordmark, local.wordmark]}>Hermes</Text>
            <Text accessibilityRole="header" style={[styles.title, styles.center]}>连接你的 Hermes</Text>
          </View>
          <View style={local.group}>
            <View style={[local.field, { borderColor: colors.edge }]}>
              <Text style={styles.label}>服务器地址</Text>
              <Field
                accessibilityLabel="服务器地址"
                autoCapitalize="none"
                autoCorrect={false}
                editable={!busy}
                keyboardType="url"
                placeholder="https://hermes.example.com"
                style={local.input}
                value={address}
                onChangeText={setAddress}
              />
            </View>
            <View style={[local.field, { borderColor: colors.edge }]}>
              <Text style={styles.label}>配对令牌</Text>
              <View style={local.token}>
                <Field
                  accessibilityLabel="配对令牌"
                  autoCapitalize="none"
                  autoComplete="off"
                  autoCorrect={false}
                  editable={!busy}
                  importantForAutofill="no"
                  onChangeText={setToken}
                  onSubmitEditing={() => void submit()}
                  placeholder="••••••••"
                  secureTextEntry
                  style={[local.input, local.secret]}
                  value={token}
                />
                <Icon name="lock" size={19} color={colors.muted} />
              </View>
            </View>
          </View>
          {error && <Notice>{error}</Notice>}
          <Action
            primary
            title={busy ? "正在配对…" : "配对设备"}
            disabled={busy || !address.trim() || !token.trim()}
            onPress={() => void submit()}
          />
        </Animated.View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: "center", paddingHorizontal: 24, paddingTop: 32, paddingBottom: 40 },
  content: { gap: 32, width: "100%", maxWidth: 430 },
  intro: { gap: 8, alignItems: "center" },
  mascot: { width: 212, height: 212, maxWidth: "100%" },
  wordmark: { fontSize: 26, lineHeight: 32 },
  group: { gap: 16 },
  field: { borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: 2 },
  token: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { backgroundColor: "transparent", paddingHorizontal: 2, marginHorizontal: -3 },
  secret: { flex: 1, minWidth: 0 },
});
