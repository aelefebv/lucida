#!/usr/bin/env bash
# Compare each tool CI installs at a hand-pinned version with that tool's
# newest release, and print a Markdown table row for every pin behind it.
# Prints nothing when every pin is current.
#
# Dependabot does not see these pins: workflow steps and the Dockerfile
# install the tools, and no manifest it reads declares them. Each pin is read
# from the file that uses it, so there is no second copy here to go stale.
#
# Needs curl, jq, and an authenticated gh for the GitHub release lookups.
set -euo pipefail

cd "$(dirname -- "${BASH_SOURCE[0]}")/.."

# The value of the first `NAME: x.y.z` line in FILE.
pin() {
  sed -nE "s/^[[:space:]]*$1:[[:space:]]*v?([0-9][0-9.]*)[[:space:]]*$/\1/p" "$2" | head -n 1
}

github_latest() { gh api "repos/$1/releases/latest" --jq .tag_name | sed 's/^v//'; }
pypi_latest() { curl -fsSL --retry 3 "https://pypi.org/pypi/$1/json" | jq -r .info.version; }
npm_latest() { curl -fsSL --retry 3 "https://registry.npmjs.org/$1/latest" | jq -r .version; }
# crates.io refuses requests without a User-Agent that names the caller.
crates_latest() {
  curl -fsSL --retry 3 -A "lucida tool-pin check (https://github.com/aelefebv/lucida)" \
    "https://crates.io/api/v1/crates/$1" | jq -r .crate.max_stable_version
}

# TOOL PINNED NEWEST WHERE: a table row when NEWEST sorts after PINNED.
check() {
  if [[ -z "$2" || -z "$3" ]]; then
    echo "could not read the pinned or newest version of $1" >&2
    exit 1
  fi
  if [[ "$2" != "$3" && "$(printf '%s\n%s\n' "$2" "$3" | sort -V | tail -n 1)" == "$3" ]]; then
    echo "| $1 | $2 | $3 | $4 |"
  fi
}

ci=.github/workflows/ci.yml

check uv "$(pin UV_VERSION "$ci")" "$(pypi_latest uv)" \
  "\`UV_VERSION\` in \`ci.yml\` and \`trace-gate.yml\`"
check cargo-deny "$(pin CARGO_DENY_VERSION "$ci")" "$(github_latest EmbarkStudios/cargo-deny)" \
  "\`CARGO_DENY_VERSION\` and its sha256 in \`ci.yml\`"
check kubeconform "$(pin KUBECONFORM_VERSION "$ci")" "$(github_latest yannh/kubeconform)" \
  "\`KUBECONFORM_VERSION\` and its sha256 in \`ci.yml\`"
check wasm-pack "$(pin WASM_PACK_VERSION "$ci")" "$(crates_latest wasm-pack)" \
  "\`WASM_PACK_VERSION\` in \`ci.yml\` and the \`Dockerfile\`"
# Moving pnpm to 11 or later also means moving the `pnpm.overrides` in
# lucida-web/package.json into a pnpm-workspace.yaml, the only place those
# majors read them from.
check pnpm "$(jq -r '.packageManager | sub("^pnpm@"; "")' lucida-web/package.json)" "$(npm_latest pnpm)" \
  "\`packageManager\` in \`lucida-web/package.json\`"
check gitleaks "$(pin GITLEAKS_VERSION .github/workflows/secret-scan.yml)" "$(github_latest gitleaks/gitleaks)" \
  "\`GITLEAKS_VERSION\` and its sha256 in \`secret-scan.yml\`"
check trivy "$(pin TRIVY_VERSION .github/workflows/release.yml)" "$(github_latest aquasecurity/trivy)" \
  "\`TRIVY_VERSION\` and its sha256 in \`release.yml\`"
