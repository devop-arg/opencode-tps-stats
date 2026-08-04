import { describe, expect, test } from "bun:test"
import {
  averageTPS,
  completedTPS,
  formatTPSValue,
  peakTPS,
  streamingTPS,
} from "../src/tps"

describe("streamingTPS", () => {
  test("returns null for empty text or too little elapsed time", () => {
    expect(streamingTPS("", 1000, 5000)).toBeNull()
    expect(streamingTPS("a".repeat(800), 1000, 1400)).toBeNull()
  })

  test("computes tokens per elapsed second", () => {
    expect(streamingTPS("a".repeat(800), 1000, 3000)).toBe(100)
  })
})

describe("completedTPS", () => {
  test("sums output and reasoning tokens", () => {
    expect(completedTPS(200, 100, 1000, 4000)).toBe(100)
  })

  test("returns null when there are no generated tokens", () => {
    expect(completedTPS(0, 0, 1000, 5000)).toBeNull()
  })
})

describe("session stats", () => {
  test("formats compact TPS values", () => {
    expect(formatTPSValue(null)).toBeNull()
    expect(formatTPSValue(0.4)).toBe("<1")
    expect(formatTPSValue(42.6)).toBe("43")
  })

  test("calculates average and peak", () => {
    expect(averageTPS([20, 80])).toBe(50)
    expect(peakTPS([20, 80, 12])).toBe(80)
    expect(averageTPS([])).toBeNull()
    expect(peakTPS([])).toBeNull()
  })
})
