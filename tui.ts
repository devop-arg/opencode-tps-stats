// Entry point de TUI para la API de plugins de OpenCode v2.
//
// v2 no resuelve el campo `exports["./tui"]` de este package cuando el plugin
// se referencia por ruta absoluta desde `cli.json`: espera un entrypoint
// `tui.ts` en la raíz del directorio. Este archivo delegue en la
// implementación real, que vive en src/index.tsx.
export { default } from "./src/index"
