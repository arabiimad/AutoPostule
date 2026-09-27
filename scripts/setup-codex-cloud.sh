#!/usr/bin/env bash
# Run from the repository root in the Codex Cloud setup phase.
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22+ requis")'
npm ci

# Enable real PDF checks when explicitly requested in the environment settings.
if [[ "${INSTALL_LATEX:-0}" == "1" ]]; then
  if ! command -v pdflatex >/dev/null 2>&1; then
    if [[ "$(id -u)" == "0" ]]; then
      apt-get update
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra texlive-lang-french lmodern poppler-utils
    else
      sudo apt-get update
      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends texlive-latex-extra texlive-fonts-recommended texlive-fonts-extra texlive-lang-french lmodern poppler-utils
    fi
  fi
fi

if [[ "${INSTALL_BROWSER:-0}" == "1" ]]; then
  npx playwright install --with-deps chromium
fi
npm run lint
npm test
npm run build
