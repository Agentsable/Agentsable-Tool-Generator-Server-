// Built-in deterministic validator rules (Validator screen, "Python Rules"
// sub-view). Spec: docs/llm_generated/14-screen-validator.md §3.3.
//
// Every rule is a standalone Python module executed in the Pyodide worker in
// its own namespace, so each one carries the helpers it needs. The execution
// contract is fixed:
//
//     def validate(ts_code: str, config_json: dict) -> tuple[bool, str]
//
// returning (True, message) for a pass and (False, message) for a failure.

export interface PythonRuleFile {
  /** Stable identifier used by the UI accordion and the results store. */
  id: string;
  /** File name as it appears in the rules folder, e.g. `rule_no_global_fetch.py`. */
  filename: string;
  /** Python source implementing `validate(ts_code, config_json)`. */
  source: string;
  /** Built-in rules ship with TGS; user rules are authored in the editor. */
  builtin: true;
}

const SOURCE_RULE_NO_GLOBAL_FETCH = `# rule_no_global_fetch.py
# Authoring rule 7 (Zero-Trust Network): a tool must never call the global
# fetch(). External calls go through dispatchToGateway(...) or
# context.useCoreTool("network_gateway", ...).

import re


def _mask_comments(code: str) -> str:
    """Blank out // and /* */ comments, keeping every newline so line
    numbers still line up. String literals are left untouched."""
    out = []
    i = 0
    n = len(code)
    mode = None  # None | "line" | "block" | "'" | '"' | "\`"
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if mode is None:
            if c == "/" and nxt == "/":
                mode = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                out.append("  ")
                i += 2
                continue
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if mode == "line":
            if c == "\\n":
                mode = None
                out.append(c)
            else:
                out.append(" ")
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                mode = None
                out.append("  ")
                i += 2
                continue
            out.append(c if c == "\\n" else " ")
            i += 1
            continue
        # inside a string literal
        if c == "\\\\":
            out.append(c)
            if i + 1 < n:
                out.append(code[i + 1])
            i += 2
            continue
        if c == mode:
            mode = None
        out.append(c)
        i += 1
    return "".join(out)


def _mask_strings(code: str) -> str:
    """Blank out the *contents* of string/template literals (quotes kept),
    preserving newlines and offsets. Run on comment-masked code."""
    out = []
    i = 0
    n = len(code)
    mode = None
    while i < n:
        c = code[i]
        if mode is None:
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if c == "\\\\":
            out.append("  ")
            i += 2
            continue
        if c == mode:
            mode = None
            out.append(c)
            i += 1
            continue
        out.append(c if c == "\\n" else " ")
        i += 1
    return "".join(out)


def _line_of(code: str, index: int) -> int:
    return code.count("\\n", 0, index) + 1


_GLOBAL_OBJECTS = ("globalThis", "window", "self", "global")


def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    code = _mask_strings(_mask_comments(ts_code))
    offences = []

    for m in re.finditer(r"fetch\\s*\\(", code):
        start = m.start()
        before = code[:start]
        stripped = before.rstrip()
        prev = code[start - 1] if start > 0 else ""

        # \`internalFetch(\`, \`myFetch(\` -> "fetch" is a tail of a longer identifier.
        if prev and (prev.isalnum() or prev in "_$"):
            continue

        if stripped.endswith("."):
            owner = re.search(r"([A-Za-z_$][\\w$]*)\\s*\\.\\s*$", stripped)
            # \`globalThis.fetch(\` / \`window.fetch(\` is still the global fetch.
            if owner is None or owner.group(1) not in _GLOBAL_OBJECTS:
                continue

        # \`function fetch(\` / \`const fetch = (\` are declarations, not calls.
        if re.search(r"\\b(function|class)\\s*$", stripped):
            continue

        offences.append(_line_of(ts_code, start))

    if offences:
        lines = ", ".join(str(n) for n in offences)
        plural = "s" if len(offences) > 1 else ""
        return (
            False,
            "Direct global fetch() call%s found on line%s %s. "
            "Route external requests through dispatchToGateway(...) or "
            'context.useCoreTool("network_gateway", ...).' % (plural, plural, lines),
        )

    return True, "No direct global fetch() calls; egress is routed through the gateway."
`;

const SOURCE_RULE_CF_WORKER_COMPAT = `# rule_cf_worker_compat.py
# Cloudflare Workers (WinterCG) isolates have no Node.js built-ins and no
# CommonJS loader. Flag both.

import re


def _mask_comments(code: str) -> str:
    """Blank out // and /* */ comments, keeping every newline so line
    numbers still line up. String literals are left untouched."""
    out = []
    i = 0
    n = len(code)
    mode = None  # None | "line" | "block" | "'" | '"' | "\`"
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if mode is None:
            if c == "/" and nxt == "/":
                mode = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                out.append("  ")
                i += 2
                continue
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if mode == "line":
            if c == "\\n":
                mode = None
                out.append(c)
            else:
                out.append(" ")
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                mode = None
                out.append("  ")
                i += 2
                continue
            out.append(c if c == "\\n" else " ")
            i += 1
            continue
        # inside a string literal
        if c == "\\\\":
            out.append(c)
            if i + 1 < n:
                out.append(code[i + 1])
            i += 2
            continue
        if c == mode:
            mode = None
        out.append(c)
        i += 1
    return "".join(out)


def _mask_strings(code: str) -> str:
    """Blank out the *contents* of string/template literals (quotes kept),
    preserving newlines and offsets. Run on comment-masked code."""
    out = []
    i = 0
    n = len(code)
    mode = None
    while i < n:
        c = code[i]
        if mode is None:
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if c == "\\\\":
            out.append("  ")
            i += 2
            continue
        if c == mode:
            mode = None
            out.append(c)
            i += 1
            continue
        out.append(c if c == "\\n" else " ")
        i += 1
    return "".join(out)


def _line_of(code: str, index: int) -> int:
    return code.count("\\n", 0, index) + 1


_PROHIBITED_BARE = (
    "fs",
    "path",
    "child_process",
    "os",
    "stream",
    "buffer",
    "crypto",
    "http",
    "https",
    "net",
    "tls",
    "zlib",
    "worker_threads",
    "vm",
    "cluster",
    "dgram",
    "readline",
    "assert",
    "util",
    "events",
    "url",
    "querystring",
    "string_decoder",
    "perf_hooks",
    "async_hooks",
    "timers",
    "dns",
    "v8",
    "tty",
)

_SPEC_PATTERNS = (
    r"""\\bfrom\\s*['"]([^'"]+)['"]""",
    r"""\\bimport\\s*\\(\\s*['"]([^'"]+)['"]""",
    r"""\\bimport\\s+['"]([^'"]+)['"]""",
    r"""\\brequire\\s*\\(\\s*['"]([^'"]+)['"]""",
)


def _base_module(spec: str) -> str:
    """\`node:fs/promises\` -> \`fs\`; \`path/posix\` -> \`path\`."""
    name = spec[5:] if spec.startswith("node:") else spec
    return name.split("/", 1)[0]


def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    code = _mask_comments(ts_code)
    offences = []

    for pattern in _SPEC_PATTERNS:
        for m in re.finditer(pattern, code):
            spec = m.group(1)
            # Relative, absolute (\`/core/...\`), and URL specifiers are fine.
            if spec.startswith((".", "/", "http:", "https:")):
                continue
            base = _base_module(spec)
            if spec.startswith("node:") or base in _PROHIBITED_BARE:
                offences.append((_line_of(ts_code, m.start(1)), spec))

    # CommonJS require() in any position.
    for m in re.finditer(r"(?<![\\w$.])require\\s*\\(", _mask_strings(code)):
        offences.append((_line_of(ts_code, m.start()), "require()"))

    if offences:
        seen = []
        for line, what in offences:
            entry = (line, what)
            if entry not in seen:
                seen.append(entry)
        seen.sort()
        detail = "; ".join(
            "Line %d: prohibited module '%s'" % (line, what) for line, what in seen
        )
        return (
            False,
            "%s. Cloudflare Workers isolates do not support Node.js built-ins "
            "or CommonJS require()." % detail,
        )

    return True, "No Node.js built-ins or CommonJS require(); Worker-compatible."
`;

const SOURCE_RULE_HAS_REQUIRED_EXPORTS = `# rule_has_required_exports.py
# Authoring rule 1 (Two Required Exports): \`export const config\` and
# \`export default async function execute\`.

import re


def _mask_comments(code: str) -> str:
    """Blank out // and /* */ comments, keeping every newline so line
    numbers still line up. String literals are left untouched."""
    out = []
    i = 0
    n = len(code)
    mode = None  # None | "line" | "block" | "'" | '"' | "\`"
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if mode is None:
            if c == "/" and nxt == "/":
                mode = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                out.append("  ")
                i += 2
                continue
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if mode == "line":
            if c == "\\n":
                mode = None
                out.append(c)
            else:
                out.append(" ")
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                mode = None
                out.append("  ")
                i += 2
                continue
            out.append(c if c == "\\n" else " ")
            i += 1
            continue
        # inside a string literal
        if c == "\\\\":
            out.append(c)
            if i + 1 < n:
                out.append(code[i + 1])
            i += 2
            continue
        if c == mode:
            mode = None
        out.append(c)
        i += 1
    return "".join(out)


def _mask_strings(code: str) -> str:
    """Blank out the *contents* of string/template literals (quotes kept),
    preserving newlines and offsets. Run on comment-masked code."""
    out = []
    i = 0
    n = len(code)
    mode = None
    while i < n:
        c = code[i]
        if mode is None:
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if c == "\\\\":
            out.append("  ")
            i += 2
            continue
        if c == mode:
            mode = None
            out.append(c)
            i += 1
            continue
        out.append(c if c == "\\n" else " ")
        i += 1
    return "".join(out)


_CONFIG_RE = re.compile(r"\\bexport\\s+const\\s+config\\b")
_EXECUTE_DECL_RE = re.compile(
    r"\\bexport\\s+default\\s+(?:async\\s+)?function\\s*\\*?\\s*execute\\b"
)
_EXECUTE_REF_RE = re.compile(r"\\bexport\\s+default\\s+execute\\b")
_EXECUTE_NAMED_RE = re.compile(r"\\bexport\\s*\\{[^}]*\\bexecute\\b[^}]*\\}")


def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    code = _mask_strings(_mask_comments(ts_code))

    missing = []
    if not _CONFIG_RE.search(code):
        missing.append(
            "\`export const config\` (finalized via initToolConfig(import.meta.url, baseConfig))"
        )

    has_execute = bool(
        _EXECUTE_DECL_RE.search(code)
        or _EXECUTE_REF_RE.search(code)
        or (
            _EXECUTE_NAMED_RE.search(code)
            and re.search(r"\\bexport\\s+default\\b", code)
        )
    )
    if not has_execute:
        missing.append("\`export default async function execute(request, context)\`")

    if missing:
        return False, "Missing required export(s): %s." % "; ".join(missing)

    return True, "Both required exports are present: config and default execute."
`;

const SOURCE_RULE_DEPENDENCIES_DECLARED = `# rule_dependencies_declared.py
# Authoring rule 3 (Explicit Tool Dependencies): every sibling tool reached via
# internalFetch()/useCoreTool() must be listed in config.tool_dependencies.

import re


def _mask_comments(code: str) -> str:
    """Blank out // and /* */ comments, keeping every newline so line
    numbers still line up. String literals are left untouched."""
    out = []
    i = 0
    n = len(code)
    mode = None  # None | "line" | "block" | "'" | '"' | "\`"
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if mode is None:
            if c == "/" and nxt == "/":
                mode = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                out.append("  ")
                i += 2
                continue
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if mode == "line":
            if c == "\\n":
                mode = None
                out.append(c)
            else:
                out.append(" ")
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                mode = None
                out.append("  ")
                i += 2
                continue
            out.append(c if c == "\\n" else " ")
            i += 1
            continue
        # inside a string literal
        if c == "\\\\":
            out.append(c)
            if i + 1 < n:
                out.append(code[i + 1])
            i += 2
            continue
        if c == mode:
            mode = None
        out.append(c)
        i += 1
    return "".join(out)


def _mask_strings(code: str) -> str:
    """Blank out the *contents* of string/template literals (quotes kept),
    preserving newlines and offsets. Run on comment-masked code."""
    out = []
    i = 0
    n = len(code)
    mode = None
    while i < n:
        c = code[i]
        if mode is None:
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if c == "\\\\":
            out.append("  ")
            i += 2
            continue
        if c == mode:
            mode = None
            out.append(c)
            i += 1
            continue
        out.append(c if c == "\\n" else " ")
        i += 1
    return "".join(out)


def _line_of(code: str, index: int) -> int:
    return code.count("\\n", 0, index) + 1


_CALL_RE = re.compile(
    r"""(?<![\\w$])(?:internalFetch|useCoreTool)\\s*\\(\\s*(['"])([^'"]+)\\1"""
)
_DYNAMIC_RE = re.compile(r"""(?<![\\w$])(?:internalFetch|useCoreTool)\\s*\\(\\s*[^'")\\s]""")
_GATEWAY_RE = re.compile(r"(?<![\\w$])dispatchToGateway\\s*\\(")


def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    code = _mask_comments(ts_code)
    declared = config_json.get("tool_dependencies") or []
    if not isinstance(declared, list):
        return False, "config.tool_dependencies must be an array of sibling tool names."
    declared_names = [str(d) for d in declared]

    missing = []
    for m in _CALL_RE.finditer(code):
        target = m.group(2)
        if target not in declared_names:
            entry = (_line_of(ts_code, m.start()), target)
            if entry not in missing:
                missing.append(entry)

    gateway = _GATEWAY_RE.search(_mask_strings(code))
    if gateway is not None and "network_gateway" not in declared_names:
        missing.append((_line_of(ts_code, gateway.start()), "network_gateway"))

    if missing:
        missing.sort()
        detail = "; ".join(
            "Line %d: '%s' is not declared" % (line, name) for line, name in missing
        )
        return (
            False,
            "%s. Add every called tool to config.tool_dependencies or the STS "
            "router will block the call." % detail,
        )

    dynamic = _DYNAMIC_RE.search(code)
    if dynamic is not None:
        return (
            True,
            "All literal tool targets are declared, but line %d builds the target "
            "dynamically and cannot be verified statically."
            % _line_of(ts_code, dynamic.start()),
        )

    return True, "Every internalFetch/useCoreTool target is declared in tool_dependencies."
`;

const SOURCE_RULE_NETWORK_ALLOWLIST = `# rule_network_allowlist.py
# Authoring rule 7 (Zero-Trust Network): every absolute http(s) URL the tool
# targets must be covered by a prefix in config.network_requests.

import re


def _mask_comments(code: str) -> str:
    """Blank out // and /* */ comments, keeping every newline so line
    numbers still line up. String literals are left untouched."""
    out = []
    i = 0
    n = len(code)
    mode = None  # None | "line" | "block" | "'" | '"' | "\`"
    while i < n:
        c = code[i]
        nxt = code[i + 1] if i + 1 < n else ""
        if mode is None:
            if c == "/" and nxt == "/":
                mode = "line"
                out.append("  ")
                i += 2
                continue
            if c == "/" and nxt == "*":
                mode = "block"
                out.append("  ")
                i += 2
                continue
            if c in ("'", '"', "\`"):
                mode = c
            out.append(c)
            i += 1
            continue
        if mode == "line":
            if c == "\\n":
                mode = None
                out.append(c)
            else:
                out.append(" ")
            i += 1
            continue
        if mode == "block":
            if c == "*" and nxt == "/":
                mode = None
                out.append("  ")
                i += 2
                continue
            out.append(c if c == "\\n" else " ")
            i += 1
            continue
        # inside a string literal
        if c == "\\\\":
            out.append(c)
            if i + 1 < n:
                out.append(code[i + 1])
            i += 2
            continue
        if c == mode:
            mode = None
        out.append(c)
        i += 1
    return "".join(out)


def _line_of(code: str, index: int) -> int:
    return code.count("\\n", 0, index) + 1


_URL_RE = re.compile(r"https?://[^\\s'\\"\`\\\\)]*")
_IMPORT_LINE_RE = re.compile(r"^\\s*(?:import\\b|export\\b.*\\bfrom\\b)")


def _string_literals(code: str):
    """Yield (offset, text, truncated) for each string/template literal.
    A template literal is cut at the first \${ so only its static prefix is
    considered a URL."""
    i = 0
    n = len(code)
    while i < n:
        c = code[i]
        if c not in ("'", '"', "\`"):
            i += 1
            continue
        quote = c
        start = i + 1
        i += 1
        chunks = []
        truncated = False
        while i < n:
            ch = code[i]
            if ch == "\\\\":
                i += 2
                chunks.append("\\\\")
                continue
            if ch == quote:
                break
            if quote == "\`" and ch == "$" and i + 1 < n and code[i + 1] == "{":
                truncated = True
                break
            chunks.append(ch)
            i += 1
        # skip to the real end of a template literal that was cut at \${
        if truncated:
            depth = 0
            while i < n:
                if code[i] == "{":
                    depth += 1
                elif code[i] == "}":
                    depth -= 1
                    if depth == 0:
                        i += 1
                        break
                i += 1
            while i < n and code[i] != quote:
                if code[i] == "\\\\":
                    i += 1
                i += 1
        yield start, "".join(chunks), truncated
        i += 1


def validate(ts_code: str, config_json: dict) -> tuple[bool, str]:
    code = _mask_comments(ts_code)
    allowlist = config_json.get("network_requests") or []
    if not isinstance(allowlist, list):
        return False, "config.network_requests must be an array of absolute URL prefixes."
    prefixes = [str(p) for p in allowlist]

    uncovered = []
    for offset, text, truncated in _string_literals(code):
        line = _line_of(ts_code, offset)
        # Import specifiers (\`/core/...\`, remote modules) are not request targets.
        line_start = code.rfind("\\n", 0, offset) + 1
        if _IMPORT_LINE_RE.match(code[line_start:offset] or ""):
            continue
        for m in _URL_RE.finditer(text):
            url = m.group(0)
            covered = any(
                url.startswith(p) or (truncated and p.startswith(url)) for p in prefixes
            )
            if not covered:
                entry = (line, url)
                if entry not in uncovered:
                    uncovered.append(entry)

    if uncovered:
        uncovered.sort()
        detail = "; ".join(
            "Line %d: '%s' is not covered" % (line, url) for line, url in uncovered
        )
        return (
            False,
            "%s. Add an absolute URL prefix to config.network_requests — the "
            "network gateway refuses any target it cannot match." % detail,
        )

    return True, "Every external URL literal is covered by config.network_requests."
`;

export const BUILTIN_PYTHON_RULES: readonly PythonRuleFile[] = [
  {
    id: "rule_no_global_fetch",
    filename: "rule_no_global_fetch.py",
    source: SOURCE_RULE_NO_GLOBAL_FETCH,
    builtin: true,
  },
  {
    id: "rule_cf_worker_compat",
    filename: "rule_cf_worker_compat.py",
    source: SOURCE_RULE_CF_WORKER_COMPAT,
    builtin: true,
  },
  {
    id: "rule_has_required_exports",
    filename: "rule_has_required_exports.py",
    source: SOURCE_RULE_HAS_REQUIRED_EXPORTS,
    builtin: true,
  },
  {
    id: "rule_dependencies_declared",
    filename: "rule_dependencies_declared.py",
    source: SOURCE_RULE_DEPENDENCIES_DECLARED,
    builtin: true,
  },
  {
    id: "rule_network_allowlist",
    filename: "rule_network_allowlist.py",
    source: SOURCE_RULE_NETWORK_ALLOWLIST,
    builtin: true,
  },
];

/**
 * The qualitative rubric persisted as `sts_rules.md` and sent to Claude as the
 * system prompt of the heuristic review (spec §4.2).
 */
export const DEFAULT_LLM_RUBRIC = `# STS Tool Heuristic Validation Guidelines

You are an automated auditor verifying compliance with
the Simple Tools Server (STS) Tool Guidelines.

## Guidelines to Evaluate
1. **Actionable Advice**: Every defined error must give
   specific instructions enabling the AI agent to
   modify its payload and self-correct on failure.
2. **Description Clarity**: The description must explain
   *what* data the tool outputs and its external utility.
3. **Rate Limits**: Rate limits must not be unlimited.
   Reasonable ranges are between 60 and 600 RPM.

## Mandatory Output Format
Return ONLY a valid JSON array of objects matching:
[
  {
    "rule": "Actionable Advice",
    "status": "pass" | "fail" | "warn",
    "reasoning": "Explanation of the evaluation..."
  }
]
`;
