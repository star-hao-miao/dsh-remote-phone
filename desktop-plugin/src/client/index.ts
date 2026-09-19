/**
 * dsh-remote-phone — browser half.
 *
 * A single self-contained script (no imports): it registers itself with the
 * official client module loader (window.__ModuleLoader__.load) and, when the
 * host half is active on the same machine, drops a floating DeepSeek whale
 * button into the page. Clicking it opens the pairing panel — an iframe
 * served by the gateway itself (http://127.0.0.1:<port>/panel) with the QR,
 * LAN/公网 mode switch, and the paired-device list.
 *
 * The bundle must stay dependency-free: tsc emits this file verbatim as a
 * classic script, matching the official client-bundle format.
 */

declare const __ModuleLoader__:
  | {
      load(input: { id: string; factory: (require: (id: string) => unknown) => unknown }): void
    }
  | undefined

const CLIENT_ID = 'dsh-remote-phone'

interface ConfigResponse {
  ok?: boolean
  enabled?: boolean
  port?: number
  cap?: string
  version?: string
}

interface UiState {
  dispose: () => void
}

const GLOBAL_KEY = '__dshRemoteGatewayUi'

interface GlobalUi {
  install?: () => void
  state?: UiState
}

const TEXT: Record<string, string> = {
  title: '远程访问 Remote Gateway',
  hint: '扫码在手机上配对控制这台电脑的 DSH',
  close: '关闭',
}

function installStyles(doc: Document): HTMLStyleElement {
  const existing = doc.getElementById('rg-style') as HTMLStyleElement | null
  if (existing !== null) return existing
  const style = doc.createElement('style')
  style.id = 'rg-style'
  style.textContent = `
#rg-whale-btn{position:fixed;right:20px;bottom:20px;width:46px;height:46px;border-radius:50%;
  border:none;cursor:pointer;display:grid;place-items:center;color:#fff;background:#4d6bfe;
  box-shadow:0 4px 14px rgba(0,0,0,.28);z-index:2147483000;padding:0;transition:transform .12s ease}
#rg-whale-btn:hover{transform:scale(1.08)}
#rg-whale-btn svg{display:block}
#rg-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483100;
  display:flex;align-items:center;justify-content:center;padding:18px}
#rg-panel{position:relative;width:min(430px,96vw);height:min(640px,92vh);background:#fff;color:#18191c;
  border-radius:16px;overflow:hidden;display:flex;flex-direction:column;
  box-shadow:0 12px 48px rgba(0,0,0,.35);font:14px/1.5 -apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){#rg-panel{background:#18181b;color:#eee}}
#rg-panel-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.25)}
#rg-panel-title{flex:1;font-weight:600;font-size:14px;display:flex;align-items:center;gap:8px}
#rg-panel-close{background:transparent;border:none;font-size:18px;cursor:pointer;color:inherit;padding:0 6px;border-radius:8px}
#rg-panel-close:hover{background:rgba(128,128,128,.18)}
#rg-panel-frame{flex:1;width:100%;border:none;background:#fff}
@media (prefers-color-scheme:dark){#rg-panel-frame{background:#141416}}
`
  doc.head.appendChild(style)
  return style
}

function escapeAttr(value: string): string {
  return value.replace(/[&"]/g, char => (char === '&' ? '&amp;' : '&quot;'))
}

function showPanel(doc: Document, port: number, cap: string): void {
  const existing = doc.getElementById('rg-overlay') as HTMLElement | null
  if (existing !== null) {
    existing.style.display = 'flex'
    return
  }
  const overlay = doc.createElement('div')
  overlay.id = 'rg-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', TEXT.title)
  overlay.innerHTML = `
    <div id="rg-panel">
      <div id="rg-panel-head">
        <span id="rg-panel-title">DSH Remote Gateway</span>
        <button id="rg-panel-close" aria-label="${escapeAttr(TEXT.close)}">✕</button>
      </div>
      <iframe id="rg-panel-frame" title="${escapeAttr(TEXT.title)}" referrerpolicy="no-referrer"
        src="http://127.0.0.1:${Number(port)}/panel?cap=${escapeAttr(cap)}"></iframe>
    </div>`
  doc.body.appendChild(overlay)
  const close = (): void => {
    overlay.style.display = 'none'
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  const closeBtn = doc.getElementById('rg-panel-close')
  closeBtn?.addEventListener('click', close)
  doc.addEventListener('keydown', function onKey(event) {
    if (event.key === 'Escape') {
      close()
      doc.removeEventListener('keydown', onKey)
    }
  })
}

function installButton(doc: Document, port: number, cap: string): void {
  const existing = doc.getElementById('rg-whale-btn') as HTMLButtonElement | null
  if (existing !== null) {
    doc.getElementById('rg-overlay')?.style.setProperty('display', 'flex')
    return
  }
  const button = doc.createElement('button')
  button.id = 'rg-whale-btn'
  button.title = TEXT.hint
  button.setAttribute('aria-label', TEXT.title)
  // The whale mark is inlined below to keep the bundle dependency-free.
  button.innerHTML =
    `<svg viewBox="0 0 28 22" width="26" height="20" fill="none" aria-hidden="true">` +
    `<path d="M2.6 13.4c-.3-2.7 1.1-5.5 3.5-6.8C9 5 12.4 4.6 16 6.2c2.7 1.2 4.6 3.4 5.4 6 1.6-2 4.3-3.1 6.6-3.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>` +
    `<path d="M4 17.9c1-.6 1.8-.3 2.6.2 1.4 1 2.8 1.1 4.5.4 1.8-.7 3.7-.8 5.2.3 1.3.9 2.9 1 3.7-.3" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>` +
    `<path d="M20.3 9.3a1.15 1.15 0 1 0 0 2.3 1.15 1.15 0 0 0 0-2.3Z" fill="currentColor"/></svg>`
  button.addEventListener('click', () => showPanel(doc, port, cap))
  doc.body.appendChild(button)
}

function fetchConfig(windowImpl: Window): Promise<ConfigResponse> {
  return fetch('/api/remote-gateway/config', { headers: { accept: 'application/json' }, cache: 'no-store' })
    .then(response => (response.ok ? response.json() : Promise.reject(new Error(`config HTTP ${response.status}`))))
    .then(json => json as ConfigResponse)
}

/**
 * cordis client entry: called once the plugin's injected services are ready.
 * Only DOM is used here (the official UI shell is already mounted by the
 * time client plugins apply).
 */
function applyClient(): void {
  const doc = window.document
  const attempts = 5
  let attempt = 0

  const bootstrap = (): void => {
    if (doc.getElementById('rg-whale-btn') !== null) return
    fetchConfig(window)
      .then((config) => {
        if (config.ok !== true || config.enabled !== true || typeof config.port !== 'number' || typeof config.cap !== 'string') {
          return
        }
        const ready = (): void => {
          if (doc.body === null) return
          installStyles(doc)
          installButton(doc, config.port as number, config.cap as string)
        }
        if (doc.readyState === 'loading') {
          doc.addEventListener('DOMContentLoaded', ready)
        } else {
          ready()
        }
      })
      .catch(() => {
        // The host probe may not be mounted yet (plugin load order); retry a
        // few times before giving up.
        attempt += 1
        if (attempt < attempts) window.setTimeout(bootstrap, 1500 * attempt)
      })
  }
  bootstrap()
}

/** Dispose previously installed UI (HMR re-apply). */
function disposeUi(): void {
  const style = window.document.getElementById('rg-style')
  style?.remove()
  const button = window.document.getElementById('rg-whale-btn')
  button?.remove()
  const overlay = window.document.getElementById('rg-overlay')
  overlay?.remove()
}

const globalState = (window as unknown as Record<string, GlobalUi>)[GLOBAL_KEY] ?? ({} as GlobalUi)
;(window as unknown as Record<string, GlobalUi>)[GLOBAL_KEY] = globalState
globalState.install = (): void => {
  if (globalState.state !== undefined) return
  disposeUi()
  const ui = {} as UiState
  const iv = window.setInterval(() => {
    if (window.document.body !== null && window.document.getElementById('rg-whale-btn') !== null) {
      window.clearInterval(iv)
    }
  }, 1000)
  applyClient()
  ui.dispose = () => {
    window.clearInterval(iv)
    disposeUi()
    globalState.state = undefined
  }
  globalState.state = ui
}

__ModuleLoader__?.load({
  id: CLIENT_ID,
  factory: () => ({
    inject: [],
    apply: () => {
      globalState.install?.()
    },
  }),
})
