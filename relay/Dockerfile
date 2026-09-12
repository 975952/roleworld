# roleworld relay（体验卡中转）
#
# 真 key 只在这个容器里；同学拿到的是可限额、可吊销的卡号。
# 构建：docker build -t roleworld-relay relay
# 运行：docker run -p 8787:8787 --env-file relay/env roleworld-relay
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
# 账本用云开发数据库时才需要 @cloudbase/node-sdk；装不上就自动退到 file 后端（启动日志会说明）。
RUN npm install --omit=dev --no-audit --no-fund || echo "依赖装不上：账本会退到 file 后端"
COPY store.js server.js index.js scf.js ./

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# 文件后端的账本目录（挂了持久盘才有意义；否则请用 CARD_STORE=cloudbase）
VOLUME ["/data"]
ENV CARD_STORE=file
ENV CARD_FILE=/data/cards.json

CMD ["node", "index.js"]
