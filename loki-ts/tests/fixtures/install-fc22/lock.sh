#!/bin/sh
echo x >> package-lock.json
echo y > stray.txt
mkdir -p node_modules && : > node_modules/.installed
exit 0
