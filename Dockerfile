# Use an official Node.js runtime as the base image. The alpine variant is
# lightweight but still includes the necessary system libraries. Using a
# pinned major version makes builds reproducible.
FROM node:20-slim

# Create app directory
WORKDIR /app

# Copy package.json and package-lock.json if present. Doing this first
# leverages Docker layer caching so that dependencies are not reinstalled
# unnecessarily when only application code changes.
COPY package.json ./

# Install app dependencies, including development dependencies. Installing
# dev dependencies is necessary because the build step relies on the
# TypeScript compiler which is listed under devDependencies. If a
# package-lock.json were checked in this would use npm ci for reproducibility.
RUN npm install

# Copy the rest of the application source code. This includes the
# TypeScript sources and configuration files.
COPY tsconfig.json ./
COPY src ./src

# Build the TypeScript sources into JavaScript. The compiled files
# will be output into the `dist` directory as specified in tsconfig.json.
RUN npm run build

# Expose no ports by default. The MCP server communicates over stdio.

# Define the default command to run the server. Environment variables
# such as MONGODB_URI, JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN must
# be provided at runtime (e.g. via docker run -e) for the server to
# connect to MongoDB and Jira.
CMD ["npm", "start"]