import { z } from 'zod';
import type { ZodError } from 'zod';
import { DOC_FORMAT, CURRENT_DOC_VERSION } from './constants.js';
import { DEFAULT_EDGE_COLOR } from './edge-colors.js';
import type { BlockNode } from './node.js';
import type { Edge } from './edge.js';
import { SyncBlockSchema } from '../sync/types.js';

/**
 * Zod 校验。
 * 目标：parseKBNoteDoc 能安全解析未知来源 JSON，剥离未知字段、对可容错字段给默认值；
 * 结构性约束（环/多父/悬空边）由 validateGraph 在本文件尾部做。
 *
 * 容错策略（与任务约定一致）：
 * - 缺失可选字段填默认值：pinned/locked/collapsed=false、tags=[]、label=''、directed=true、
 *   edge.style.color 缺省取 DEFAULT_EDGE_COLOR、viewport/page/layout 缺省给默认。
 * - 未知字段 zod 自动剥离（非 strict 模式）。
 * - 数值字段非法（NaN/Infinity）报错；尺寸 width/height 必须为正数。
 */

// ---- 基础数值守卫：拒绝 NaN / Infinity ----
const finiteNumber = z
  .number()
  .refine((v) => Number.isFinite(v), 'must be a finite number (NaN/Infinity not allowed)');

const HandlePositionSchema = z.enum(['top', 'right', 'bottom', 'left']);

const BlockContentSchema = z.object({
  format: z.literal('tiptap-json'),
  // Tiptap doc 形状由 web 侧负责，core 宽松承载。
  data: z.unknown(),
});

const BlockStyleSchema = z
  .object({
    color: z.string().optional(),
    bg: z.string().optional(),
    border: z.string().optional(),
  })
  .partial();

export const BlockNodeSchema = z.object({
  id: z.string().min(1),
  // 附加式兼容（不升 schema 版本）：未知 type（未来版本/外部档）回退最通用的文本块，
  // 节点其余字段（content/data 等）原样保留，不因枚举拒档。与 layout.mode 的 .catch 策略一致。
  type: z
    .enum([
      'text',
      'heading',
      'todo',
      'bullet',
      'image',
      'note',
      'group',
      // P1 预留
      'table',
      'code',
      'equation',
      'bookmark',
      'attachment',
      'reminder',
    ])
    .catch('text'),
  x: finiteNumber,
  y: finiteNumber,
  width: finiteNumber.refine((v) => v > 0, 'width must be a positive number'),
  height: finiteNumber.refine((v) => v > 0, 'height must be a positive number'),
  content: BlockContentSchema,
  parentId: z.string().nullish().default(null),
  pinned: z.boolean().default(false),
  locked: z.boolean().default(false),
  collapsed: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  style: BlockStyleSchema.default({}),
  // 块特有可选字段（宽松：存在即透传，不做深度收窄）
  todo: z.object({ checked: z.boolean() }).optional(),
  image: z.object({ src: z.string(), alt: z.string().optional() }).optional(),
  heading: z.object({ level: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional() }).optional(),
  bookmark: z.object({ url: z.string().optional() }).optional(),
  attachment: z.object({ assetRef: z.string().optional(), name: z.string().optional() }).optional(),
  reminder: z.object({ dueAt: z.number().optional() }).optional(),
});

// ---- 边（无 relation/line/direction 字段；v2 起允许 points）----
const EdgeStyleSchema = z.object({
  color: z.string().default(DEFAULT_EDGE_COLOR.hex),
});

/** 手动弯折点（世界坐标）。未知键剥离；x/y 必须有限数。 */
export const EdgePointSchema = z.object({
  x: finiteNumber,
  y: finiteNumber,
});

export const EdgeSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  target: z.string().min(1),
  sourceHandle: HandlePositionSchema.default('right'),
  targetHandle: HandlePositionSchema.default('left'),
  label: z.string().default(''),
  directed: z.literal(true).default(true),
  style: EdgeStyleSchema.default({ color: DEFAULT_EDGE_COLOR.hex }),
  // v2：手动弯折点，最多 64 个；缺省/空数组 = 默认贝塞尔。
  points: z.array(EdgePointSchema).max(64, 'points 最多 64 个弯折点').optional(),
});

// ---- 文档引用链接（v2）----
export const DocRefLinkSchema = z.object({
  id: z.string().min(1),
  sourceDocId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  targetDocId: z.string().min(1),
  targetNodeId: z.string().min(1),
  targetTitle: z.string(),
  createdAt: finiteNumber,
});

// ---- 其余顶层对象 ----
export const TagSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  color: z.string(),
});

export const LayoutPrefsSchema = z.object({
  // Wave21：枚举附加式新增 'flow-layered'（不升 schema 版本、不写迁移）。
  // 宽容解析：未知/非法 mode 值一律回退 'mindmap-down'（.catch），
  // 任何历史/未来非法 mode 都不会导致文档打开失败（参照 Wave20 附加 kind 不升版本的思路）。
  mode: z
    .enum(['mindmap-right', 'mindmap-down', 'org-tree', 'radial', 'flow-layered'])
    .catch('mindmap-down')
    .default('mindmap-right'),
  rankSpacing: finiteNumber.default(90),
  nodeSpacing: finiteNumber.default(28),
});

export const ViewportSchema = z.object({
  x: finiteNumber.default(0),
  y: finiteNumber.default(0),
  zoom: finiteNumber.default(1),
});

export const PageSettingsSchema = z.object({
  size: z.literal('A4').default('A4'),
  // 附加式兼容（不升版本）：未知枚举值回退各自默认分页设置，整文档不拒开，与 layout.mode 一致。
  orientation: z.enum(['portrait', 'landscape']).catch('portrait').default('portrait'),
  marginMm: z.union([z.literal(10), z.literal(15), z.literal(20)]).catch(15).default(15),
  mode: z.enum(['fit', 'tiles', 'flow']).catch('fit').default('fit'),
  showPageBreak: z.boolean().default(true),
  colorMode: z.enum(['color', 'gray']).catch('color').default('color'),
  header: z.boolean().default(false),
  footer: z.boolean().default(false),
  showPageNumbers: z.boolean().default(false),
  edgeLabels: z.boolean().default(true),
  pageBreaks: z.array(z.object({ at: z.number() })).default([]),
  pageOrigin: z.object({ x: z.number(), y: z.number() }).optional(),
});

export const KBNoteDocSchema = z.object({
  format: z.literal(DOC_FORMAT),
  version: z.literal(CURRENT_DOC_VERSION),
  id: z.string().min(1),
  title: z.string().default('未命名画布'),
  board: z
    .object({ createdAt: finiteNumber, updatedAt: finiteNumber })
    .default({ createdAt: 0, updatedAt: 0 }),
  nodes: z.array(BlockNodeSchema).default([]),
  edges: z.array(EdgeSchema).default([]),
  tags: z.array(TagSchema).default([]),
  layout: LayoutPrefsSchema.default({ mode: 'mindmap-right', rankSpacing: 90, nodeSpacing: 28 }),
  viewport: ViewportSchema.default({ x: 0, y: 0, zoom: 1 }),
  page: PageSettingsSchema.default({}),
  assetRefs: z.array(z.string()).default([]),
  links: z.array(DocRefLinkSchema).default([]),
  // v3：跨设备同步元数据（版本向量/字段时钟/墓碑）。旧档经迁移补齐；缺省为空块。
  sync: SyncBlockSchema.default(() => ({ vv: {} })),
});

// ---- 类型化解析错误 ----

/** 单条校验错误：带 dotted path 信息，便于 UI 定位。 */
export interface KBNoteIssue {
  path: string;
  message: string;
}

/**
 * parseKBNoteDoc 失败时抛出的类型化错误。
 * 包装 zod 校验结果，暴露逐字段路径，而非裸 ZodError。
 */
export class KBNoteParseError extends Error {
  readonly issues: readonly KBNoteIssue[];

  constructor(zodError: ZodError) {
    const issues: KBNoteIssue[] = zodError.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    super(
      `KBNote 文档校验失败（${issues.length} 处）：\n` +
        issues.map((i) => `  at ${i.path || '<root>'}: ${i.message}`).join('\n'),
    );
    this.name = 'KBNoteParseError';
    this.issues = issues;
  }
}

// ---- 图结构校验问题（可辨识联合）----

/**
 * 图校验问题。code 为可辨识联合判别字段，每种 issue 携带各自负载。
 * 与 graph 模块的 analyzeGraph 互补：这里返回「一条条问题」供 store/UI 精确处理。
 */
export type ValidationIssue =
  | { code: 'self-loop'; edgeId: string; nodeId: string }
  | {
      code: 'dangling-edge';
      edgeId: string;
      /** 缺失端点是 source 还是 target。 */
      endpoint: 'source' | 'target';
      /** 缺失的节点 id。 */
      missingNodeId: string;
    }
  | {
      code: 'duplicate-edge';
      edgeId: string;
      /** 同一 source→target 第一次出现的边 id。 */
      firstEdgeId: string;
      source: string;
      target: string;
    }
  | {
      code: 'multi-parent';
      nodeId: string;
      /** 指向该节点的全部入边 id（按 edges 数组顺序）。 */
      parentEdgeIds: string[];
      /** 入边对应父节点 id（与 parentEdgeIds 对齐）。 */
      parentIds: string[];
    }
  | { code: 'cycle'; nodeIds: string[]; edgeIds: string[] }
  | {
      code: 'parentid-mismatch';
      nodeId: string;
      /** 节点上声明的 parentId。 */
      declaredParentId: string | null;
      /** 由 edges 推导的父（首条有效入边的 source）。 */
      derivedParentId: string | null;
    };

/** 有向环检测结果内部结构。 */
interface DetectedCycle {
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * DFS 着色（白/灰/黑）找有向环。自环也算环。
 * 只考虑端点均存在的边；按 nodes/edges 数组顺序遍历，结果确定性。
 */
function findDirectedCycles(nodes: BlockNode[], edges: Edge[]): DetectedCycle[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  const adj = new Map<string, { to: string; edgeId: string }[]>();
  for (const edge of edges) {
    if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
    const list = adj.get(edge.source) ?? [];
    list.push({ to: edge.target, edgeId: edge.id });
    adj.set(edge.source, list);
  }

  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const n of nodes) color.set(n.id, WHITE);

  const cycles: DetectedCycle[] = [];
  const seen = new Set<string>();
  // 当前 DFS 栈：节点 + 进入该节点的边 id
  const stack: { node: string; edgeId: string | null }[] = [];
  const onStack = new Map<string, number>();

  const dfs = (u: string, incomingEdgeId: string | null): void => {
    color.set(u, GRAY);
    stack.push({ node: u, edgeId: incomingEdgeId });
    onStack.set(u, stack.length - 1);
    for (const { to, edgeId } of adj.get(u) ?? []) {
      const c = color.get(to) ?? WHITE;
      if (c === GRAY) {
        const idx = onStack.get(to);
        if (idx === undefined) continue;
        const slice = stack.slice(idx);
        const cycleNodes = slice.map((s) => s.node);
        // slice[0] 是环起点 to，其 edgeId 不属于环；后续节点的 edgeId 即环上有向边。
        const cycleEdges = slice.slice(1).map((s) => s.edgeId as string);
        cycleEdges.push(edgeId); // 闭合边 u -> to
        const key = cycleEdges.slice().sort().join('|');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push({ nodeIds: [...cycleNodes, to], edgeIds: cycleEdges });
        }
      } else if (c === WHITE) {
        dfs(to, edgeId);
      }
    }
    stack.pop();
    onStack.delete(u);
    color.set(u, BLACK);
  };

  for (const n of nodes) {
    if (color.get(n.id) === WHITE) dfs(n.id, null);
  }
  return cycles;
}

/**
 * 安全解析未知 JSON 为 KBNoteDoc。
 * 失败抛 KBNoteParseError（带逐字段路径）。未知字段被 zod 自动剥离。
 */
export function parseKBNoteDoc(input: unknown): import('./doc.js').KBNoteDoc {
  const result = KBNoteDocSchema.safeParse(input);
  if (!result.success) {
    throw new KBNoteParseError(result.error);
  }
  return result.data as import('./doc.js').KBNoteDoc;
}

/** safeParse 的判别联合结果。 */
export type SafeParseKBNoteResult =
  | { success: true; doc: import('./doc.js').KBNoteDoc }
  | { success: false; error: KBNoteParseError };

/** 宽松解析，不抛错。 */
export function safeParseKBNoteDoc(input: unknown): SafeParseKBNoteResult {
  const result = KBNoteDocSchema.safeParse(input);
  if (!result.success) {
    return { success: false, error: new KBNoteParseError(result.error) };
  }
  return { success: true, doc: result.data as import('./doc.js').KBNoteDoc };
}

/**
 * 校验图结构：自环 / 悬空边 / 重复边 / 多父 / 有向环 / parentId 不一致。
 * 纯结构检查，不修改入参；每条 issue 携带可辨识负载，供 UI 精确弹窗。
 */
export function validateGraph(nodes: BlockNode[], edges: Edge[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  // 入边索引（端点均存在、且非自环）：target -> [{ edgeId, parentId }]
  const incoming = new Map<string, { edgeId: string; parentId: string }[]>();

  for (const edge of edges) {
    if (edge.source === edge.target) {
      issues.push({ code: 'self-loop', edgeId: edge.id, nodeId: edge.source });
    }
    if (!nodeIds.has(edge.source)) {
      issues.push({
        code: 'dangling-edge',
        edgeId: edge.id,
        endpoint: 'source',
        missingNodeId: edge.source,
      });
    }
    if (!nodeIds.has(edge.target)) {
      issues.push({
        code: 'dangling-edge',
        edgeId: edge.id,
        endpoint: 'target',
        missingNodeId: edge.target,
      });
    }
    if (
      nodeIds.has(edge.source) &&
      nodeIds.has(edge.target) &&
      edge.source !== edge.target
    ) {
      const list = incoming.get(edge.target) ?? [];
      list.push({ edgeId: edge.id, parentId: edge.source });
      incoming.set(edge.target, list);
    }
  }

  // 重复边：同一 source→target 第二次起记为重复
  const seenPairs = new Map<string, string>();
  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`;
    const first = seenPairs.get(key);
    if (first !== undefined) {
      issues.push({
        code: 'duplicate-edge',
        edgeId: edge.id,
        firstEdgeId: first,
        source: edge.source,
        target: edge.target,
      });
    } else {
      seenPairs.set(key, edge.id);
    }
  }

  // 多父：入度 > 1
  for (const [nodeId, list] of incoming) {
    if (list.length > 1) {
      issues.push({
        code: 'multi-parent',
        nodeId,
        parentEdgeIds: list.map((x) => x.edgeId),
        parentIds: list.map((x) => x.parentId),
      });
    }
  }

  // 有向环
  for (const c of findDirectedCycles(nodes, edges)) {
    issues.push({ code: 'cycle', nodeIds: c.nodeIds, edgeIds: c.edgeIds });
  }

  // parentId 一致性：声明的 parentId 与首条有效入边推导的父对比
  for (const node of nodes) {
    const list = incoming.get(node.id);
    const derivedParent = list && list.length > 0 ? (list[0] as { parentId: string }).parentId : null;
    const declared = node.parentId;
    if (derivedParent !== declared) {
      issues.push({
        code: 'parentid-mismatch',
        nodeId: node.id,
        declaredParentId: declared,
        derivedParentId: derivedParent,
      });
    }
  }

  return issues;
}
