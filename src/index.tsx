/**
 * @jsxImportSource @opentui/solid
 */

import type { SessionMessageAssistant } from "@opencode/client"
import type { Context } from "@opencode/plugin/tui/context"
import { Plugin } from "@opencode/plugin/tui"
import { Database } from "bun:sqlite"
import { homedir } from "node:os"
import { join } from "node:path"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { averageTPS, completedTPS, formatTPSValue, peakTPS, streamingTPS } from "./tps"
import { calculateCost, formatCost } from "./pricing"

const REFRESH_MS = 1000

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

function isAssistant(message: { type: string }): message is SessionMessageAssistant {
  return message.type === "assistant"
}

/** Textos ya emissionados por el asistente (respuesta + razonamiento). */
function assistantText(message: SessionMessageAssistant): string {
  return message.content
    .filter((part) => part.type === "text" || part.type === "reasoning")
    .map((part) => part.text)
    .join("")
}

type Totals = {
  input: number
  output: number
  cache: number
  total: number
  requests: number
  cost: number
}

const EMPTY_TOTALS: Totals = { input: 0, output: 0, cache: 0, total: 0, requests: 0, cost: 0 }

// Los totales salen de opencode.db, no de la lista de mensajes del TUI.
//
// `context.data.session.message.list()` devuelve solo una ventana de las últimas
// decenas de entradas, así que en sesiones largas mostraba un subtotal (unos 27
// requests de 262 reales). v1 leía la base con bun:sqlite y veía la sesión
// completa; quedamos igual.
//
// La base se lee en modo read-only. Si algo falla se devuelven totales vacíos y
// la línea se oculta, en vez de mostrar números que no son los reales.
function readTotalsFromDB(sessionID: string): Totals | null {
  try {
    const dbPath = join(homedir(), ".local/share/opencode/opencode.db")
    const db = new Database(dbPath, { readonly: true })
    const rows = db
      .query("SELECT data FROM session_message WHERE session_id = ? AND type = 'assistant' ORDER BY time_created")
      .all(sessionID) as { data: string }[]
    db.close()

    const totals: Totals = { ...EMPTY_TOTALS }
    for (const row of rows) {
      const message = JSON.parse(row.data) as SessionMessageAssistant
      const t = message.tokens
      if (!t) continue
      totals.requests++
      const inTok = t.input ?? 0
      const outTok = (t.output ?? 0) + (t.reasoning ?? 0)
      const cacheTok = (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      totals.input += inTok
      totals.output += outTok
      totals.cache += cacheTok
      totals.cost += calculateCost(message.model?.id ?? "unknown", inTok, outTok, cacheTok)
    }
    totals.total = totals.input + totals.output + totals.cache
    return totals
  } catch {
    return null
  }
}

function View(props: {
  context: Context
  sessionID: string
  version: () => number
}) {
  const context = props.context
  const sessionID = props.sessionID

  // La lista del TUI se usa solo para el TPS en vivo y las medias: son datos
  // del mensaje actual o de los últimos, así que la ventana de la API alcanza.
  // Los totales de la sesión salen de la base (ver readTotalsFromDB).
  const messages = createMemo<SessionMessageAssistant[]>(() => {
    // props.version() agrega la dependencia reactiva: los eventos del server
    // invalidan la lista.
    props.version()
    return context.data.session.message.list(sessionID).filter(isAssistant)
  })

  onMount(() => {
    // El host suele traer los mensajes ya sincronizados; solo pedimos sync si
    // la caché está vacía para no generar invalidaciones en loop.
    if (context.data.session.message.list(sessionID).length === 0) {
      void context.data.session.message.sync(sessionID)
    }
  })

  const lastAssistant = createMemo(() => messages().at(-1))
  const isStreaming = createMemo(() => {
    const last = lastAssistant()
    return last !== undefined && !last.time.completed
  })

  const [tick, setTick] = createSignal(Date.now())
  createEffect(() => {
    if (!isStreaming()) return
    const handle = setInterval(() => setTick(Date.now()), REFRESH_MS)
    onCleanup(() => clearInterval(handle))
  })

  const tps = createMemo<number | null>(() => {
    const last = lastAssistant()
    if (!last) return null
    if (isStreaming()) {
      tick()
      return streamingTPS(assistantText(last), last.time.created, Date.now())
    }
    const idle = messages().findLast((item) => {
      const t = item.tokens
      return item.time.completed !== undefined && !!t && t.output + t.reasoning > 0
    })
    if (!idle?.time.completed || !idle.tokens) return null
    return completedTPS(idle.tokens.output, idle.tokens.reasoning, idle.time.created, idle.time.completed)
  })

  const tpsStats = createMemo(() => {
    const completed = messages()
      .filter((item) => item.time.completed !== undefined && !!item.tokens && item.tokens.output + item.tokens.reasoning > 0)
      .map((item) =>
        completedTPS(item.tokens!.output, item.tokens!.reasoning, item.time.created, item.time.completed!),
      )
      .filter((value): value is number => value !== null)
    const current = tps()
    const averageValues = completed.length > 0 || current === null ? completed : [current]
    const peakValues = isStreaming() && current !== null ? [...completed, current] : completed
    return { current, average: averageTPS(averageValues), peak: peakTPS(peakValues) }
  })

  const tpsLabel = createMemo(() => {
    const stats = tpsStats()
    if (stats.current === null) return null
    return `tps ${formatTPSValue(stats.current)} μ${formatTPSValue(stats.average)} ↑${formatTPSValue(stats.peak)} · `
  })

  const totals = createMemo(() => readTotalsFromDB(sessionID))

  return (
    <Show when={totals()}>
      {(t) => (
        <text fg={context.theme.text.muted}>
          <Show when={tpsLabel()}>
            {(label) => <>{label()}</>}
          </Show>
          {t().requests}r ↑{formatTokens(t().input)} ↓{formatTokens(t().output)} · C{" "}
          {formatTokens(t().cache)} T {formatTokens(t().total)} · {formatCost(t().cost)}
        </text>
      )}
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-tps-stats",
  setup(context) {
    const [version, setVersion] = createSignal(0)
    const bump = () => setVersion((v) => v + 1)

    // v2 renombró los eventos: no existen `message.updated` ni `message.removed`.
    // Lo que invalida los contadores es la llegada de texto, la carga de tokens
    // y el cambio de estado de la sesión.
    const stops = [
      context.data.on("session.text.delta", bump),
      context.data.on("session.text.ended", bump),
      context.data.on("session.usage.updated", bump),
      context.data.on("session.status", bump),
      context.data.on("session.idle", bump),
    ]

    // v1 usaba el slot `session_prompt_right`; en v2 ese slot no existe y la
    // misma posición visual (fila de estado debajo de la ventana de contexto) es
    // `prompt.footer.status`.
    const unregister = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => (
        <Show when={input.sessionID} keyed>
          {(id) => <View context={context} sessionID={id} version={version} />}
        </Show>
      ),
    })

    return () => {
      unregister()
      for (const stop of stops) stop()
    }
  },
})
