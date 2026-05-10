"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { EgoEdge, EgoGraphState, LaidOutNode } from "../types";
import type { EgoGraphAction } from "../hooks/useEgoGraphState";
import { CX, CY, RING_R, W, H } from "../lib/layout";
import { curve } from "../lib/edgeRouting";
import { nodeColor } from "../lib/colors";
import {
  renderFocus,
  renderFragment,
  renderPerson,
  renderWiki,
} from "../lib/nodeShapes";
import styles from "../EgoGraphEditorial.module.css";

interface StageProps {
  nodes: LaidOutNode[];
  edges: EgoEdge[];
  state: EgoGraphState;
  dispatch: Dispatch<EgoGraphAction>;
  focusId: string;
}

const HOP_OPACITY = [1, 1, 0.78, 0.5];
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.4;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Read the node id from a pointer/mouse event by walking up the DOM
 * looking for a `data-node-id` attribute. Returns null when the event
 * landed on the SVG background or any decoration without an id.
 */
function nodeIdFrom(target: EventTarget | null): string | null {
  let el = target as Element | null;
  while (el && el.nodeType === 1) {
    const id = el.getAttribute?.("data-node-id");
    if (id) return id;
    el = el.parentElement;
  }
  return null;
}

export function Stage({ nodes, edges, state, dispatch, focusId }: StageProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    panX: number;
    panY: number;
  } | null>(null);

  const nodeIndex = useMemo(() => {
    const m = new Map<string, LaidOutNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const neighborEdgeIds = useMemo(() => {
    if (!state.hover) return null;
    const set = new Set<string>();
    for (const e of edges) {
      if (e.source === state.hover || e.target === state.hover) {
        set.add(e.id);
      }
    }
    return set;
  }, [edges, state.hover]);

  const neighborNodeIds = useMemo(() => {
    if (!state.hover) return null;
    const set = new Set<string>([state.hover]);
    for (const e of edges) {
      if (e.source === state.hover) set.add(e.target);
      else if (e.target === state.hover) set.add(e.source);
    }
    return set;
  }, [edges, state.hover]);

  // Wheel zoom. We attach a non-passive listener so preventDefault
  // works in modern Chrome, which treats wheel handlers attached via
  // React props as passive by default.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      const factor = e.deltaY < 0 ? 1.08 : 0.92;
      dispatch({ type: "SET_ZOOM", zoom: state.zoom * factor });
    }
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [dispatch, state.zoom]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      // Don't start a pan if the drag began on a node.
      if (nodeIdFrom(e.target)) return;
      dragRef.current = {
        active: true,
        startX: e.clientX,
        startY: e.clientY,
        panX: state.pan.x,
        panY: state.pan.y,
      };
      (e.currentTarget as SVGSVGElement).setPointerCapture(e.pointerId);
    },
    [state.pan.x, state.pan.y],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const drag = dragRef.current;
      if (!drag || !drag.active) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      dispatch({ type: "SET_PAN", x: drag.panX + dx, y: drag.panY + dy });
    },
    [dispatch],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (dragRef.current) {
        dragRef.current.active = false;
        try {
          (e.currentTarget as SVGSVGElement).releasePointerCapture(e.pointerId);
        } catch {
          // pointerId may already be released; safe to ignore.
        }
      }
    },
    [],
  );

  const onSvgClick = useCallback(
    (e: ReactMouseEvent<SVGSVGElement>) => {
      const id = nodeIdFrom(e.target);
      if (id) {
        dispatch({ type: "SELECT", id });
      } else {
        dispatch({ type: "CLEAR_SELECT" });
      }
    },
    [dispatch],
  );

  const onNodeEnter = useCallback(
    (e: ReactPointerEvent<SVGGElement>) => {
      const id = e.currentTarget.getAttribute("data-node-id");
      if (id) dispatch({ type: "SET_HOVER", id });
    },
    [dispatch],
  );

  const onNodeLeave = useCallback(() => {
    dispatch({ type: "SET_HOVER", id: null });
  }, [dispatch]);

  // Edges first so nodes paint on top.
  const renderedEdges = edges.map((e) => {
    const a = nodeIndex.get(e.source);
    const b = nodeIndex.get(e.target);
    if (!a || !b) return null;
    const path = curve(a.x, a.y, b.x, b.y);
    const kindClass =
      e.kind === "wikilink"
        ? styles.wikilink
        : e.kind === "mention"
          ? styles.mention
          : styles.filing;
    let stateClass = "";
    if (neighborEdgeIds) {
      stateClass = neighborEdgeIds.has(e.id) ? styles.isHot : styles.isDim;
    }
    const className = [styles.edge, kindClass, stateClass]
      .filter(Boolean)
      .join(" ");
    return <path key={e.id} d={path} className={className} />;
  });

  const renderedNodes = nodes.map((n) => {
    const color = nodeColor(n);
    const hopOpacity = HOP_OPACITY[Math.min(n.hop, 3)] ?? 1;

    let inner;
    if (n.id === focusId) {
      inner = renderFocus(n, color);
    } else if (n.type === "wiki") {
      inner = renderWiki(n, color, hopOpacity);
    } else if (n.type === "fragment") {
      inner = renderFragment(n, color, hopOpacity);
    } else {
      inner = renderPerson(n, color, hopOpacity);
    }

    let stateClass = "";
    if (neighborNodeIds) {
      stateClass = neighborNodeIds.has(n.id) ? styles.isHot : styles.isDim;
    }
    if (n.id === focusId) {
      stateClass = `${stateClass} ${styles.isFocus}`.trim();
    }

    const typeClass =
      n.type === "fragment"
        ? styles.frag
        : n.type === "person"
          ? styles.person
          : "";

    const className = [styles.node, typeClass, stateClass]
      .filter(Boolean)
      .join(" ");

    return (
      <g
        key={n.id}
        data-node-id={n.id}
        className={className}
        style={{ color }}
        onPointerEnter={onNodeEnter}
        onPointerLeave={onNodeLeave}
      >
        {inner}
      </g>
    );
  });

  // Concentric ring decorations.
  const ringDecor: React.ReactNode[] = [];
  for (let hop = 1; hop <= 3; hop++) {
    const r = RING_R[hop];
    ringDecor.push(
      <circle
        key={`ring-${hop}`}
        cx={CX}
        cy={CY}
        r={r}
        className={styles.ringCircle}
      />,
    );
    // North / East / South / West ticks.
    const tickLen = 6;
    ringDecor.push(
      <line
        key={`tick-n-${hop}`}
        x1={CX}
        y1={CY - r - tickLen}
        x2={CX}
        y2={CY - r + tickLen}
        className={styles.ringTick}
      />,
      <line
        key={`tick-s-${hop}`}
        x1={CX}
        y1={CY + r - tickLen}
        x2={CX}
        y2={CY + r + tickLen}
        className={styles.ringTick}
      />,
      <line
        key={`tick-e-${hop}`}
        x1={CX + r - tickLen}
        y1={CY}
        x2={CX + r + tickLen}
        y2={CY}
        className={styles.ringTick}
      />,
      <line
        key={`tick-w-${hop}`}
        x1={CX - r - tickLen}
        y1={CY}
        x2={CX - r + tickLen}
        y2={CY}
        className={styles.ringTick}
      />,
    );
    ringDecor.push(
      <text
        key={`label-${hop}`}
        x={CX + r + 12}
        y={CY + 3}
        className={styles.ringLabel}
      >
        {`HOP ${hop}`}
      </text>,
    );
  }

  const onZoomIn = () =>
    dispatch({ type: "SET_ZOOM", zoom: clamp(state.zoom * 1.15, ZOOM_MIN, ZOOM_MAX) });
  const onZoomOut = () =>
    dispatch({ type: "SET_ZOOM", zoom: clamp(state.zoom * 0.87, ZOOM_MIN, ZOOM_MAX) });
  const onZoomReset = () => {
    dispatch({ type: "SET_ZOOM", zoom: 1 });
    dispatch({ type: "SET_PAN", x: 0, y: 0 });
  };

  return (
    <main className={styles.stage}>
      <div className={`${styles.stageCorner} ${styles.tl}`}>
        <b>FIG. 01</b> · ego graph<br />
        <span style={{ opacity: 0.7 }}>{`v = ${nodes.length} · e = ${edges.length}`}</span>
      </div>
      <div className={`${styles.stageCorner} ${styles.tr}`}>
        <b>VAULT</b> · work<br />
        <span style={{ opacity: 0.7 }}>profile · operating</span>
      </div>
      <div className={`${styles.stageCorner} ${styles.bl}`}>
        <b>SCALE</b><br />
        <span style={{ opacity: 0.7 }}>≈ 220 px / hop</span>
      </div>
      <div className={`${styles.stageCorner} ${styles.br}`}>
        <b>UPDATED</b><br />
        <span style={{ opacity: 0.7 }}>now · ⏵ live</span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onSvgClick}
      >
        <g
          transform={`translate(${state.pan.x} ${state.pan.y}) scale(${state.zoom})`}
        >
          {ringDecor}
          {renderedEdges}
          {renderedNodes}
        </g>
      </svg>

      <div className={styles.stageTools}>
        <button type="button" title="Zoom in" onClick={onZoomIn}>＋</button>
        <button type="button" title="Zoom out" onClick={onZoomOut}>−</button>
        <button type="button" title="Reset" onClick={onZoomReset}>⊕</button>
      </div>
    </main>
  );
}
