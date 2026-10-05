// 限制外部请求并发，并按输入顺序返回结果。
export async function mapConcurrent(values, limit, task) {
  const results = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await task(values[index], index);
    }
  }));
  return results;
}
