const assert = require("node:assert/strict");
const test = require("node:test");
const { formatTopicTime, groupTopics } = require("../src/chat/topic-groups.ts");

process.env.TZ = "Asia/Shanghai";
const now = new Date("2026-03-31T04:00:00Z");

test("会话按本地日期和最后活动倒序分组，月底回退到上月最后一天", () => {
  const topics = [
    { id: "older", updated_at: "2026-02-27T15:59:59Z" },
    { id: "month", updated_at: "2026-02-27T16:00:00Z" },
    { id: "yesterday", updated_at: "2026-03-30T15:59:59Z" },
    { id: "today", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-03-30T16:00:00Z" },
    { id: "first", updated_at: "2026-03-31T01:00:00Z" },
    { id: "week", updated_at: "2026-03-23T16:00:00Z" },
    { id: "before-week", updated_at: "2026-03-23T15:59:59Z" },
  ];
  assert.deepEqual(groupTopics(topics, now).map(({ title, rows }) => [title, rows.map(({ id }) => id)]), [
    ["今天", ["first", "today"]],
    ["昨天", ["yesterday"]],
    ["7天内", ["week"]],
    ["一个月内", ["before-week", "month"]],
    ["一个月前", ["older"]],
  ]);
});

test("隐藏空分组，保留只有创建时间或旧缓存中没有时间的会话", () => {
  const rows = [{ id: "new", created_at: "2026-03-31T02:00:00Z" }, { id: "cached" }];
  assert.deepEqual(groupTopics(rows, now), [
    { title: "今天", rows: [rows[0]] }, { title: undefined, rows: [rows[1]] },
  ]);
  assert.deepEqual(groupTopics([], now), []);
});

test("每个时间独立按本地日期显示，今天保留秒数", () => {
  assert.equal(formatTopicTime("2026-03-30T16:00:05Z", now), "00:00:05");
  assert.equal(formatTopicTime("2026-03-30T15:59:59Z", now), "2026年3月30日");
  assert.equal(formatTopicTime(undefined, now), "—");
});
