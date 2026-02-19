#!/bin/bash
path="${1/#$HOME/\~}"
IFS='/' read -ra parts <<< "$path"
n=${#parts[@]}
if [ "$n" -gt 2 ]; then
  echo "…/${parts[$((n-2))]}/${parts[$((n-1))]}"
else
  echo "$path"
fi
