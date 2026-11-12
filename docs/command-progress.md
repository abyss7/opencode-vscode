# Command progress adapters

The extension passively reads existing shell output by its byte cursor. It does
not wrap commands, change their environment, enable a PTY, redirect output, or
infer execution status from text. Terminal execution remains server-owned.

Add a JSON file under `src/progress-adapters/` to support another command. Files
are loaded when the extension starts; no executable adapter code is supported.
See `src/progress-adapters/ninja.json` for the complete format:

- `id`: unique adapter ID.
- `match.executables`: literal executable basenames in shell command positions.
  Compound commands, quoted paths, assignments, redirects and basic
  `env`/`command`/`exec`/`time`/`nice` prefixes are supported. Dynamic commands and
  scripts hidden inside other executables are not resolved.
- `rules[].pattern`: JavaScript regular expression with named captures, applied
  to the current decoded terminal line (including CR redraws and partial lines).
- `rules[].set.completed` and `total`: `{ "capture": "name", "type": "integer" }`.
  Values must be safe integers, with `0 <= completed <= total` and `total > 0`.
- `presentation`: `{ "template": "progress", "label": "Accessible name" }`.

A matching record updates a single inline graphical bar and counter. Nonmatching
output leaves it unchanged. Reaching the total does not complete the execution.
The bar disappears only when the command's execution finishes. Background jobs
keep their existing status, Stop control and output disclosure.

Foreground shells are associated by session, exact command and working directory;
ambiguous identical concurrent invocations are not guessed. Background shells use
the server-issued shellID. No output is read for commands without an adapter.
