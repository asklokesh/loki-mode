#!/bin/sh
(sleep 1; echo late >> ../late.txt) &
exit 0
