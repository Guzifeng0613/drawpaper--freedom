import type { ClientId } from './identity.js';
import type { EventMarker } from './clock.js';

/**
 * 并发冲突记录：LWW 裁决时「败方不静默丢弃」，写入 conflicts 供 UI 横幅/列表展示。
 */

/** 冲突涉及的实体类型。 */
export type ConflictEntity = 'node' | 'edge' | 'doc' | 'page';

/**
 * 冲突种类：
 * - reparent = 同一节点并发改挂到不同父（结构性）；
 * - field-lww = 同字段并发写；
 * - edge-orphaned = 边的某个端点节点在合并后被墓碑删除，边因端点消失被丢弃；
 * - edge-dropped = 边的某个端点节点在合并后不存在（既不在存活集也无墓碑，幽灵引用），边被丢弃。
 */
export type ConflictKind = 'reparent' | 'field-lww' | 'edge-orphaned' | 'edge-dropped';

/** 冲突一方（赢家或输家）的定位与取值。 */
export interface ConflictSide {
  clientId: ClientId;
  lamport: number;
  /** 该方写入的值（已按 JSON 可序列化方式快照）。 */
  value: unknown;
}

/** 一条不可自动调和的并发冲突。 */
export interface CollabConflict {
  entity: ConflictEntity;
  /** 实体 id（doc/page 类为 null）。 */
  entityId: string | null;
  /** 发生冲突的字段名（BlockNode/Edge 的键）。 */
  field: string;
  kind: ConflictKind;
  winner: ConflictSide;
  loser: ConflictSide;
  /** 可读原因（中文，给技术排查与 UI tooltip）。 */
  reason: string;
}

/** 字段 → 中文标签（展示给用户）。 */
const FIELD_LABELS: Record<string, string> = {
  parentId: '父级归属',
  x: 'X 坐标',
  y: 'Y 坐标',
  width: '宽度',
  height: '高度',
  content: '块内容',
  pinned: '固定状态',
  locked: '锁定状态',
  collapsed: '折叠状态',
  tags: '标签',
  style: '样式',
  type: '块类型',
  todo: '待办勾选',
  image: '图片',
  heading: '标题层级',
  bookmark: '书签',
  attachment: '附件',
  reminder: '提醒',
  source: '连线起点',
  target: '连线终点',
  sourceHandle: '起点句柄',
  targetHandle: '终点句柄',
  label: '边标签',
  color: '颜色',
  points: '弯折点',
  title: '文档标题',
  orientation: '页面方向',
  marginMm: '页边距',
  mode: '分页模式',
  pageBreaks: '分页符',
  pageOrigin: '分页原点',
};

/** 把任意 value 压成一行可读摘要（超长截断）。 */
function summarizeValue(v: unknown): string {
  if (v === undefined) return '（无）';
  if (v === null) return '（空）';
  if (typeof v === 'string') return v.length > 24 ? `${v.slice(0, 24)}…` : v || '（空串）';
  try {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return s.length > 48 ? `${s.slice(0, 48)}…` : s;
  } catch {
    return String(v);
  }
}

/** clientId → 标签页名 的可选映射（UI 传进来，文案更友好）。 */
export type NameMap = Map<ClientId, string>;

function nameOf(names: NameMap | undefined, side: ConflictSide): string {
  const n = names?.get(side.clientId);
  return n && n.trim().length > 0 ? n : side.clientId;
}

/**
 * 生成一条冲突的人类可读中文文案（供 UI 横幅/列表直接渲染）。
 * @param names 可选 clientId → 标签名映射
 */
export function describeConflict(c: CollabConflict, names?: NameMap): string {
  const w = c.winner;
  const l = c.loser;
  const wName = nameOf(names, w);
  const lName = nameOf(names, l);
  const fieldLabel = FIELD_LABELS[c.field] ?? c.field;

  if (c.kind === 'reparent') {
    const nodeRef = c.entityId ? `节点「${c.entityId}」` : '该节点';
    return [
      `${wName} 与 ${lName} 同时把 ${nodeRef} 改挂到不同父节点：`,
      `${wName} 挂到「${summarizeValue(w.value)}」，${lName} 挂到「${summarizeValue(l.value)}」。`,
      `已保留 ${wName} 的结果（Lamport ${w.lamport}），${lName} 的改动因并发冲突未生效。`,
    ].join('');
  }

  if (c.kind === 'edge-orphaned' || c.kind === 'edge-dropped') {
    const edgeRef = c.entityId ? `边「${c.entityId}」` : '该边';
    const action = c.kind === 'edge-orphaned' ? '其端点节点被并发删除' : '其端点节点不存在';
    return [
      `${lName} 创建的${edgeRef}${action}，已在合并时丢弃以避免悬挂边。`,
      c.reason ? `${c.reason}。` : '',
    ].join('');
  }

  const entityRef =
    c.entity === 'doc'
      ? '文档'
      : c.entity === 'page'
        ? '分页设置'
        : `${c.entity === 'node' ? '节点' : '边'}「${c.entityId ?? '?'}」`;
  return [
    `${wName} 与 ${lName} 同时修改${entityRef}的「${fieldLabel}」：`,
    `${lName} 写为 ${summarizeValue(l.value)}，${wName} 写为 ${summarizeValue(w.value)}。`,
    `已采用时间戳较新的一方（${wName}，Lamport ${w.lamport}）。`,
  ].join('');
}

/** 批量摘要：返回与输入等长的文案数组。 */
export function summarizeConflicts(conflicts: readonly CollabConflict[], names?: NameMap): string[] {
  return conflicts.map((c) => describeConflict(c, names));
}

/** 从事件标记构造冲突一侧（合并引擎内部用）。 */
export function sideOf(m: EventMarker, value: unknown): ConflictSide {
  return { clientId: m.clientId, lamport: m.lamport, value };
}
