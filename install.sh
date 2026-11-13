#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

read_field() {
  sed -n "s/^  \"$1\": \"\([^\"]*\)\".*/\1/p" "${SOURCE_DIR}/package.json" | head -1
}

EXTENSION_NAME="$(read_field publisher).$(read_field name)-$(read_field version)"

if [[ -n "${VSCODE_EXTENSIONS_DIR:-}" ]]; then
  EXTENSIONS_DIR="${VSCODE_EXTENSIONS_DIR}"
elif [[ -d "${HOME}/.vscode-server/extensions" ]]; then
  EXTENSIONS_DIR="${HOME}/.vscode-server/extensions"
elif [[ -d "${HOME}/.vscode/extensions" ]]; then
  EXTENSIONS_DIR="${HOME}/.vscode/extensions"
else
  echo "VS Code extensions directory not found. Set VSCODE_EXTENSIONS_DIR." >&2
  exit 1
fi

TARGET="${EXTENSIONS_DIR}/${EXTENSION_NAME}"

if [[ -L "${TARGET}" ]]; then
  rm "${TARGET}"
elif [[ -e "${TARGET}" ]]; then
  echo "${TARGET} already exists and is not a symlink." >&2
  echo "Remove it manually or set a different VSCODE_EXTENSIONS_DIR." >&2
  exit 1
fi

ln -s "${SOURCE_DIR}" "${TARGET}"

echo "Extension installed:"
echo "  ${TARGET} -> ${SOURCE_DIR}"
echo
echo 'Now run "Developer: Reload Window" in VS Code.'
