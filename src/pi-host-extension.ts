import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  MARIONETTE_PI_DISCOVER_CHANNEL,
  type MarionettePiDiscoveryRequest,
} from './pi-integration.ts';
import { isMarionetteExtensionRegistered, registerMarionetteExtension } from './pi-extension.ts';

/**
 * Entry for hosts that own the generic planning commands themselves.
 *
 * Marionette's manifest lists both this entry and the standalone one, so this
 * must be a no-op whenever the standalone surface is already present. Presence
 * is decided by the shared registration record first — that is independent of
 * which entry loaded first — and by the discovery probe second, which also
 * covers a standalone extension registered against a different module instance.
 */
export default function marionetteHostExtension(pi: ExtensionAPI): void {
  if (isMarionetteExtensionRegistered(pi)) return;

  let standaloneLoaded = false;
  pi.events.emit(MARIONETTE_PI_DISCOVER_CHANNEL, {
    respond() {
      standaloneLoaded = true;
    },
  } satisfies MarionettePiDiscoveryRequest);
  if (standaloneLoaded) return;

  registerMarionetteExtension(pi, { genericPlanning: false });
}
