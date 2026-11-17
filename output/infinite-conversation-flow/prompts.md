# 无限会话流 · Imagegen 提示词

生成方式：内置 image_gen；以下为实际使用的完整提示词。

## settings

```text
Use case: ui-mockup.
Create a high-fidelity Chinese iOS mobile app UI design for the existing Hermes app, feature name EXACTLY "无限会话流". This is a practical product design for an existing app, not a brand reinvention or a marketing poster.
LOCKED DESIGN SYSTEM across the whole series: warm parchment flat background #F7F2EA; surface #FFFCF7; cocoa primary text #352820; muted brown #735F50; accent #86553B; filled accent #9C6548; user message tint #EBDDD0; field #EFE5DA; hairline separators #DDD0C2. Use the actual existing understated clean SF Symbol-style outline icons, no colorful icons, no gradients, no paper noise, no illustrations except circular letter avatars. SF Pro / PingFang Chinese-like typography, 18pt semibold centered page titles, 17pt body, 13pt tab labels. Page padding 24pt, generous white space, flat list rows 64pt tall, 44-48pt touch targets, restrained 12-19pt corner radii.
PHONE PRESENTATION: straight-on thin graphite iPhone frame, no perspective, no hand, no scenery. Device screen ratio about 9:19.5 with Dynamic Island, status bar 9:41, wireless and battery symbols, black home indicator, correct safe areas. Device frame is subtle and content is the hero. Small even neutral off-white outer margin and restrained soft shadow. Very high resolution, razor sharp readable Chinese text. All functional UI text in Chinese except "Hermes". NO extra watermarks, promotional headlines, callout numbers, floating explanatory boxes, invented settings, top new-chat icons or gratuitous decorations.
NAV RULES: In infinite conversation mode, the chat is the root screen, there is no conversation-list screen and no top-left back arrow. Each profile has one continuous session. The top left is the active profile's round letter avatar (48pt in warm tint). Centered header is the active profile's Chinese name, with two very small pagination dots directly beneath to express swipeable profiles. Top right is a single brown outline gear for conversation settings, NEVER a compose/new-session action. Bottom global tabs in infinite mode are "聊天", "收件箱", "设置"; the first is selected. Retaining the settings tab keeps the feature switch reachable. Composer sits directly above global tabs with a thin top separator, rounded pale beige input, left paperclip with vertical hairline, placeholder EXACT "发消息给 Hermes", small up-arrow send button inside its right edge; separate microphone button outside on the right. No keyboard. All text should remain comfortably readable.

SCREEN 1 ONLY, PORTRAIT 1024x1536 composition. A single large centered phone, settings center BEFORE activation, showing default OFF.
Centered header exact "设置", with no back icon on this root page. Below, one flat full-width list, not cards, with these exact rows in order:
infinity outline icon, "无限会话流", iOS switch at far right OFF (muted beige gray track, white circular thumb clearly on LEFT).
Then an unobtrusive 20pt vertical spacing and the familiar existing rows separated by hairlines:
round profile outline icon, "配置档案", chevron
sliders outline icon, "管理", chevron
link outline icon, "连接", trailing exact "在线", chevron
archive outline icon, "已归档会话", chevron
info circle icon, "版本信息", chevron.
No secondary descriptions under any row. No headline explaining the mode. Bottom navigation has exact "话题", "收件箱", "设置", with "设置" highlighted in brown. No composer on this screen. Lower half is calm empty parchment. Produce a complete polished screen that looks directly compatible with the Hermes existing app.

```

## first-entry

```text
Use case: ui-mockup.
Create a high-fidelity Chinese iOS mobile app UI design for the existing Hermes app, feature name EXACTLY "无限会话流". This is a practical product design for an existing app, not a brand reinvention or a marketing poster.
LOCKED DESIGN SYSTEM across the whole series: warm parchment flat background #F7F2EA; surface #FFFCF7; cocoa primary text #352820; muted brown #735F50; accent #86553B; filled accent #9C6548; user message tint #EBDDD0; field #EFE5DA; hairline separators #DDD0C2. Use the actual existing understated clean SF Symbol-style outline icons, no colorful icons, no gradients, no paper noise, no illustrations except circular letter avatars. SF Pro / PingFang Chinese-like typography, 18pt semibold centered page titles, 17pt body, 13pt tab labels. Page padding 24pt, generous white space, flat list rows 64pt tall, 44-48pt touch targets, restrained 12-19pt corner radii.
PHONE PRESENTATION: straight-on thin graphite iPhone frame, no perspective, no hand, no scenery. Device screen ratio about 9:19.5 with Dynamic Island, status bar 9:41, wireless and battery symbols, black home indicator, correct safe areas. Device frame is subtle and content is the hero. Small even neutral off-white outer margin and restrained soft shadow. Very high resolution, razor sharp readable Chinese text. All functional UI text in Chinese except "Hermes". NO extra watermarks, promotional headlines, callout numbers, floating explanatory boxes, invented settings, top new-chat icons or gratuitous decorations.
NAV RULES: In infinite conversation mode, the chat is the root screen, there is no conversation-list screen and no top-left back arrow. Each profile has one continuous session. The top left is the active profile's round letter avatar (48pt in warm tint). Centered header is the active profile's Chinese name, with two very small pagination dots directly beneath to express swipeable profiles. Top right is a single brown outline gear for conversation settings, NEVER a compose/new-session action. Bottom global tabs in infinite mode are "聊天", "收件箱", "设置"; the first is selected. Retaining the settings tab keeps the feature switch reachable. Composer sits directly above global tabs with a thin top separator, rounded pale beige input, left paperclip with vertical hairline, placeholder EXACT "发消息给 Hermes", small up-arrow send button inside its right edge; separate microphone button outside on the right. No keyboard. All text should remain comfortably readable.

SCREEN 2 ONLY, PORTRAIT 1024x1536 composition. A single large centered phone. The first screen after enabling infinite stream: the session has already been created automatically and has no messages.
Top-left round warm-tint avatar with exact single character "日". Center title exact "日常助手", underneath first of two tiny pagination dots highlighted brown. Top-right only brown gear.
Content is intentionally quiet, a small outline chat-bubble icon at the optical center and a single short title EXACT "开始对话". Do NOT show a new-session button, plus button, onboarding panels, session IDs, a loading indicator, welcome paragraphs, tooltips, assistant message or any suggestions. The only further invitation is the existing placeholder "发消息给 Hermes" in the composer. Most of the parchment remains beautiful empty space.
At the bottom the composer uses paperclip INSIDE input at left, gray disabled up-arrow INSIDE right, microphone OUTSIDE input at right. Then three global tabs "聊天", "收件箱", "设置", with "聊天" selected. Real safe areas. This view must communicate ready-to-chat immediately, no creation action required.

```

## profile-swipe

```text
Use case: ui-mockup.
Create a high-fidelity Chinese iOS mobile app UI design for the existing Hermes app, feature name EXACTLY "无限会话流". This is a practical product design for an existing app, not a brand reinvention or a marketing poster.
LOCKED DESIGN SYSTEM across the whole series: warm parchment flat background #F7F2EA; surface #FFFCF7; cocoa primary text #352820; muted brown #735F50; accent #86553B; filled accent #9C6548; user message tint #EBDDD0; field #EFE5DA; hairline separators #DDD0C2. Use the actual existing understated clean SF Symbol-style outline icons, no colorful icons, no gradients, no paper noise, no illustrations except circular letter avatars. SF Pro / PingFang Chinese-like typography, 18pt semibold centered page titles, 17pt body, 13pt tab labels. Page padding 24pt, generous white space, flat list rows 64pt tall, 44-48pt touch targets, restrained 12-19pt corner radii.
PHONE PRESENTATION: straight-on thin graphite iPhone frame, no perspective, no hand, no scenery. Device screen ratio about 9:19.5 with Dynamic Island, status bar 9:41, wireless and battery symbols, black home indicator, correct safe areas. Device frame is subtle and content is the hero. Small even neutral off-white outer margin and restrained soft shadow. Very high resolution, razor sharp readable Chinese text. All functional UI text in Chinese except "Hermes". NO extra watermarks, promotional headlines, callout numbers, floating explanatory boxes, invented settings, top new-chat icons or gratuitous decorations.
NAV RULES: In infinite conversation mode, the chat is the root screen, there is no conversation-list screen and no top-left back arrow. Each profile has one continuous session. The top left is the active profile's round letter avatar (48pt in warm tint). Centered header is the active profile's Chinese name, with two very small pagination dots directly beneath to express swipeable profiles. Top right is a single brown outline gear for conversation settings, NEVER a compose/new-session action. Bottom global tabs in infinite mode are "聊天", "收件箱", "设置"; the first is selected. Retaining the settings tab keeps the feature switch reachable. Composer sits directly above global tabs with a thin top separator, rounded pale beige input, left paperclip with vertical hairline, placeholder EXACT "发消息给 Hermes", small up-arrow send button inside its right edge; separate microphone button outside on the right. No keyboard. All text should remain comfortably readable.

INTERACTION BOARD, LANDSCAPE 2048x1536 composition. Exactly TWO equally scaled large straight-on iPhone screens side by side, sufficient width for comfortably readable Chinese, identical device and type scale. Clean equal gutters. Outside the phones, between them near the upper middle, one fine horizontal bidirectional brown arrow. Along the top outside devices, a small neat design annotation exact "左右滑动，切换配置档案". This is a design-board annotation, not an in-app explanatory banner. No other outer annotations.
LEFT PHONE: ongoing infinite session for "日常助手"; avatar exact "日"; first pagination dot active. Top right gear, no back or new chat. Display a simple realistic brief conversation in the upper half. User message right-aligned in warm tinted rounded bubble, exact "帮我梳理今天的重点。" Assistant response left-aligned directly on parchment, NO card or avatar, exact "先把最重要的一件事做好。" Then a generous gap and exact "上午：处理关键任务" on one line, "下午：推进项目" on next, "晚上：留一点时间给自己" on next. Additional small right-aligned user bubble exact "下午先做界面设计。". Avoid unnecessary timestamps or status tags. Composer and three bottom tabs as in the locked system.
RIGHT PHONE: after swiping to "研究助手"; avatar exact "研"; second pagination dot active. The entire profile header and message content have changed, keeping precisely the same layout. User bubble exact "这篇文章的核心观点是什么？" Assistant body without card exact "我会从三个角度整理：" followed by three short plain numbered lines exact "1. 主要结论", "2. 论据与证据", "3. 值得追问的问题". Composer and global tabs remain identical. Both phones demonstrate distinct existing sessions, not a single shared transcript.
The phones should visually dominate the board, arranged at equal heights with matching margins; top annotation small but legible. Chinese must be correct and UI must be highly readable. No list of conversations, no carousel profile selector row, no label reading session, no added feature badges.

```

## profile-swipe refinement

```text
Use case: precise-object-edit / ui-mockup.
Image 1 is the EDIT TARGET: the landscape Hermes UI board showing two phones titled 日常助手 and 研究助手.
Image 2 is ONLY a supporting visual reference for the bottom composer component. Do NOT output Image 2 and do NOT replace the layout of Image 1 with Image 2.
Change ONLY the input composer row inside BOTH phones of Image 1 to exactly follow the component construction seen in Image 2:
- One continuous pale beige rounded input capsule extends from the left padding across the paperclip, its thin vertical divider, the exact placeholder 发消息给 Hermes, and the up-arrow send button at the capsule's right.
- The paperclip icon and vertical divider must be INSIDE the capsule, not floating outside its left edge.
- The microphone stays OUTSIDE the capsule at the far right with comfortable separation.
- Both composer inputs are empty, so both send circles must be disabled pale taupe-gray, with low contrast pale up-arrow; do not use an enabled brown send button.
Keep the controls at the SAME HEIGHT AND SCALE as the original Image 1. Keep all other pixels, content, text, profiles, avatar initials 日 and 研, current profile dots, header gears, messages, global tabs, bottom safe areas, phone frames, background, top annotation 左右滑动，切换配置档案, center bidirectional arrow, dimensions and spacing unchanged. No extra text, no redesign, no new UI. Output the corrected two-phone landscape board only, clean sharp Chinese and consistent warm palette.
```
