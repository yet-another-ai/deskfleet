import { describe, expect, it } from "vitest"
import { createSpring } from "./spring.ts"

describe("spring integration", () => {
  it("animates the first target from rest using velocity-first Euler integration in seconds", () => {
    const spring = createSpring(0)
    spring.setTarget(100)
    expect(spring.position).toBe(0)
    expect(spring.velocity).toBe(0)
    expect(spring.isActive).toBe(true)
    const dt = 1 / 240
    spring.advance(dt)
    const acceleration = (2 * Math.PI / 0.5) ** 2 * 100
    expect(spring.velocity).toBeCloseTo(acceleration * dt)
    expect(spring.position).toBeCloseTo(acceleration * dt * dt)
  })

  it("preserves position and velocity when paused and redirected", () => {
    const spring = createSpring(0)
    spring.setTarget(100)
    spring.advance(0.1)
    const position = spring.position
    const velocity = spring.velocity
    spring.pause()
    spring.advance(0.5)
    expect(spring.position).toBe(position)
    expect(spring.velocity).toBe(velocity)
    spring.setTarget(-100)
    expect(spring.position).toBe(position)
    expect(spring.velocity).toBe(velocity)
    spring.advance(1 / 240)
    expect(spring.position).toBeGreaterThan(position)
    spring.advance(3)
    expect(spring.position).toBe(-100)
    expect(spring.velocity).toBe(0)
    expect(spring.isActive).toBe(false)
  })

  it("subdivides a delayed frame and remains stable for short durations and high bounce", () => {
    for (const duration of [0.001, 0.05, 0.5]) {
      const spring = createSpring(0, { duration, bounce: 0.9 })
      spring.setTarget(100)
      spring.advance(30)
      expect(spring.position).toBe(100)
      expect(spring.velocity).toBe(0)
      expect(spring.isActive).toBe(false)
    }
  })

  it("requires both small displacement and small velocity to settle", () => {
    const spring = createSpring(100)
    spring.setVelocity(100)
    spring.setTarget(100)
    spring.advance(1 / 240)
    expect(spring.isActive).toBe(true)
    expect(spring.position).toBeGreaterThan(100)
    spring.advance(3)
    expect(spring.position).toBe(100)
    expect(spring.velocity).toBe(0)
  })

  it("uses duration for speed and bounce for overshoot", () => {
    const critical = createSpring(0, { bounce: 0 })
    const bouncy = createSpring(0, { bounce: 0.5 })
    const quick = createSpring(0, { duration: 0.2, bounce: 0 })
    for (const spring of [critical, bouncy, quick]) spring.setTarget(1)
    let overshot = false
    for (let frame = 0; frame < 120; frame++) {
      critical.advance(1 / 120)
      bouncy.advance(1 / 120)
      quick.advance(1 / 120)
      expect(critical.position).toBeLessThanOrEqual(1)
      if (frame === 10) expect(quick.position).toBeGreaterThan(critical.position)
      if (bouncy.position > 1) overshot = true
    }
    expect(overshot).toBe(true)
  })
})

describe("drag and inertia", () => {
  it("catches motion without a jump and releases with measured pointer velocity", () => {
    const spring = createSpring(0)
    spring.setTarget(100)
    spring.advance(0.1)
    const caught = spring.position
    const incoming = spring.velocity
    spring.startDrag(1)
    expect(spring.position).toBe(caught)
    expect(spring.velocity).toBe(incoming)
    spring.advance(0.2)
    expect(spring.position).toBe(caught)
    spring.dragTo(caught + 10, 1.1)
    expect(spring.position).toBe(caught + 10)
    expect(spring.velocity).toBeCloseTo(100)
    spring.endDrag(1.11)
    expect(spring.velocity).toBeCloseTo(100)
    spring.advance(1 / 240)
    expect(spring.position).toBeGreaterThan(caught + 10)
    spring.advance(3)
    expect(spring.position).toBe(100)
  })

  it("rebases the viewport without changing velocity or subsequent pointer deltas", () => {
    const spring = createSpring(0)
    spring.startDrag(1)
    spring.dragTo(-50, 1.1)
    spring.rebase(390)
    expect(spring.position).toBe(340)
    expect(spring.target).toBe(390)
    expect(spring.velocity).toBeCloseTo(-500)
    spring.dragTo(330, 1.2)
    expect(spring.velocity).toBeCloseTo(-100)
  })

  it("coasts monotonically to rest without returning to the release point", () => {
    const spring = createSpring(0)
    spring.startDrag(0)
    spring.dragTo(100, 0.1)
    spring.endDrag(0.1, "inertia")
    let previous = spring.position
    let previousVelocity = spring.velocity
    for (let frame = 0; frame < 180; frame++) {
      spring.advance(1 / 60)
      expect(spring.position).toBeGreaterThanOrEqual(previous)
      expect(spring.velocity).toBeLessThanOrEqual(previousVelocity)
      previous = spring.position
      previousVelocity = spring.velocity
    }
    expect(spring.position).toBeGreaterThan(100)
    expect(spring.target).toBe(spring.position)
    expect(spring.velocity).toBe(0)
    expect(spring.isActive).toBe(false)
  })

  it("does not fling a pointer that rested before release", () => {
    const spring = createSpring(0)
    spring.startDrag(0)
    spring.dragTo(100, 0.1)
    spring.endDrag(0.3, "inertia")
    spring.advance(1)
    expect(spring.position).toBe(100)
    expect(spring.velocity).toBe(0)
    expect(spring.isActive).toBe(false)
  })

  it("anchors a new target to the current inertial position without resetting velocity", () => {
    const spring = createSpring(0)
    spring.startDrag(0)
    spring.dragTo(100, 0.1)
    spring.endDrag(0.1, "inertia")
    spring.advance(0.1)
    const position = spring.position
    const velocity = spring.velocity
    expect(position).toBeGreaterThan(116)
    expect(spring.target).toBe(position)
    spring.setTarget(spring.target + 16)
    expect(spring.position).toBe(position)
    expect(spring.velocity).toBe(velocity)
    spring.advance(3)
    expect(spring.position).toBe(position + 16)
    expect(spring.isActive).toBe(false)
  })

  it("absorbs momentum at current bounds without a rebound", () => {
    let maximum = 120
    const spring = createSpring(0, { min: 0, max: () => maximum })
    spring.startDrag(0)
    spring.dragTo(100, 0.1)
    spring.endDrag(0.1, "inertia")
    spring.advance(0.5)
    expect(spring.position).toBe(120)
    expect(spring.velocity).toBe(0)
    maximum = 110
    spring.setTarget(200)
    spring.advance(1)
    expect(spring.position).toBe(110)
    expect(spring.isActive).toBe(false)
  })

  it("settles when a dynamic bound shrinks below an in-flight target", () => {
    let maximum = 1000
    const spring = createSpring(0, { min: 0, max: () => maximum })
    spring.setTarget(900)
    spring.advance(0.1)
    maximum = 100
    spring.advance(3)
    expect(spring.target).toBe(100)
    expect(spring.position).toBe(100)
    expect(spring.velocity).toBe(0)
    expect(spring.isActive).toBe(false)
  })
})
