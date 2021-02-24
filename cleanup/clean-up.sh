#!/bin/sh
echo "============================== Starting Angles Build Cleanup Script =============================="
teams=$(curl --silent "http://localhost:$PORT/rest/api/v1.0/team" | jq -c '.[]')
for team in $teams
do
  teamId=$(jq -r '._id' <<< $team)
  teamName=$(jq '.name' <<< $team)
  echo "$(date '+%d/%m/%Y %H:%M:%S'): Attempting to delete old builds for team $teamName with id $teamId";
  response=$(curl --silent -X "DELETE" "http://localhost:$PORT/rest/api/v1.0/build?teamId=$teamId&ageInDays=$BUILD_CLEAN_UP_AGE_IN_DAYS" | jq '.message')
  echo $(date '+%d/%m/%Y %H:%M:%S'): $response
done
echo -e "============================== Finished cleanup ==============================\n"
