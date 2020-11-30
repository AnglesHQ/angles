# pull official base image
FROM node:13.12.0

# set working directory
WORKDIR /app

EXPOSE 3000/tcp

VOLUME /app/screenshots
VOLUME /app/compares

# install app dependencies
COPY package.json ./
COPY package-lock.json ./
RUN npm install --silent

# add app
COPY . ./

# start app
CMD ["node",  "server.js"]
