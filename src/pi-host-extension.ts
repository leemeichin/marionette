import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  MARIONETTE_PI_DISCOVER_CHANNEL,
  type MarionettePiDiscoveryRequest,
} from './pi-integration.ts';
import { registerMarionetteExtension } from './pi-extension.ts';

export default function marionetteHostExtension(pi: ExtensionAPI): void {
  let standaloneLoaded = false;
  pi.events.emit(MARIONETTE_PI_DISCOVER_CHANNEL, {
    respond() {
      standaloneLoaded = true;
    },
  } satisfies MarionettePiDiscoveryRequest);
  if (!standaloneLoaded) registerMarionetteExtension(pi, { genericPlanning: false });
}
