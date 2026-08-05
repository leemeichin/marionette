import type { Choice, Trajectory } from './types.ts';

export type InteractionKind = 'agent' | 'ask' | 'input' | 'legacy-human' | 'external-human';

const specParts = (spec: string): [number, number] => {
  const [major = '0', minor = '0'] = spec.split('.');
  return [Number(major) || 0, Number(minor) || 0];
};

/**
 * Spec 0.5 used `ask: true` for fixed-target free-text elicitation. Spec 0.6
 * gives that behavior an explicit `input` bit and reuses `ask` for a trusted
 * operator route decision. Archived trajectories are interpreted by their own
 * spec rather than rewritten during replay.
 */
export function interactionKind(
  trajectory: Pick<Trajectory, 'spec'>,
  choice: Pick<Choice, 'ask' | 'human' | 'input'>,
): InteractionKind {
  const [major, minor] = specParts(trajectory.spec);
  if (choice.human) {
    return major === 0 && minor <= 5 ? 'legacy-human' : 'external-human';
  }
  if (choice.input === true) return 'input';
  if (choice.ask) return major === 0 && minor <= 5 ? 'input' : 'ask';
  return 'agent';
}

export const isOperatorChoice = (
  trajectory: Pick<Trajectory, 'spec'>,
  choice: Pick<Choice, 'ask' | 'human' | 'input'>,
): boolean => interactionKind(trajectory, choice) === 'ask';

export const isInputChoice = (
  trajectory: Pick<Trajectory, 'spec'>,
  choice: Pick<Choice, 'ask' | 'human' | 'input'>,
): boolean => interactionKind(trajectory, choice) === 'input';

export const isExternalHumanChoice = (
  trajectory: Pick<Trajectory, 'spec'>,
  choice: Pick<Choice, 'ask' | 'human' | 'input'>,
): boolean => interactionKind(trajectory, choice) === 'external-human';
