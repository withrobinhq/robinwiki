import { CX, CY } from "./layout";

/**
 * Build a quadratic bezier path between two points, bent gently
 * toward the graph center. The bend factor `k` is fixed at 0.25,
 * which produces a subtle inward curve that avoids the cluttered
 * straight-line look without becoming swirly.
 */
export function curve(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx: number = CX,
  cy: number = CY
): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = mx - cx;
  const dy = my - cy;
  const k = 0.25;
  const ccx = mx - dx * k;
  const ccy = my - dy * k;
  return `M ${x1} ${y1} Q ${ccx} ${ccy} ${x2} ${y2}`;
}
