import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import React, { act } from 'react';
import { render } from 'ink';
import { InteractiveInput } from '../dist/components/InteractiveInput.js';

async function inputFixture(t, predefinedOptions) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => {};
  stdin.ref = () => {};
  stdin.unref = () => {};
  const stdout = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  stdout.columns = 80;
  const answers = [];
  let view;
  await act(async () => {
    view = render(
      React.createElement(InteractiveInput, {
        question: 'How should we proceed?',
        questionId: 'question-1',
        predefinedOptions,
        onSubmit: (questionId, value) => answers.push({ questionId, value }),
      }),
      {
        stdin,
        stdout,
        stderr: stdout,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );
  });
  t.after(async () => {
    await act(async () => {
      view.unmount();
    });
    view.cleanup();
    stdin.destroy();
    stdout.destroy();
  });
  return {
    answers,
    async type(value) {
      await act(async () => {
        stdin.write(value);
        await setImmediate();
      });
    },
  };
}

for (const { name, options, input, expected } of [
  {
    name: 'free-text answer',
    input: ['Keep my changes'],
    expected: 'Keep my changes',
  },
  { name: 'empty answer', input: [], expected: '' },
  {
    name: 'selected option',
    options: ['Continue', 'Stop'],
    input: ['\u001b[B'],
    expected: 'Stop',
  },
  {
    name: 'custom answer instead of an option',
    options: ['Continue', 'Stop'],
    input: ['Use another approach'],
    expected: 'Use another approach',
  },
  {
    name: 'option selected after typing',
    options: ['Continue', 'Stop'],
    input: ['custom', '\u001b[B'],
    expected: 'Stop',
  },
]) {
  test(`one Enter submits one ${name}`, async (t) => {
    const ui = await inputFixture(t, options);
    for (const value of input) await ui.type(value);
    await ui.type('\r');
    assert.deepEqual(ui.answers, [
      { questionId: 'question-1', value: expected },
    ]);
  });
}
