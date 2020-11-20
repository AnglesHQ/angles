# Angles dashboard
A test dashboard that will allow you to store your automated test results in a common way an display the reports from various test execution frameworks

## Setup
To setup your own instance of the Angles dashboard you can use the [docker compose](setup/docker-compose.yml) file and [Docker-compose](https://docs.docker.com/compose/). 

The Angles dashboard is made up of 3 parts (each of which run in their own container):
- the backend ([angles](https://hub.docker.com/repository/docker/angleshq/angles)), 
- the frontend ([angles-ui](https://hub.docker.com/repository/docker/angleshq/angles-ui)) 
- and the default mongo container (where the test results are stored).

### Setting up Angles
You'll need to clone the angles project and then using a terminal navigate to the [setup directory](setup/) which contains the docker-compose.yml file and the mongo-init.js file.
The mongo-int.js file will setup the necessary database collections and indexes.

Before you can install 

```shellscript
# set the version you want to install 
export ANGLES_VERSION=1.0.0-BETA1

# run in same directory as docker-compose file
docker-compose up --build -d  
```

### Tearing down Angles
If you would like to tear down the containers, you can run the following command in the directory with the docker-compose.yml file. 

```shellscript
# and to tear it down
docker-compose down
```
NOTE: Angles creates volumes to store persistent data (e.g. database config and records), and these will remain even after running the command above. If you wanted to remove this as well you would have to do manually.

### Angles API
Once Angles is running you can access the documentation by navigating to the following url http://<angles-server-ip:3000/api-docs.
 
Or if you just want to have a look at the api documentation it can be found in the [swagger json](swagger/swagger.json) which you can then load in the [swagger editor](https://editor.swagger.io/?url=https://raw.githubusercontent.com/AnglesHQ/angles/master/swagger/swagger.json).

This API is what the Angles clients ([Java Client](https://github.com/AnglesHQ/angles-java-client), more to follow) and the [Angles-ui](https://github.com/AnglesHQ/angles-ui) can use to store and retrieve data in and from the angles back-end.

### Using the API
Before you can store any test results in the Angles dashboard you will need to:
- Setup a team (using the API)
- Setup an environment (using the API)

Please refer to the Swagger endpoint once your instance is up and running and click the "Try it out" button on the create team endpoint. Once you fill in the details and click execute, the team will be added. Repeat these steps for the environment.