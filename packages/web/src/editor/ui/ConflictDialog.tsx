import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useEditorApi, useEditorSnapshot } from '../canvas/editor-context';

/**
 * ConflictDialog —— 多父 / 成环冲突弹窗（§4.5，绝不静默处理）。
 * - 多父：列出父候选，单选唯一主父
 * - 成环：列出环边，选一条断开
 * 提交 api.resolveConflicts / 取消 api.cancelConflicts。
 */
export function ConflictDialog() {
  const api = useEditorApi();
  const snap = useEditorSnapshot();
  const pending = snap.pendingConflicts;
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [broken, setBroken] = useState<Set<string>>(new Set());

  if (!pending) return null;

  const nodeLabel = (id: string) => snap.doc.nodes.find((n) => n.id === id)?.id.slice(-4) ?? id;

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) api.cancelConflicts(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[900] bg-slate-900/30" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[901] w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-4 shadow-xl">
          <Dialog.Title className="text-sm font-semibold">连线冲突，请裁决</Dialog.Title>

          {pending.multiParents.map((mp) => {
            const chosen = choices[mp.nodeId] ?? mp.parentEdgeIds[0]!;
            return (
              <div key={mp.nodeId} className="mt-3">
                <p className="text-xs text-slate-500">
                  块 <b>{nodeLabel(mp.nodeId)}</b> 有多个父块，请选择唯一主父：
                </p>
                <div className="mt-1 space-y-1">
                  {mp.parentEdgeIds.map((edgeId, i) => (
                    <label
                      key={edgeId}
                      className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${
                        chosen === edgeId ? 'border-blue-400 bg-blue-50' : 'border-slate-200'
                      }`}
                    >
                      <input
                        type="radio"
                        name={mp.nodeId}
                        checked={chosen === edgeId}
                        onChange={() => setChoices((c) => ({ ...c, [mp.nodeId]: edgeId }))}
                      />
                      父块 {nodeLabel(mp.parentIds[i] ?? '')}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}

          {pending.cycles.map((cyc) => (
            <div key={cyc.edgeIds.join(',')} className="mt-3">
              <p className="text-xs text-slate-500">成环了！请选择断开哪条边：</p>
              <div className="mt-1 space-y-1">
                {cyc.edgeIds.map((edgeId) => (
                  <label
                    key={edgeId}
                    className={`flex cursor-pointer items-center gap-2 rounded border px-2 py-1 text-xs ${
                      broken.has(edgeId) ? 'border-red-300 bg-red-50' : 'border-slate-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={broken.has(edgeId)}
                      onChange={() => {
                        setBroken((s) => {
                          const next = new Set(s);
                          if (next.has(edgeId)) next.delete(edgeId);
                          else next.add(edgeId);
                          return next;
                        });
                      }}
                    />
                    断开边 {nodeLabel(edgeId)}
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="rounded border px-3 py-1 text-xs text-slate-600 hover:bg-slate-100"
              onClick={() => api.cancelConflicts()}
            >
              取消
            </button>
            <button
              className="rounded bg-blue-600 px-3 py-1 text-xs text-white hover:bg-blue-700"
              onClick={() => {
                api.resolveConflicts({
                  choosePrimaryParent: choices,
                  breakEdgeIds: [...broken],
                });
              }}
            >
              确定
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
