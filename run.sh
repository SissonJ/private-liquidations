#!/bin/bash

cd /root/private-liquidations
ts-node --esm ./index.ts >> ./logs/"$(date +%Y-%m-%d).log" 2>&1
