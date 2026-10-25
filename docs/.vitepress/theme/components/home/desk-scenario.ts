/** Real application windows fan out around the foreground session. */
export interface DeskWindow {
  x: number
  y: number
  w: number
  h: number
  depth: number
  pitch: number
  yaw: number
  roll: number
  parallax: number
}

export const deskWindows = {
  fleet: { x: 0, y: 16, w: 36, h: 47, depth: -130, pitch: 12, yaw: 24, roll: -12, parallax: 14 },
  providers: { x: 67, y: 15, w: 34, h: 44, depth: -100, pitch: 10, yaw: -26, roll: 12, parallax: 20 },
  activity: { x: 8, y: 43, w: 34, h: 44, depth: 20, pitch: 8, yaw: 14, roll: -9, parallax: 32 },
  session: { x: 27, y: 12, w: 53, h: 69, depth: 110, pitch: 5, yaw: -6, roll: -3, parallax: 46 },
} satisfies Record<string, DeskWindow>
