import { defineConfig } from 'wxt';

// Firefox-first build. WXT defaults Firefox to MV2; this project targets Firefox MV3 (event-page background,
// sidebar_action for the panel, scripting API for the probe).
// The e2e build (pnpm e2e) bakes in a fixture server URL; it goes to .output/e2e so dist/ stays a clean build.
const e2e = !!process.env.WXT_E2E_URL;
// pnpm e2e:bridge: the normal extension plus a hook that opens the panel as a tab on that page (WXT_BRIDGE_TEST).
const bridgeTest = !!process.env.WXT_BRIDGE_TEST;

export default defineConfig({
  browser: 'firefox',
  manifestVersion: 3,
  outDir: e2e ? '.output/e2e' : bridgeTest ? '.output/e2e-bridge' : 'dist',
  outDirTemplate: '',
  imports: false,
  manifest: {
    name: 'Firefox Browser Use',
    description: 'A fast web agent for local models. Runs in the sidebar, drives the current tab.',
    permissions: ['tabs', 'scripting', 'storage', 'theme', 'webRequest', 'webRequestBlocking'],
    host_permissions: ['<all_urls>'],
    // Firefox's default MV3 CSP adds `upgrade-insecure-requests`, which silently rewrites http://<LAN model server> to
    // https:// and breaks every plain-HTTP local server off localhost (Splash/LM Studio/Ollama on another Mac).
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'self';" },
    // AMO's add-on icon comes from the `icons` key, so it gets PNGs at the sizes AMO and Firefox use. The SVG stays
    // the toolbar button and sidebar icon (action / sidebar_action below).
    icons: { 48: 'icons/icon-48.png', 96: 'icons/icon-96.png', 128: 'icons/icon-128.png' },
    action: { default_title: 'Toggle agent sidebar', default_icon: 'icon.svg' },
    commands: {
      _execute_sidebar_action: {
        suggested_key: { default: 'Alt+Shift+A', mac: 'MacCtrl+Shift+A' },
        description: 'Toggle the agent sidebar',
      },
    },
    browser_specific_settings: {
      gecko: {
        id: 'firefox-computeruse@local',
        strict_min_version: '128.0',
        // Page content goes to the model server the user configures (and to OpenAI with ChatGPT sign-in); the ChatGPT
        // tokens and Bitwarden sign-in are authentication data. Values are from the add-on linter's category enum.
        data_collection_permissions: { required: ['websiteContent', 'authenticationInfo'] },
      },
    },
  },
  hooks: {
    'build:manifestGenerated': (_wxt, manifest) => {
      const m = manifest as { sidebar_action?: Record<string, unknown> };
      if (m.sidebar_action) m.sidebar_action.default_icon = 'icon.svg';
    },
  },
  vite: () => ({
    // Firefox 128 has modulepreload; the polyfill is dead weight.
    build: { target: 'firefox128', sourcemap: false, modulePreload: { polyfill: false } },
    plugins: [
      {
        // The sidebar's HTML ships as written: drop its indentation (no <pre> or <textarea> content to disturb), and the
        // line breaks before tags where whitespace never renders (options, head elements).
        name: 'fcu:strip-html-whitespace',
        transformIndexHtml: {
          order: 'post',
          handler: (html: string) =>
            html.replace(/\n[ \t]+/g, '\n').replace(/>\n(?=<(?:\/?(?:option|select|optgroup|head|body|html)|meta|link|script|title)\b)/g, '>'),
        },
      },
    ],
  }),
});
