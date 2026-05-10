#!/bin/zsh

cd "$(dirname "$0")"
npm run app

echo
echo "Suede Market Maker is open at http://localhost:8787"
echo "You can close this window."
