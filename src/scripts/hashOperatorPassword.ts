/**
 * Generates an OPERATOR_PASSWORD_HASH from a password.
 *
 *   npm run operator:hash                 # prompts, no echo
 *   npm run operator:hash -- 'my secret'  # non-interactive (avoid: shows in history)
 *
 * Prints ONLY the hash line, so it can be piped straight into a secret store.
 * The plaintext is never logged, and interactive input is read with echo off so
 * it does not appear on screen or in the terminal scrollback.
 */

import { createInterface } from 'node:readline';

import { hashPassword } from '../auth/operator/password';

/** Reads a line from stdin without echoing it (so the password stays hidden). */
function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // Suppress echo: replace the output writer while the prompt is active.
    const asMutable = rl as unknown as { _writeToOutput?: (s: string) => void };
    const original = asMutable._writeToOutput?.bind(rl);
    asMutable._writeToOutput = (chunk: string): void => {
      if (original === undefined) return;
      // Show the prompt itself, hide everything the user types.
      if (chunk.includes(prompt)) original(chunk);
    };
    rl.question(prompt, (answer: string) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const fromArg = process.argv[2];
  const password =
    fromArg !== undefined && fromArg.length > 0
      ? fromArg
      : await promptHidden('Operator password: ');

  if (password.trim().length < 8) {
    console.error('Password must be at least 8 characters.');
    process.exit(1);
    return;
  }

  const hash = await hashPassword(password);

  process.stderr.write(
    '\nAdd this to your backend .env (single line), then set SESSION_SECRET too:\n\n',
  );
  // The hash itself goes to stdout so `... | pbcopy` / redirection works.
  console.log(`OPERATOR_PASSWORD_HASH=${hash}`);
  process.stderr.write(
    '\nGenerate a session secret with:  openssl rand -base64 48\n',
  );
}

void main().catch((error: unknown) => {
  console.error('Failed to hash password:', error instanceof Error ? error.message : error);
  process.exit(1);
});
