import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
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

const RECENT_WINDOW_DAYS = 7

/**
 * Elige un modelo realmente en uso, de los últimos {@link RECENT_WINDOW_DAYS}
 * días, que además necesite el sync con session-stats para resolverse.
 *
 * Los ids de modelo cambian seguido y un ejemplo hardcodeado se pudre en
 * semanas: el test passaría cubriendo un caso que ya no existe. Leyendo la
 * base de opencode el test sigue apuntando a algo vigente, y el filtro por
 * "no resoluble localmente" garantiza que el sync sea lo que se está probando.
 *
 * Devuelve `null` si no hay base, no hay modelos recientes, o ninguno necesita
 * el sync; en ese caso quien llama omite el test y avisa por consola, para que
 * un skip no se lea como cobertura real.
 */
function recentModels(): string[] {
  try {
    const db = new Database(join(homedir(), ".local/share/opencode/opencode.db"), { readonly: true })
    const cutoff = Date.now() - RECENT_WINDOW_DAYS * 86_400_000
    const rows = db
      .query(
        // Se agrupa por la expresión, no por el alias: `session_message` ya
        // tiene una columna `id` y SQLite resolvería `GROUP BY id` contra esa
        // columna, devolviendo una fila por mensaje en lugar de una por modelo.
        `SELECT json_extract(data, '$.model.id') AS model
           FROM session_message
          WHERE type = 'assistant'
            AND json_extract(data, '$.model.id') IS NOT NULL
            AND time_created > ?
          GROUP BY json_extract(data, '$.model.id')
          ORDER BY MAX(time_created) DESC`,
      )
      .all(cutoff) as { model: string }[]
    db.close()
    return rows.map((row) => row.model)
  } catch {
    return []
  }
}

function recentModelNeedingSync(): string | null {
  const rows = recentModels()
  if (rows.length === 0) return null

  // Sin el sync, con el fallback embebido, este modelo no resuelve.
  setModelCostsPath(NO_PRICES)
  setModelAliasesPath(NO_ALIASES)
  resetCostCache()
  try {
    for (const model of rows) {
      if (getModelCost(model) === null) return model
    }
  } finally {
    restoreCostSource()
    resetCostCache()
  }
  return null
}

/**
 * Igual que {@link recentModelNeedingSync}, pero además exige que el modelo
 * tenga un precio real y distinto de cero en session-stats.
 *
 * Los modelos gratuitos se pricean a $0, así que "resuelve" no implica "tiene
 * precio": sin este filtro el test elegiría un modelo gratis y fallaría al
 * exigir un costo mayor a cero, cuando el comportamiento era correcto.
 */
function recentPaidModelNeedingSync(): string | null {
  setModelCostsPath(null)
  setModelAliasesPath(null)
  resetCostCache()
  try {
    const rows = recentModels()
    for (const id of rows) {
      const cost = getModelCost(id)
      if (cost && cost.input > 0 && cost.output > 0) return id
    }
    return null
  } finally {
    restoreCostSource()
    resetCostCache()
  }
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
    const model = recentModelNeedingSync()
    if (!model) {
      // Sin base de opencode, o sin modelos recientes que necesiten el sync, no
      // hay nada vigente que probar. Se avisa para que un skip no se confunda
      // con una cobertura real.
      console.warn(
        "[pricing] sin modelo reciente que necesite el sync: este test no cubrió nada. " +
          "Suele significar que no hay sesiones de opencode en los últimos 7 días.",
      )
      return
    }
    const { costsPath, aliasesPath } = pricingFixture(
      { [model]: "modelo-de-prueba" },
      { "modelo-de-prueba": { input: 2, output: 6, cache: 0.25 } },
    )
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    // El alias propio del plugin no lo cubre, así que sin el sync daría null.
    expect(getModelCost(model)).not.toBeNull()
    expect(getModelCost(model)!.input).toBe(2)
    expect(getModelCost(model)!.output).toBe(6)
  })

  test("resuelve contra los datos reales de session-stats", () => {
    const model = recentPaidModelNeedingSync()
    if (!model) {
      // Todos los modelos recientes son gratuitos ($0), así que no hay un caso
      // de pago contra el que verificar.
      console.warn(
        "[pricing] ningún modelo reciente tiene precio > 0 (los gratuitos dan $0 " +
          "por diseño): este test no cubrió nada.",
      )
      return
    }
    // Sin fixtures: contra los JSON de session-stats de verdad.
    setModelCostsPath(null)
    setModelAliasesPath(null)
    resetCostCache()

    const c = getModelCost(model)
    expect(c).not.toBeNull()
    expect(c!.input).toBeGreaterThan(0)
    expect(c!.output).toBeGreaterThan(0)
  })

  test("un modelo gratuito resuelve a costo cero, no a null", () => {
    // space-bunny-free es el modelo de esta sesión: se pricea a $0. Que
    // resuelva a 0 y no a null es lo correcto, y es un caso distinto al del
    // alias que sincroniza.
    setModelCostsPath(null)
    setModelAliasesPath(null)
    resetCostCache()

    const free = recentModels().find((id) => {
      const c = getModelCost(id)
      return c !== null && c.input === 0 && c.output === 0
    })
    if (!free) {
      console.warn("[pricing] no hay modelos gratuitos recientes: este test no cubrió nada.")
      return
    }

    resetCostCache()
    const c = getModelCost(free)
    expect(c).not.toBeNull()
    expect(c!.input).toBe(0)
    expect(calculateCost(free, 1_000_000, 1_000_000, 0)).toBe(0)
  })

  test("resuelve un alias con prefijo de provider", () => {
    // Un id con prefijo de provider no lo cubre el alias propio del plugin,
    // que está escrito sin prefijo.
    const { costsPath, aliasesPath } = pricingFixture(
      { "acme/acme-model-x": "acme-model-x" },
      { "acme-model-x": { input: 0.22, output: 0.66 } },
    )
    setModelCostsPath(costsPath)
    setModelAliasesPath(aliasesPath)
    resetCostCache()

    const c = getModelCost("acme/acme-model-x")
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