# Command progress adapters

The extension passively reads existing output by its byte cursor. It does
not wrap commands, change their environment, enable a PTY, redirect output, or
infer execution status from text. Terminal execution remains server-owned.

Add a JSON file under `src/progress-adapters/` to support another command. Files
are loaded when the extension starts; no executable adapter code is supported.
See `src/progress-adapters/ninja.json` for the complete format:

- `id`: unique adapter ID.
- `match.executables`: literal executable basenames in shell command positions
  select candidate adapters; Linux discovery then checks the real executable.
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
The bar disappears when the observed executable exits, even if the outer shell
continues with tests. Background jobs keep their existing status, Stop control
and output disclosure. No completion state is inferred from the log.

Foreground shells are associated by session, exact command and working directory;
ambiguous identical concurrent invocations are not guessed. Background shells use
the server-issued shellID. No output is read for commands without an adapter.

## Output sources and portability

The existing authenticated server plugin has a read-only `progress` RPC. Discovery
and file IO happen on the OpenCode execution host, not in the webview or on an
assumed local VS Code host. These reads are not model tool calls and do not add
log contents to the model context. Existing bounded shell results are unchanged.

On Linux, the observer checks only descendants of the identified shell, which
must itself belong to the OpenCode server. It matches real executable names and
uses PID plus process start time to reject PID reuse. Multiple concurrent matches
are ambiguous and do not produce a single misleading bar.

- Regular stdout/stderr files: independent positional reads, identified by
  device/inode, with cursors and reset on replacement or observed truncation.
  Incremental UTF-8 decoding and CR/ANSI parsing retain state across chunks.
- Pipes, sockets and PTYs: use native shell capture, never read the process's
  descriptor directly. For compound commands, shared capture starts at attachment
  time, not at an old `head` excerpt from another stage. A direct unredirected
  invocation can safely retain its initial captured progress.
- Polling can miss very short-lived executables; missing progress is preferable
  to displaying unrelated output. Discovery does not expand shell variables or
  guess log filenames. Only regular-file outputs of the actual process are read.

The file reader, source protocol, parser and UI are platform-independent. Automatic
descriptor discovery is currently Linux-only; VS Code terminal/task APIs do not
observe external OpenCode processes. Other platforms/older plugin versions retain
capture progress only for a single direct, unredirected adapted invocation.
Compound redirected scripts never fall back to parsing their `head` output.
