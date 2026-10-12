/**
 * 同步端到端加密（Wave11 阶段 A，契约冻结）。
 *
 * 设计约束（与通道传输完全解耦，WebDAV PUT 前加密、GET 后解密；FSA 不接）：
 *  - 零新依赖：只用 globalThis.crypto.subtle（Node 22 / 现代浏览器原生）。
 *  - KDF：PBKDF2，SHA-256，迭代次数固化 310_000（≥ OWASP 2023 建议），随机 salt 16B。
 *  - 对称：AES-GCM-256，每文件随机 12B nonce（GCM 标准推荐长度）。
 *  - 信封外层 JSON 明文【只含】格式版本 / 算法标识 / salt / 迭代次数 / nonce / 密文；
 *    不含任何文档内容、标题或块文本。
 *  - 本模块全部为纯函数 / 纯异步函数：不碰 DOM、不碰 localStorage、不发网络，便于单测。
 *
 * 信封形状（JSON，UTF-8）：
 * {
 *   "v": 1,                        // 格式版本（前向兼容：未知版本号直接报错，不静默解析）
 *   "kdf": "PBKDF2-SHA-256",
 *   "enc": "A256GCM",
 *   "it": 310000,                  // 迭代次数（与 salt 一起随包存放，解密自描述）
 *   "salt": "<base64url 16B>",
 *   "nonce": "<base64url 12B>",
 *   "ct": "<base64url 密文+GCM 认证标签>"
 * }
 */

export const ENVELOPE_VERSION = 1 as const;
export const KDF_ID = 'PBKDF2-SHA-256' as const;
export const CIPHER_ID = 'A256GCM' as const;
/** PBKDF2 迭代次数（冻结值；OWASP 2023 对 SHA-256 的建议下限即 310000）。 */
export const PBKDF2_ITERATIONS = 310_000 as const;
/**
 * 信封 it 上限：防远端坏档/恶意档声明超大迭代次数导致本地 PBKDF2 阻塞（CPU DoS）。
 * 本端产出恒为 310_000；历史/对端合法档均远低于此。越界按 bad-envelope 拒绝，
 * 在进入 deriveKey 之前失败。
 */
export const MAX_PBKDF2_ITERATIONS = 1_000_000 as const;
export const SALT_BYTES = 16 as const;
export const NONCE_BYTES = 12 as const;
export const KEY_BITS = 256 as const;

/** 自描述信封（外层 JSON 可被服务器看到的全部字段）。 */
export interface Envelope {
  v: number;
  kdf: typeof KDF_ID;
  enc: typeof CIPHER_ID;
  it: number;
  /** base64url（无填充）。 */
  salt: string;
  /** base64url（无填充）。 */
  nonce: string;
  /** base64url（无填充）：AES-GCM 输出 = 密文 ‖ 16B 认证标签。 */
  ct: string;
}

export type E2eeErrorKind = 'bad-envelope' | 'unsupported-version' | 'auth' | 'aborted';

export class E2eeError extends Error {
  readonly kind: E2eeErrorKind;
  constructor(kind: E2eeErrorKind, message: string) {
    super(message);
    this.name = 'E2eeError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// 编码辅助（纯函数，web/Node 通用，零依赖）
// ---------------------------------------------------------------------------

/** Uint8Array → base64url（无填充）。分块走 String.fromCharCode 避免栈溢出。 */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  // btoa 在 Node 18+ / 现代浏览器均全局可用。
  return btoa(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url（容忍标准 base64 与填充）→ Uint8Array。非法字符抛 E2eeError。 */
export function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  try {
    const bin = atob(b64 + pad);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    throw new E2eeError('bad-envelope', '信封 base64 非法');
  }
}

/** UTF-8 string → bytes。 */
export function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** bytes → UTF-8 string。 */
export function utf8Decode(b: Uint8Array): string {
  return new TextDecoder().decode(b);
}

// ---------------------------------------------------------------------------
// 信封 parse / serialize（纯函数；便于单测与未来版本演进）
// ---------------------------------------------------------------------------

/** 序列化为 UTF-8 JSON 字节（字段顺序固定，便于 diff/审计）。 */
export function serializeEnvelope(env: Envelope): Uint8Array {
  return utf8Encode(
    JSON.stringify({
      v: env.v,
      kdf: env.kdf,
      enc: env.enc,
      it: env.it,
      salt: env.salt,
      nonce: env.nonce,
      ct: env.ct,
    }),
  );
}

/**
 * 解析信封字节。任何结构不符 / 未知版本号都抛 E2eeError，绝不返回半成品。
 * 纯函数：只做校验与形状还原，不碰 crypto。
 */
export function parseEnvelope(envBytes: Uint8Array): Envelope {
  let raw: unknown;
  try {
    raw = JSON.parse(utf8Decode(envBytes));
  } catch {
    throw new E2eeError('bad-envelope', '信封不是合法 JSON');
  }
  if (typeof raw !== 'object' || raw === null) throw new E2eeError('bad-envelope', '信封不是对象');
  const o = raw as Record<string, unknown>;
  if (typeof o.v !== 'number') throw new E2eeError('bad-envelope', '信封缺版本号');
  if (o.v > ENVELOPE_VERSION) {
    throw new E2eeError('unsupported-version', `不支持的信封版本：${o.v}（本端最高 ${ENVELOPE_VERSION}）`);
  }
  if (o.v < ENVELOPE_VERSION) throw new E2eeError('unsupported-version', `信封版本过旧：${o.v}`);
  if (o.kdf !== KDF_ID) throw new E2eeError('bad-envelope', `不支持的 KDF：${String(o.kdf)}`);
  if (o.enc !== CIPHER_ID) throw new E2eeError('bad-envelope', `不支持的对称算法：${String(o.enc)}`);
  if (typeof o.it !== 'number' || !Number.isFinite(o.it) || o.it <= 0) {
    throw new E2eeError('bad-envelope', '信封迭代次数非法');
  }
  if (o.it > MAX_PBKDF2_ITERATIONS) {
    throw new E2eeError(
      'bad-envelope',
      `信封迭代次数过大（${o.it} > ${MAX_PBKDF2_ITERATIONS}），拒绝以避免本地派生阻塞`,
    );
  }
  if (typeof o.salt !== 'string' || typeof o.nonce !== 'string' || typeof o.ct !== 'string') {
    throw new E2eeError('bad-envelope', '信封字段缺失');
  }
  return { v: o.v, kdf: o.kdf, enc: o.enc, it: o.it, salt: o.salt, nonce: o.nonce, ct: o.ct };
}

// ---------------------------------------------------------------------------
// 底层 KDF / 原语
// ---------------------------------------------------------------------------

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new E2eeError('aborted', '当前环境不支持 Web Crypto（crypto.subtle 不可用）');
  return c.subtle;
}

function randomBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  globalThis.crypto.getRandomValues(buf);
  return buf;
}

/**
 * 会话内派生密钥缓存（Wave14 打磨）。
 *
 * 键 = `${passphrase}|${saltB64url}|${iterations}`：同一口令 + 同一 salt + 同一迭代次数
 * 不重复跑 310k 次 PBKDF2（一次派生约数百 ms，一轮同步可能解/封大量文档与资产）。
 *  - 仅内存（模块级 Map），绝不写 localStorage/sessionStorage 之外的持久层；
 *  - 页面刷新后 Map 随 JS 堆一起销毁，按原策略重新派生；
 *  - 缓存的是【Promise】而非 resolved key：同一键的并发派生只跑一次，不会竞态双派生；
 *  - 派生失败时从缓存剔除，允许下次重试。
 */
const derivedKeyCache = new Map<string, Promise<CryptoKey>>();

function keyCacheKey(passphrase: string, salt: Uint8Array, iterations: number): string {
  return `${passphrase}|${bytesToBase64Url(salt)}|${iterations}`;
}

/** 测试用：清空会话内派生密钥缓存（隔离单测用；生产不调用）。 */
export function __clearKeyCacheForTest(): void {
  derivedKeyCache.clear();
}

/** 测试用：当前缓存条目数（断言命中/隔离用；生产不调用）。 */
export function __derivedKeyCacheSizeForTest(): number {
  return derivedKeyCache.size;
}

/** 由口令 + salt 派生 AES-GCM 加密密钥（不可导出）。同键会话内缓存复用。 */
async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const cacheKey = keyCacheKey(passphrase, salt, iterations);
  const hit = derivedKeyCache.get(cacheKey);
  if (hit) return hit;
  const promise = (async () => {
    const baseKey = await subtle().importKey('raw', utf8Encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return subtle().deriveKey(
      { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
      baseKey,
      { name: 'AES-GCM', length: KEY_BITS },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  derivedKeyCache.set(cacheKey, promise);
  promise.catch(() => {
    // 派生失败：剔除缓存，避免一个坏键永久占位导致后续必然失败。
    if (derivedKeyCache.get(cacheKey) === promise) derivedKeyCache.delete(cacheKey);
  });
  return promise;
}

// ---------------------------------------------------------------------------
// 高层信封 API（纯异步）
// ---------------------------------------------------------------------------

export interface EncryptOptions {
  /** 测试可注入固定 salt/nonce/迭代；默认全部随机 + 固化参数。 */
  salt?: Uint8Array;
  nonce?: Uint8Array;
  iterations?: number;
}

/**
 * 加密一段明文 → 自描述信封字节（UTF-8 JSON）。
 * 默认：随机 16B salt、随机 12B nonce、310_000 次 PBKDF2。
 */
export async function encryptBundle(
  plaintext: Uint8Array,
  passphrase: string,
  opts: EncryptOptions = {},
): Promise<Uint8Array> {
  const salt = opts.salt ?? randomBytes(SALT_BYTES);
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES);
  const it = opts.iterations ?? PBKDF2_ITERATIONS;
  const key = await deriveKey(passphrase, salt, it);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource));
  return serializeEnvelope({
    v: ENVELOPE_VERSION,
    kdf: KDF_ID,
    enc: CIPHER_ID,
    it,
    salt: bytesToBase64Url(salt),
    nonce: bytesToBase64Url(nonce),
    ct: bytesToBase64Url(ct),
  });
}

/**
 * 解密信封字节 → 明文。口令错误 / 密文被篡改 → 抛 E2eeError('auth')（GCM 认证失败）。
 * 不返回 null：失败一律显式抛错，由通道层转 toast，绝不把密文当明文喂给上层。
 */
export async function decryptBundle(envelopeBytes: Uint8Array, passphrase: string): Promise<Uint8Array> {
  const env = parseEnvelope(envelopeBytes);
  const salt = base64UrlToBytes(env.salt);
  const nonce = base64UrlToBytes(env.nonce);
  const ct = base64UrlToBytes(env.ct);
  try {
    const key = await deriveKey(passphrase, salt, env.it);
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ct as BufferSource);
    return new Uint8Array(pt);
  } catch (e) {
    if (e instanceof E2eeError) throw e;
    // Web Crypto 在认证失败时抛 OperationError；映射成明确的 auth 错误。
    throw new E2eeError('auth', '端到端加密口令不正确，或数据已被篡改');
  }
}
