#!/bin/bash
touch /app/cleanup/.env
echo "export PORT=$PORT; export BUILD_CLEAN_UP_AGE_IN_DAYS=$BUILD_CLEAN_UP_AGE_IN_DAYS" > /app/cleanup/.env
