#!/usr/bin/env sh
cd "$(dirname "$0")" || exit 1
echo "Embassy of Burgers — откройте http://localhost:8080"
python3 -m http.server 8080
