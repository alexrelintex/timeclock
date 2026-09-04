/**
 * Make a failed assertion fail the build.
 *
 * These suites use console.assert, which prints to stderr and then carries on —
 * so a run could report "ALL TESTS PASSED" with three broken assertions scrolled
 * off the top. That was found the hard way while adding the scheduling tests: two
 * assertions had been failing and the suite still exited 0.
 *
 * Importing this module wraps console.assert to count failures; call finish() at
 * the end and a non-zero exit follows any failure.
 */

let failures = 0;
const passthrough = console.assert.bind(console);

console.assert = (condition: unknown, ...rest: unknown[]): void => {
  if (!condition) {
    failures += 1;
    passthrough(false, ...rest);
  }
};

export function failureCount(): number {
  return failures;
}

export function finish(label: string): void {
  if (failures > 0) {
    console.error(`\n${label}: ${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log(`${label}: all assertions passed`);
}
