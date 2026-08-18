// Relative (x,y) offsets (fraction of cell half-size) for orb clusters of size 1-4.
export const ORB_LAYOUTS: Record<number, [number, number][]> = {
  1: [[0, 0]],
  2: [
    [-0.34, 0],
    [0.34, 0],
  ],
  3: [
    [0, -0.38],
    [-0.34, 0.24],
    [0.34, 0.24],
  ],
  4: [
    [-0.34, -0.34],
    [0.34, -0.34],
    [-0.34, 0.34],
    [0.34, 0.34],
  ],
};

export function layoutFor(count: number): [number, number][] {
  if (count <= 0) return [];
  if (count <= 4) return ORB_LAYOUTS[count];
  // fallback for rare overflow: reuse 4-corner layout, extra orbs stack near center
  return ORB_LAYOUTS[4];
}
