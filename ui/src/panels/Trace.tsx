/**
 * The observability dashboard: the call hierarchy rendered from parentId,
 * with any node expandable to its exact input and output. The server streams
 * the same rows the store holds, so this view behaves identically while a
 * task runs and after it finishes.
 */

import { useState } from 'react';

import type { TraceNode } from '../types.ts';
import { buildTree } from '../state.ts';

export function Trace({ nodes }: { nodes: TraceNode[] }): JSX.Element {
  const tree = buildTree(nodes);
  if (nodes.length === 0) {
    return <div className="panel muted">No trace yet. Start a task to see the call tree.</div>;
  }
  return (
    <div className="panel trace">
      <Totals nodes={nodes} />
      <NodeList tree={tree} parentId={null} depth={0} />
    </div>
  );
}

function Totals({ nodes }: { nodes: TraceNode[] }): JSX.Element {
  const cost = nodes.reduce((n, e) => n + e.costUsd, 0);
  const tokens = nodes.reduce((n, e) => n + e.tokensIn + e.tokensOut, 0);
  const calls = nodes.filter((e) => e.kind === 'llm_call').length;
  const errors = nodes.filter((e) => e.status === 'error').length;

  return (
    <div className="totals">
      <span><b>{calls}</b> model calls</span>
      <span><b>{tokens.toLocaleString()}</b> tokens</span>
      <span><b>${cost.toFixed(5)}</b></span>
      {errors > 0 && <span className="bad"><b>{errors}</b> errors</span>}
    </div>
  );
}

function NodeList({
  tree, parentId, depth,
}: {
  tree: Map<number | null, TraceNode[]>;
  parentId: number | null;
  depth: number;
}): JSX.Element {
  return (
    <>
      {(tree.get(parentId) ?? []).map((node) => (
        <Node key={node.id} node={node} tree={tree} depth={depth} />
      ))}
    </>
  );
}

function Node({
  node, tree, depth,
}: {
  node: TraceNode; tree: Map<number | null, TraceNode[]>; depth: number;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const children = tree.get(node.id) ?? [];

  return (
    <div className="trace-node">
      <div
        className={`trace-row ${node.status === 'error' ? 'bad' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="caret">
          {children.length > 0 || node.payload ? (open ? '▾' : '▸') : ' '}
        </span>
        <span className={`kind kind-${node.kind}`}>{node.kind}</span>
        {node.role && <span className="role">{node.role}</span>}
        {node.stepId && <span className="muted">{node.stepId}</span>}
        {node.model && (
          <span className="model" title="Which model and provider handled this">
            {node.provider}/{shortModel(node.model)}
          </span>
        )}
        {node.tokensIn + node.tokensOut > 0 && (
          <span className="muted">{node.tokensIn}+{node.tokensOut} tok</span>
        )}
        {node.costUsd > 0 && <span className="muted">${node.costUsd.toFixed(5)}</span>}
        {node.durationMs > 0 && <span className="muted">{node.durationMs}ms</span>}
      </div>

      {open && (
        <pre className="payload" style={{ marginLeft: depth * 16 + 24 }}>
          {formatPayload(node.payload)}
        </pre>
      )}

      {children.length > 0 && <NodeList tree={tree} parentId={node.id} depth={depth + 1} />}
    </div>
  );
}

function shortModel(id: string): string {
  const parts = id.split('/');
  return parts[parts.length - 1] ?? id;
}

function formatPayload(payload: unknown): string {
  if (payload == null) return '(no payload)';
  const text = JSON.stringify(payload, null, 2);
  return text.length > 20_000 ? `${text.slice(0, 20_000)}\n… truncated for display` : text;
}
