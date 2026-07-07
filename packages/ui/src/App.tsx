import { Background, Controls, ReactFlow } from "@xyflow/react";
import type { Edge, Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";

// Placeholder graph — the real orchestration view is defined with the spec.
const nodes: Node[] = [
  {
    id: "orchestrator",
    position: { x: 0, y: 0 },
    data: { label: "orchestrator" },
  },
  { id: "worker", position: { x: 0, y: 120 }, data: { label: "worker" } },
];

const edges: Edge[] = [
  { id: "orchestrator->worker", source: "orchestrator", target: "worker" },
];

export default function App() {
  return (
    <div style={{ width: "100vw", height: "100vh" }}>
      <ReactFlow nodes={nodes} edges={edges} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
