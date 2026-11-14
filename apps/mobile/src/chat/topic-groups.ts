type TopicTimes = { created_at?: string | number; updated_at?: string | number };

export function groupTopics<T extends TopicTimes>(topics: readonly T[], now: Date) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const day = now.getDate();
  const lastMonthDay = Math.min(day, new Date(year, month, 0).getDate());
  const groups: { title: string; since: number; rows: { row: T; time: number }[] }[] = [
    { title: "今天", since: new Date(year, month, day).getTime(), rows: [] },
    { title: "昨天", since: new Date(year, month, day - 1).getTime(), rows: [] },
    { title: "7天内", since: new Date(year, month, day - 7).getTime(), rows: [] },
    { title: "一个月内", since: new Date(year, month - 1, lastMonthDay).getTime(), rows: [] },
    { title: "一个月前", since: -Infinity, rows: [] },
  ];
  const undated: T[] = [];
  for (const row of topics) {
    const time = new Date(row.updated_at ?? row.created_at ?? NaN).getTime();
    const group = groups.find(({ since }) => time >= since);
    if (group) group.rows.push({ row, time });
    else undated.push(row);
  }
  const result: { title: string | undefined; rows: T[] }[] = groups.filter(({ rows }) => rows.length > 0)
    .map(({ title, rows }) => ({ title, rows: rows.sort((a, b) => b.time - a.time).map(({ row }) => row) }));
  if (undated.length) result.push({ title: undefined, rows: undated });
  return result;
}

export function formatTopicTime(value: string | number | undefined, now: Date) {
  const date = new Date(value ?? NaN);
  if (Number.isNaN(date.getTime())) return "—";
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
