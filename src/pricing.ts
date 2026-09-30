// Pricing del plugin: calcula el costo estimado ($) de la sesión.
//
// Replica la lógica de session-stats (stats_common.py):
//   - normalize_model_name(): quita prefijos de provider y sufijos de variante.
//   - calculate_cost(): costo = (input*in + output*out + cache*cache) / 1M.
// Para opencode (source sin cache en input), input y cache son separados:
// el input se cobra full y el cache se suma aparte.
//
// Los precios se leen de model_costs.json de session-stats (fuente de verdad)
// con fallback a un mapa embebido para los modelos críticos si el JSON no
// está o el modelo no aparece. Si un modelo no tiene precio → costo 0 (no
// rompe nada, solo queda ese request sin costo).

const PROVIDER_PREFIXES = [
  "antigravity-",
  "z-ai/",
  "deepseek/",
  "deepseek-ai/",
  "google/",
  "anthropic/",
  "openai/",
  "moonshot/",
  "openrouter/",
  "arcee-ai/",
  "minimax/",
  "nvidia/",
  "qwen/",
  "stepfun/",
  "xiaomi/",
  "zai-org/",
]

// Sufijos de variante que session-stats descarta al normalizar.
const VARIANT_SUFFIXES = [
  "-thinking-high",
  "-thinking/low",
  "-thinking/medium",
  "-thinking/minimal",
  "-thinking-low",
  "-thinking-medium",
  "-thinking-minimal",
  "-thinking/high",
  "/high",
  "/low",
  "/medium",
  "/minimal",
  "-high",
  "-low",
  "-medium",
  "-minimal",
  "-free",
  ":free",
  ":pro",
  ":lite",
  ":discounted",
]

export type ModelCost = {
  input: number
  output: number
  cache?: number
}

// Fallback embebido para modelos que session-stats sabe pricear pero que
// podrían no estar en model_costs.json (p. ej. tras un reset del JSON).
const EMBEDDED_COSTS: Record<string, ModelCost> = {
  "deepseek-v4-flash": { input: 0.14, output: 0.28, cache: 0.0028 },
  "deepseek-v4-pro": { input: 0.435, output: 0.87, cache: 0.0037 },
  "glm-5.2": { input: 0.8, output: 2.56, cache: 0.16 },
  "glm-4.7": { input: 0.39, output: 1.75, cache: 0.195 },
  "gpt-5.4": { input: 1.25, output: 10 },
  "kimi-k2.5": { input: 0.5, output: 2.6, cache: 0.09 },
  "minimax-m3": { input: 0.27, output: 0.95 },
  "minimax-m2.7": { input: 0.27, output: 0.95 },
  "mimo-v2.5": { input: 0.3, output: 1.2, cache: 0.03 },
  "mimo-v2.5-pro": { input: 0.3, output: 1.2, cache: 0.03 },
  "claude-sonnet-4.6": { input: 3, output: 15, cache: 0.3 },
  "claude-haiku-4.5": { input: 1, output: 5, cache: 0.1 },
  "claude-opus-4.6": { input: 5, output: 25, cache: 0.5 },
  "qwen3.6-flash": { input: 0.5, output: 3 },
  "tencent/hy3": { input: 0.5, output: 2.6, cache: 0.09 },
}

// Aliases de modelo clave (modelID opencode → nombre session-stats).
// deepseek-v4-flash-0731 es el mismo modelo que deepseek-v4-flash (alibaba
// le agrega la fecha de salida); replicamos el alias del pricing de Hermes.
const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-flash-0731": "deepseek-v4-flash",
  "deepseek-v4-flash-free": "deepseek-v4-flash",
  "deepseek-v4-pro-75off": "deepseek-v4-pro",
  "minimax-m2.5-free": "minimax-m2.5",
  "minimax-m3-free": "minimax-m3",
  "mimo-v2.5-free": "mimo-v2.5",
  "nex-agi/nex-n2-pro:free": "nex-agi/nex-n2",
}

let _cachedCosts: Record<string, ModelCost> | null = null
let _costsPath: string | null = null

/**
 * Override de la ubicación de `model_costs.json`. `null` restaura el valor por
 * defecto (`~/scripts/session-stats/model_costs.json`). Existe para que los
 * tests puedan ejercitar el fallback embebido sin depender de los precios
 * vigentes de session-stats: `os.homedir()` se cachea al inicio del proceso,
 * así que redirigir `HOME` dentro de un test no sirve.
 */
export function setModelCostsPath(path: string | null): void {
  _costsPath = path
  _cachedCosts = null
}

function loadModelCosts(): Record<string, ModelCost> {
  if (_cachedCosts) return _cachedCosts
  const merged: Record<string, ModelCost> = { ...EMBEDDED_COSTS }
  try {
    // model_costs.json de session-stats (fuente de verdad de precios).
    const fs = require("fs")
    const os = require("os")
    const path = require("path")
    const p = _costsPath ?? path.join(os.homedir(), "scripts/session-stats/model_costs.json")
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf8"))
      for (const [k, v] of Object.entries(parsed)) {
        const c = v as Partial<ModelCost>
        if (c && typeof c === "object") {
          merged[k] = {
            input: Number(c.input ?? 0),
            output: Number(c.output ?? 0),
            cache: Number(c.cache ?? 0),
          }
        }
      }
    }
  } catch {
    // Si no se puede leer, quedamos con el mapa embebido.
  }
  _cachedCosts = merged
  return merged
}

export function resetCostCache(): void {
  _cachedCosts = null
}

export function normalizeModelName(model: string): string {
  if (!model) return "unknown"
  const alias = MODEL_ALIASES[model]
  if (alias) return alias

  let name = model.toLowerCase()
  for (const prefix of PROVIDER_PREFIXES) {
    name = name.replace(prefix, "")
  }
  for (const suffix of VARIANT_SUFFIXES) {
    name = name.replace(suffix, "")
  }
  return name
}

export function getModelCost(model: string): ModelCost | null {
  const normalized = normalizeModelName(model)
  return loadModelCosts()[normalized] ?? null
}

/** Costo en USD para un request de un modelo dado. */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheTokens: number,
): number {
  const costs = getModelCost(model)
  if (!costs) return 0
  const m = 1_000_000
  return (
    (inputTokens / m) * (costs.input ?? 0) +
    (outputTokens / m) * (costs.output ?? 0) +
    (cacheTokens / m) * (costs.cache ?? 0)
  )
}

/** Formatea un costo USD igual que el status bar de Hermes: 4 decimales si
 *  < $1, 2 si >= $1. */
export function formatCost(usd: number): string {
  if (usd < 1) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}