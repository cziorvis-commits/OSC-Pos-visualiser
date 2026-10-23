#!/bin/bash
# macOS: double-click to start the OSC Position Visualiser.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  for p in /opt/homebrew/bin /usr/local/bin; do [ -x "$p/node" ] && PATH="$p:$PATH"; done
fi
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display dialog "Node.js is needed to run the OSC Position Visualiser.\n\nInstall the LTS version from nodejs.org, then double-click this launcher again." buttons {"Open nodejs.org", "Cancel"} default button 1 with title "OSC Position Visualiser"' \
    -e 'if button returned of result is "Open nodejs.org" then open location "https://nodejs.org"' >/dev/null 2>&1
  exit 1
fi

echo "Starting OSC Position Visualiser..."
node bridge/server.js --open
echo
read -n 1 -s -r -p "Visualiser stopped. Press any key to close this window."
