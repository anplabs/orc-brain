/**
 * Secret scrubber (§8.6). Tool inputs are redacted before they are written to
 * the append-only audit log. Pattern-based and conservative: it would rather
 * over-redact than leak a token.
 */

const REDACTIONS: { re: RegExp; replacement: string }[] = [
  // Anthropic / OpenAI style keys.
  { re: /\b(sk-[a-zA-Z0-9_-]{16,})\b/g, replacement: "sk-***REDACTED***" },
  {
    re: /\b(sk-ant-[a-zA-Z0-9_-]{16,})\b/g,
    replacement: "sk-ant-***REDACTED***",
  },
  // AWS access key id / secret.
  { re: /\b(AKIA[0-9A-Z]{16})\b/g, replacement: "AKIA***REDACTED***" },
  {
    re: /\baws_secret_access_key\s*=\s*\S+/gi,
    replacement: "aws_secret_access_key=***REDACTED***",
  },
  // Generic bearer tokens & auth headers.
  {
    re: /\bBearer\s+[a-zA-Z0-9._-]{12,}/g,
    replacement: "Bearer ***REDACTED***",
  },
  { re: /\b(gh[pousr]_[A-Za-z0-9]{16,})\b/g, replacement: "gh***REDACTED***" },
  // KEY=value / TOKEN=value / PASSWORD=value / SECRET=value assignments.
  {
    re: /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY))\s*[=:]\s*("?)[^\s"']+\2/gi,
    replacement: "$1=***REDACTED***",
  },
  // Connection strings with inline credentials: scheme://user:pass@host
  {
    re: /([a-z][a-z0-9+.-]*:\/\/[^:@\s/]+):[^@\s/]+@/gi,
    replacement: "$1:***REDACTED***@",
  },
  // PEM private key blocks.
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: "***REDACTED PRIVATE KEY***",
  },
];

/**
 * Exact secret values registered at runtime — plugin secrets (spec 003 §R5).
 * Redacted from every string before the pattern pass, so a token that matches
 * no pattern (e.g. a Linear API key) still never reaches logs or audit.
 */
const SECRET_VALUES = new Set<string>();

/** Registers a literal value for redaction (spec 003 §R5). Short values are ignored. */
export function registerSecretValue(value: string): void {
  if (value.length >= 6) SECRET_VALUES.add(value);
}

/** Clears runtime-registered secret values. Test-only. */
export function clearRegisteredSecretValues(): void {
  SECRET_VALUES.clear();
}

/** Redacts secrets from a plain string. */
export function redactString(input: string): string {
  let out = input;
  for (const value of SECRET_VALUES) {
    if (out.includes(value)) out = out.split(value).join("***REDACTED***");
  }
  for (const { re, replacement } of REDACTIONS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/**
 * Deep-redacts secrets from an arbitrary JSON-serializable value, returning a
 * structurally-identical copy with string leaves scrubbed (§8.6).
 */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactValue(v);
    return out;
  }
  return value;
}
