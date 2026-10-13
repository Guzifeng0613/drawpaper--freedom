import * as React from 'react';
import { cn } from '@/lib/utils';

/**
 * Tiptap JSON → 静态 HTML（导出/打印专用）。
 * 不依赖 @tiptap/react，仅做一次递归遍历渲染；黑白模式下用 .tp-gray 降级。
 * 支持：标题 / 段落 / 有序无序列表 / 待办 / 引用 / 图片 / 分隔线 / 行内格式 / 链接。
 */

interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

interface PMNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PMNode[];
  text?: string;
  marks?: PMMark[];
  [k: string]: unknown;
}

/** 把一个 marks 包裹到 children 外。 */
function applyMarks(node: PMNode, children: React.ReactNode, gray: boolean): React.ReactNode {
  let out = children;
  for (const mark of node.marks ?? []) {
    switch (mark.type) {
      case 'bold':
        out = <strong>{out}</strong>;
        break;
      case 'italic':
        out = <em>{out}</em>;
        break;
      case 'underline':
        out = <u>{out}</u>;
        break;
      case 'strike':
        out = <s>{out}</s>;
        break;
      case 'code':
        out = <code className="rounded bg-muted px-1">{out}</code>;
        break;
      case 'highlight':
        out = <mark className="bg-yellow-200">{out}</mark>;
        break;
      case 'link':
        out = (
          <a href={typeof mark.attrs?.href === 'string' ? mark.attrs.href : '#'} target="_blank" rel="noreferrer">
            {out}
          </a>
        );
        break;
      case 'textStyle': {
        const color = typeof mark.attrs?.color === 'string' ? mark.attrs.color : undefined;
        out = (
          <span style={gray || !color ? undefined : { color }}>{out}</span>
        );
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function renderInline(node: PMNode, gray: boolean): React.ReactNode {
  if (node.type === 'text') {
    return applyMarks(node, node.text ?? '', gray);
  }
  if (node.type === 'hardBreak') return <br />;
  return renderNode(node, gray);
}

export function renderNode(node: PMNode, gray: boolean): React.ReactNode {
  const children = (node.content ?? []).map((c, i) => <React.Fragment key={i}>{renderInline(c, gray)}</React.Fragment>);
  switch (node.type) {
    case 'doc':
      return <div>{children}</div>;
    case 'paragraph':
      return <p className="my-1">{children}</p>;
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      const Tag = (`h${level}`) as 'h1';
      return <Tag className="font-semibold">{children}</Tag>;
    }
    case 'bulletList':
      return <ul className="list-disc pl-5">{children}</ul>;
    case 'orderedList':
      return <ol className="list-decimal pl-5">{children}</ol>;
    case 'listItem':
      return <li>{children}</li>;
    case 'taskList':
      return <ul className="list-none pl-0">{children}</ul>;
    case 'taskItem': {
      const checked = Boolean(node.attrs?.checked);
      return (
        <li className="flex items-start gap-1.5">
          <span className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded border border-current text-center text-[10px] leading-3">
            {checked ? '✓' : ''}
          </span>
          <span className="flex-1">{(node.content ?? []).map((c, i) => <React.Fragment key={i}>{renderInline(c, gray)}</React.Fragment>)}</span>
        </li>
      );
    }
    case 'blockquote':
      return <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>;
    case 'horizontalRule':
      return <hr className="my-2 border-border" />;
    case 'image': {
      const src = typeof node.attrs?.src === 'string' ? node.attrs.src : '';
      const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt : '';
      return src ? <img src={src} alt={alt} className="max-w-full" /> : null;
    }
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      const cls = language ? `hljs language-${language}` : 'hljs';
      return (
        <pre className="my-1 overflow-x-auto rounded bg-slate-100 p-2 text-xs">
          <code className={cls}>{children}</code>
        </pre>
      );
    }
    default:
      return children;
  }
}

export function TiptapStatic({ doc, gray = false }: { doc: unknown; gray?: boolean }) {
  const root = doc as PMNode | undefined;
  if (!root || typeof root !== 'object') return null;
  return <div className={cn('tp-static text-sm', gray && 'tp-gray')}>{renderNode(root, gray)}</div>;
}
