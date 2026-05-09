"use client";

import { useReducer, useMemo } from "react";
import type { Dispatch } from "react";
import type { EgoGraphState, NodeType } from "../types";

export type EgoGraphAction =
  | { type: "SET_HOVER"; id: string | null }
  | { type: "SELECT"; id: string }
  | { type: "CLEAR_SELECT" }
  | { type: "SET_DEPTH"; depth: 1 | 2 | 3 }
  | { type: "TOGGLE_TYPE"; nodeType: NodeType }
  | { type: "SET_ZOOM"; zoom: number }
  | { type: "SET_PAN"; x: number; y: number };

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.4;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Build a pure reducer bound to a particular focus id. We close over
 * `focusId` at hook-construction time so `CLEAR_SELECT` knows what to
 * reset to without touching component scope or refs from inside the
 * reducer itself. The hook re-memoises the reducer if `focusId`
 * changes — useReducer will pick up the new function on the next
 * render and existing dispatched actions stay pure.
 */
function makeReducer(focusId: string) {
  return function reducer(
    state: EgoGraphState,
    action: EgoGraphAction
  ): EgoGraphState {
    switch (action.type) {
      case "SET_HOVER":
        if (state.hover === action.id) return state;
        return { ...state, hover: action.id };
      case "SELECT":
        if (state.selected === action.id) return state;
        return { ...state, selected: action.id };
      case "CLEAR_SELECT":
        if (state.selected === focusId) return state;
        return { ...state, selected: focusId };
      case "SET_DEPTH":
        if (state.depth === action.depth) return state;
        return { ...state, depth: action.depth };
      case "TOGGLE_TYPE": {
        const next = new Set(state.activeTypes);
        if (next.has(action.nodeType)) next.delete(action.nodeType);
        else next.add(action.nodeType);
        return { ...state, activeTypes: next };
      }
      case "SET_ZOOM": {
        const z = clamp(action.zoom, ZOOM_MIN, ZOOM_MAX);
        if (state.zoom === z) return state;
        return { ...state, zoom: z };
      }
      case "SET_PAN":
        if (state.pan.x === action.x && state.pan.y === action.y) return state;
        return { ...state, pan: { x: action.x, y: action.y } };
      default:
        return state;
    }
  };
}

function initialState(focusId: string): EgoGraphState {
  return {
    hover: null,
    selected: focusId,
    depth: 2,
    activeTypes: new Set<NodeType>(["wiki", "fragment", "person"]),
    zoom: 1,
    pan: { x: 0, y: 0 },
  };
}

/**
 * Reducer hook that owns the editorial ego graph's transient view
 * state: hover, selection, depth, type filters, zoom, and pan.
 * Reducer is rebuilt only when `focusId` changes, which is rare —
 * the page route remounts the component on navigation.
 */
export function useEgoGraphState(focusId: string): {
  state: EgoGraphState;
  dispatch: Dispatch<EgoGraphAction>;
} {
  const reducer = useMemo(() => makeReducer(focusId), [focusId]);
  const [state, dispatch] = useReducer(reducer, focusId, initialState);
  return { state, dispatch };
}
