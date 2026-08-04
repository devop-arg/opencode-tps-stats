/**
 * @jsxImportSource @opentui/solid
 */

import type { TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui"
import type { AssistantMessage } from "@opencode-ai/sdk/v2"
import { Database } from "bun:sqlite"
import path from "path"
import os from "os"
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { averageTPS, completedTPS, formatTPSValue, peakTPS, streamingTPS } from "./tps"

const id = "opencode-tps-stats"
const REFRESH_MS = 1000

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1000)}k`
  return String(n)
}

type Totals = {
  input: number
  output: number
  cache: number
  total: number
  requests: number
}

const EMPTY_TOTALS: Totals = { input: 0, output: 0, cache: 0, total: 0, requests: 0 }

// Lee los totales de la DB de opencode, igual que session-stats
// (get_opencode_sqlite_sessions): un request = un mensaje assistant con tokens.
function readDBTotals(session_id: string): Totals {
  try {
    const dbPath = path.join(os.homedir(), ".local/share/opencode/opencode.db")
    const db = new Database(dbPath, { readonly: true })
    const stmt = db.prepare(
      "SELECT data FROM message WHERE session_id = ? ORDER BY time_created",
    )
    const rows = stmt.all(session_id) as { data: string }[]
    let input = 0
    let output = 0
    let cache = 0
    let requests = 0
    for (const row of rows) {
      const msg = JSON.parse(row.data)
      if (msg.role !== "assistant") continue
      const t = msg.tokens
      if (!t || (t.input === undefined && t.output === undefined && t.reasoning === undefined)) {
        continue
      }
      requests++
      input += t.input ?? 0
      output += (t.output ?? 0) + (t.reasoning ?? 0)
      cache += (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    }
    db.close()
    return { input, output, cache, total: input + output + cache, requests }
  } catch {
    return { ...EMPTY_TOTALS }
  }
}

function View(props: {
  api: Parameters<TuiPlugin>[0]
  session_id: string
  version: () => number
}) {
  const theme = () => props.api.theme.current
  const msg = createMemo(() => props.api.state.session.messages(props.session_id))
  const lastAssistant = createMemo(() =>
    msg().findLast((item): item is AssistantMessage => item.role === "assistant"),
  )
  const isStreaming = createMemo(
    () => lastAssistant() !== undefined && !lastAssistant()!.time.completed,
  )

  const [tick, setTick] = createSignal(Date.now())
  createEffect(() => {
    if (!isStreaming()) return
    const handle = setInterval(() => setTick(Date.now()), REFRESH_MS)
    onCleanup(() => clearInterval(handle))
  })

  const tps = createMemo<number | null>(() => {
    const m = lastAssistant()
    if (!m) return null
    if (isStreaming()) {
      tick()
      const combined = props.api.state
        .part(m.id)
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => p.text)
        .join("")
      return streamingTPS(combined, m.time.created, Date.now())
    }
    const idle = msg().findLast(
      (item): item is AssistantMessage =>
        item.role === "assistant" &&
        item.time.completed !== undefined &&
        item.tokens.output + item.tokens.reasoning > 0,
    )
    if (!idle?.time.completed) return null
    return completedTPS(idle.tokens.output, idle.tokens.reasoning, idle.time.created, idle.time.completed)
  })

  const tpsStats = createMemo(() => {
    const completed = msg()
      .filter(
        (item): item is AssistantMessage =>
          item.role === "assistant" &&
          item.time.completed !== undefined &&
          item.tokens.output + item.tokens.reasoning > 0,
      )
      .map((item) => completedTPS(item.tokens.output, item.tokens.reasoning, item.time.created, item.time.completed!))
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

  const totals = createMemo(() => {
    props.version()
    return readDBTotals(props.session_id)
  })

  return (
    <text fg={theme().textMuted}>
      <Show when={tpsLabel()}>
        {(label) => <>{label()}</>}
      </Show>
      {totals().requests}r ↑{formatTokens(totals().input)} ↓{formatTokens(totals().output)}{" "}
      · C {formatTokens(totals().cache)} T {formatTokens(totals().total)}
    </text>
  )
}

const tui: TuiPlugin = async (api) => {
  const [version, setVersion] = createSignal(0)

  const bump = () => setVersion((v) => v + 1)
  api.event.on("message.updated", bump)
  api.event.on("message.removed", bump)
  api.event.on("session.status", bump)

  api.slots.register({
    order: 9999,
    slots: {
      session_prompt_right: (_ctx, props) => (
        <View api={api} session_id={props.session_id} version={version} />
      ),
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id, tui }
export default plugin
