// Regenerate the pty transcripts in transcripts/ against the real CLI.
//
// Every demo frame on the site is a verbatim capture (check-fidelity.mjs
// fails the build if a rendered frame diverges by a byte), so any edit to
// the walkthrough plans or the CLI's output means recapturing. This script
// is the choreography: it replays the manifest's commands in a scratch
// directory — including the file swaps and uncaptured state-setup steps the
// demo narrative implies — and rewrites transcripts/*.txt.
//
// Usage:  node build/capture.mjs        (from docs-site/)
// Needs:  util-linux `script` for the pty (colors are TTY-gated), Linux/macOS.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..');
const repo = resolve(site, '..');
const transcripts = join(site, 'transcripts');
const cli = join(repo, 'bin', 'marionette.js');

// The example plans in transcripts/ are display copies; examples/ is the
// source of truth. Sync before capturing so the site's <mar-file> sources
// and the captured output can never drift apart.
for (const f of ['build_mvp.mar', 'paas_replatform.mar']) {
  copyFileSync(join(repo, 'examples', f), join(transcripts, f));
}

const scratch = mkdtempSync(join(tmpdir(), 'marionette-capture-'));
for (const f of ['checkout.mar', 'checkout-v2.mar', 'checkout-broken.mar',
                 'build_mvp.mar', 'paas_replatform.mar', 'session.ndjson']) {
  copyFileSync(join(transcripts, f), join(scratch, f));
}

/** Run a CLI command in the scratch dir under a pty; return {out, code}. */
function pty(cmd, { stdin } = {}) {
  const shellCmd = `node ${cli} ${cmd}` + (stdin ? ` < ${stdin}` : '');
  try {
    const env = { ...process.env, TERM: 'xterm-256color' };
    delete env.NO_COLOR; // presence alone disables color
    const out = execFileSync('script', ['-qec', shellCmd, '/dev/null'], {
      cwd: scratch,
      encoding: 'utf8',
      env,
    });
    return { out: out.replaceAll('\r\n', '\n'), code: 0 };
  } catch (e) {
    return { out: (e.stdout ?? '').replaceAll('\r\n', '\n'), code: e.status ?? 1 };
  }
}

// The choreography. `capture` names a manifest id; steps without one are
// narrative setup (state resets between demo frames) and are not recorded.
const steps = [
  { copy: ['checkout-broken.mar', 'checkout.mar'] },
  { capture: '01-validate-broken', cmd: 'validate checkout.mar', exit: 1 },
  { copy: ['checkout.mar.orig', 'checkout.mar'] },
  { capture: '02-validate-clean', cmd: 'validate checkout.mar --strict', exit: 0 },
  { capture: '03-compile', cmd: 'compile checkout.mar', exit: 0 },
  { capture: '04-summarize', cmd: 'summarize checkout.mar', exit: 0 },
  { capture: '05-render', cmd: 'render checkout.mar', exit: 0 },
  { capture: '06-state-init', cmd: 'state init checkout.mar', exit: 0 },
  { capture: '07-brief', cmd: 'brief checkout.mar', exit: 0 },
  { capture: '08-choose-refused', cmd: 'state choose checkout.mar 0 --actor agent --rationale "metrics look good"', exit: 1 },
  { capture: '09-choose-loop', cmd: 'state choose checkout.mar 1 --actor agent --rationale "conversion flat; iterating on the payment step"', exit: 0 },
  { capture: '10-state-show', cmd: 'state show checkout.mar', exit: 0 },
  { capture: '17-brief-json', cmd: 'brief checkout.mar --json', exit: 0 },
  { capture: '11-choose-human', cmd: 'state choose checkout.mar 0 --actor lee --rationale "cohort shows +9% completion; ship it"', exit: 0 },
  { capture: '12-advance-end', cmd: 'state advance checkout.mar --actor agent --rationale "flag at 100%, old flow retired"', exit: 0 },
  { capture: '13-brief-completed', cmd: 'brief checkout.mar', exit: 0 },
  // Reset: iterate the loop to exhaustion so only @human doors remain.
  { cmd: 'state init checkout.mar --force', exit: 0 },
  { cmd: 'state choose checkout.mar 1 --actor agent --rationale "attempt 2: shipping address autofill"', exit: 0 },
  { cmd: 'state choose checkout.mar 1 --actor agent --rationale "attempt 3: one-page flow"', exit: 0 },
  { cmd: 'state choose checkout.mar 1 --actor agent --rationale "attempt 4: express pay buttons"', exit: 0 },
  { cmd: 'state choose checkout.mar 1 --actor agent --rationale "attempt 5: trust badges at payment"', exit: 0 },
  { capture: '18-brief-awaiting', cmd: 'brief checkout.mar', exit: 0 },
  // Reset again to mid-flight, then edit the plan underneath the state.
  { cmd: 'state init checkout.mar --force', exit: 0 },
  { cmd: 'state choose checkout.mar 1 --actor agent --rationale "conversion flat; iterating on the payment step"', exit: 0 },
  { copy: ['checkout-v2.mar', 'checkout.mar'] },
  { capture: '14-drift', cmd: 'state show checkout.mar', exit: 3 },
  { capture: '15-rebind', cmd: 'state rebind checkout.mar', exit: 0 },
  { capture: '16-help', cmd: 'help', exit: 0 },
  { capture: '19-summarize-build-mvp', cmd: 'summarize build_mvp.mar', exit: 0 },
  { capture: '20-validate-paas', cmd: 'validate paas_replatform.mar --strict', exit: 0 },
  { capture: '21-runtime-session', cmd: 'start checkout.mar --run docs-demo --principal coding-agent --role agent', stdin: 'session.ndjson', exit: 0 },
];

// Keep a pristine copy of the good plan for the post-broken swap.
copyFileSync(join(transcripts, 'checkout.mar'), join(scratch, 'checkout.mar.orig'));

let failures = 0;
for (const step of steps) {
  if (step.copy) {
    copyFileSync(join(scratch, step.copy[0]), join(scratch, step.copy[1]));
    continue;
  }
  const { out, code } = pty(step.cmd, { stdin: step.stdin });
  if (code !== step.exit) {
    console.error(`✗ ${step.capture ?? '(setup)'}: exit ${code}, expected ${step.exit}\n${out}`);
    failures++;
    continue;
  }
  if (step.capture) {
    writeFileSync(join(transcripts, `${step.capture}.txt`), out);
    console.log(`✓ ${step.capture} (exit ${code})`);
  }
}

rmSync(scratch, { recursive: true, force: true });
if (failures > 0) {
  console.error(`${failures} step(s) failed; transcripts partially updated`);
  process.exit(1);
}
console.log('all transcripts recaptured');
