# pull official base image
FROM node:16.15.0

# set working directory
WORKDIR /app

EXPOSE 3000/tcp

# variables to configure the swagger doc
ENV REACT_APP_SWAGGER_ANGLES_API_URL=127.0.0.1:3000
ENV REACT_APP_SWAGGER_SCHEMES=http

VOLUME /app/screenshots
VOLUME /app/compares

# required to setup the clean-up crontab
RUN apt-get update
RUN apt-get -y install cron vim jq
RUN apt-get -y --fix-missing install build-essential libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev librsvg2-dev

# crontab
COPY cleanup /cleanup
RUN cp /cleanup/crontab /etc/cron.d/angles_cleanup
RUN chmod 0644 /etc/cron.d/angles_cleanup
RUN chmod 0644 /etc/crontab
RUN crontab /etc/cron.d/angles_cleanup

# install app dependencies
COPY package.json ./
COPY package-lock.json ./
RUN npm install --silent

# add app
COPY . ./

# start app
CMD sh /app/cleanup/entrypoint.sh && cron && touch /var/log/cron.log && node server.js
