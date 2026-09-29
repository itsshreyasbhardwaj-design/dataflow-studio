#!/usr/bin/env bash
#
# Scans the working tree for committed credentials.
#
# Deliberately narrow: it looks for real credential shapes, not every string that
# happens to contain the word "key". Run it locally with `pnpm run secret-scan`;
# CI runs the same script, so a clean local run means a clean CI run.
set -uo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- patterns ---
# Shapes that identify a credential on sight.
PATTERNS=(
  '(sk-[A-Za-z0-9_-]{20,})'
  '(gh[pousr]_[A-Za-z0-9]{30,})'
  '(AKIA[0-9A-Z]{16})'
  '(xox[abprs]-[A-Za-z0-9-]{20,})'
  '-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----'
  '(postgres|postgresql|mysql)://[^:/@[:space:]]+:[^@[:space:]]{8,}@'
)

# --------------------------------------------------------------- allowlist ---
# Published, non-secret example values. Every entry here is a literal that is
# public by design and would otherwise match a pattern above. Adding to this list
# means asserting that the value is documented as an example by whoever owns it -
# never that a real credential is "probably fine".
#
#   AKIAIOSFODNN7EXAMPLE   AWS's own example access key, from the documented
#                          Signature V4 test vectors. The sigv4 tests reproduce
#                          those vectors, so this string has to appear verbatim
#                          or the signatures cannot be checked against AWS's
#                          published expected output.
#   dataflow:dataflow      The example database credentials used by the local
#                          docker-compose snippets, .env.example and CI's
#                          throwaway service container. Never a real deployment.
ALLOWLIST=(
  'AKIAIOSFODNN7EXAMPLE'
  '://dataflow:dataflow@'
)

args=()
for pattern in "${PATTERNS[@]}"; do args+=(-e "$pattern"); done

matches=$(grep -rInE "${args[@]}" \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist \
  --exclude-dir=.next --exclude-dir=playwright-report --exclude-dir=test-results \
  --exclude=pnpm-lock.yaml --exclude="$(basename "$0")" \
  . || true)

for allowed in "${ALLOWLIST[@]}"; do
  matches=$(printf '%s\n' "$matches" | grep -Fv "$allowed" || true)
done

matches=$(printf '%s\n' "$matches" | sed '/^$/d')

if [ -n "$matches" ]; then
  echo "Possible credentials committed to the repository:"
  echo "$matches"
  echo
  echo "If a match is a documented public example, add it to ALLOWLIST in $0"
  echo "with a note saying who publishes it. Otherwise remove the credential and"
  echo "rotate it."
  exit 1
fi

echo "No credential patterns found."
