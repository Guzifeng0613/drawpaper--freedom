import type { KBNoteDoc, BlockNode, Edge } from '../model/index.js';
import type { AIChatMessage } from '../store/adapters.js';
import type { AiTask } from './suggestion-schema.js';

/**
 * 构造发送给模型的 system/user prompt（纯函数，零 DOM）。
 *
 * 策略（见 §2.5 AI 铁律）：
 *  - 只建议 父子关系 / 分组 / 拆块 / 摘要 / 孤立断点；
 *  - 严格要求 JSON 输出，且 node id 只能从给出的清单里选，禁止臆造；
 *  - 把「现有节点 + 纯文本片段 + 现有边」一并塞给模型，避免它凭空想象。
 */

/**
 * 递归提取 Tiptap JSON 纯文本（core 不依赖 @tiptap，纯数据遍历）。
 *
 * 同时用最小鸭子类型识别非 Tiptap 块的自定义 data 形状：
 * 若对象既无 text 字符串也无 content 数组（即不是 Tiptap 节点），
 * 按固定优先级 source → url → name → note → title 取第一个非空字符串，
 * 供 AI 上下文 / SVG 导出 / nodeDigest 拿到公式源码、书签 URL、附件名等。
 */
export function extractNodePlainText(data: unknown): string {
  const parts: string[] = [];
  /** 非 Tiptap 数据对象的文本字段优先级。 */
  const FIELD_PRIORITY = ['source', 'url', 'name', 'note', 'title'] as const;
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.text === 'string') {
      parts.push(n.text);
      return; // Tiptap 文本节点：不继续走鸭子类型
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child);
      return; // Tiptap 容器节点：递归子节点
    }
    // 非 Tiptap 数据对象（equation/bookmark/attachment/reminder 等）：按优先级取一个字段。
    for (const key of FIELD_PRIORITY) {
      const v = n[key];
      if (typeof v === 'string' && v.trim()) {
        parts.push(v);
        break;
      }
    }
  };
  walk(data);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

const MAX_TEXT_PER_NODE = 160;

function nodeDigest(n: BlockNode): string {
  const text = extractNodePlainText(n.content.data);
  const clipped = text.length > MAX_TEXT_PER_NODE ? `${text.slice(0, MAX_TEXT_PER_NODE)}…` : text;
  const bits: string[] = [`id=${n.id}`, `type=${n.type}`];
  if (n.heading?.level) bits.push(`level=${n.heading.level}`);
  if (n.todo?.checked !== undefined) bits.push(`todo=${n.todo.checked ? 'done' : 'todo'}`);
  bits.push(clipped ? `text="${clipped}"` : 'text=""');
  return `  - ${bits.join(' ')}`;
}

function edgeDigest(edges: Edge[]): string {
  if (edges.length === 0) return '  （当前没有任何父子边）';
  return edges
    .map((e) => `  - ${e.source} -> ${e.target}${e.label ? `（"${e.label}"）` : ''}`)
    .join('\n');
}

/** 输出给模型的 JSON 契约（在 system prompt 里声明）。 */
const JSON_CONTRACT = `你必须只输出一个 JSON 数组，不要输出任何解释、不要用 markdown 代码块包裹。
每个元素形状为其中之一：
  {"kind":"add-edge","reason":"…","source":"<节点id>","target":"<节点id>","label":"可选"}
  {"kind":"set-root","reason":"…","rootNodeId":"<节点id>"}
  {"kind":"group","reason":"…","memberNodeIds":["<id>","<id>",…],"title":"可选"}
  {"kind":"split-block","reason":"…","targetNodeId":"<节点id>","afterText":"<新块段落文本>"}
  {"kind":"summarize","reason":"…","targetNodeId":"<节点id>","newText":"<凝练后的段落文本>"}
约束：
  - 所有 id 必须来自下面给出的节点清单，严禁臆造新 id；
  - 每条 reason 用一句中文说明为什么；
  - 只给出高置信度的建议，没有合适的就输出空数组 []；
  - add-edge 只建议父子（source=父，target=子）关系，不要建议重复已存在的边。`;

const TASK_GUIDE: Record<AiTask, string> = {
  organize:
    '任务：通读整张画布，找出「明显应该有父子关系但还没连」的节点对，并在森林过多时建议一个主根。可输出 add-edge / set-root。',
  split: '任务：找出内容明显过长、一个块里塞了多个要点的节点，把它拆成前后相连的多个知识块。只输出 split-block（afterText 为拆出来的新块段落）。',
  group:
    '任务：找出语义相近、应归入同一章节/分组容器的节点集合，给分组起标题。只输出 group（memberNodeIds ≥ 2 个同类节点）。',
  summarize:
    '任务：对啰嗦/散乱的长块，凝练为一段更短更清楚的摘要文本。只输出 summarize（newText 为替换后的段落文本）。',
  gaps:
    '任务：找出孤立空块（叶子但没文字）、与主体断开的连通分量、缺主根的多根森林。可输出 set-root，或在 reason 里指出孤立节点（用 add-edge 建议把它们接到主体）。',
};

/**
 * 构造 messages。opts.temperature 由调用方在 provider 层设置，这里不涉及。
 */
export function buildAiMessages(doc: KBNoteDoc, task: AiTask): AIChatMessage[] {
  const nodeList = doc.nodes.map(nodeDigest).join('\n');
  const edgeList = edgeDigest(doc.edges);
  const nodeIds = doc.nodes.map((n) => n.id).join(', ');

  const system: AIChatMessage = {
    role: 'system',
    content: [
      '你是「知识块连线笔记」的本地 AI 助手。你只做结构建议，不直接改图；',
      '所有建议会由用户逐条勾选确认后才落库。',
      JSON_CONTRACT,
    ].join('\n\n'),
  };

  const user: AIChatMessage = {
    role: 'user',
    content: [
      `文档标题：${doc.title}`,
      TASK_GUIDE[task],
      '',
      '【可用节点 id 清单】',
      nodeIds || '  （空文档）',
      '',
      '【节点明细】',
      nodeList || '  （空文档）',
      '',
      '【现有父子边】',
      edgeList,
    ].join('\n'),
  };

  return [system, user];
}
