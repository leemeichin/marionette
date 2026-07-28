import { Type } from 'typebox';
import {
  PiAgentBridge,
} from '../dist/index.js';

const splitArgs = (input) =>
  [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? '');

const projectionOf = (result) => result.result.projection;

const safeRunId = (value) =>
  value.replace(/[^A-Za-z0-9._-]/g, '-');

const errorMessage = (error) =>
  error instanceof Error ? error.message : String(error);

export default function marionetteExtension(pi) {
  let bridge = null;

  pi.registerFlag('marionette-plan', {
    description: 'Bind this Pi session to a Marionette .mar plan',
    type: 'string',
  });
  pi.registerFlag('marionette-run', {
    description: 'Runtime run id used with --marionette-plan',
    type: 'string',
  });
  pi.registerFlag('marionette-human', {
    description: 'Human identity recorded by /marionette-decide',
    type: 'string',
  });

  const updateUi = (projection, ctx) => {
    const phase = projection.node?.id ?? projection.status;
    ctx.ui.setStatus('marionette', `${phase} · r${projection.revision}`);
    if (!projection.escalation) {
      ctx.ui.setWidget('marionette-escalation', undefined);
      return;
    }
    const lines = [
      `Marionette needs a human decision (${projection.escalation.id})`,
      ...projection.escalation.choices.map((choice) => `  ${choice.id} — ${choice.label}`),
      ...projection.escalation.fallbacks.map((fallback) =>
        `  fallback ${fallback.choiceId} opens ${fallback.dueAt ?? 'at its authored timeout'}`),
      'Use /marionette-decide to respond.',
    ];
    ctx.ui.setWidget('marionette-escalation', lines);
  };

  const open = async (
    planFile,
    runId,
    ctx,
  ) => {
    bridge = await PiAgentBridge.open({
      planFile,
      runId,
      sessionId: ctx.sessionManager.getSessionId(),
    });
    const projection = projectionOf(await bridge.next());
    updateUi(projection, ctx);
    return projection;
  };

  const publishProjection = (
    projection,
    triggerTurn,
  ) => {
    const instruction = projection.status === 'awaiting-human'
      ? 'Stop autonomous work and wait. The user must answer through /marionette-decide.'
      : 'Use marionette_walk for the next graph transition after completing the current phase.';
    pi.sendMessage({
      customType: 'marionette-projection',
      content: `${instruction}\n\n${JSON.stringify(projection)}`,
      display: true,
      details: projection,
    }, { triggerTurn });
  };

  pi.registerCommand('marionette-start', {
    description: 'Start or resume a Marionette plan: /marionette-start <plan.mar> [run-id]',
    handler: async (args, ctx) => {
      const [planFile, requestedRun] = splitArgs(args);
      if (!planFile) {
        ctx.ui.notify('Usage: /marionette-start <plan.mar> [run-id]', 'error');
        return;
      }
      const runId = requestedRun ??
        safeRunId(`pi-${ctx.sessionManager.getSessionId()}`);
      try {
        const projection = await open(planFile, runId, ctx);
        pi.appendEntry('marionette-binding', { planFile: bridge.planFile, runId });
        publishProjection(projection, true);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
      }
    },
  });

  pi.registerCommand('marionette-decide', {
    description: 'Record a human answer at an @human checkpoint',
    handler: async (args, ctx) => {
      if (!bridge) {
        ctx.ui.notify('No Marionette run is bound; use /marionette-start first.', 'error');
        return;
      }
      try {
        const current = projectionOf(await bridge.next());
        const escalation = current.escalation;
        if (!escalation) {
          ctx.ui.notify(`Run is ${current.status}; no human decision is pending.`, 'warning');
          return;
        }

        const tokens = splitArgs(args);
        let choiceId = tokens.shift();
        if (!choiceId && ctx.hasUI) {
          const labels = escalation.choices.map((choice) => `${choice.id} — ${choice.label}`);
          const selected = await ctx.ui.select('Choose a Marionette outcome', labels);
          choiceId = escalation.choices[labels.indexOf(selected ?? '')]?.id;
        }
        const choice = escalation.choices.find((candidate) => candidate.id === choiceId);
        if (!choice) {
          ctx.ui.notify(
            `Choose one of: ${escalation.choices.map((candidate) => candidate.id).join(', ')}`,
            'error',
          );
          return;
        }

        let humanId = pi.getFlag('marionette-human');
        if (typeof humanId !== 'string' && ctx.hasUI) {
          humanId = await ctx.ui.input('Your name', 'recorded as the decision actor');
        }
        if (typeof humanId !== 'string' || !humanId.trim()) {
          ctx.ui.notify('Set --marionette-human <name> or provide a name in the prompt.', 'error');
          return;
        }

        let rationale = tokens.join(' ').trim();
        if (!rationale && ctx.hasUI) {
          rationale = (await ctx.ui.editor('Decision rationale', '') ?? '').trim();
        }
        if (!rationale) {
          ctx.ui.notify('A human rationale is required.', 'error');
          return;
        }

        const result = await bridge.humanChoose(
          { id: humanId.trim(), uri: `pi://human/${encodeURIComponent(humanId.trim())}` },
          choice.id,
          rationale,
          `human:${escalation.id}:${choice.id}`,
        );
        const projection = projectionOf(result);
        updateUi(projection, ctx);
        pi.appendEntry('marionette-human-decision', {
          escalationId: escalation.id,
          choiceId: choice.id,
          human: humanId.trim(),
          rationale,
          revision: projection.revision,
        });
        publishProjection(projection, true);
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
      }
    },
  });

  pi.registerTool({
    name: 'marionette_walk',
    label: 'Marionette walk',
    description: 'Read or advance the bound Marionette run. This tool is agent-bound and cannot take @human choices.',
    parameters: Type.Object({
      operation: Type.Union([
        Type.Literal('next'),
        Type.Literal('choose'),
        Type.Literal('advance'),
        Type.Literal('observe'),
      ]),
      choiceId: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      value: Type.Optional(Type.Union([Type.String(), Type.Number(), Type.Boolean()])),
      rationale: Type.Optional(Type.String()),
    }, { additionalProperties: false }),
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      if (!bridge) {
        return {
          content: [{ type: 'text', text: 'No run is bound. Ask the user to run /marionette-start <plan.mar>.' }],
          details: {},
          isError: true,
        };
      }
      try {
        let result;
        switch (params.operation) {
          case 'next':
            result = await bridge.next();
            break;
          case 'choose':
            if (!params.choiceId || !params.rationale) {
              throw new Error('choose requires choiceId and rationale');
            }
            result = await bridge.choose(params.choiceId, params.rationale, toolCallId);
            break;
          case 'advance':
            if (!params.rationale) throw new Error('advance requires rationale');
            result = await bridge.advance(params.rationale, toolCallId);
            break;
          case 'observe':
            if (!params.name || params.value === undefined || !params.rationale) {
              throw new Error('observe requires name, value, and rationale');
            }
            result = await bridge.observe(
              params.name,
              params.value,
              params.rationale,
              toolCallId,
            );
            break;
        }
        const projection = projectionOf(result);
        updateUi(projection, ctx);
        const stop = projection.status === 'awaiting-human'
          ? '\nSTOP: do not infer or take a human choice. Wait for /marionette-decide.'
          : '';
        return {
          content: [{
            type: 'text',
            text: `${JSON.stringify(projection)}${stop}`,
          }],
          details: { projection, replayed: result.replayed },
        };
      } catch (error) {
        return {
          content: [{ type: 'text', text: errorMessage(error) }],
          details: {},
          isError: true,
        };
      }
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    const configuredPlan = pi.getFlag('marionette-plan');
    const configuredRun = pi.getFlag('marionette-run');
    let binding;
    if (typeof configuredPlan === 'string') {
      binding = {
        planFile: configuredPlan,
        runId: typeof configuredRun === 'string'
          ? configuredRun
          : safeRunId(`pi-${ctx.sessionManager.getSessionId()}`),
      };
    } else {
      const entry = [...ctx.sessionManager.getEntries()].reverse().find((candidate) =>
        candidate.type === 'custom' && candidate.customType === 'marionette-binding');
      binding = entry?.type === 'custom' ? entry.data : undefined;
    }
    if (!binding) return;
    try {
      const projection = await open(binding.planFile, binding.runId, ctx);
      updateUi(projection, ctx);
    } catch (error) {
      ctx.ui.notify(`Marionette resume failed: ${errorMessage(error)}`, 'error');
    }
  });
}
