// Pricing del plugin: calcula el costo estimado ($) de la sesión.
//
// Replica la lógica de session-stats (stats_common.py):
//   - normalize_model_name(): quita prefijos de provider y sufijos de variante.
//   - calculate_cost(): costo = (input*in + output*out + cache*cache) / 1M.
// Para opencode (source sin cache en input), input y cache son separados:
// el input se cobra full y el cache se suma aparte.
//
// La fuente de verdad es session-stats, que mantiene el mapeo de aliases
// (model_aliases.json) y el de precios (model_costs.json). La sincronización
// es bajo demanda: solo ocurre cuando la resolución local falla, es decir
// cuando aparece un modelo nuevo o falta un precio. No hay timers, polling
// ni sincronización al arranque; el camino rápido nunca toca el disco más allá
// de la primera lectura, y las relecturas se filtran por mtime.
//
// MODEL_ALIASES es solo un atajo para los casos frecuentes, y EMBEDDED_COSTS
// el fallback si session-stats no está instalado. Si un modelo no tiene
// precio → costo 0 (no rompe nada, solo queda ese request sin costo).

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

// Fallback para cuando session-stats no está instalado o su JSON no tiene el
// modelo. El JSON de session-stats gana siempre cuando está disponible.
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

// Atajos para los aliases más frecuentes, evaluados antes que los de
// session-stats. deepseek-v4-flash-0731 es el mismo modelo que
// deepseek-v4-flash (alibaba le agrega la fecha de salida). El resto llega por
// el sync bajo demanda, así que esta lista no necesita crecer.
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
let _costsMtime: number | null = null
let _costsPath: string | null = null
let _sessionAliases: Record<string, string> | null = null
let _aliasesMtime: number | null = null
let _aliasesPath: string | null = null

function sessionStatsFile(name: string): string {
  const os = require("os")
  const path = require("path")
  return path.join(os.homedir(), "scripts/session-stats", name)
}

function fileMtime(path: string): number | null {
  try {
    return require("fs").statSync(path).mtimeMs
  } catch {
    return null
  }
}

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
  _costsMtime = null
}

/** Override de la ubicación de `model_aliases.json`. Mismo propósito que
 *  {@link setModelCostsPath}. */
export function setModelAliasesPath(path: string | null): void {
  _aliasesPath = path
  _sessionAliases = null
  _aliasesMtime = null
}

function costsPath(): string {
  return _costsPath ?? sessionStatsFile("model_costs.json")
}

function aliasesPath(): string {
  return _aliasesPath ?? sessionStatsFile("model_aliases.json")
}

/**
 * Reconstruye el mapa de precios si el archivo de session-stats cambió desde la
 * última carga. Devuelve el mapa vigente. `checkFreshness` hace el `stat`: solo
 * se pide desde el camino de fallo, nunca en una resolución exitosa.
 */
function loadModelCosts(checkFreshness = false): Record<string, ModelCost> {
  if (_cachedCosts && !checkFreshness) return _cachedCosts
  if (_cachedCosts && _costsMtime !== null && _costsMtime === fileMtime(costsPath())) {
    return _cachedCosts
  }
  const merged: Record<string, ModelCost> = { ...EMBEDDED_COSTS }
  const p = costsPath()
  try {
    // model_costs.json de session-stats (fuente de verdad de precios).
    if (require("fs").existsSync(p)) {
      const parsed = JSON.parse(require("fs").readFileSync(p, "utf8"))
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
      _costsMtime = fileMtime(p)
    }
  } catch {
    // Si no se puede leer, quedamos con el mapa embebido.
  }
  _cachedCosts = merged
  return merged
}

/**
 * Mapa de alias de session-stats (`model_aliases.json`, ~150 entradas). Es la
 * fuente de verdad de las equivalencias entre nombres de modelo; el plugin solo
 * mantiene las suyas propias como atajo. Se carga bajo demanda: la primera
 * llamada construye el caché y las siguientes solo comparan el mtime.
 */
function loadSessionAliases(checkFreshness = false): Record<string, string> {
  if (_sessionAliases && !checkFreshness) return _sessionAliases
  const p = aliasesPath()
  if (_sessionAliases && _aliasesMtime !== null && _aliasesMtime === fileMtime(p)) {
    return _sessionAliases
  }
  let parsed: Record<string, string> = {}
  try {
    if (require("fs").existsSync(p)) {
      const raw = JSON.parse(require("fs").readFileSync(p, "utf8"))
      for (const [k, v] of Object.entries(raw)) {
        if (typeof v === "string" && v) parsed[k] = v
      }
      _aliasesMtime = fileMtime(p)
    }
  } catch {
    // Sin aliases de session-stats seguimos con MODEL_ALIASES + affixes.
  }
  _sessionAliases = parsed
  return parsed
}

export function resetCostCache(): void {
  _cachedCosts = null
  _costsMtime = null
  _sessionAliases = null
  _aliasesMtime = null
}

/**
 * Normalización pura, sin I/O: alias propio del plugin y luego strip de prefijos
 * de provider y sufijos de variante. Es la forma rápida y la que se usa en
 * caliente; no consulta los alias de session-stats.
 */
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

/**
 * Resuelve un modelo contra los alias de session-stats. Se invoca únicamente
 * desde el camino de fallo de {@link getModelCost}, y es el único punto del
 * plugin que los carga: no hay timers, polling ni sincronización al arranque.
 *
 * Replica el orden de `normalize_model_name()` en session-stats, que consulta
 * su mapa de alias contra el nombre original y contra el nombre ya normalizado.
 */
function resolveWithSessionAliases(model: string, costs: Record<string, ModelCost>): ModelCost | null {
  const aliases = loadSessionAliases(true)
  const normalized = normalizeModelName(model)
  for (const key of [model, model.toLowerCase(), normalized]) {
    if (!key) continue
    const target = aliases[key]
    if (target) {
      const cost = costs[target]
      if (cost) return cost
    }
  }
  return null
}

/**
 * Precio de un modelo, o `null` si no se conoce ninguno.
 *
 * El camino rápido solo usa el alias propio del plugin y el mapa de precios ya
 * cargado, sin tocar el disco. Si eso falla —un modelo nuevo o un precio que
 * session-stats todavía no tiene— se sincroniza con session-stats una sola vez
 * y se reintenta. La sincronización es bajo demanda, no periódica.
 */
export function getModelCost(model: string): ModelCost | null {
  const normalized = normalizeModelName(model)
  const local = loadModelCosts()[normalized]
  if (local) return local

  // Camino de fallo: recargar por si session-stats se actualizó. El precio
  // puede haber aparecido para este mismo nombre, o el modelo necesitar el mapa
  // de alias de session-stats para llegar a una clave con precio.
  const costs = loadModelCosts(true)
  const refreshed = costs[normalized]
  if (refreshed) return refreshed
  return resolveWithSessionAliases(model, costs)
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