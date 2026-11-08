import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { install } from '../src/probe';

// Injected into every frame of the agent's tab with scripting.executeScript({ files: ['/probe.js'], allFrames: true }).
export default defineUnlistedScript(() => {
  install();
});
