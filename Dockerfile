FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

# El proceso por defecto es el web. El worker se despliega como un segundo
# servicio con el mismo Dockerfile y CMD ["npm", "run", "start:worker"].
CMD ["npm", "run", "start"]
