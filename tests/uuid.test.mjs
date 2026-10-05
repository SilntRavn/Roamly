import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { newId } from '../src/uuid.mjs';

test('HTTP WebView without randomUUID can create distinct RFC 4122 v4 item IDs', () => {
  const httpCrypto = { getRandomValues: (bytes) => webcrypto.getRandomValues(bytes) };
  const ids = new Set(Array.from({ length: 100 }, () => newId(httpCrypto)));
  assert.equal(ids.size, 100);
  for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
