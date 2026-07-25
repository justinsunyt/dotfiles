#!/bin/bash

set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

echo "install.sh now delegates to the reproducible Nix bootstrap."
exec "$SCRIPT_DIR/bootstrap.sh" "$@"
