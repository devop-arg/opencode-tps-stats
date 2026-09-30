import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  normalizeModelName,
  calculateCost,
  formatCost,
  getModelCost,
  resetCostCache,
  setModelAliasesPath,
  setModelCostsPath,
} from "../src/pricing"

// El loader de precios busca ~/scripts/session-stats/model_costs.json, que
// pertenece a session-stats y cambia cada vez que se actualizan sus precios.
// Estos tests apuntan el loader a una ruta inexistente para ejercitar el
// fallback embebido y no depender de esos precios vigentes. No se puede
// redirigir `HOME`: `os.homedir()` se cachea al inicio del proceso.
const NO_PRICES = "/nonexistent/session-stats/model_costs.json"
const NO_ALIASES = "/nonexistent/session-stats/model_aliases.json"

function useEmbeddedFallback() {
  setModelCostsPath(NO_PRICES)
  setModelAliasesPath(NO_ALIASES)
}

function restoreCostSource() {
  setModelCostsPath(null)
  setModelAliasesPath(null)
}

/** Crea un directorio temporal con un model_costs.json y un model_aliases.json. */
function pricingFixture(aliases: Record<string, string>, costs: Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "tps-pricing-"))
  const costsPath = join(dir, "model_costs.json")
  const aliasesPath = join(dir, "model_aliases.json")
  writeFileSync(costsPath, JSON.stringify(costs))
  writeFileSync(aliasesPath, JSON.stringify(aliases))
  return { costsPath, aliasesPath }
}

/** Adelanta el mtime de un archivo para que el guard de frescura lo detecte
 *  sin depender de la resolución de timestamps del filesystem. */
function bumpMtime(path: string) {
  const future = new Date(Date.now() + 5000)
  utimesSync(path, future, future)
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

describe("sync con session-stats bajo demanda", () => {
  beforeEach(() => {
    resetCostCache()
  })
  afterEach(restoreCostSource)

  test("resuelve un alias que solo existe en session-stats", () => {
    // qwen3.8-max-preview es un modelo real en uso: la normalización local no
    // lo resuelve y sin el sync daría null.
    const { costsPath, aliasesPath } = pricingFixture(
      { "qwen3.8-max-preview": "qwen3.8-max" },
      { "qwen3.8-max": { input: 2, output: 6, cache: 0.25 } },
    )
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    expect(normalizeModelName("qwen3.8-max-preview")).toBe("qwen3.8-max-preview")

    const c = getModelCost("qwen3.8-max-preview")
    expect(c).not.toBeNull()
    expect(c!.input).toBe(2)
    expect(c!.output).toBe(6)
  })

  test("resuelve un alias con prefijo de provider", () => {
    // El alias propio del plugin es "deepseek-v4-flash-0731", pero el id que
    // trae el mensaje incluye el prefijo del provider.
    const { costsPath, aliasesPath } = pricingFixture(
      { "deepseek/deepseek-v4-flash-0731": "deepseek-v4-flash" },
      { "deepseek-v4-flash": { input: 0.22, output: 0.66 } },
    )
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    const c = getModelCost("deepseek/deepseek-v4-flash-0731")
    expect(c).not.toBeNull()
    expect(c!.input).toBe(0.22)
  })

  test("detecta un precio nuevo para un modelo ya conocido", () => {
    // "acme-model-x" no está en el fallback embebido, así que sin precio en
    // session-stats no hay resolución posible.
    const { costsPath, aliasesPath } = pricingFixture({}, {})
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    expect(getModelCost("acme-model-x")).toBeNull()

    // session-stats publica el precio: la siguiente resolución lo ve. Se fuerza
    // el mtime para no depender de la granularidad del filesystem.
    writeFileSync(costsPath, JSON.stringify({ "acme-model-x": { input: 1.5, output: 3 } }))
    bumpMtime(costsPath)
    const c = getModelCost("acme-model-x")
    expect(c).not.toBeNull()
    expect(c!.input).toBe(1.5)
  })

  test("no sincroniza si la resolución local funciona", () => {
    // El alias de session-stats apunta a otro modelo con otro precio. Si el
    // camino de fallo llegara a aplicarse, veríamos 99 en lugar de 2.
    const { costsPath, aliasesPath } = pricingFixture(
      { "qwen3.8-max": "otro-modelo" },
      { "qwen3.8-max": { input: 2, output: 6 }, "otro-modelo": { input: 99, output: 99 } },
    )
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    expect(getModelCost("qwen3.8-max")!.input).toBe(2)
  })

  test("sigue devolviendo null si session-stats tampoco conoce el modelo", () => {
    const { costsPath, aliasesPath } = pricingFixture({}, {})
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    expect(getModelCost("modelo-que-no-existe")).toBeNull()
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