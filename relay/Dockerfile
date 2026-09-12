# roleworld relay（体验卡中转）
#
# 真 key 只在这个容器里；同学拿到的是可限额、可吊销的卡号。
# 构建：docker build -t roleworld-relay relay
# 运行：docker run -p 8787:8787 --env-file relay/.env roleworld-relay
FROM node:20-alpine

WORKDIR /app
# 服务本身零依赖；要用云开发数据库账本时再单独装 @cloudbase/node-sdk。
COPY package.json ./
COPY store.js server.js index.js scf.js ./

ENV NODE_ENV=production
ENV PORT=8787
EXPOSE 8787

# 容器里的账本目录（挂了持久盘才有意义；否则请用 cloudbase 账本）
VOLUME ["/data"]
ENV CARD_STORE=file
ENV CARD_FILE=/data/cards.json

CMD ["node", "index.js"]
