# Changelog

## 0.2.0

Primera versión sobre la API de plugins de OpenCode v2. La API de TUI plugins
de v1 no está soportada.

### Migración a v2

- El entrypoint usa `Plugin.define({ id, setup })` de `@opencode/plugin/tui` en
  lugar del módulo `{ id, tui }` de v1.
- El slot `session_prompt_right` de v1 no existe en v2. Se usa
  `prompt.footer.status`, que es la misma fila de estado debajo de la ventana de
  contexto.
- Los mensajes se discriminan por `type` (`assistant`/`user`/`idle`) en lugar de
  por `role`, y el modelo vive en `model.id`.
- Los eventos se renombraron: `session.text.delta`, `session.text.ended`,
  `session.usage.updated`, `session.status` y `session.idle`.
- Se agrega `tui.ts` en la raíz del paquete. v2 no resuelve el
  `exports["./tui"]` de `package.json` cuando el plugin se referencia por ruta
  local: espera ese archivo en la raíz. Sin él, una referencia por ruta carga en
  silencio sin mostrar nada.

### Precios

- Se lee `model_aliases.json` de session-stats, que es la fuente de verdad con
  unas 150 entradas, además de `model_costs.json`. Antes el plugin mantenía un
  mapa propio de 7 alias y los modelos que solo session-stats conocía quedaban
  sin precio.
- La sincronización es bajo demanda: ocurre solo cuando la resolución local
  falla, es decir cuando aparece un modelo nuevo o falta un precio. No hay
  timers, polling ni sincronización al arranque, y las relecturas se filtran
  por mtime.
- El mapa local de aliases queda como atajo y ya no necesita crecer.

### Totales de sesión

- Los totales se leen de `opencode.db` en modo read-only. La lista de mensajes
  del TUI está paginada y mostraba un subtotal en sesiones largas.
- El costo se muestra siempre, incluso en `$0.0000`. Antes se ocultaba cuando
  daba cero, lo que en un modelo gratuito se leía como que el plugin no
  calculaba el costo.
- Si la base no se puede leer, la línea se oculta en vez de mostrar números que
  no son los reales.

### Tests

- 24 tests, todos en verde. Los de precios son herméticos: no dependen de los
  precios vigentes de session-stats.
- Los tests que dependen de la realidad eligen solos un modelo usado en los
  últimos 7 días, leído de la base de opencode, para no depender de un id de
  modelo que se pudre.
