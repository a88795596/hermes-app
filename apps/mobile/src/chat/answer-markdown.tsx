import { useMemo, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View, type TextStyle } from "react-native";
import Markdown, { MarkdownIt, type RenderFunction, type RenderRules } from "react-native-markdown-renderer";
import { useTheme } from "../ui/theme";

const parser = MarkdownIt({ html: false, linkify: true });
// Stop detected URLs at Chinese punctuation while preserving explicit Markdown link targets.
const linkify = parser.linkify;
const testSchemaAt = linkify.testSchemaAt.bind(linkify);
linkify.testSchemaAt = (text: string, schema: string, position: number) => {
  const length = testSchemaAt(text, schema, position);
  const separator = text.slice(position, position + length).search(/[，。！？；：（）【】《》「」]/u);
  return separator === -1 ? length : testSchemaAt(text.slice(0, position + separator), schema, position);
};
const monospace = Platform.OS === "ios" ? "Menlo" : "monospace";

function isWebUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;

  try {
    return Boolean(new URL(url).hostname);
  } catch {
    return false;
  }
}

function MarkdownLink({ url, color, onOpenLink, children }: {
  url: string; color: string; onOpenLink: (url: string) => void; children: ReactNode;
}) {
  if (!isWebUrl(url)) return <Text>{children}</Text>;

  const link = Platform.OS === "web" ? { href: url } : {};
  return <Text accessible accessibilityRole="link" style={{ color, textDecorationLine: "underline" }} {...link} onPress={(event) => {
    event.preventDefault();
    onOpenLink(url);
  }}>{children}</Text>;
}

function markdownTheme(colors: ReturnType<typeof useTheme>["colors"], onOpenLink: (url: string) => void) {
  const line = StyleSheet.hairlineWidth;
  const headingDivider = { borderBottomColor: colors.edge, borderBottomWidth: line, paddingBottom: 6 };
  const cell = { flex: 1, flexBasis: 0, minWidth: 0, paddingHorizontal: 10, paddingVertical: 7,
    borderColor: colors.edge, borderBottomWidth: line, borderEndWidth: line };
  const style = StyleSheet.create({
    root: { gap: 12, minWidth: 0 },
    text: { color: colors.foreground, fontSize: 15, lineHeight: 23 },
    paragraph: { gap: 4 },
    heading: { fontWeight: "600" },
    heading1: { fontSize: 24, lineHeight: 30 },
    heading2: { fontSize: 20, lineHeight: 26 },
    heading3: { fontSize: 17, lineHeight: 23 },
    heading4: { fontSize: 16, lineHeight: 22 },
    heading5: { fontSize: 15, lineHeight: 21 },
    heading6: { fontSize: 14, lineHeight: 20, color: colors.muted },
    strong: { fontWeight: "600" },
    codeInline: { color: colors.foreground, backgroundColor: colors.secondary, borderRadius: 4,
      fontFamily: monospace, fontSize: 13, paddingHorizontal: 3 },
    codeFrame: { backgroundColor: colors.field, borderRadius: 6 },
    codeContent: { padding: 12 },
    codeBlock: { color: colors.foreground, fontFamily: monospace, fontSize: 13, lineHeight: 20,
      ...Platform.select({ web: { whiteSpace: "pre", overflowWrap: "normal" } }) },
    blockquote: { borderStartColor: colors.edge, borderStartWidth: 3, paddingStart: 11, gap: 8 },
    quoteText: { color: colors.muted },
    list: { gap: 3 },
    listRow: { flexDirection: "row", alignItems: "flex-start", gap: 8, paddingStart: 8 },
    listItem: { flex: 1, gap: 4 },
    tableContent: { flexGrow: 1 },
    table: { flexGrow: 1, borderTopWidth: line, borderStartWidth: line, borderColor: colors.edge },
    tableRow: { flexDirection: "row" },
    tableShade: { backgroundColor: colors.field },
    tableHeader: { backgroundColor: colors.field },
    tableHeaderCell: cell,
    tableRowCell: cell,
    hr: { height: 1, backgroundColor: colors.edge, marginVertical: 3 },
  });

  const codeBlock: RenderFunction = (node) => (
    <ScrollView key={node.key} horizontal tabIndex={0} style={style.codeFrame} contentContainerStyle={style.codeContent}>
      <Text selectable style={style.codeBlock}>{node.content.replace(/\n$/, "")}</Text>
    </ScrollView>
  );
  const link: RenderFunction = (node, children) => (
    <MarkdownLink key={node.key} url={node.attributes.href} color={colors.accent} onOpenLink={onOpenLink}>{children}</MarkdownLink>
  );
  function heading(level: number, size: TextStyle): RenderFunction {
    return function renderHeading(node, children) {
      return (
        <View key={node.key} style={[node.index > 0 && { marginTop: 2 }, level <= 2 && headingDivider]}>
          <Text selectable accessibilityRole="header" {...{ "aria-level": level }} style={[style.text, style.heading, size]}>
            {children}
          </Text>
        </View>
      );
    };
  }

  const rules: RenderRules = {
    heading1: heading(1, style.heading1),
    heading2: heading(2, style.heading2),
    heading3: heading(3, style.heading3),
    heading4: heading(4, style.heading4),
    heading5: heading(5, style.heading5),
    heading6: heading(6, style.heading6),
    textgroup(node, children, parents) {
      const parent = parents[0];
      if (parent?.type.startsWith("heading")) return children;

      const alignment = parent?.attributes.style;
      const linkNode = node.children[0];
      const standaloneUrl = Platform.OS !== "web" && node.children.length === 1 && linkNode.type === "link"
        && isWebUrl(linkNode.attributes.href) ? linkNode.attributes.href : undefined;
      const text = <Text key={node.key} accessible={standaloneUrl ? false : undefined} selectable={!standaloneUrl}
        style={[style.text, parents.some(({ type }) => type === "blockquote") && style.quoteText,
          parent?.type === "th" && style.strong,
          alignment === "text-align:right" && { textAlign: "right" },
          alignment === "text-align:center" && { textAlign: "center" }]}>{children}</Text>;
      // Native accessibility can omit the link role when it spans the entire text run.
      return standaloneUrl ? <Pressable key={node.key} accessibilityRole="link" onPress={() => onOpenLink(standaloneUrl)}>
        {text}
      </Pressable> : text;
    },
    fence: codeBlock,
    code_block: codeBlock,
    link,
    blocklink: link,
    // Keep image requests user-initiated, just like other external links.
    image(node, _children, parents) {
      const label = node.content || "查看图片";
      return <Text key={node.key} selectable>
        {parents.some(({ type }) => type === "blocklink") ? label : (
          <MarkdownLink url={node.attributes.src} color={colors.accent} onOpenLink={onOpenLink}>{label}</MarkdownLink>
        )}
      </Text>;
    },
    list_item(node, children, [parent]) {
      const marker = parent?.type === "ordered_list" ? `${Number(parent.attributes.start ?? 1) + node.index}.` : "•";
      return <View key={node.key} style={style.listRow}>
        <Text style={[style.text, style.quoteText]}>{marker}</Text>
        <View style={style.listItem}>{children}</View>
      </View>;
    },
    table(node, children) {
      const columns = node.children[0]?.children[0]?.children.length ?? 1;
      return <ScrollView key={node.key} horizontal tabIndex={0} contentContainerStyle={style.tableContent}>
        <View style={[style.table, { width: columns * 92 }]}>{children}</View>
      </ScrollView>;
    },
    tr: (node, children, [parent]) => (
      <View key={node.key} style={[style.tableRow, parent?.type === "tbody" && node.index % 2 === 1 && style.tableShade]}>{children}</View>
    ),
  };

  return { style, rules };
}

export function AnswerMarkdown({ text, onOpenLink }: { text: string; onOpenLink: (url: string) => void }) {
  const { colors } = useTheme();
  const { style, rules } = useMemo(() => markdownTheme(colors, onOpenLink), [colors, onOpenLink]);
  return <Markdown markdownit={parser} mergeStyle={false} style={style} rules={rules}>{text}</Markdown>;
}
