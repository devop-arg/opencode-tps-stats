import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  normalizeModelName,
  calculateCost,
  formatCost,
  getModelCost,
  resetCostCache,
  setModelCostsPath,
} from "../src/pricing"

// El loader de precios busca ~/scripts/session-stats/model_costs.json, que
// pertenece a session-stats y cambia cada vez que se actualizan sus precios.
// Estos tests apuntan el loader a una ruta inexistente para ejercitar el
// fallback embebido y no depender de esos precios vigentes. No se puede
// redirigir `HOME`: `os.homedir()` se cachea al inicio del proceso.
const NO_PRICES = "/nonexistent/session-stats/model_costs.json"

function useEmbeddedFallback() {
  setModelCostsPath(NO_PRICES)
}

function restoreCostSource() {
  setModelCostsPath(null)
}

describe("normalizeModelName", () => {
  test("strips provider prefixes", () => {
    expect(normalizeModelName("deepseek/deepseek-v4-flash")).toBe("deepseek-v4-flash")
    // El sufijo pelado "-thinking" no se quita: se replica la lista de sufijos
    // de session-stats, que solo descarta "-thinking-high", "-thinking/low",
    // etc. Los nombres con "-thinking" a secas se resuelven por MODEL_ALIASES,
    // no por normalización.
    expect(normalizeModelName("antigravity-claude-opus-4-6-thinking")).toBe("claude-opus-4-6-thinking")
  })

  test("strips variant suffixes", () => {
    expect(normalizeModelName("deepseek-v4-flash-free")).toBe("deepseek-v4-flash")
    expect(normalizeModelName("minimax-m2.5-free")).toBe("minimax-m2.5")
  })

  test("resolves known aliases", () => {
    // alibaba agrega la fecha de salida; es el mismo modelo que flash.
    expect(normalizeModelName("deepseek-v4-flash-0731")).toBe("deepseek-v4-flash")
  })

  test("returns unknown for empty", () => {
    expect(normalizeModelName("")).toBe("unknown")
    expect(normalizeModelName(undefined as unknown as string)).toBe("unknown")
  })
})

describe("getModelCost", () => {
  beforeEach(useEmbeddedFallback)
  afterEach(restoreCostSource)

  test("resolves deepseek-v4-flash via embedded fallback", () => {
    const c = getModelCost("deepseek-v4-flash")
    expect(c).not.toBeNull()
    expect(c!.input).toBe(0.14)
    expect(c!.output).toBe(0.28)
  })

  test("resolves the -0731 alias to flash pricing", () => {
    const c = getModelCost("deepseek-v4-flash-0731")
    expect(c).not.toBeNull()
    expect(c!.input).toBe(0.14)
  })

  test("returns null for unknown model", () => {
    expect(getModelCost("totally-unknown-model")).toBeNull()
  })
})

describe("calculateCost", () => {
  beforeEach(useEmbeddedFallback)
  afterEach(restoreCostSource)

  test("computes input+output+cache per million", () => {
    // 1M input @ 0.14 + 1M output @ 0.28 + 1M cache @ 0.0028
    const cost = calculateCost("deepseek-v4-flash", 1_000_000, 1_000_000, 1_000_000)
    expect(cost).toBeCloseTo(0.4228, 6)
  })

  test("returns 0 for unknown model", () => {
    expect(calculateCost("nope", 1_000_000, 1_000_000, 0)).toBe(0)
  })
})

describe("formatCost", () => {
  test("4 decimals under $1", () => {
    expect(formatCost(0.006)).toBe("$0.0060")
    expect(formatCost(0.42)).toBe("$0.4200")
  })

  test("2 decimals from $1 up", () => {
    expect(formatCost(1.2345)).toBe("$1.23")
  })
})