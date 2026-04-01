import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import AppIcon from "./components/AppIcon.vue";
import router from "./router/index";
import "./styles/global.css";
import { APP_NAME } from "./appConfig";

const app = createApp(App);
const pinia = createPinia();

// ── Production error overlay ─────────────────────────────────────────────────
if (import.meta.env.PROD) {
  const showError = (msg: string) => {
    try { localStorage.setItem('__app_last_error', msg) } catch (_) {}
    const el = document.getElementById('__app_err') ?? document.createElement('div')
    el.id = '__app_err'
    el.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:99999',
      'background:#1a1a1a', 'color:#ff6b6b',
      'padding:32px', 'font:13px/1.6 monospace',
      'white-space:pre-wrap', 'overflow:auto',
    ].join(';'))
    el.textContent = `${APP_NAME} — startup error\n\n` + msg
    document.body?.appendChild(el)
  }

  app.config.errorHandler = (err, _vm, info) => {
    const e = err instanceof Error ? (err.stack ?? err.message) : String(err)
    showError(`Vue error [${info}]:\n${e}`)
  }

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason
    showError(`Unhandled rejection:\n${r instanceof Error ? (r.stack ?? r.message) : String(r)}`)
  })

  window.onerror = (_msg, _src, _line, _col, err) => {
    showError(`Uncaught error:\n${err instanceof Error ? (err.stack ?? err.message) : String(err ?? _msg)}`)
  }

  const prev = localStorage.getItem('__app_last_error')
  if (prev) {
    console.warn(`[${APP_NAME}] Previous run error:\n`, prev)
    localStorage.removeItem('__app_last_error')
  }
}

app.use(pinia);
app.use(router);
app.component('AppIcon', AppIcon);
app.mount("#app");
