// key.txt 可以继续增加「高德api4」等条目，按编号排序；环境变量仍优先。
export function parseAmapWebKeys(entries, override = "") {
  const localKeys = Object.entries(entries)
    .map(([name, value]) => ({ number: name.match(/^高德\s*api\s*(\d+)$/i)?.[1], value }))
    .filter(({ number }) => number !== undefined)
    .sort((a, b) => Number(a.number) - Number(b.number))
    .map(({ value }) => value);
  return [...new Set((override || localKeys.join(","))
    .split(",").map((key) => key.trim()).filter(Boolean))];
}

export function createAmapKeyRotation() {
  let cursor = 0;
  return (keys) => {
    if (!keys.length) return [];
    const start = cursor % keys.length;
    cursor = (start + 1) % keys.length;
    // 请求开始时确定全部候选，并发请求及失败重试不会互相改变顺序。
    return [...keys.slice(start), ...keys.slice(0, start)];
  };
}
