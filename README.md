# Angles dashboard
Angles is dashboard that will allow you to store your automated test results and screenshots by providing a clear API, which allows you to enter your tests results from various frameworks and languages. This means you will no longer have different reporting for each of the testing frameworks you use and you can generate reports covering various test phases and tools.

Some additional features provided are:
- Visual comparison (against a baseline)
- Setting ignore boxes (for areas that should be included in the compare)
- Storing addition details as part of the test runs such as platform and artefact versions for system under test.
- Automatic cleanup of builds and screenshots after 90 days (configurable)
- Test Case history (allowing you to see the history of a single automated test case)
- Test Matrix (allow you to compare multiple builds, to e.g. find any flakey test cases)

## Setup
To setup your own instance of the Angles dashboard you can use the [docker compose](setup/docker-compose.yml) file and [Docker-compose](https://docs.docker.com/compose/).

The Angles dashboard is made up of 3 parts (each of which run in their own container):
- the backend ([angles](https://hub.docker.com/repository/docker/angleshq/angles)),
- the frontend ([angles-ui](https://hub.docker.com/repository/docker/angleshq/angles-ui))
- and the default mongo container (where the test results are stored).

### Setting up Angles
You'll need to clone the angles project and then using a terminal navigate to the [setup directory](setup/) which contains the docker-compose.yml file and the mongo-init.js file. The mongo-int.js file will setup the necessary database collections and indexes.

Before you can install Angles you'll have to define the environment variable for the Angles version you'll want to install by exporting ANGLES_VERSION.
If you're not running Angles locally (e.g. 127.0.0.1), you should also change the environment variable "REACT_APP_ANGLES_API_URL" in the docker-compose file to point to the url where the angles API is accessible (e.g. domain name or external ip address).

```shellscript
# run in same directory as docker-compose file (and it will install the latest tag)
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
Before you can store any test results in the Angles dashboard you will need to setup a team (and it's component(s)) and an environment. Please note that the team, component and environment have to exist before you can start adding builds for the relevant team (otherwise angles will return an error). If you would like to use the [TestNG-Example Project](https://github.com/AnglesHQ/testng-example) setup the example team, component and environment mentioned below using the angles-api which is accessible via the following url when you setup the containers locally: [http://127.0.0.1:3000/api-docs](http://127.0.0.1:3000/api-docs).

- Setup a team (using the API)

``` json
{
  "name": "angles",
  "components": [
    {
      "name": "example"
    }
  ]
}
```
- Setup an environment (using the API)

``` json
{
  "name": "qa"
}
```

Please refer to the Swagger endpoint once your instance is up and running and click the "Try it out" button on the create team endpoint. Once you fill in the details and click execute, the team will be added. Repeat these steps for the environment.

### Angles Cleanup (Cron)
Please not that angles has a nightly cron that will use the build delete API to remove any builds and screenshots older than 90 days. If you would like to change this number please BUILD_CLEAN_UP_AGE_IN_DAYS value in the docker-compose file and run the docker-compose command again. If you want to keep specific builds there is a "keep" flag which can be set, which means those builds will not be removed as part of the nightly run (once they hit the relevant age). Also the cleanup will not remove any build that contain a "baseline" image. Once the baseline is updated, the build will be removed during the next run.
