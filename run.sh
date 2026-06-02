#!/bin/bash
# Cron wrapper — sources env and runs the alert
set -e
cd "$(dirname "$0")"
export $(grep -v '^#' .env | xargs)
/opt/homebrew/bin/node alert.js >> /tmp/demand-alert.log 2>&1
