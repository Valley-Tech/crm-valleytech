FROM node:20-alpine

WORKDIR /app

# Prisma necesita OpenSSL presente para detectar la plataforma correctamente.
RUN apk add --no-cache openssl

COPY package*.json ./
COPY prisma ./prisma
RUN npm ci --omit=dev

COPY . .

# Compila la interfaz React (web/dist). El servidor la sirve como estáticos.
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# El proceso por defecto es el web. El worker se despliega como un segundo
# servicio con el mismo Dockerfile y CMD ["npm", "run", "start:worker"].
CMD ["npm", "run", "start"]
