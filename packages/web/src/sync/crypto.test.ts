// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import {
  encryptBundle,
  decryptBundle,
  parseEnvelope,
  serializeEnvelope,
  bytesToBase64Url,
  base64UrlToBytes,
  ENVELOPE_VERSION,
  KDF_ID,
  CIPHER_ID,
  PBKDF2_ITERATIONS,
  SALT_BYTES,
  NONCE_BYTES,
  E2eeError,
  __clearKeyCacheForTest,
  __derivedKeyCacheSizeForTest,
  type Envelope,
} from './crypto';

/**
 * Wave11 E2EE 单测：真实 Web Crypto（Node 22 自带 crypto.subtle）。
 * 不 mock 加密原语——往返/认证失败/篡改检测都走真实 AES-GCM。
 */

const TEXT = '来自A：文档标题《秘密计划》{ "blocks": ["吃早饭", "写代码"] }';
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('crypto.ts 信封往返', () => {
  it('加密→解密还原明文（含中文/JSON 特殊字符）', async () => {
    const env = await encryptBundle(bytes(TEXT), 'correct horse battery staple');
    const out = await decryptBundle(env, 'correct horse battery staple');
    expect(new TextDecoder().decode(out)).toBe(TEXT);
  });

  it('信封为自描述 JSON：字段齐全且不含明文', async () => {
    const envBytes = await encryptBundle(bytes(TEXT), 'pw');
    const env = parseEnvelope(envBytes);
    expect(env.v).toBe(ENVELOPE_VERSION);
    expect(env.kdf).toBe(KDF_ID);
    expect(env.enc).toBe(CIPHER_ID);
    // 外层 JSON 明文里绝不能出现任何文档内容。
    const outer = new TextDecoder().decode(envBytes);
    expect(outer).not.toContain('秘密计划');
    expect(outer).not.toContain('吃早饭');
    expect(outer).not.toContain('文档标题');
  });
});

describe('crypto.ts 随机性与参数固化', () => {
  it('两次加密同明文产出不同信封（salt/nonce 随机）', async () => {
    const a = await encryptBundle(bytes(TEXT), 'pw');
    const b = await encryptBundle(bytes(TEXT), 'pw');
    const ea = parseEnvelope(a);
    const eb = parseEnvelope(b);
    expect(ea.salt).not.toBe(eb.salt);
    expect(ea.nonce).not.toBe(eb.nonce);
    expect(ea.ct).not.toBe(eb.ct);
    // 密文仍可各自解开。
    expect(new TextDecoder().decode(await decryptBundle(a, 'pw'))).toBe(TEXT);
    expect(new TextDecoder().decode(await decryptBundle(b, 'pw'))).toBe(TEXT);
  });

  it('默认参数固化：迭代 310000、salt 16B、nonce 12B', async () => {
    expect(PBKDF2_ITERATIONS).toBe(310000);
    expect(SALT_BYTES).toBe(16);
    expect(NONCE_BYTES).toBe(12);
    const env = parseEnvelope(await encryptBundle(bytes('x'), 'pw'));
    expect(env.it).toBe(310000);
    expect(base64UrlToBytes(env.salt).length).toBe(16);
    expect(base64UrlToBytes(env.nonce).length).toBe(12);
  });

  it('注入固定 salt/nonce 时信封确定性可复算', async () => {
    const salt = new Uint8Array(16).fill(7);
    const nonce = new Uint8Array(12).fill(9);
    const a = await encryptBundle(bytes('deterministic'), 'pw', { salt, nonce });
    const b = await encryptBundle(bytes('deterministic'), 'pw', { salt, nonce });
    expect(Buffer.from(a).toString()).toBe(Buffer.from(b).toString());
  });
});

describe('crypto.ts 认证失败与篡改检测', () => {
  it('错误口令必抛 E2eeError(auth)', async () => {
    const env = await encryptBundle(bytes(TEXT), 'right-passphrase');
    await expect(decryptBundle(env, 'wrong-passphrase')).rejects.toMatchObject({
      name: 'E2eeError',
      kind: 'auth',
    });
  });

  it('篡改密文任意字节 → GCM 认证失败抛 auth', async () => {
    const env = parseEnvelope(await encryptBundle(bytes(TEXT), 'pw'));
    const ct = base64UrlToBytes(env.ct);
    ct[ct.length - 1] = (ct[ct.length - 1] ?? 0) ^ 0xff; // 翻转认证标签最后一字节
    const tampered: Envelope = { ...env, ct: bytesToBase64Url(ct) };
    await expect(decryptBundle(serializeEnvelope(tampered), 'pw')).rejects.toMatchObject({
      name: 'E2eeError',
      kind: 'auth',
    });
  });

  it('篡改 nonce → auth 失败', async () => {
    const env = parseEnvelope(await encryptBundle(bytes(TEXT), 'pw'));
    const nonce = base64UrlToBytes(env.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 0x01;
    const tampered: Envelope = { ...env, nonce: bytesToBase64Url(nonce) };
    await expect(decryptBundle(serializeEnvelope(tampered), 'pw')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('非信封 JSON 抛 bad-envelope', async () => {
    await expect(decryptBundle(bytes('{"hello":"world"}'), 'pw')).rejects.toBeInstanceOf(E2eeError);
  });

  it('过高信封版本号抛 unsupported-version（不静默解析）', async () => {
    const future: Envelope = { v: 999, kdf: KDF_ID, enc: CIPHER_ID, it: 310000, salt: bytesToBase64Url(new Uint8Array(16)), nonce: bytesToBase64Url(new Uint8Array(12)), ct: bytesToBase64Url(new Uint8Array(16)) };
    expect(() => parseEnvelope(serializeEnvelope(future))).toThrowError(/不支持的信封版本/);
  });
});

describe('crypto.ts base64url 编解码', () => {
  it('往返：任意字节（含 0x00 / 0xff）', () => {
    const data = new Uint8Array(32);
    for (let i = 0; i < data.length; i++) data[i] = i * 7;
    data[0] = 0;
    data[31] = 255;
    expect([...base64UrlToBytes(bytesToBase64Url(data))]).toEqual([...data]);
  });
});

describe('crypto.ts PBKDF2 派生密钥会话内缓存（Wave14）', () => {
  beforeEach(() => __clearKeyCacheForTest());

  it('同口令同 salt 不重复派生：第二次 subtle.deriveKey 调用数不增', async () => {
    const subtleApi = globalThis.crypto.subtle;
    const origDerive = subtleApi.deriveKey.bind(subtleApi) as typeof subtleApi.deriveKey;
    let deriveCalls = 0;
    // 包一层计数：证明命中缓存时不再跑 PBKDF2（deriveKey）。
    subtleApi.deriveKey = ((...args: Parameters<typeof origDerive>) => {
      deriveCalls += 1;
      return origDerive(...args);
    }) as typeof origDerive;

    try {
      const salt = new Uint8Array(16).fill(3);
      await encryptBundle(bytes('first'), 'pw-cache', { salt, nonce: new Uint8Array(12).fill(5) });
      expect(deriveCalls).toBe(1);
      // 第二次：同口令同 salt，nonce 不同（缓存键不含 nonce）→ 应命中缓存，不再派生。
      await encryptBundle(bytes('second'), 'pw-cache', { salt, nonce: new Uint8Array(12).fill(6) });
      expect(deriveCalls, '同口令同 salt 第二次不应再跑 PBKDF2 派生').toBe(1);
      // 命中缓存解出的 key 仍可正确加解密。
      const env = await encryptBundle(bytes('roundtrip'), 'pw-cache', { salt, nonce: new Uint8Array(12).fill(7) });
      expect(new TextDecoder().decode(await decryptBundle(env, 'pw-cache'))).toBe('roundtrip');
      expect(deriveCalls, '解密同 salt 也命中缓存').toBe(1);
    } finally {
      subtleApi.deriveKey = origDerive;
      __clearKeyCacheForTest();
    }
  });

  it('缓存隔离：不同 salt / 口令互不串键，各自派生独立密钥', async () => {
    const saltA = new Uint8Array(16).fill(1);
    const saltB = new Uint8Array(16).fill(2);
    const envA = await encryptBundle(bytes('aaa'), 'pass-A', { salt: saltA, nonce: new Uint8Array(12).fill(1) });
    const envB = await encryptBundle(bytes('bbb'), 'pass-B', { salt: saltB, nonce: new Uint8Array(12).fill(2) });
    // 两个不同键各派生一次，缓存里恰好两条。
    expect(__derivedKeyCacheSizeForTest()).toBe(2);
    // 各自口令解开各自密文。
    expect(new TextDecoder().decode(await decryptBundle(envA, 'pass-A'))).toBe('aaa');
    expect(new TextDecoder().decode(await decryptBundle(envB, 'pass-B'))).toBe('bbb');
    // 交叉口令解不开（GCM 认证失败），证明没有串键。
    await expect(decryptBundle(envA, 'pass-B')).rejects.toMatchObject({ kind: 'auth' });
    await expect(decryptBundle(envB, 'pass-A')).rejects.toMatchObject({ kind: 'auth' });
  });

  it('缓存仅内存：清空后同口令同 salt 重新派生', async () => {
    const subtleApi = globalThis.crypto.subtle;
    const origDerive = subtleApi.deriveKey.bind(subtleApi) as typeof subtleApi.deriveKey;
    let deriveCalls = 0;
    subtleApi.deriveKey = ((...args: Parameters<typeof origDerive>) => {
      deriveCalls += 1;
      return origDerive(...args);
    }) as typeof origDerive;
    try {
      const salt = new Uint8Array(16).fill(8);
      await encryptBundle(bytes('x'), 'pw-evict', { salt, nonce: new Uint8Array(12).fill(9) });
      expect(deriveCalls).toBe(1);
      __clearKeyCacheForTest(); // 模拟页面刷新后的内存态
      await encryptBundle(bytes('y'), 'pw-evict', { salt, nonce: new Uint8Array(12).fill(10) });
      expect(deriveCalls, '清空缓存后应重新派生').toBe(2);
    } finally {
      subtleApi.deriveKey = origDerive;
      __clearKeyCacheForTest();
    }
  });
});

describe('crypto.ts 信封迭代次数上限（防远端坏档本地派生阻塞）', () => {
  const validSalt = bytesToBase64Url(new Uint8Array(16));
  const validNonce = bytesToBase64Url(new Uint8Array(12));
  const validCt = bytesToBase64Url(new Uint8Array(32));
  function envWithIt(it: unknown): Envelope {
    return { v: ENVELOPE_VERSION, kdf: KDF_ID, enc: CIPHER_ID, it: it as number, salt: validSalt, nonce: validNonce, ct: validCt };
  }

  it.each([1e10, 10_000_000, 1_000_001])(
    'it=%i 越上限 → bad-envelope，且完全不进入 deriveKey/PBKDF2',
    async (it) => {
      const subtleApi = globalThis.crypto.subtle;
      const origDerive = subtleApi.deriveKey.bind(subtleApi) as typeof subtleApi.deriveKey;
      let deriveCalls = 0;
      subtleApi.deriveKey = ((...args: Parameters<typeof origDerive>) => {
        deriveCalls += 1;
        return origDerive(...args);
      }) as typeof origDerive;
      try {
        const p = serializeEnvelope(envWithIt(it));
        expect(() => parseEnvelope(p)).toThrowError(/迭代次数过大/);
        await expect(decryptBundle(p, 'pw')).rejects.toMatchObject({ name: 'E2eeError', kind: 'bad-envelope' });
        expect(deriveCalls, '越上限信封绝不应触发 PBKDF2 派生').toBe(0);
      } finally {
        subtleApi.deriveKey = origDerive;
      }
    },
  );

  it.each([-5, 0, Number('NaN')] as unknown[])('it=%s 非法 → bad-envelope', (it) => {
    expect(() => parseEnvelope(serializeEnvelope(envWithIt(it)))).toThrow(E2eeError);
    expect(() => parseEnvelope(serializeEnvelope(envWithIt(it)))).toThrowError(/迭代次数/);
  });

  it('合法 it=310000（本端产出）正常解析与往返', async () => {
    const envBytes = await encryptBundle(bytes('ok'), 'pw-cap');
    const env = parseEnvelope(envBytes);
    expect(env.it).toBe(310000);
    expect(new TextDecoder().decode(await decryptBundle(envBytes, 'pw-cap'))).toBe('ok');
  });
});
