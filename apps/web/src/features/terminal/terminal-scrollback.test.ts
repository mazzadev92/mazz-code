import { expect, it } from 'vitest';
import { TERMINAL_SCROLLBACK } from './InteractiveTerminal';

it('keeps 10 000 lines of terminal scrollback (spec 02)', () => {
  expect(TERMINAL_SCROLLBACK).toBe(10_000);
});
