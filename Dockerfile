FROM node:18

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the entire project
COPY . .

# Expose the port your server uses
EXPOSE 3000

# Start the server
CMD ["node", "server.js"]
