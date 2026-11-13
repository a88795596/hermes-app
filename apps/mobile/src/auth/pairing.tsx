import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { Action, Field, Icon, Notice, useTheme } from "../ui/theme";
import { parseOrigin } from "./session";

export function Pairing({
  onPair, initialError,
}: {
  onPair: (origin: string, token: string) => Promise<void>;
  initialError?: string;
}) {
  const { colors, styles } = useTheme();
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
    } catch (error) {
      setError(error instanceof Error ? error.message : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <KeyboardAvoidingView style={styles.frame} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.pairContent, local.scroll]}>
        <View style={local.content}>
          <View style={local.intro}>
            <View style={[local.icon, { backgroundColor: colors.tint }]}>
              <Icon name="lock" size={18} color={colors.accent} />
            </View>
            <Text accessibilityRole="header" style={styles.title}>Hermes Mobile</Text>
            <Text style={styles.muted}>Pair this device with your Hermes Mobile server.</Text>
          </View>
          <View style={[local.group, { backgroundColor: colors.surface }]}>
            <View style={local.field}>
              <Text style={[styles.sectionLabel, local.fieldLabel]}>Server address</Text>
              <Field
                accessibilityLabel="Server address"
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
            <View style={[local.divider, { backgroundColor: colors.edge }]} />
            <View style={local.field}>
              <Text style={[styles.sectionLabel, local.fieldLabel]}>Pairing token</Text>
              <Field
                accessibilityLabel="Pairing token"
                autoCapitalize="none"
                autoComplete="off"
                autoCorrect={false}
                editable={!busy}
                importantForAutofill="no"
                onChangeText={setToken}
                onSubmitEditing={() => void submit()}
                secureTextEntry
                style={local.input}
                value={token}
              />
            </View>
          </View>
          {error && <Notice>{error}</Notice>}
          <Action
            primary
            title={busy ? "Pairing…" : "Pair device"}
            disabled={busy || !address.trim() || !token.trim()}
            onPress={() => void submit()}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const local = StyleSheet.create({
  scroll: { alignItems: "center" },
  content: { gap: 20, width: "100%", maxWidth: 430 },
  intro: { gap: 6 },
  icon: { width: 38, height: 38, borderRadius: 10, alignItems: "center", justifyContent: "center", marginBottom: 10 },
  group: { borderRadius: 14, overflow: "hidden" },
  field: { paddingHorizontal: 13, paddingTop: 10 },
  fieldLabel: { marginLeft: 0, marginBottom: 0 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 13 },
  input: { backgroundColor: "transparent", paddingHorizontal: 3, marginHorizontal: -4, borderRadius: 7, marginVertical: 3 },
});
