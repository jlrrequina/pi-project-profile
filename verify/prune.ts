/**
 * Turn a wall of tool output into the few lines the model needs. Diagnostic
 * lines (file:line:col, error/FAIL markers) win; a short tail is kept when the
 * output has no recognisable diagnostics.
 */

const DIAG_PATTERNS: RegExp[] = [
  /^\s*[^\s:()]+\.[a-z]{1,10}\(\d+,\d+\): (error|warning) TS\d+/i, // tsc
  /^\s*[^\s:()]+\.[a-z]{1,10}:\d+:\d+ - error TS\d+/i, // tsc pretty
  /^\s*[^\s:]+:\d+:\d+:?\s+(error|warning|E|W|C|F|R|N)\b/i, // gcc/go/ruff/rubocop/shellcheck/flake8 style
  /^\s*[^\s:]+:\d+:\s+(error|warning|note):/i, // mypy
  /^\s*[^\s:]+:\d+:\d+\s+-\s+(error|warning)/i, // pyright
  /^\s*\d+:\d+\s+(error|warning)\s/, // eslint stylish
  /^(error|warning)(\[[A-Z]\d+\])?:\s/, // cargo/rustc
  /^\s*-->\s+\S+:\d+:\d+/, // rustc location
  /^\s*(FAIL|FAILED|ERROR|✖|✗|×|✕|✘)\b/, // test runners
  /^\s*(---\s+FAIL:|panic:|fatal error:)/, // go test
  /^\s*E\s{2,}/, // pytest assertion detail
  /^\s*(AssertionError|TypeError|ReferenceError|SyntaxError|RangeError|Error:|\w+Error:|Exception:|\w+Exception:)/,
  /^\s*Traceback \(most recent call last\)/,
  /^\s*File "[^"]+", line \d+/,
  /^\s*at .+\(.+:\d+:\d+\)$/, // js stack (kept but de-prioritised via limit)
  /^\s*(Failed asserting|expected .* to|Expected:|Received:|Actual:|\+ expected|- actual)/i,
  /^\s*rspec \.\/\S+:\d+/,
  /^\s*Failures:/,
  /^\s*\d+\)\s.+/, // rspec/mocha numbered failures
  /^(PHP )?(Parse|Fatal) error:/i,
  /^\s*(error|ERROR|Error)\b.*$/,
  /^\s*(Tests|Test Suites|Test Files):\s.*(failed|fail)/i,
  /^\s*(Found \d+ errors?|\d+ errors?(,| generated)|✖ \d+ problems?)/i,
  /^\s*(could not compile|failed to compile|compilation failed|Build FAILED|BUILD FAILED)/i,
  /^\s*\d+ (file|files) (would be|need) reformatt/i,
  /^\s*(would reformat|Would reformat)\s/i,
  /^\s*(mypy|pyright|ruff|eslint|tsc|cargo|go|rubocop|phpstan|psalm|swiftlint|dart|deno|biome):?\s+.*\b(error|fail)/i,
  /^\s*(npm|pnpm|yarn|bun) (ERR!|error)/i,
  /^\s*ELIFECYCLE|ERR_PNPM/,
  /^\s*error: (unknown|unrecognized|invalid) (option|argument|command)/i,
];

const NOISE_PATTERNS: RegExp[] = [
  /^\s*$/,
  /^\s*[>|]\s*(\S+@\S+\s+)?(tsc|vitest|jest|eslint|biome|prettier|cargo|go|pytest|mypy|ruff|rubocop|rspec)\b/, // npm script echo
  /^\s*> .*$/,
  /^\s*\$ .*$/, // yarn command echo
  /^\s*(warning|warn):?\s.*(deprecated|deprecation|peer dep|EXPERIMENTAL)/i,
  /^\s*(Compiling|Checking|Downloading|Downloaded|Updating|Fetching|Blocking|Finished|Running|Locking)\s/, // cargo progress
  /^\s*(RUN|PASS|✓|✔|ok)\s/, // passing tests
  /^\s*\.+$/,
  /^\s*=+\s*$/,
  /^\s*-+\s*$/,
  /^\s*Duration\s|^\s*Start at\s|^\s*Time:\s/,
  /^\s*npm notice/,
  /^\s*ExperimentalWarning/,
  /^\s*\(Use `node --trace/,
  /^\s*node:internal/,
];

export interface Pruned {
  lines: string[];
  totalLines: number;
  diagnosticCount: number;
  /** First file paths mentioned in diagnostics (for the failure signature). */
  files: string[];
}

export function pruneOutput(text: string, maxLines = 40): Pruned {
  const all = text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/\s+$/, ""));
  const totalLines = all.filter((l) => l.trim() !== "").length;
  const isDiag = (l: string) => DIAG_PATTERNS.some((re) => re.test(l));
  const isNoise = (l: string) => NOISE_PATTERNS.some((re) => re.test(l));
  const diagIdx: number[] = [];
  for (let i = 0; i < all.length; i++) if (isDiag(all[i]!) && !isNoise(all[i]!)) diagIdx.push(i);
  const files = new Set<string>();
  for (const i of diagIdx.slice(0, 50)) {
    const m = all[i]!.match(/([^\s:()'"]+\.[A-Za-z0-9]{1,10})(?=[:(]\d)/);
    if (m) files.add(m[1]!);
  }
  let picked: string[] = [];
  if (diagIdx.length > 0) {
    // Keep diagnostic lines plus one line of trailing context each (messages often wrap), in order.
    const keep = new Set<number>();
    const CONTEXT_RE = /^\s*(-->|\d+\s*\||\|\s*[\^~-]|=\s+(help|note)|E\s|at |File "|\.\.\.)/;
    for (const i of diagIdx) {
      keep.add(i);
      // rustc/gcc/pytest style blocks: keep the snippet/context lines that follow (up to 8), skipping bare gutters.
      for (let j = 1; j <= 8 && i + j < all.length; j++) {
        const nx = all[i + j]!;
        if (nx.trim() === "" || isNoise(nx)) break;
        if (/^\s*\|\s*$/.test(nx)) continue; // bare gutter line
        if (CONTEXT_RE.test(nx) || (j <= 2 && /^\s{2,}\S/.test(nx))) keep.add(i + j);
        else break;
      }
    }
    // Stack traces: cap "at ..." lines to 3 per block
    let atRun = 0;
    const ordered = Array.from(keep).sort((a, b) => a - b);
    for (const i of ordered) {
      const l = all[i]!;
      if (/^\s*at .+\(.+:\d+:\d+\)$/.test(l)) {
        atRun++;
        if (atRun > 3) continue;
      } else atRun = 0;
      picked.push(l);
      if (picked.length >= maxLines) break;
    }
    // Always include a summary line if present near the end.
    const summary = all.slice(-15).find((l) => /(Found \d+ errors?|\d+ (failed|passed|errors?|problems?)|Tests?:\s|could not compile|FAILED|✖)/i.test(l) && !picked.includes(l));
    if (summary && picked.length < maxLines + 2) picked.push(summary);
  } else {
    // No diagnostics recognised: first 8 non-noise lines + tail.
    const nonNoise = all.filter((l) => !isNoise(l));
    const head = nonNoise.slice(0, 8);
    const tail = nonNoise.slice(-Math.max(6, maxLines - head.length));
    picked = head.length + tail.length > nonNoise.length ? nonNoise.slice(0, maxLines) : [...head, "…", ...tail];
  }
  picked = picked.map((l) => (l.length > 400 ? l.slice(0, 397) + "…" : l));
  return { lines: picked, totalLines, diagnosticCount: diagIdx.length, files: Array.from(files).slice(0, 12) };
}
